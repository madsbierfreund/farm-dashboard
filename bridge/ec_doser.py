#!/usr/bin/env python3
"""EC-doser (goedning) til hydroponik.

Koerer paa samme Raspberry Pi som ph_bridge.py / ph_doser.py og taler KUN med
den lokale MQTT-broker. Modelleret paa ph_doser.py: samme moenstre for
MQTT-haandtering, indstillings-polling, tilstands-persistens, dagstaellere,
nedkoeling, laas og logning.

En EC-dosis er TRE pumpekoersler i fast raekkefoelge med PUMP_GAP_SECONDS
imellem: pumpe 3 (Micro), pumpe 4 (Grow), pumpe 2 (Bloom). Micro skal ALTID i
foer Bloom — koncentreret calcium og fosfat udfaelder, hvis de moedes.
"""

import json
import logging
import os
import threading
import time
from datetime import date, datetime

import paho.mqtt.client as mqtt

# --- Faste emner ---
EC_TOPIC = "farm/ph_node/sensor/ec/state"
STATUS_TOPIC = "farm/ec/status"
SETTINGS_TOPIC = "farm/ec/settings"
STOP_TOPIC = "farm/pump/stop_all"      # noedstop: stop alle pumper
DOSE_LOG_TOPIC = "farm/ec/dose_log"    # relayes af ph_bridge.py til /api/dose
PUMP_STATE_WILDCARD = "farm/pump/+/state"


def pump_run_topic(n):
    return f"farm/pump/{n}/run"


def env_str(name, default):
    return os.environ.get(name, default)


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return int(default)


def env_float(name, default):
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return float(default)


def env_bool(name, default):
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on", "ja")


# --- Konfiguration, laest ved opstart med fornuftige standardvaerdier ---
MQTT_HOST = env_str("MQTT_HOST", "localhost")
MQTT_PORT = env_int("MQTT_PORT", 1883)
MQTT_USER = env_str("MQTT_USER", "")
MQTT_PASSWORD = env_str("MQTT_PASSWORD", "")

# Overstyrbare i drift via farm/ec/settings (env er kun fallback ved opstart).
EC_ENABLED = env_bool("EC_ENABLED", False)
EC_TARGET = env_float("EC_TARGET", 1.8)
EC_DEADBAND = env_float("EC_DEADBAND", 0.15)
EC_COOLDOWN_MINUTES = env_float("EC_COOLDOWN_MINUTES", 60)
EC_MAX_DOSES_PER_DAY = env_int("EC_MAX_DOSES_PER_DAY", 6)
EC_CONSECUTIVE_READINGS = env_int("EC_CONSECUTIVE_READINGS", 3)
GROWTH_STAGE = env_str("GROWTH_STAGE", "growing")
DOSE_ML_GROW = env_float("DOSE_ML_GROW", 2.0)

# Pumpernes maalte gennemstroemning (ml/s) til at omregne volumen -> varighed.
ML_PER_SECOND_PUMP_2 = env_float("ML_PER_SECOND_PUMP_2", 0.40)  # Bloom
ML_PER_SECOND_PUMP_3 = env_float("ML_PER_SECOND_PUMP_3", 0.36)  # Micro
ML_PER_SECOND_PUMP_4 = env_float("ML_PER_SECOND_PUMP_4", 0.36)  # Grow

PUMP_GAP_SECONDS = env_float("PUMP_GAP_SECONDS", 60)
EC_STALE_SECONDS = env_float("EC_STALE_SECONDS", 120)
EC_FLOOR = env_float("EC_FLOOR", 0.2)  # laavere aflaesninger ignoreres (probe-fejl)
STATE_FILE = os.path.expanduser(env_str("STATE_FILE", "~/.ec_doser_state.json"))

# Noedstop / laas (samme form som ph_doser). For hoej EC = noedstop.
EC_EMERGENCY_CEILING = env_float("EC_EMERGENCY_CEILING", 4.0)
EC_EMERGENCY_LATCH_FILE = os.path.expanduser(
    env_str("EC_EMERGENCY_LATCH_FILE", "/var/lib/ec-doser/emergency.lock")
)
EMERGENCY_STOP_INTERVAL = 10.0
LATCH_LOG_INTERVAL = 60.0

