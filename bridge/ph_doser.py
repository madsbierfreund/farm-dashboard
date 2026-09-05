#!/usr/bin/env python3
"""pH-doser til hydroponik.

Koerer paa samme Raspberry Pi som ph_bridge.py og taler KUN med den lokale
MQTT-broker. Ingen internetadgang: mistet net maa aldrig stoppe styringen
eller efterlade den midt i en dosering. En dosering publicerer varigheden i
sekunder til DOSE_TOPIC (farm/pump/1/run), hvorpaa ESPHome-noden koerer pumpe 1
(pH-down). Homey-flowsene er ikke laengere en del af doseringsvejen.
"""

import json
import logging
import os
import time
from datetime import date, datetime

import paho.mqtt.client as mqtt

# --- Faste emner ---
PH_TOPIC = "farm/ph_node/sensor/ph/state"
TEMP_TOPIC = "farm/ph_node/sensor/water_temperature/state"
STATUS_TOPIC = "farm/dose/status"
SETTINGS_TOPIC = "farm/dose/settings"
# Noedstop: en besked her faar noden til at stoppe ALLE pumper med det samme.
STOP_TOPIC = "farm/pump/stop_all"
# Noden publicerer pumpe 1's (pH-down) faktiske tilstand ("on"/"off") her.
STATE_TOPIC = "farm/pump/1/state"


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

# En dosis er nu en kørsel af pumpe 1 (pH-down) via noden: publicér varigheden
# i sekunder til DOSE_TOPIC. DOSE_SECONDS er varigheden pr. dosis.
DOSE_TOPIC = env_str("DOSE_TOPIC", "farm/pump/1/run")
DOSE_SECONDS = env_float("DOSE_SECONDS", 5.0)
ENABLED = env_bool("ENABLED", True)
DOSE_ABOVE = env_float("DOSE_ABOVE", 6.3)
TARGET_PH = env_float("TARGET_PH", 6.1)
COOLDOWN_MINUTES = env_float("COOLDOWN_MINUTES", 30)
MAX_DOSES_PER_DAY = env_int("MAX_DOSES_PER_DAY", 8)
CONSECUTIVE_READINGS = env_int("CONSECUTIVE_READINGS", 3)
STALE_SECONDS = env_float("STALE_SECONDS", 120)
SANITY_MIN = env_float("SANITY_MIN", 4.0)
SANITY_MAX = env_float("SANITY_MAX", 9.0)
STATE_FILE = os.path.expanduser(env_str("STATE_FILE", "~/.ph_doser_state.json"))

# --- Noedstop / laas (to uafhaengige sikkerhedsforanstaltninger) ---
# Falder pH under gulvet, stoppes pumpen og en laasefil skrives. Mens laasefilen
# findes, doseres der aldrig. Laasen ryddes kun ved at slette filen manuelt.
PH_EMERGENCY_FLOOR = env_float("PH_EMERGENCY_FLOOR", 5.0)
PH_EMERGENCY_LATCH_FILE = os.path.expanduser(
    env_str("PH_EMERGENCY_LATCH_FILE", "/var/lib/ph-doser/emergency.lock")
)
EMERGENCY_STOP_INTERVAL = 10.0  # sekunder mellem gentagne noedstop-publiceringer
LATCH_LOG_INTERVAL = 60.0       # sekunder mellem gentagne laase-advarsler

# --- Tilstands-watchdog: fanger UAUTORISEREDE taend af pumpen ---
# Noden publicerer pumpe 1's faktiske tilstand til STATE_TOPIC. Et "on", der
# ikke falder taet paa vores egen doseringskommando, stoppes straks —
# uafhaengigt af pH.
DOSE_WINDOW_S = env_float("DOSE_WINDOW_S", 8.0)                 # "on" inden for dette efter en dosis er vores
UNAUTHORIZED_MAX_STOPS = env_int("UNAUTHORIZED_MAX_STOPS", 10)  # laas efter saa mange forgaeves stop i traek
STATE_STALE_S = env_float("STATE_STALE_S", 900)                 # ingen tilstand i saa lang tid → blind
WATCHDOG_STOP_INTERVAL = 1.0                                    # hoejst ét watchdog-stop pr. sekund

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ph_doser")

