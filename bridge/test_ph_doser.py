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

    def payloads_on(self, topic):
        return [p for (t, p, *_rest) in self.published if t == topic]


class FakeMsg:
    """Minimal efterligning af en paho MQTT-besked."""

    def __init__(self, topic, payload):
        self.topic = topic
        self.payload = payload


class DoserTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.latch = os.path.join(self.tmp, "emergency.lock")

        d.PH_EMERGENCY_FLOOR = 5.0
        d.PH_EMERGENCY_LATCH_FILE = self.latch
        d.STATE_FILE = os.path.join(self.tmp, "state.json")
        d.SANITY_MIN = 4.0
        d.SANITY_MAX = 9.0
        d.STALE_SECONDS = 120
        d.DOSE_SECONDS = 5.0

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

        # Watchdog-konfiguration og -tilstand.
        d.DOSE_WINDOW_S = 8.0
        d.UNAUTHORIZED_MAX_STOPS = 10
        d.STATE_STALE_S = 900
        d.last_dose_command = 0.0
        d.switch_state = None
        d.switch_state_time = 0.0
        d.watchdog_started = 0.0
        d.unauthorized_stops = 0
        d.watchdog_marker["last_stop"] = 0.0
        d.state_stale_marker["last_warn"] = 0.0

        d.client = FakeClient()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class SafetyTests(DoserTestBase):
    """Noedstop (pH-gulv) og laas."""

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


class WatchdogTests(DoserTestBase):
    """Tilstands-watchdog: fanger uautoriserede taend af Hue-kontakten."""

    def test_on_inside_dose_window_not_unauthorized(self):
        d.last_dose_command = 100.0
        d.on_state("on", 102.0)  # 2 s efter kommandoen — inden for vinduet

        self.assertNotIn(d.STOP_TOPIC, d.client.topics())
        self.assertEqual(d.unauthorized_stops, 0)

    def test_on_outside_window_triggers_stop(self):
        d.last_dose_command = 100.0
        d.on_state("on", 200.0)  # 100 s efter — klart uden for vinduet

        self.assertIn(d.STOP_TOPIC, d.client.topics())
        self.assertEqual(d.unauthorized_stops, 1)

    def test_repeated_on_rate_limited(self):
        # Tre "on" taet paa hinanden → kun to stop pga. 1 s rate-limit.
        d.on_state("on", 100.0)
        d.on_state("on", 100.5)  # <1 s siden sidste stop → intet stop
        d.on_state("on", 101.5)

        stops = [t for t in d.client.topics() if t == d.STOP_TOPIC]
        self.assertEqual(len(stops), 2)
        self.assertEqual(d.unauthorized_stops, 2)

    def test_latch_after_max_failed_stops(self):
        d.UNAUTHORIZED_MAX_STOPS = 3
        for t in (100.0, 101.0, 102.0):  # tre stop uden et "off"
            d.on_state("on", t)

        self.assertTrue(d.latch_exists())
        self.assertGreaterEqual(d.unauthorized_stops, 3)
        self.assertEqual(d.read_latch()["reason"], "switch_unresponsive")

    def test_off_resets_counter(self):
        d.on_state("on", 100.0)
        d.on_state("on", 101.0)
        self.assertEqual(d.unauthorized_stops, 2)

        d.on_state("off", 102.0)
        self.assertEqual(d.unauthorized_stops, 0)

    def test_staleness_warns_but_no_latch(self):
        d.switch_state_time = 1000.0
        now = 1000.0 + d.STATE_STALE_S + 10

        with self.assertLogs(d.log, level="WARNING") as cm:
            d.check_state_stale(now)

        self.assertTrue(any("blind" in line for line in cm.output))
        self.assertFalse(d.latch_exists())


class NodePathTests(DoserTestBase):
    """Ny node-vej: pumpe-koersel, nødstop og watchdog paa de nye emner."""

    def test_dose_publishes_duration_seconds(self):
        d.on_ph(7.0)  # over dose_above; én maaling er nok → dosering

        self.assertEqual(d.DOSE_TOPIC, "farm/pump/1/run")
        payloads = d.client.payloads_on(d.DOSE_TOPIC)
        self.assertEqual(len(payloads), 1)
        # Payload skal vaere et tal i sekunder lig med DOSE_SECONDS.
        self.assertEqual(float(payloads[0]), d.DOSE_SECONDS)

    def test_emergency_stop_publishes_stop_all(self):
        self.assertEqual(d.STOP_TOPIC, "farm/pump/stop_all")
        d.emergency_stop(2.0, 100.0)
        self.assertIn("farm/pump/stop_all", d.client.topics())

    def test_watchdog_reacts_to_pump_state_topic(self):
        # En uautoriseret "on" paa det nye state-emne udloeser et stop.
        self.assertEqual(d.STATE_TOPIC, "farm/pump/1/state")
        d.on_message(None, None, FakeMsg("farm/pump/1/state", b"on"))

        self.assertIn(d.STOP_TOPIC, d.client.topics())
        self.assertEqual(d.switch_state, "on")
        self.assertEqual(d.unauthorized_stops, 1)


if __name__ == "__main__":
    unittest.main()
