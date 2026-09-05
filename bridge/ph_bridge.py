#!/usr/bin/env python3
"""Lytter paa mosquitto og sender maalinger til Vercel-endpointet."""

import json
import os
import statistics
import threading
import time
import urllib.error
import urllib.request

import paho.mqtt.client as mqtt

BROKER = os.environ.get("MQTT_HOST", "localhost")
PORT = int(os.environ.get("MQTT_PORT", "1883"))
USER = os.environ["MQTT_USER"]
PASSWORD = os.environ["MQTT_PASSWORD"]
INGEST_URL = os.environ["INGEST_URL"]
INGEST_TOKEN = os.environ["INGEST_TOKEN"]
INTERVAL = int(os.environ.get("INTERVAL_SECONDS", "300"))

# Live-visning: hurtige, ikke-loggede opdateringer til dashboardet.
LIVE_URL = os.environ.get("LIVE_URL")
LIVE_INTERVAL = int(os.environ.get("LIVE_INTERVAL_SECONDS", "15"))

# Doseringslog: en dosis er nu en koersel af pumpe 1 (pH-down) via noden. Vi
# lytter paa koerselskommandoen (farm/pump/1/run), laeser varigheden i sekunder
# og udleder volumenet fra den (ml = sekunder * ML_PER_SECOND) i stedet for en
# fast 2 ml pr. dosis. Saadan bliver reservoir-sporingen ved med at virke.
DOSE_URL = os.environ.get("DOSE_URL")
ML_PER_SECOND = float(os.environ.get("ML_PER_SECOND", "0.4"))
DOSE_TOPIC = "farm/pump/1/run"

# Indstillinger fra web-panelet relayes til doseren via MQTT (retained), saa
# doseren aldrig afhaenger af internettet ved runtime.
SETTINGS_URL = os.environ.get("SETTINGS_URL")
SETTINGS_POLL = int(os.environ.get("SETTINGS_POLL_SECONDS", "60"))
SETTINGS_TOPIC = "farm/dose/settings"
# Kun vaerdifelterne relayes (ikke updated_at), saa vi kun publicerer, naar de
# faktiske vaerdier aendrede sig — ikke ved hvert gem med samme vaerdier.
SETTINGS_FIELDS = (
    "enabled",
    "dose_above",
    "target_ph",
    "cooldown_minutes",
    "max_doses_per_day",
    "consecutive_readings",
)

TOPICS = {
    "farm/ph_node/sensor/ph/state": "ph",
    "farm/ph_node/sensor/ph_voltage/state": "ph_voltage",
    "farm/ph_node/sensor/water_temperature/state": "water_temperature",
    "farm/ph_node/sensor/ec/state": "ec",
}

client = None  # saettes i main(); bruges af settings_poll_loop til at publicere.

lock = threading.Lock()
buffer = {"ph": [], "ph_voltage": [], "water_temperature": [], "ec": []}
# Seneste kendte vaerdi pr. felt til live-visningen (ikke median).
latest = {"ph": None, "ph_voltage": None, "water_temperature": None, "ec": None}
# Monotont tidsstempel for sidste live-POST, saa vi kan begraense frekvensen.
live_marker = {"last": 0.0}


def on_connect(client, userdata, flags, reason_code, properties=None):
    if reason_code != 0:
        print(f"forbindelse afvist: {reason_code}", flush=True)
        return
    print("forbundet til broker", flush=True)
    for topic in TOPICS:
        client.subscribe(topic)
    client.subscribe(DOSE_TOPIC)


def on_message(client, userdata, msg):
    if msg.topic == DOSE_TOPIC:
        try:
            seconds = float(msg.payload.decode())
        except ValueError:
            return  # ikke-numerisk varighed — ignorér
        maybe_send_dose(seconds)
        return
    field = TOPICS.get(msg.topic)
    if field is None:
        return
    try:
        value = float(msg.payload.decode())
    except ValueError:
        return
    with lock:
        buffer[field].append(value)
        latest[field] = value
    if field == "ph":
        maybe_send_live()