# --- Foranderlig tilstand (koerer i én traad: paho's netvaerks-loop) ---
client = None
last_ph = None
last_ph_time = 0.0
last_temp = None
consecutive = 0          # antal maalinger over dose_above i traek
last_dose_time = 0.0     # epoch for seneste dosering (bevares over genstart)
dose_count = 0           # doser siden lokal midnat
dose_day = ""            # den lokale dato dose_count gaelder for
# Rate-limit markoerer for de to sikkerhedsforanstaltninger.
emergency_marker = {"last_stop": 0.0}  # sidste noedstop-publicering (epoch)
latch_marker = {"last_log": 0.0}       # sidste laase-advarsel (epoch)

# --- Tilstands-watchdog ---
last_dose_command = 0.0   # epoch for seneste publish til DOSE_TOPIC (ikke persisteret)
switch_state = None       # sidst kendte kontakt-tilstand ("on"/"off")
switch_state_time = 0.0   # epoch for sidste tilstandsbesked
watchdog_started = 0.0    # epoch for opstart (basislinje for staleness)
unauthorized_stops = 0    # forgaeves stop i traek uden et "off"
watchdog_marker = {"last_stop": 0.0}     # rate-limit for watchdog-stop (epoch)
state_stale_marker = {"last_warn": 0.0}  # rate-limit for blind-advarsel (epoch)

# De aktive indstillinger. Env-vaerdierne er kun fallback ved opstart, foer en
# retained MQTT-besked ankommer (og hvis en modtaget besked er ugyldig). Den
# sidst modtagne, gyldige udgave gemmes i tilstandsfilen, saa en genstart med
# doed broker koerer videre paa de sidst kendte gode vaerdier.
settings = {
    "enabled": ENABLED,
    "dose_above": DOSE_ABOVE,
    "target_ph": TARGET_PH,
    "cooldown_minutes": COOLDOWN_MINUTES,
    "max_doses_per_day": MAX_DOSES_PER_DAY,
    "consecutive_readings": CONSECUTIVE_READINGS,
}


def valid_settings(raw):
    """Valider indkomne indstillinger som databasens constraints. Returnerer et
    normaliseret dict, eller None hvis noget er ugyldigt (fx dose_above <=
    target_ph eller nedkoeling under 5 min)."""
    try:
        da = float(raw["dose_above"])
        tp = float(raw["target_ph"])
        cm = int(raw["cooldown_minutes"])
        md = int(raw["max_doses_per_day"])
        cr = int(raw["consecutive_readings"])
        en = raw["enabled"]
    except (KeyError, TypeError, ValueError):
        return None
    if isinstance(en, str):
        en = en.strip().lower() in ("1", "true", "yes", "on", "ja")
    en = bool(en)
    if not (da > tp):
        return None
    if cm < 5:
        return None
    if tp < 4.0 or da > 9.0:
        return None
    if not (1 <= md <= 100):
        return None
    if not (1 <= cr <= 20):
        return None
    return {
        "enabled": en,
        "dose_above": da,
        "target_ph": tp,
        "cooldown_minutes": cm,
        "max_doses_per_day": md,
        "consecutive_readings": cr,
    }


def apply_settings(raw, source):
    """Erstat de aktive indstillinger, hvis de modtagne er gyldige. Ugyldige
    afvises og logges, og de forrige vaerdier beholdes."""
    v = valid_settings(raw)
    if v is None:
        log.warning("ugyldige indstillinger fra %s afvist, beholder nuvaerende: %r", source, raw)
        return
    if all(settings.get(k) == v[k] for k in v):
        return  # uaendret — undgaa at fylde journalen
    settings.update(v)
    save_state()
    log.info(
        "indstillinger opdateret fra %s: enabled=%s, doser over %.2f, maal %.2f, "
        "nedkoeling %d min, maks %d/dag, %d i traek",
        source, v["enabled"], v["dose_above"], v["target_ph"],
        v["cooldown_minutes"], v["max_doses_per_day"], v["consecutive_readings"],
    )


def _local_date():
    return date.today().isoformat()


def _fmt_ts(ts):
    if not ts:
        return "aldrig"
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def load_state():
    """Indlaes seneste dosistidspunkt og dagens taeller.

    En genstart maa ikke nulstille nedkoelingen eller det daglige loft —
    ellers bliver en crash-loop til en doserings-loop.
    """
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
            dose_count = 0  # ny dag siden sidst — men bevar nedkoelingen
        stored_settings = data.get("settings")
        if stored_settings:
            v = valid_settings(stored_settings)
            if v:
                settings.update(v)
                log.info("indstillinger indlaest fra tilstandsfil")
        log.info(
            "tilstand indlaest: sidste dosis %s, %d doser i dag",
            _fmt_ts(last_dose_time),
            dose_count,
        )
    except FileNotFoundError:
        log.info("ingen tilstandsfil (%s) — starter forfra", STATE_FILE)
    except Exception as err:
        log.warning("kunne ikke laese tilstandsfil: %s — starter forfra", err)


