'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { recordRefill } from './refillAction';

const TZ = 'Europe/Copenhagen';
const GREEN = '#4ade80';
const AMBER = '#f59e0b';
const RED = '#ef4444';
const DAY_MS = 86400e3;

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('da-DK', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ
  });
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString('da-DK', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: TZ
  });
}

const comma = (v, d = 1) => Number(v).toFixed(d).replace('.', ',');

export default function BottleGauge({ initial, now }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [volume, setVolume] = useState('500');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function onConfirm() {
    const v = Number(volume);
    if (!Number.isFinite(v) || v <= 0 || v > 20000) {
      setError('Volumen skal være et tal mellem 0 og 20000 ml.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await recordRefill(v);
      if (!res.ok) {
        setError(res.error);
      } else {
        setConfirming(false);
        router.refresh();
      }
    } catch {
      setError('Kunne ikke gemme — prøv igen.');
    } finally {
      setBusy(false);
    }
  }

  const card = {
    marginTop: 24,
    border: '1px solid #2a2e37',
    borderRadius: 8,
    padding: 16
  };
  const smallBtn = {
    background: 'transparent',
    border: '1px solid #2a2e37',
    color: '#e8eaed',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer'
  };

  const refillControls = (
    <div style={{ marginTop: 14 }}>
      {!confirming ? (
        <button
          style={smallBtn}
          onClick={() => {
            setConfirming(true);
            setError(null);
          }}
        >
          Fyldt op
        </button>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            Volumen (ml)
            <input
              type="number"
              inputMode="decimal"
              min={1}
              max={20000}
              value={volume}
              onChange={e => setVolume(e.target.value)}
              style={{
                width: 90,
                background: '#0f1115',
                border: '1px solid #2a2e37',
                borderRadius: 6,
                color: '#e8eaed',
                padding: '6px 8px',
                fontSize: 14
              }}
            />
          </label>
          <button
            style={{
              ...smallBtn,
              background: GREEN,
              borderColor: GREEN,
              color: '#0f1115',
              fontWeight: 600,
              opacity: busy ? 0.6 : 1
            }}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Gemmer…' : 'Bekræft påfyldning'}
          </button>
          <button style={smallBtn} onClick={() => setConfirming(false)} disabled={busy}>
            Annullér
          </button>
        </div>
      )}
      {error && <div style={{ color: RED, fontSize: 13, marginTop: 8 }}>{error}</div>}
    </div>
  );

  const title = {
    fontSize: 11,
    opacity: 0.45,
    letterSpacing: 0.3,
    marginBottom: 10
  };

  // RPC'en returnerer ingen raekker, hvis der aldrig er fyldt op.
  if (!initial) {
    return (
      <div style={card}>
        <div style={title}>PH-DOWN BEHOLDER</div>
        <div style={{ opacity: 0.6, fontSize: 13 }}>
          Ingen påfyldning registreret endnu.
        </div>
        {refillControls}
      </div>
    );
  }

  const volumeMl = Number(initial.volume_ml);
  const remaining = Math.max(0, Number(initial.remaining_ml));
  const pct = volumeMl > 0 ? Math.max(0, Math.min(100, (remaining / volumeMl) * 100)) : 0;
  const color = pct > 25 ? GREEN : pct >= 10 ? AMBER : RED;
  const mlPerDay = Number(initial.ml_per_day);
  const daysLeft = initial.days_left == null ? null : Number(initial.days_left);
  const emptyAt = daysLeft == null ? null : now + daysLeft * DAY_MS;

  const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 13, marginTop: 8 };
  const muted = { opacity: 0.55 };

  return (
    <div style={card}>
      <div style={title}>PH-DOWN BEHOLDER</div>

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 20, fontWeight: 500 }}>
          {Math.round(remaining)} / {Math.round(volumeMl)} ml
        </span>
        <span style={{ fontSize: 20, fontWeight: 600, color }}>{Math.round(pct)} %</span>
      </div>

      <div
        style={{
          marginTop: 8,
          height: 14,
          borderRadius: 7,
          background: '#0f1115',
          border: '1px solid #2a2e37',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            transition: 'width 0.3s'
          }}
        />
      </div>

      <div style={rowStyle}>
        <span style={muted}>Sidst fyldt op</span>
        <span>{fmtDateTime(initial.refilled_at)}</span>
      </div>
      <div style={rowStyle}>
        <span style={muted}>Forbrug</span>
        <span>{comma(mlPerDay)} ml/dag</span>
      </div>
      <div style={rowStyle}>
        <span style={muted}>Tom om</span>
        <span>
          {daysLeft == null ? (
            <span style={muted}>— (ikke nok data endnu)</span>
          ) : (
            <>
              {comma(daysLeft)} dage <span style={muted}>({fmtDate(emptyAt)})</span>
            </>
          )}
        </span>
      </div>

      {refillControls}
    </div>
  );
}