def send(payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        INGEST_URL,
        data=data,
        headers={
            "content-type": "application/json",
            "x-ingest-token": INGEST_TOKEN,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            print(f"sendt {payload} -> {resp.status}", flush=True)
    except urllib.error.HTTPError as err:
        print(f"http-fejl {err.code}: {err.read().decode()[:200]}", flush=True)
    except Exception as err:
        print(f"netvaerksfejl: {err}", flush=True)


def live_send(snapshot):
    """POSTer de seneste vaerdier til live-endpointet. Kaldes paa en worker-traad."""
    if snapshot["ph"] is None:
        return
    payload = {"ph": round(snapshot["ph"], 3)}
    for field in ("ph_voltage", "water_temperature", "ec"):
        if snapshot[field] is not None:
            payload[field] = round(snapshot[field], 4)

    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        LIVE_URL,
        data=data,
        headers={
            "content-type": "application/json",
            "x-ingest-token": INGEST_TOKEN,
        },
        method="POST",
    )
    # Ingen success-log her: dette koerer hvert ~15 s og ville oversvoemme journalen.
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except urllib.error.HTTPError as err:
        print(f"live http-fejl {err.code}: {err.read().decode()[:200]}", flush=True)
    except Exception as err:
        print(f"live netvaerksfejl: {err}", flush=True)


def maybe_send_live():
    """Sender en live-opdatering, dog hoejst en gang pr. LIVE_INTERVAL sekunder.

    Selve POST'et sker paa en daemon-traad, saa en langsom eller fejlende
    forespoergsel aldrig blokerer MQTT-callbacket.
    """
    if not LIVE_URL:
        return
    moment = time.monotonic()
    with lock:
        if moment - live_marker["last"] < LIVE_INTERVAL:
            return
        live_marker["last"] = moment
        snapshot = dict(latest)
    threading.Thread(target=live_send, args=(snapshot,), daemon=True).start()


def dose_send(seconds):
    """Logger en dosering i databasen. Kaldes paa en worker-traad. Volumenet
    udledes af koerselstiden: ml = sekunder * ML_PER_SECOND."""
    payload = {
        "ml": round(seconds * ML_PER_SECOND, 3),
        "seconds": seconds,
        "kind": "ph_down",
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        DOSE_URL,
        data=data,
        headers={
            "content-type": "application/json",
            "x-ingest-token": INGEST_TOKEN,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            print(f"dosering logget {payload} -> {resp.status}", flush=True)
    except urllib.error.HTTPError as err:
        print(f"dose http-fejl {err.code}: {err.read().decode()[:200]}", flush=True)
    except Exception as err:
        print(f"dose netvaerksfejl: {err}", flush=True)


def maybe_send_dose(seconds):
    """Logger en dosering off-callback, saa et langsomt eller fejlende POST
    aldrig blokerer MQTT-callbacket."""
    if not DOSE_URL:
        return
    threading.Thread(target=dose_send, args=(seconds,), daemon=True).start()


def fetch_settings():
    """Henter doseringsindstillingerne fra web-appen. Returnerer et dict med
    kun de relevante felter, eller None ved fejl/manglende raekke."""
    req = urllib.request.Request(SETTINGS_URL, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
    except Exception as err:
        print(f"kunne ikke hente indstillinger: {err}", flush=True)
        return None
    if not isinstance(data, dict):
        return None
    return {k: data[k] for k in SETTINGS_FIELDS if k in data}


def settings_poll_loop():
    """Poller web-appen og relayer aendringer til MQTT (retained). Publicerer
    kun naar vaerdierne faktisk aendrede sig, saa journalen ikke fyldes op."""
    last = None
    time.sleep(2)  # lad MQTT-forbindelsen naa at komme op foerst
    while True:
        settings = fetch_settings()
        if settings is not None:
            payload = json.dumps(settings, sort_keys=True)
            if payload != last:
                info = client.publish(SETTINGS_TOPIC, payload, qos=1, retain=True)
                if info.rc == mqtt.MQTT_ERR_SUCCESS:
                    last = payload
                    print(f"indstillinger relayet -> {SETTINGS_TOPIC}: {payload}", flush=True)
                else:
                    print(f"kunne ikke publicere indstillinger (rc={info.rc})", flush=True)
        time.sleep(SETTINGS_POLL)


def flush_loop():
    while True:
        time.sleep(INTERVAL)
        with lock:
            snapshot = {k: v[:] for k, v in buffer.items()}
            for v in buffer.values():
                v.clear()

        if not snapshot["ph"]:
            print("ingen ph-maalinger i perioden", flush=True)
            continue

        payload = {"ph": round(statistics.median(snapshot["ph"]), 3)}
        for field in ("ph_voltage", "water_temperature", "ec"):
            if snapshot[field]:
                payload[field] = round(statistics.median(snapshot[field]), 4)
        send(payload)


def main():
    global client

    if not LIVE_URL:
        print("LIVE_URL ikke sat - live-visning deaktiveret", flush=True)
    if not DOSE_URL:
        print("DOSE_URL ikke sat - doseringslog deaktiveret", flush=True)
    if not SETTINGS_URL:
        print("SETTINGS_URL ikke sat - relay af indstillinger deaktiveret", flush=True)

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.username_pw_set(USER, PASSWORD)
    client.on_connect = on_connect
    client.on_message = on_message

    threading.Thread(target=flush_loop, daemon=True).start()
    if SETTINGS_URL:
        threading.Thread(target=settings_poll_loop, daemon=True).start()

    client.connect(BROKER, PORT, keepalive=60)
    client.loop_forever()


if __name__ == "__main__":
    main()
