"""Enhedstests for EC-doseren.

    python3 -m unittest bridge/test_ec_doser.py
"""

import logging
import os
import shutil
import sys
import tempfile
import time
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

import ec_doser as d  # noqa: E402

d.log.setLevel(logging.CRITICAL)


class FakeClient:
    def __init__(self):
        self.published = []

    def publish(self, topic, payload=None, qos=0, retain=False):
        self.published.append((topic, payload, qos, retain))
        return types.SimpleNamespace(rc=0)

    def topics(self):
        return [t for (t, *_rest) in self.published]

    def runs(self):
        return [t for t in self.topics() if t.endswith("/run")]


class EcDoserTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.latch = os.path.join(self.tmp, "emergency.lock")

        d.EC_EMERGENCY_LATCH_FILE = self.latch
        d.STATE_FILE = os.path.join(self.tmp, "state.json")
        d.EC_EMERGENCY_CEILING = 4.0
        d.EC_FLOOR = 0.2
        d.EC_STALE_SECONDS = 120
        d.PUMP_GAP_SECONDS = 0
        d.ML_PER_SECOND_PUMP_2 = 0.40
        d.ML_PER_SECOND_PUMP_3 = 0.36
        d.ML_PER_SECOND_PUMP_4 = 0.36

        d.settings = {
            "ec_enabled": True,
            "ec_target": 1.8,
            "ec_deadband": 0.15,
            "ec_cooldown_minutes": 60,
            "ec_max_doses_per_day": 6,
            "ec_consecutive_readings": 1,  # én maaling under taersklen er nok
            "growth_stage": "growing",
            "dose_ml_grow": 2.0,
        }
        d.consecutive = 0
        d.last_ec = None
        d.last_ec_time = 0.0
        d.last_dose_time = 0.0
        d.dose_count = 0
        d.dose_day = d._local_date()
        d.dosing = False
        d.pump_state = {1: None, 2: None, 3: None, 4: None}
        d.emergency_marker["last_stop"] = 0.0
        d.latch_marker["last_log"] = 0.0
        d.client = FakeClient()
        d._sleep = lambda s: None  # ingen rigtige pauser

        # Fang doserings-sekvenser uden at starte en traad.
        self.started = []
        d.start_dose_sequence = lambda plan: self.started.append(plan)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # --- volumen og varighed ---

    def test_volumes_scale_per_stage(self):
        cases = {
            "growing": {"grow": 2.0, "micro": 2.0 * (1.2 / 1.8), "bloom": 2.0 * (0.6 / 1.8)},
            "preflowering": {"grow": 2.0, "micro": 2.0 * (2.0 / 2.0), "bloom": 2.0 * (1.5 / 2.0)},
            "flowering": {"grow": 2.0, "micro": 2.0 * (1.6 / 0.8), "bloom": 2.0 * (2.4 / 0.8)},
        }
        for stage, expected in cases.items():
            ml = {s["name"]: s["ml"] for s in d.dose_plan(stage, 2.0)}
            for name, want in expected.items():
                self.assertAlmostEqual(ml[name], want, places=6, msg=f"{stage}/{name}")

    def test_durations_use_pump_flow_rate(self):
        # Distinkte satser pr. pumpe: hver varighed skal bruge SIN pumpes sats.
        d.ML_PER_SECOND_PUMP_3 = 0.25  # Micro
        d.ML_PER_SECOND_PUMP_4 = 0.10  # Grow
        d.ML_PER_SECOND_PUMP_2 = 0.50  # Bloom
        by_pump = {s["pump"]: s for s in d.dose_plan("growing", 2.0)}
        self.assertAlmostEqual(by_pump[3]["seconds"], by_pump[3]["ml"] / 0.25, places=6)
        self.assertAlmostEqual(by_pump[4]["seconds"], by_pump[4]["ml"] / 0.10, places=6)
        self.assertAlmostEqual(by_pump[2]["seconds"], by_pump[2]["ml"] / 0.50, places=6)

    def test_order_is_micro_grow_bloom(self):
        plan = d.dose_plan("growing", 2.0)
        self.assertEqual([s["name"] for s in plan], ["micro", "grow", "bloom"])
        self.assertEqual([s["pump"] for s in plan], [3, 4, 2])

        d.run_dose_sequence(plan)
        self.assertEqual(
            d.client.runs(),
            ["farm/pump/3/run", "farm/pump/4/run", "farm/pump/2/run"],
        )

    def test_duration_out_of_range_skips_whole_dose(self):
        # Stor Grow-mængde → Grow-varighed > 30 s → hele dosen springes over.
        d.settings["dose_ml_grow"] = 20.0  # 20 / 0.36 ≈ 55.6 s
        d.on_ec(1.0)  # under trigger (1,8 - 0,15 = 1,65)
        self.assertEqual(d.dose_count, 0)
        self.assertEqual(self.started, [])
        self.assertEqual(d.client.runs(), [])

    def test_pump_on_aborts_remaining_runs(self):
        plan = d.dose_plan("growing", 2.0)
        calls = {"n": 0}

        def hook(_secs):
            calls["n"] += 1
            if calls["n"] == 1:  # efter Micros kørsel: en anden pumpe tænder
                d.pump_state[1] = "on"

        d._sleep = hook
        d.run_dose_sequence(plan)
        # Kun Micro (pumpe 3) nåede at køre; Grow og Bloom blev afbrudt.
        self.assertEqual(d.client.runs(), ["farm/pump/3/run"])

    # --- sikkerhed: loft og laas ---

    def test_ceiling_sets_latch(self):
        self.assertFalse(d.latch_exists())
        d.on_ec(4.5)  # over loftet 4,0
        self.assertTrue(d.latch_exists())
        self.assertEqual(d.read_latch()["reason"], "ec_ceiling")
        self.assertIn("farm/pump/stop_all", d.client.topics())

    def test_latch_blocks_dosing(self):
        with open(self.latch, "w") as f:
            f.write('{"at": "x", "reason": "ec_ceiling", "ec": 5}')
        self.assertTrue(d.latch_exists())

        d.on_ec(1.0)  # ville ellers dosere
        self.assertEqual(d.dose_count, 0)
        self.assertEqual(self.started, [])

        # Kontrol: uden laasen doserer samme aflaesning.
        os.remove(self.latch)
        d.consecutive = 0
        d.last_dose_time = 0.0
        self.started = []
        d.on_ec(1.0)
        self.assertEqual(d.dose_count, 1)
        self.assertEqual(len(self.started), 1)

    # --- nedkoeling og daglig graense (som ph_doser) ---

    def test_cooldown_blocks_dosing(self):
        d.last_dose_time = time.time()  # netop doseret → nedkøling aktiv
        d.on_ec(1.0)
        self.assertEqual(d.dose_count, 0)
        self.assertEqual(self.started, [])

    def test_daily_cap_blocks_dosing(self):
        d.dose_count = d.settings["ec_max_doses_per_day"]  # loftet nået
        d.on_ec(1.0)
        self.assertEqual(d.dose_count, d.settings["ec_max_doses_per_day"])
        self.assertEqual(self.started, [])


if __name__ == "__main__":
    unittest.main()