MIN_RUN_S = 0.5
MAX_RUN_S = 30.0

# Vaekststadier: Grow : Micro : Bloom. Skal matche STAGE_RATIOS i settingsSchema.js.
STAGE_RATIOS = {
    "growing": {"grow": 1.8, "micro": 1.2, "bloom": 0.6},
    "preflowering": {"grow": 2.0, "micro": 2.0, "bloom": 1.5},
    "flowering": {"grow": 0.8, "micro": 1.6, "bloom": 2.4},
}
STAGES = tuple(STAGE_RATIOS)

# Fast doseringsraekkefoelge: Micro (pumpe 3) foer Grow (pumpe 4) foer Bloom (pumpe 2).
DOSE_ORDER = ((3, "micro"), (4, "grow"), (2, "bloom"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ec_doser")

# --- Foranderlig tilstand ---
client = None
last_ec = None
last_ec_time = 0.0
consecutive = 0            # antal maalinger under (maal - doedbaand) i traek
last_dose_time = 0.0       # epoch for seneste dosering (bevares over genstart)
dose_count = 0             # doser siden lokal midnat
dose_day = ""              # den lokale dato dose_count gaelder for
dosing = False             # er en tre-pumpe-sekvens i gang?
pump_state = {1: None, 2: None, 3: None, 4: None}  # retained farm/pump/<n>/state
emergency_marker = {"last_stop": 0.0}
latch_marker = {"last_log": 0.0}

settings = {
    "ec_enabled": EC_ENABLED,
    "ec_target": EC_TARGET,
    "ec_deadband": EC_DEADBAND,
    "ec_cooldown_minutes": EC_COOLDOWN_MINUTES,
    "ec_max_doses_per_day": EC_MAX_DOSES_PER_DAY,
    "ec_consecutive_readings": EC_CONSECUTIVE_READINGS,
    "growth_stage": GROWTH_STAGE,
    "dose_ml_grow": DOSE_ML_GROW,
}


def _sleep(secs):
    """Indpakket saa tests kan erstatte den med en no-op."""
    time.sleep(secs)


def flow_for(pump):
    return {
        2: ML_PER_SECOND_PUMP_2,
        3: ML_PER_SECOND_PUMP_3,
        4: ML_PER_SECOND_PUMP_4,
    }[pump]


def dose_plan(stage, dose_ml_grow):
    """De tre koersler i fast raekkefoelge (Micro, Grow, Bloom) med volumen (ml)
    og varighed (s). Micro og Bloom skaleres fra Grow-maengden ved stadiets
    forhold; varighed = ml / pumpens gennemstroemning."""
    r = STAGE_RATIOS.get(stage) or STAGE_RATIOS["growing"]
    ml_grow = float(dose_ml_grow)
    ml = {
        "grow": ml_grow,
        "micro": ml_grow * (r["micro"] / r["grow"]),
        "bloom": ml_grow * (r["bloom"] / r["grow"]),
    }
    plan = []
    for pump, name in DOSE_ORDER:
        volume = ml[name]
        plan.append({
            "pump": pump,
            "name": name,
            "ml": volume,
            "seconds": volume / flow_for(pump),
        })
    return plan


def plan_out_of_range(plan):
    """Returnér de trin, hvis varighed falder uden for 0.5-30 s."""
    return [s for s in plan if s["seconds"] < MIN_RUN_S or s["seconds"] > MAX_RUN_S]


# --- Indstillinger (relayes fra web-panelet via farm/ec/settings) ---

def valid_settings(raw):
    """Valider indkomne EC-indstillinger som databasens constraints. Returnerer
    et normaliseret dict, eller None hvis noget er ugyldigt."""
    try:
        en = raw["ec_enabled"]
        tgt = float(raw["ec_target"])
        db = float(raw["ec_deadband"])
        cm = int(raw["ec_cooldown_minutes"])
        md = int(raw["ec_max_doses_per_day"])
        cr = int(raw["ec_consecutive_readings"])
        stage = str(raw["growth_stage"])
        mlg = float(raw["dose_ml_grow"])
    except (KeyError, TypeError, ValueError):
        return None
    if isinstance(en, str):
        en = en.strip().lower() in ("1", "true", "yes", "on", "ja")
    en = bool(en)
    if not (0 < tgt <= 5.0):
        return None
    if not (0 <= db <= 1.0):
        return None
    if cm < 5:
        return None
    if not (1 <= md <= 100):
        return None
    if not (1 <= cr <= 20):
        return None
    if stage not in STAGE_RATIOS:
        return None
    if not (0 < mlg <= 100):
        return None
    return {
        "ec_enabled": en,
        "ec_target": tgt,
        "ec_deadband": db,
        "ec_cooldown_minutes": cm,
        "ec_max_doses_per_day": md,
        "ec_consecutive_readings": cr,
        "growth_stage": stage,
        "dose_ml_grow": mlg,
    }


def apply_settings(raw, source):
    v = valid_settings(raw)
    if v is None:
        log.warning("ugyldige EC-indstillinger fra %s afvist, beholder nuvaerende: %r", source, raw)
        return
    if all(settings.get(k) == v[k] for k in v):
        return
    settings.update(v)
    save_state()
    log.info(
        "EC-indstillinger opdateret fra %s: enabled=%s, maal %.2f, doedbaand %.2f, "
        "nedkoeling %d min, maks %d/dag, %d i traek, stadie %s, grow %.2f ml",
        source, v["ec_enabled"], v["ec_target"], v["ec_deadband"],
        v["ec_cooldown_minutes"], v["ec_max_doses_per_day"],
        v["ec_consecutive_readings"], v["growth_stage"], v["dose_ml_grow"],
    )


def _local_date():
    return date.today().isoformat()


def _fmt_ts(ts):
    if not ts:
        return "aldrig"
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def load_state():
    """En genstart maa ikke nulstille nedkoelingen eller det daglige loft."""
    global last_dose_time, dose_count, dose_day
    dose_day = _local_date()
    try:
        with open(STATE_FILE) as f:
            data = json.load(f)
        last_dose_time = float(data.get("last_dose_time", 0.0))
        stored_day = data.get("dose_day")
        if stored_day == _local_date():
            dose_count = int(data.get("dose_count", 0))
            dose_day = stored_day
        else:
            dose_count = 0
        stored_settings = data.get("settings")
        if stored_settings:
            v = valid_settings(stored_settings)
            if v:
                settings.update(v)
                log.info("EC-indstillinger indlaest fra tilstandsfil")
        log.info("tilstand indlaest: sidste dosis %s, %d doser i dag", _fmt_ts(last_dose_time), dose_count)
    except FileNotFoundError:
        log.info("ingen tilstandsfil (%s) — starter forfra", STATE_FILE)
    except Exception as err:
        log.warning("kunne ikke laese tilstandsfil: %s — starter forfra", err)


def save_state():
    data = {
        "last_dose_time": last_dose_time,
        "dose_count": dose_count,
        "dose_day": dose_day,
        "settings": settings,
    }
    try:
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, STATE_FILE)
    except Exception as err:
        log.warning("kunne ikke gemme tilstand: %s", err)


def roll_day(now):
    global dose_day, dose_count
    today = _local_date()
    if today != dose_day:
        log.info("ny dag (%s) — dagens dosistaeller nulstillet (var %d)", today, dose_count)
        dose_day = today
        dose_count = 0
        save_state()


# --- Noedstop (EC-loft) og laas ---

def latch_exists():
    return os.path.exists(EC_EMERGENCY_LATCH_FILE)


def read_latch():
    try:
        with open(EC_EMERGENCY_LATCH_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except Exception:
        return {"at": None, "reason": None, "ec": None}


def write_latch(now, reason, ec=None):
    data = {"at": datetime.fromtimestamp(now).isoformat(timespec="seconds"), "reason": reason, "ec": ec}
    try:
        parent = os.path.dirname(EC_EMERGENCY_LATCH_FILE)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(EC_EMERGENCY_LATCH_FILE, "w") as f:
            json.dump(data, f)
    except Exception as err:
        log.error("kunne ikke skrive laasefil %s: %s", EC_EMERGENCY_LATCH_FILE, err)


def publish_stop():
    """Publicér en tom besked til STOP_TOPIC, saa noden stopper alle pumper."""
    try:
        client.publish(STOP_TOPIC, payload=b"", qos=1)
    except Exception as err:
        log.error("kunne ikke sende stop paa %s: %s", STOP_TOPIC, err)


def emergency_stop(value, now):
    """EC-loft. Ved EC over loftet: stop alle pumper, skriv laasefilen og log en
    ERROR. Laasefilen skrives ved foerste udloesning; stop-publiceringen gentages
    hoejst én gang pr. EMERGENCY_STOP_INTERVAL sekunder."""
    if not latch_exists():
        write_latch(now, "ec_ceiling", value)
    if now - emergency_marker["last_stop"] < EMERGENCY_STOP_INTERVAL:
        return
    emergency_marker["last_stop"] = now
    publish_stop()
    log.error(
        "NOEDSTOP: EC %.3f over loft %.2f — stop_all sendt, laasefil %s",
        value, EC_EMERGENCY_CEILING, EC_EMERGENCY_LATCH_FILE,
    )


def warn_latched(now):
    if now - latch_marker["last_log"] < LATCH_LOG_INTERVAL:
        return
    latch_marker["last_log"] = now
    log.warning(
        "noedstop-laas aktiv (%s findes) — EC-dosering blokeret, indtil filen slettes manuelt",
        EC_EMERGENCY_LATCH_FILE,
    )


# --- Dosering ---

def publish_pump_run(pump, seconds):
    try:
        client.publish(pump_run_topic(pump), f"{seconds:.3f}", qos=0)
    except Exception as err:
        log.error("kunne ikke sende koersel til pumpe %d: %s", pump, err)


def publish_dose_log(step):
    """Publicér en dosis-log, som ph_bridge.py relayer til /api/dose, saa dosen
    ses paa dashboardet med pumpenummer og goedningsnavn."""
    payload = {
        "kind": f"pump{step['pump']}-{step['name']}",
        "ml": round(step["ml"], 3),
        "seconds": round(step["seconds"], 3),
    }
    try:
        client.publish(DOSE_LOG_TOPIC, json.dumps(payload), qos=1)
    except Exception as err:
        log.warning("kunne ikke sende dosis-log: %s", err)


def run_dose_sequence(plan):
    """Koer de tre pumper i raekkefoelge med gap imellem. Foer HVER koersel:
    afbryd hvis laasen er sat, eller hvis en pumpe allerede koerer (ph_doser kan
    dosere pH-down samtidig). En delvis dosis er vaerre end ingen."""
    global dosing
    try:
        for i, step in enumerate(plan):
            if latch_exists():
                log.error("EC-dosis afbrudt: noedstop-laas sat under dosering — resterende koersler droppet")
                return
            on_pumps = sorted(n for n, st in pump_state.items() if st == "on")
            if on_pumps:
                log.error("EC-dosis afbrudt: pumpe(r) %s koerer allerede — resterende koersler droppet", on_pumps)
                return
            publish_pump_run(step["pump"], step["seconds"])
            publish_dose_log(step)
            log.info(
                "EC-dosis %d/3: pumpe %d (%s) %.2f ml / %.2f s",
                i + 1, step["pump"], step["name"], step["ml"], step["seconds"],
            )
            _sleep(step["seconds"])
            if i < len(plan) - 1:
                _sleep(PUMP_GAP_SECONDS)
    finally:
        dosing = False


def start_dose_sequence(plan):
    global dosing
    dosing = True
    threading.Thread(target=run_dose_sequence, args=(plan,), daemon=True).start()


def publish_status(dose_fired):
    """Status til farm/ec/status: aktuel EC, taeller, nedkoeling, doser i dag,
    daglig graense, valgt stadie, de tre volumener og varigheder, laasetilstand."""
    cooldown_seconds = settings["ec_cooldown_minutes"] * 60.0
    cooldown_left = max(0.0, cooldown_seconds - (time.time() - last_dose_time))
    latched = latch_exists()
    plan = dose_plan(settings["growth_stage"], settings["dose_ml_grow"])
    status = {
        "ec": round(last_ec, 3) if last_ec is not None else None,
        "consecutive": consecutive,
        "cooldown_min_left": round(cooldown_left / 60.0, 1),
        "doses_today": dose_count,
        "max_doses_per_day": settings["ec_max_doses_per_day"],
        "dose_fired": dose_fired,
        "enabled": settings["ec_enabled"],
        "stage": settings["growth_stage"],
        "volumes_ml": {s["name"]: round(s["ml"], 3) for s in plan},
        "durations_s": {s["name"]: round(s["seconds"], 3) for s in plan},
        "settings": dict(settings),
        "emergency_ceiling": EC_EMERGENCY_CEILING,
        "latched": latched,
        "latch": read_latch() if latched else None,
    }
    try:
        client.publish(STATUS_TOPIC, json.dumps(status), qos=0, retain=True)
    except Exception as err:
        log.warning("kunne ikke sende status: %s", err)


def on_ec(value):
    """Traef en doseringsbeslutning ud fra en ny EC-maaling."""
    global consecutive, last_ec, last_ec_time, last_dose_time, dose_count

    now = time.time()
    last_ec = value
    last_ec_time = now
    roll_day(now)

    # Sikkerhed: EC-loft (noedstop). Bevidst FOER sanitet, saa en reel, farligt
    # hoej EC ikke fejlagtigt afvises.
    if value > EC_EMERGENCY_CEILING:
        emergency_stop(value, now)

    latched = latch_exists()
    if latched:
        warn_latched(now)

    enabled = settings["ec_enabled"]
    target = settings["ec_target"]
    deadband = settings["ec_deadband"]
    trigger = target - deadband
    cooldown_seconds = settings["ec_cooldown_minutes"] * 60.0
    max_doses = settings["ec_max_doses_per_day"]
    consecutive_needed = settings["ec_consecutive_readings"]
    stage = settings["growth_stage"]
    dose_ml_grow = settings["dose_ml_grow"]

    # Sanitetsgulv: ignorér probe-fejl (fx sonde ude af vand), saa vi ikke
    # doserer paa en falsk lav aflaesning.
    if value < EC_FLOOR:
        log.warning("ADVARSEL: EC %.3f under gulv %.2f — ignorerer (probe ude af vand?)", value, EC_FLOOR)
        publish_status(dose_fired=False)
        return

    # Traek-taeller med hysterese: taeller op under (maal - doedbaand), nulstil
    # naar EC naar maalet igen.
    if value < trigger:
        consecutive += 1
    elif value >= target:
        if consecutive != 0:
            log.info("EC %.3f paa/over maal %.2f — taeller nulstillet", value, target)
            consecutive = 0
    # Mellem trigger og maal: hold taelleren.

    if value >= trigger:
        publish_status(dose_fired=False)
        return

    # value < trigger: traef beslutning.
    age = now - last_ec_time
    cooldown_left = max(0.0, cooldown_seconds - (now - last_dose_time))
    dose_fired = False

    if latched:
        reason = "noedstop-laas aktiv — doserer ikke"
    elif dosing:
        reason = "dosering i gang — springer over"
    elif not enabled:
        reason = "EC-dosering deaktiveret (ec_enabled=false)"
    elif age > EC_STALE_SECONDS:
        reason = f"data foraeldet ({age:.0f}s > {EC_STALE_SECONDS:.0f}s)"
    elif consecutive < consecutive_needed:
        reason = f"afventer flere maalinger ({consecutive}/{consecutive_needed})"
    elif cooldown_left > 0:
        reason = f"nedkoeling {cooldown_left / 60:.0f} min tilbage"
    elif dose_count >= max_doses:
        reason = f"daglig graense naaet ({dose_count}/{max_doses})"
    else:
        plan = dose_plan(stage, dose_ml_grow)
        bad = plan_out_of_range(plan)
        if bad:
            for s in bad:
                log.error(
                    "EC-dosis sprunget over: pumpe %d (%s) varighed %.2f s uden for %.1f-%.1f s",
                    s["pump"], s["name"], s["seconds"], MIN_RUN_S, MAX_RUN_S,
                )
            # En delvis dosis aendrer forholdet — spring HELE dosen over.
            reason = "ugyldig varighed — hele dosen sprunget over"
        else:
            last_dose_time = now
            dose_count += 1
            save_state()
            dose_fired = True
            reason = "dosering udloest"
            log.info(
                "EC-DOSERING udloest (%s): Micro %.2f ml, Grow %.2f ml, Bloom %.2f ml (%d/%d i dag)",
                stage, plan[0]["ml"], plan[1]["ml"], plan[2]["ml"], dose_count, max_doses,
            )
            start_dose_sequence(plan)

    log.info(
        "EC %.3f under %.2f (taeller %d/%d) — %s",
        value, trigger, consecutive, consecutive_needed, reason,
    )
    publish_status(dose_fired=dose_fired)


def on_connect(client, userdata, flags, reason_code, properties=None):
    if reason_code != 0:
        log.warning("forbindelse afvist: %s", reason_code)
        return
    log.info("forbundet til broker %s:%s", MQTT_HOST, MQTT_PORT)
    client.subscribe(EC_TOPIC)
    client.subscribe(SETTINGS_TOPIC)
    client.subscribe(PUMP_STATE_WILDCARD)


def on_disconnect(client, userdata, flags, reason_code, properties=None):
    log.warning("forbindelse tabt (%s) — genopretter", reason_code)


def on_message(client, userdata, msg):
    """Wrappet saa en fejlbehaeftet payload logges og springes over, aldrig crasher."""
    try:
        if msg.topic == EC_TOPIC:
            on_ec(float(msg.payload.decode()))
        elif msg.topic == SETTINGS_TOPIC:
            apply_settings(json.loads(msg.payload.decode()), "MQTT")
        elif msg.topic.startswith("farm/pump/") and msg.topic.endswith("/state"):
            n = int(msg.topic.split("/")[2])
            if n in pump_state:
                pump_state[n] = msg.payload.decode().strip().lower()
    except (ValueError, UnicodeDecodeError):
        log.warning("ugyldig payload paa %s: %r", msg.topic, msg.payload[:50])
    except Exception as err:
        log.warning("uventet fejl i on_message: %s", err)


def main():
    global client

    load_state()
    log.info(
        "EC-doser starter: enabled=%s, maal %.2f, doedbaand %.2f, nedkoeling %g min, "
        "maks %d/dag, %d maalinger i traek, stadie %s, grow %.2f ml",
        settings["ec_enabled"], settings["ec_target"], settings["ec_deadband"],
        settings["ec_cooldown_minutes"], settings["ec_max_doses_per_day"],
        settings["ec_consecutive_readings"], settings["growth_stage"], settings["dose_ml_grow"],
    )
    log.info(
        "EC-loft %.2f, laasefil %s, pumpe-gap %g s",
        EC_EMERGENCY_CEILING, EC_EMERGENCY_LATCH_FILE, PUMP_GAP_SECONDS,
    )
    if latch_exists():
        log.warning(
            "noedstop-laas allerede aktiv ved opstart (%s) — EC-dosering blokeret",
            EC_EMERGENCY_LATCH_FILE,
        )

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    if MQTT_USER:
        client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=30)

    while True:
        try:
            client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
            client.loop_forever()
        except Exception as err:
            log.warning("forbindelsesfejl: %s — proever igen om 10 s", err)
            time.sleep(10)


if __name__ == "__main__":
    main()
