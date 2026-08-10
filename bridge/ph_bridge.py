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

TOPICS = {
    "farm/ph_node/sensor/ph/state": "ph",
    "farm/ph_node/sensor/ph_voltage/state": "ph_voltage",
    "farm/ph_node/sensor/water_temperature/state": "water_temperature",
}

lock = threading.Lock()
buffer = {"ph": [], "ph_voltage": [], "water_temperature": []}


def on_connect(client, userdata, flags, reason_code, properties=None):
    if reason_code != 0:
        print(f"forbindelse afvist: {reason_code}", flush=True)
        return
    print("forbundet til broker", flush=True)
    for topic in TOPICS:
        client.subscribe(topic)


def on_message(client, userdata, msg):
    field = TOPICS.get(msg.topic)
    if field is None:
        return
    try:
        value = float(msg.payload.decode())
    except ValueError:
        return
    with lock:
        buffer[field].append(value)


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
        for field in ("ph_voltage", "water_temperature"):
            if snapshot[field]:
                payload[field] = round(statistics.median(snapshot[field]), 4)
        send(payload)


def main():
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.username_pw_set(USER, PASSWORD)
    client.on_connect = on_connect
    client.on_message = on_message

    threading.Thread(target=flush_loop, daemon=True).start()

    client.connect(BROKER, PORT, keepalive=60)
    client.loop_forever()


if __name__ == "__main__":
    main()