def save_state():
    """Skriv tilstanden atomisk, saa en afbrudt skrivning ikke korrumperer den."""
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
    """Nulstil dagens dosistaeller ved lokal midnat (nedkoelingen roeres ikke)."""
    global dose_day, dose_count
    today = _local_date()
    if today != dose_day:
        log.info("ny dag (%s) — dagens dosistaeller nulstillet (var %d)", today, dose_count)
        dose_day = today
        dose_count = 0
        save_state()


# === Sikkerhed 1: pH-gulv (noedstop) og Sikkerhed 2: laas ===

def latch_exists():
    return os.path.exists(PH_EMERGENCY_LATCH_FILE)


def read_latch():
    """Laeser laasefilens indhold (tidsstempel + pH) til status. None hvis ingen."""
    try:
        with open(PH_EMERGENCY_LATCH_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except Exception:
        # Filen findes, men kunne ikke laeses/parses — meld stadig som laast.
        return {"at": None, "reason": None, "ph": None}


def write_latch(now, reason, ph=None):
    """Skriver laasefilen med et ISO-tidsstempel, en aarsag og evt. pH-vaerdi."""
    data = {
        "at": datetime.fromtimestamp(now).isoformat(timespec="seconds"),
        "reason": reason,
        "ph": ph,
    }
    try:
        parent = os.path.dirname(PH_EMERGENCY_LATCH_FILE)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(PH_EMERGENCY_LATCH_FILE, "w") as f:
            json.dump(data, f)
    except Exception as err:
        log.error("kunne ikke skrive laasefil %s: %s", PH_EMERGENCY_LATCH_FILE, err)


def publish_stop():
    """Publicér en tom besked til STOP_TOPIC, saa noden stopper alle pumper."""
    try:
        client.publish(STOP_TOPIC, payload=b"", qos=1)
    except Exception as err:
        log.error("kunne ikke sende stop paa %s: %s", STOP_TOPIC, err)


def emergency_stop(value, now):
    """Sikkerhed 1 — pH-gulv. Ved pH under gulvet: stop pumpen (tom besked til
    STOP_TOPIC), skriv laasefilen og log en ERROR. Laasefilen skrives ved
    foerste udloesning (bevarer det foerste tidspunkt); selve stop-publiceringen
    gentages hoejst én gang pr. EMERGENCY_STOP_INTERVAL sekunder."""
    if not latch_exists():
        write_latch(now, "ph_floor", value)
    if now - emergency_marker["last_stop"] < EMERGENCY_STOP_INTERVAL:
        return
    emergency_marker["last_stop"] = now
    publish_stop()
    log.error(
        "NOEDSTOP: pH %.2f under gulv %.2f — stop sendt, laasefil %s",
        value, PH_EMERGENCY_FLOOR, PH_EMERGENCY_LATCH_FILE,
    )


def warn_latched(now):
    """Sikkerhed 2 — laas. Logger, at doseringen er blokeret, hoejst én gang pr.
    LATCH_LOG_INTERVAL sekunder."""
    if now - latch_marker["last_log"] < LATCH_LOG_INTERVAL:
        return
    latch_marker["last_log"] = now
    log.warning(
        "noedstop-laas aktiv (%s findes) — dosering blokeret, indtil filen slettes manuelt",
        PH_EMERGENCY_LATCH_FILE,
    )


# === Tilstands-watchdog (uafhaengig af pH) ===

def _iso(ts):
    return datetime.fromtimestamp(ts).isoformat(timespec="seconds") if ts > 0 else None


def _watchdog_baseline():
    """Referencepunkt for staleness: sidste tilstandsbesked, ellers opstart."""
    if switch_state_time > 0:
        return switch_state_time
    if watchdog_started > 0:
        return watchdog_started
    return None


def watchdog_stale(now):
    base = _watchdog_baseline()
    return base is not None and (now - base) > STATE_STALE_S


def check_state_stale(now):
    """Advarer (rate-limitet) hvis der ikke er set en kontakt-tilstand laenge.
    Laaser ALDRIG paa staleness alene — vi ved bare ikke, hvad kontakten laver."""
    if not watchdog_stale(now):
        return
    if now - state_stale_marker["last_warn"] < STATE_STALE_S:
        return
    state_stale_marker["last_warn"] = now
    log.warning(
        "watchdog blind: ingen kontakt-tilstand paa %s i %.0fs (>%.0fs)",
        STATE_TOPIC, now - _watchdog_baseline(), STATE_STALE_S,
    )


def _handle_switch_on(now):
    """Behandl et "on": afgoer om vi selv udloeste det, og stop det ellers."""
    global unauthorized_stops

    since = now - last_dose_command
    if last_dose_command > 0 and since <= DOSE_WINDOW_S:
        return  # inden for doseringsvinduet — vores egen dosis, goer intet

    # Uautoriseret taend. Stop straks, men hoejst ét stop pr. sekund.
    if now - watchdog_marker["last_stop"] < WATCHDOG_STOP_INTERVAL:
        return
    watchdog_marker["last_stop"] = now
    publish_stop()
    unauthorized_stops += 1
    since_txt = (
        f"{since:.1f}s efter sidste kommanderede dosis"
        if last_dose_command > 0
        else "ingen kommanderet dosis i denne session"
    )
    log.error(
        "UAUTORISERET taend paa %s: kontakt ON, %s — stop sendt (forsoeg %d/%d)",
        STATE_TOPIC, since_txt, unauthorized_stops, UNAUTHORIZED_MAX_STOPS,
    )
    if unauthorized_stops == UNAUTHORIZED_MAX_STOPS:
        if not latch_exists():
            write_latch(now, "switch_unresponsive", last_ph)
        log.critical(
            "kontakt reagerer IKKE paa stop efter %d forsoeg — noedstop-laas sat; "
            "fortsaetter med at sende stop", unauthorized_stops,
        )


def on_state(payload, now):
    """Behandl en pumpe-tilstandsbesked ("on"/"off") fra noden.

    Et UAUTORISERET "on" (ikke taet paa vores egen doseringskommando) stoppes
    straks — uafhaengigt af pH og af noedstop-laasen."""
    global switch_state, switch_state_time, unauthorized_stops

    state = payload.strip().lower()
    switch_state = state
    switch_state_time = now

    if state == "off":
        if unauthorized_stops:
            log.info("kontakt slukket — nulstiller taeller for forgaeves stop (var %d)", unauthorized_stops)
        unauthorized_stops = 0
    elif state == "on":
        _handle_switch_on(now)
    else:
        log.warning("ukendt kontakt-tilstand paa %s: %r", STATE_TOPIC, payload[:50])

    publish_status(dose_fired=False)


def publish_status(dose_fired):
    """Send en samlet status til farm/dose/status efter hver beslutning.

    Statusbeskeden inkluderer de aktive indstillinger og laasetilstanden, saa
    det altid er synligt, hvad doseren faktisk koerer med."""
    cooldown_seconds = settings["cooldown_minutes"] * 60.0
    cooldown_left = max(0.0, cooldown_seconds - (time.time() - last_dose_time))
    latched = latch_exists()
    status = {
        "ph": round(last_ph, 3) if last_ph is not None else None,
        "water_temperature": round(last_temp, 2) if last_temp is not None else None,
        "consecutive": consecutive,
        "cooldown_min_left": round(cooldown_left / 60.0, 1),
        "doses_today": dose_count,
        "max_doses_per_day": settings["max_doses_per_day"],
        "dose_fired": dose_fired,
        "enabled": settings["enabled"],
        "settings": dict(settings),
        "emergency_floor": PH_EMERGENCY_FLOOR,
        "latched": latched,
        "latch": read_latch() if latched else None,
        "switch_state": switch_state,
        "switch_state_at": _iso(switch_state_time),
        "watchdog_stale": watchdog_stale(time.time()),
        "unauthorized_stops": unauthorized_stops,
    }
    try:
        client.publish(STATUS_TOPIC, json.dumps(status), qos=0, retain=True)
    except Exception as err:
        log.warning("kunne ikke sende status: %s", err)


def fire_dose(now):
    """Udloes en dosering: publicér varigheden (sekunder) til DOSE_TOPIC, saa
    noden koerer pumpe 1 (pH-down) i DOSE_SECONDS.

    Taeller kun doseringen, hvis publiceringen faktisk lykkedes, saa en
    fejlet besked hverken blokerer eller springer en reel dosering over.
    """
    global last_dose_time, dose_count, last_dose_command
    try:
        info = client.publish(DOSE_TOPIC, f"{DOSE_SECONDS:g}", qos=0)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            log.warning("kunne ikke sende dosering (rc=%s) — proever igen", info.rc)
            return False
    except Exception as err:
        log.warning("fejl ved doseringsbesked: %s — proever igen", err)
        return False

    # Registrér tidspunktet for kommandoen, saa watchdog'en ved, at det "on",
    # der straks foelger, er vores eget.
    last_dose_command = now
    last_dose_time = now
    dose_count += 1
    save_state()
    log.info(
        "DOSERING udloest: pumpe 1 koerer %.1fs (%d/%d i dag)",
        DOSE_SECONDS, dose_count, settings["max_doses_per_day"],
    )
    return True


def on_ph(value):
    """Traef en doseringsbeslutning ud fra en ny pH-maaling."""
    global consecutive, last_ph, last_ph_time

    now = time.time()
    last_ph = value
    last_ph_time = now
    roll_day(now)

    # Watchdog: advar (men laas aldrig) hvis vi ikke har hoert kontaktens
    # tilstand laenge. Koeres her, fordi pH-maalinger kommer regelmaessigt.
    check_state_stale(now)

    # === SIKKERHEDSFORANSTALTNINGER ===
    # Disse koerer paa HVER maaling, foer enhver doseringsbeslutning, og kan
    # ikke springes over af en early-return laengere nede.
    #
    # Sikkerhed 1 — pH-gulv. Bevidst UDEN for sanitetstjekket: en reel, farligt
    # lav pH (som pumpen der koerte til 1,79) ligger ogsaa under SANITY_MIN og
    # ville ellers blive fejlfortolket som "probe ude af vand" og ignoreret.
    if value < PH_EMERGENCY_FLOOR:
        emergency_stop(value, now)

    # Sikkerhed 2 — laas. Mens laasefilen findes, doseres der ALDRIG, uanset pH.
    latched = latch_exists()
    if latched:
        warn_latched(now)

    # Aktive indstillinger (kan aendres i drift via farm/dose/settings).
    enabled = settings["enabled"]
    dose_above = settings["dose_above"]
    target_ph = settings["target_ph"]
    max_doses = settings["max_doses_per_day"]
    consecutive_needed = settings["consecutive_readings"]
    cooldown_seconds = settings["cooldown_minutes"] * 60.0

    # --- Sanitetstjek foerst: en probe ude af vandet eller et defekt kabel
    #     giver vilde vaerdier og maa ALDRIG udloese en dosering. ---
    if value < SANITY_MIN or value > SANITY_MAX:
        log.warning(
            "ADVARSEL: pH %.2f uden for interval %.1f-%.1f — ignorerer (probe ude af vand?)",
            value, SANITY_MIN, SANITY_MAX,
        )
        publish_status(dose_fired=False)
        return

    # --- Opdatér traek-taelleren (hysterese mellem target_ph og dose_above) ---
    if value > dose_above:
        consecutive += 1
    elif value <= target_ph:
        # Enhver maaling paa eller under maalet nulstiller taelleren.
        if consecutive != 0:
            log.info("pH %.2f paa/under maal %.1f — taeller nulstillet", value, target_ph)
            consecutive = 0
    # Mellem target_ph og dose_above: hold taelleren (hysterese, ingen aendring).

    if value <= dose_above:
        # Ikke over dose-taersklen: ingen dosering mulig, og vi logger ikke
        # hver normal maaling for at holde journalen laesbar.
        publish_status(dose_fired=False)
        return

    # Her er value > dose_above. Denne maaling logges altid, og vi traeffer
    # en beslutning i den raekkefoelge betingelserne er beskrevet.
    age = now - last_ph_time
    cooldown_left = max(0.0, cooldown_seconds - (now - last_dose_time))
    dose_fired = False

    if latched:
        # Noedstop-laasen blokerer al dosering (advarsel logget ovenfor).
        reason = "noedstop-laas aktiv — doserer ikke"
    elif not enabled:
        reason = "dosering deaktiveret (enabled=false)"
    elif age > STALE_SECONDS:
        reason = f"data foraeldet ({age:.0f}s > {STALE_SECONDS:.0f}s)"
    elif consecutive < consecutive_needed:
        reason = f"afventer flere maalinger ({consecutive}/{consecutive_needed})"
    elif cooldown_left > 0:
        # NEDKOELING er den vigtigste regel i filen: syren skal naa at blande
        # sig, foer den naeste maaling overhovedet betyder noget. Uden denne
        # ventetid vil styringen overdosere kraftigt og skyde langt forbi maalet.
        reason = f"nedkoeling {cooldown_left / 60:.0f} min tilbage"
    elif dose_count >= max_doses:
        reason = f"daglig graense naaet ({dose_count}/{max_doses})"
    else:
        dose_fired = fire_dose(now)
        reason = "dosering udloest" if dose_fired else "publicering fejlede, proever igen"

    log.info(
        "pH %.2f over %.1f (taeller %d/%d) — %s",
        value, dose_above, consecutive, consecutive_needed, reason,
    )
    publish_status(dose_fired=dose_fired)


def on_connect(client, userdata, flags, reason_code, properties=None):
    if reason_code != 0:
        log.warning("forbindelse afvist: %s", reason_code)
        return
    log.info("forbundet til broker %s:%s", MQTT_HOST, MQTT_PORT)
    client.subscribe(PH_TOPIC)
    client.subscribe(TEMP_TOPIC)
    client.subscribe(SETTINGS_TOPIC)
    client.subscribe(STATE_TOPIC)


def on_disconnect(client, userdata, flags, reason_code, properties=None):
    # loop_forever genopretter forbindelsen automatisk; her logger vi blot.
    log.warning("forbindelse tabt (%s) — genopretter", reason_code)


def on_message(client, userdata, msg):
    """Wrappet saa en fejlbehaeftet payload logges og springes over, aldrig crasher."""
    global last_temp
    try:
        if msg.topic == PH_TOPIC:
            on_ph(float(msg.payload.decode()))
        elif msg.topic == TEMP_TOPIC:
            last_temp = float(msg.payload.decode())
        elif msg.topic == SETTINGS_TOPIC:
            # Malformet JSON fanges nedenfor; da beholdes de nuvaerende vaerdier.
            apply_settings(json.loads(msg.payload.decode()), "MQTT")
        elif msg.topic == STATE_TOPIC:
            on_state(msg.payload.decode(), time.time())
    except (ValueError, UnicodeDecodeError):
        log.warning("ugyldig payload paa %s: %r", msg.topic, msg.payload[:50])
    except Exception as err:
        log.warning("uventet fejl i on_message: %s", err)


def main():
    global client, watchdog_started

    watchdog_started = time.time()
    load_state()
    log.info(
        "pH-doser starter: enabled=%s, doser over %.2f, maal %.2f, "
        "nedkoeling %g min, maks %d/dag, %d maalinger i traek "
        "(env er fallback; web-panelet er den normale maade at aendre dem)",
        settings["enabled"], settings["dose_above"], settings["target_ph"],
        settings["cooldown_minutes"], settings["max_doses_per_day"],
        settings["consecutive_readings"],
    )
    if settings["target_ph"] > settings["dose_above"]:
        log.warning(
            "ADVARSEL: target_ph (%.2f) er hoejere end dose_above (%.2f) — "
            "tjek konfigurationen", settings["target_ph"], settings["dose_above"],
        )
    log.info("noedstop-gulv pH %.2f, laasefil %s", PH_EMERGENCY_FLOOR, PH_EMERGENCY_LATCH_FILE)
    log.info(
        "watchdog: dosisvindue %.1fs, laas efter %d forgaeves stop, blind efter %.0fs",
        DOSE_WINDOW_S, UNAUTHORIZED_MAX_STOPS, STATE_STALE_S,
    )
    if latch_exists():
        log.warning(
            "noedstop-laas allerede aktiv ved opstart (%s) — dosering blokeret, "
            "indtil filen slettes manuelt", PH_EMERGENCY_LATCH_FILE,
        )

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    if MQTT_USER:
        client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=30)

    # Yderste loekke: taaler at broker er nede ved opstart eller genstarter.
    while True:
        try:
            client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
            client.loop_forever()  # blokerer og genopretter selv forbindelsen
        except Exception as err:
            log.warning("forbindelsesfejl: %s — proever igen om 10 s", err)
            time.sleep(10)


if __name__ == "__main__":
    main()
