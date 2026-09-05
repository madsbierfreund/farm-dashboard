# farm-dashboard

Next.js 15 (app router) dashboard for pH readings from a hydroponics tank.
Data flow: ESP32 node → MQTT broker on a Raspberry Pi → `bridge/ph_bridge.py`
→ `POST /api/ingest` → Supabase. A separate `bridge/ph_doser.py` runs the
pH-down dosing controller on the same Pi, talking only to the local broker.

## Database migrations

The database schema lives in `supabase/migrations/` and that directory is the
authoritative record of it. The rules:

- **Any change that requires a database schema change must be written as a new
  numbered file in `supabase/migrations/` as part of the same change**, before
  or alongside the application code that depends on it. Never hand the user
  loose SQL to paste without also committing it.
- **Migrations are append-only:** to change something, add a new numbered file
  (e.g. `004_...sql`); do not edit an existing one.
- **Every migration that creates a table must include the grants to
  `service_role`**, because the project has "Automatically expose new tables"
  disabled — a new table without grants fails with "permission denied".

The migration files are already applied to the live Supabase project; they are
a record of current state, not something to re-run there. See
`supabase/migrations/README.md` for details.

## Environment variables

### Web app (configured in Vercel)

- `SUPABASE_URL` — Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY` — service-role key; used server-side only.
- `INGEST_TOKEN` — shared secret required in the `x-ingest-token` header on
  `POST /api/ingest`, `/api/live` and `/api/dose`.

### Bridge on the Pi — `bridge/.env` (read by `bridge/ph_bridge.py`)

- `MQTT_HOST` (default `localhost`), `MQTT_PORT` (default `1883`),
  `MQTT_USER`, `MQTT_PASSWORD` — local MQTT broker.
- `INGEST_URL` — the `/api/ingest` endpoint.
- `INGEST_TOKEN` — matches the app's `INGEST_TOKEN`.
- `INTERVAL_SECONDS` (default `300`) — median flush interval.
- `LIVE_URL` — the `/api/live` endpoint; omit to disable live posting.
- `LIVE_INTERVAL_SECONDS` (default `15`) — minimum gap between live POSTs.
- `DOSE_URL` — the `/api/dose` endpoint; omit to disable dose logging. Logs
  from the pump run command on `farm/pump/1/run`.
- `ML_PER_SECOND` (default `0.4`) — volume per second; the logged ml is
  derived from the run duration (`ml = seconds * ML_PER_SECOND`).

### Doser on the Pi — `bridge/.env.doser` (read by `bridge/ph_doser.py`)

- `MQTT_HOST` (default `localhost`), `MQTT_PORT` (default `1883`),
  `MQTT_USER`, `MQTT_PASSWORD` — local MQTT broker.
- `DOSE_TOPIC` (default `farm/pump/1/run`) — pump-run topic the ESPHome node
  listens on; the doser publishes the run duration in seconds here.
- `DOSE_SECONDS` (default `5.0`) — how long pump 1 runs per dose.
- `ENABLED` (default `true`) — set `false` to pause dosing.
- `DOSE_ABOVE` (default `6.3`) — dose when pH is above this.
- `TARGET_PH` (default `6.1`) — stop dosing once at or below this.
- `COOLDOWN_MINUTES` (default `30`) — minimum wait between doses.
- `MAX_DOSES_PER_DAY` (default `8`).
- `CONSECUTIVE_READINGS` (default `3`) — readings above `DOSE_ABOVE` in a row.
- `STALE_SECONDS` (default `120`) — ignore data older than this.
- `SANITY_MIN` (default `4.0`), `SANITY_MAX` (default `9.0`) — dosing is
  skipped for readings outside this range.
- `STATE_FILE` (default `~/.ph_doser_state.json`) — persists last-dose time
  and today's dose count.

### EC doser on the Pi — `bridge/.env.ec-doser` (read by `bridge/ec_doser.py`)

Fertiliser dosing (Terra Aquatica TriPart). A dose is three pump runs in fixed
order Micro (pump 3) → Grow (pump 4) → Bloom (pump 2), `PUMP_GAP_SECONDS`
(default `60`) apart. Volumes come from `GROWTH_STAGE` + `DOSE_ML_GROW`;
durations from the per-pump flow rates.

- `MQTT_HOST`/`MQTT_PORT`/`MQTT_USER`/`MQTT_PASSWORD` — local broker.
- `EC_ENABLED` (default `false`), `EC_TARGET` (`1.8`), `EC_DEADBAND` (`0.15`),
  `EC_COOLDOWN_MINUTES` (`60`), `EC_MAX_DOSES_PER_DAY` (`6`),
  `EC_CONSECUTIVE_READINGS` (`3`), `GROWTH_STAGE` (`growing`), `DOSE_ML_GROW`
  (`2.0`) — the settings-overridable set (relayed from the web panel via
  `farm/ec/settings`; env is fallback).
- `ML_PER_SECOND_PUMP_2` (`0.40`), `ML_PER_SECOND_PUMP_3` (`0.36`),
  `ML_PER_SECOND_PUMP_4` (`0.36`) — measured flow rates (ml→seconds).
- `PUMP_GAP_SECONDS` (`60`), `EC_FLOOR` (`0.2`, ignore below), stale/state as
  ph_doser.
- `EC_EMERGENCY_CEILING` (`4.0`) — EC above it → `farm/pump/stop_all` + latch;
  `EC_EMERGENCY_LATCH_FILE` (`/var/lib/ec-doser/emergency.lock`).
- Status on `farm/ec/status`; doses logged via `farm/ec/dose_log` (relayed to
  `/api/dose` by the bridge).

## Conventions

- No charting library, no Tailwind, no CSS modules, no new dependencies. The
  UI uses inline styles and a dark palette (background `#0f1115`, text
  `#e8eaed`, accent `#4ade80`). All UI text is in Danish.
- The bridge scripts use paho-mqtt (`CallbackAPIVersion.VERSION2`) and the
  Python standard library only.
