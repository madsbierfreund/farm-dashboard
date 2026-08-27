"""Enhedstests for pH-doserens sikkerhedsforanstaltninger (noedstop + laas).

Koeres med den indbyggede unittest, uden eksterne afhaengigheder:

    python3 -m unittest bridge/test_ph_doser.py
"""

import json
import logging
import os
import shutil
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Mock paho, saa modulet kan importeres uden paho-mqtt installeret.
try:
    import paho.mqtt.client  # noqa: F401
except Exception:
    _paho = types.ModuleType("paho")
    _paho_mqtt = types.ModuleType("paho.mqtt")
    _paho_client = types.ModuleType("paho.mqtt.client")
    _paho_client.MQTT_ERR_SUCCESS = 0
    _paho_client.CallbackAPIVersion = type("CB", (), {"VERSION2": 2})
    _paho_client.Client = object
    _paho.mqtt = _paho_mqtt
    _paho_mqtt.client = _paho_client
    sys.modules["paho"] = _paho
    sys.modules["paho.mqtt"] = _paho_mqtt
    sys.modules["paho.mqtt.client"] = _paho_client

import ph_doser as d  # noqa: E402

d.log.setLevel(logging.CRITICAL)  # hold testudskriften ren


class FakeClient:
    """Optager publiceringer i stedet for at tale med en broker."""

    def __init__(self):
        self.published = []

    def publish(self, topic, payload=None, qos=0, retain=False):
        self.published.append((topic, payload, qos, retain))
        return types.SimpleNamespace(rc=0)

    def topics(self):
        return [t for (t, *_rest) in self.published]


class DoserSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.latch = os.path.join(self.tmp, "emergency.lock")

        d.PH_EMERGENCY_FLOOR = 5.0
        d.PH_EMERGENCY_LATCH_FILE = self.latch
        d.STATE_FILE = os.path.join(self.tmp, "state.json")
        d.SANITY_MIN = 4.0
        d.SANITY_MAX = 9.0
        d.STALE_SECONDS = 120

        d.settings = {
            "enabled": True,
            "dose_above": 6.3,
            "target_ph": 6.1,
            "cooldown_minutes": 30,
            "max_doses_per_day": 8,
            "consecutive_readings": 1,  # én maaling over taersklen er nok
        }
        d.consecutive = 0
        d.last_dose_time = 0.0
        d.dose_count = 0
        d.dose_day = d._local_date()
        d.last_ph = None
        d.last_ph_time = 0.0
        d.last_temp = None
        d.emergency_marker["last_stop"] = 0.0
        d.latch_marker["last_log"] = 0.0
        d.client = FakeClient()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_below_floor_triggers_stop_and_latch(self):
        d.on_ph(1.79)

        # Pumpen stoppes og laasefilen skrives med tidsstempel + pH-vaerdi.
        self.assertIn(d.STOP_TOPIC, d.client.topics())
        self.assertTrue(os.path.exists(self.latch))
        with open(self.latch) as f:
            latch = json.load(f)
        self.assertEqual(latch["ph"], 1.79)
        self.assertIsInstance(latch["at"], str)

        # En noedstop maa aldrig samtidig udloese en dosering.
        self.assertNotIn(d.DOSE_TOPIC, d.client.topics())

    def test_latch_blocks_dosing(self):
        # Laasefil til stede → ingen dosering, selv om pH ellers ville dosere.
        with open(self.latch, "w") as f:
            f.write('{"at": "2026-08-27T12:00:00", "ph": 1.5}')
        self.assertTrue(d.latch_exists())

        d.on_ph(7.0)  # over dose_above; én maaling er nok
        self.assertNotIn(d.DOSE_TOPIC, d.client.topics())

        # Kontrol: uden laasen doserer nøjagtig samme maaling — saa laasen er
        # beviseligt aarsagen til blokeringen.
        os.remove(self.latch)
        d.consecutive = 0
        d.last_dose_time = 0.0
        d.client = FakeClient()
        d.on_ph(7.0)
        self.assertIn(d.DOSE_TOPIC, d.client.topics())

    def test_stop_publish_rate_limited(self):
        d.emergency_stop(2.0, 100.0)  # udloeser: publicér + skriv laas
        d.emergency_stop(2.0, 105.0)  # inden for 10 s → ingen ny publicering
        d.emergency_stop(2.0, 115.0)  # >10 s → publicér igen

        stops = [t for t in d.client.topics() if t == d.STOP_TOPIC]
        self.assertEqual(len(stops), 2)

    def test_normal_ph_unaffected(self):
        d.on_ph(6.0)  # over gulvet, ingen laas, under dose_above

        self.assertNotIn(d.STOP_TOPIC, d.client.topics())
        self.assertFalse(os.path.exists(self.latch))
        self.assertNotIn(d.DOSE_TOPIC, d.client.topics())
        # Status udsendes stadig som normalt.
        self.assertIn(d.STATUS_TOPIC, d.client.topics())


if __name__ == "__main__":
    unittest.main()
