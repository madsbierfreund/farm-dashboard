'use client';

import { useState, useEffect } from 'react';

const TZ = 'Europe/Copenhagen';
const STALE_MS = 2 * 60 * 1000;
const WARN = '#f59e0b';

function fmtTime(t) {
  return new Date(t).toLocaleString('da-DK', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ
  });
}

function fmtAgo(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'lige nu';
  if (min < 60) return `for ${min} min. siden`;
  const h = Math.round(min / 60);
  if (h < 24) return `for ${h} t. siden`;
  return `for ${Math.round(h / 24)} d. siden`;
}

export default function LiveReading({ initial }) {
  const [reading, setReading] = useState(initial);
  // `now` stays null until after mount so the first client render matches the
  // server HTML (we fall back to the server-computed age) and hydration is clean.
  const [now, setNow] = useState(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const res = await fetch('/api/live', { cache: 'no-store' });
        if (!res.ok) return;
        const row = await res.json();
        if (!alive || !row || row.ph == null) return;
        setReading({
          ph: row.ph,
          temp: row.water_temperature,
          updatedAt: row.updated_at
        });
      } catch {
        // netværksfejl — behold den sidst kendte værdi
      }
    }

    setNow(Date.now());
    load();
    const fetchId = setInterval(load, 10000);
    const tickId = setInterval(() => setNow(Date.now()), 10000);
    return () => {
      alive = false;
      clearInterval(fetchId);
      clearInterval(tickId);
    };
  }, []);

  if (!reading || reading.ph == null) {
    return <p style={{ opacity: 0.6 }}>Ingen målinger endnu.</p>;
  }

  const updatedMs = new Date(reading.updatedAt).getTime();
  const ageMs = now == null ? initial.ageMs : now - updatedMs;
  const stale = ageMs > STALE_MS;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 20 }}>
        <span style={{ fontSize: 68, fontWeight: 600, lineHeight: 1.1 }}>
          {reading.ph.toFixed(2)}
        </span>
        {reading.temp != null && (
          <span style={{ fontSize: 24, opacity: 0.55 }}>
            {reading.temp.toFixed(1)} °C
          </span>
        )}
      </div>

      <div
        style={{
          fontSize: 13,
          marginBottom: 28,
          color: stale ? WARN : '#e8eaed',
          opacity: stale ? 1 : 0.5
        }}
      >
        Målt {fmtTime(updatedMs)} · {fmtAgo(ageMs)}
      </div>
    </>
  );
}
