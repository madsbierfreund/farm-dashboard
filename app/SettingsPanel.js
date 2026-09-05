'use client';

import { useState } from 'react';
import {
  NUMBER_FIELDS,
  EC_NUMBER_FIELDS,
  STAGES,
  STAGE_LABELS,
  DEFAULTS,
  doseVolumes,
  validateSettings
} from './settingsSchema';
import { saveSettings } from './settingsAction';

const TZ = 'Europe/Copenhagen';
const WARN = '#f59e0b';

function fmtChanged(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('da-DK', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ
  });
}

const comma = (v) => Number(v).toFixed(2).replace('.', ',');

function toForm(row) {
  const src = row ?? DEFAULTS;
  const form = {
    enabled: src.enabled !== false,
    ec_enabled: src.ec_enabled === true,
    growth_stage: src.growth_stage ?? DEFAULTS.growth_stage
  };
  for (const f of NUMBER_FIELDS) form[f.key] = String(src[f.key] ?? DEFAULTS[f.key]);
  for (const f of EC_NUMBER_FIELDS) form[f.key] = String(src[f.key] ?? DEFAULTS[f.key]);
  return form;
}

export default function SettingsPanel({ initial }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(initial ?? { ...DEFAULTS, updated_at: null });
  const [form, setForm] = useState(() => toForm(initial));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [okMsg, setOkMsg] = useState(null);

  const setField = (key, value) => {
    setForm(f => ({ ...f, [key]: value }));
    setError(null);
    setOkMsg(null);
  };

  async function onSave() {
    const payload = {
      enabled: form.enabled,
      dose_above: Number(form.dose_above),
      target_ph: Number(form.target_ph),
      cooldown_minutes: Number(form.cooldown_minutes),
      max_doses_per_day: Number(form.max_doses_per_day),
      consecutive_readings: Number(form.consecutive_readings),
      ec_enabled: form.ec_enabled,
      ec_target: Number(form.ec_target),
      ec_deadband: Number(form.ec_deadband),
      ec_cooldown_minutes: Number(form.ec_cooldown_minutes),
      ec_max_doses_per_day: Number(form.ec_max_doses_per_day),
      ec_consecutive_readings: Number(form.ec_consecutive_readings),
      growth_stage: form.growth_stage,
      dose_ml_grow: Number(form.dose_ml_grow)
    };

    // Valider i browseren først, så brugeren får årsagen med det samme.
    const check = validateSettings(payload);
    if (!check.ok) {
      setError(check.error);
      return;
    }

    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const res = await saveSettings(check.values);
      if (!res.ok) {
        setError(res.error);
      } else {
        setSaved(res.row);
        setForm(toForm(res.row));
        setOkMsg('Gemt');
      }
    } catch {
      setError('Kunne ikke gemme — prøv igen.');
    } finally {
      setBusy(false);
    }
  }

  const paused = saved.enabled === false;
  const ecPaused = saved.ec_enabled === false;
  const vol = doseVolumes(form.growth_stage, form.dose_ml_grow);

  const label = { fontSize: 12, opacity: 0.6, marginBottom: 4 };
  const input = {
    width: '100%',
    boxSizing: 'border-box',
    background: '#0f1115',
    border: '1px solid #2a2e37',
    borderRadius: 6,
    color: '#e8eaed',
    padding: '8px 10px',
    fontSize: 14
  };
  const grid = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: 14
  };
  const heading = { fontSize: 13, fontWeight: 600, opacity: 0.75, margin: '4px 0 12px' };
  const toggleRow = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
    cursor: 'pointer'
  };

  return (
    <div style={{ marginTop: 28, borderTop: '1px solid #2a2e37', paddingTop: 16 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          background: 'transparent',
          border: 'none',
          color: '#e8eaed',
          fontSize: 14,
          fontWeight: 500,
          cursor: 'pointer',
          padding: 0,
          textAlign: 'left'
        }}
      >
        <span style={{ opacity: 0.6, fontSize: 12 }}>{open ? '▾' : '▸'}</span>
        Doseringsindstillinger
        {paused && (
          <span style={{ color: WARN, fontSize: 12, fontWeight: 600, marginLeft: 8 }}>
            ⏸ pH på pause
          </span>
        )}
      </button>

      {open && (
        <div style={{ marginTop: 16 }}>
          {/* ---------- pH ---------- */}
          <div style={heading}>pH-dosering</div>

          <label style={toggleRow}>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={e => setField('enabled', e.target.checked)}
              style={{ width: 18, height: 18, accentColor: '#4ade80' }}
            />
            <span style={{ fontSize: 14 }}>
              pH-dosering aktiveret{' '}
              <span style={{ opacity: 0.55 }}>
                ({form.enabled ? 'til' : 'fra — doserer ikke'})
              </span>
            </span>
          </label>

          <div style={grid}>
            {NUMBER_FIELDS.map(f => (
              <div key={f.key}>
                <div style={label}>{f.label}</div>
                <input
                  type="number"
                  inputMode="decimal"
                  step={f.step}
                  min={f.min}
                  max={f.max}
                  value={form[f.key]}
                  onChange={e => setField(f.key, e.target.value)}
                  style={input}
                />
              </div>
            ))}
          </div>

          {/* ---------- EC ---------- */}
          <div style={{ ...heading, marginTop: 26 }}>EC-gødning (TriPart)</div>

          <label style={toggleRow}>
            <input
              type="checkbox"
              checked={form.ec_enabled}
              onChange={e => setField('ec_enabled', e.target.checked)}
              style={{ width: 18, height: 18, accentColor: '#38bdf8' }}
            />
            <span style={{ fontSize: 14 }}>
              EC-dosering aktiveret{' '}
              <span style={{ opacity: 0.55 }}>
                ({form.ec_enabled ? 'til' : 'fra — doserer ikke'})
              </span>
            </span>
          </label>

          <div style={grid}>
            <div>
              <div style={label}>Vækststadie</div>
              <select
                value={form.growth_stage}
                onChange={e => setField('growth_stage', e.target.value)}
                style={input}
              >
                {STAGES.map(s => (
                  <option key={s} value={s}>
                    {STAGE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            {EC_NUMBER_FIELDS.map(f => (
              <div key={f.key}>
                <div style={label}>{f.label}</div>
                <input
                  type="number"
                  inputMode="decimal"
                  step={f.step}
                  min={f.min}
                  max={f.max}
                  value={form[f.key]}
                  onChange={e => setField(f.key, e.target.value)}
                  style={input}
                />
              </div>
            ))}
          </div>

          <div
            style={{
              marginTop: 12,
              fontSize: 13,
              opacity: 0.75,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 14
            }}
          >
            <span>En dosis nu:</span>
            <span style={{ color: '#38bdf8' }}>Micro {comma(vol.micro)} ml</span>
            <span style={{ color: '#38bdf8' }}>Grow {comma(vol.grow)} ml</span>
            <span style={{ color: '#38bdf8' }}>Bloom {comma(vol.bloom)} ml</span>
            <span style={{ opacity: 0.5 }}>(rækkefølge: Micro → Grow → Bloom)</span>
          </div>

          {error && (
            <div style={{ color: WARN, fontSize: 13, marginTop: 14 }}>{error}</div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 18 }}>
            <button
              onClick={onSave}
              disabled={busy}
              style={{
                background: '#4ade80',
                border: '1px solid #4ade80',
                color: '#0f1115',
                borderRadius: 6,
                padding: '8px 16px',
                fontSize: 14,
                fontWeight: 600,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1
              }}
            >
              {busy ? 'Gemmer…' : 'Gem'}
            </button>
            {okMsg && <span style={{ color: '#4ade80', fontSize: 13 }}>{okMsg}</span>}
            {ecPaused && (
              <span style={{ color: WARN, fontSize: 12 }}>EC på pause</span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.5 }}>
              Sidst ændret {fmtChanged(saved.updated_at)}
            </span>
          </div>

          <div style={{ fontSize: 12, opacity: 0.4, marginTop: 14 }}>
            Ændringer sendes til doserne via MQTT. Doserne kører videre på de
            sidst kendte værdier, hvis forbindelsen er nede.
          </div>
        </div>
      )}
    </div>
  );
}
