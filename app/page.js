import { createClient } from '@supabase/supabase-js';
import LiveReading from './LiveReading';
import ChartZoom from './ChartZoom';

export const dynamic = 'force-dynamic';

// Valgbare tidsvinduer. Nøglen ligger i URL'ens ?range=... så et genindlæst
// eller bogmærket link husker valget.
const RANGES = {
  '1h': { label: '1 time', ms: 3600e3 },
  '6h': { label: '6 timer', ms: 6 * 3600e3 },
  '1d': { label: '1 dag', ms: 24 * 3600e3 },
  '1w': { label: '1 uge', ms: 7 * 24 * 3600e3 },
  '1m': { label: '1 måned', ms: 30 * 24 * 3600e3 }
};
const DEFAULT_RANGE = '1d';
const MAX_POINTS = 400;

export default async function Page({ searchParams }) {
  const sp = (await searchParams) ?? {};
  const rangeParam = Array.isArray(sp.range) ? sp.range[0] : sp.range;
  const range = RANGES[rangeParam] ? rangeParam : DEFAULT_RANGE;

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const now = Date.now();
  const windowStart = now - RANGES[range].ms;
  const since = new Date(windowStart).toISOString();

  // Vinduet til grafen/statistikken + den nyeste måling til live-tallet
  // (uafhængigt af det valgte vindue, så tallet altid er korrekt).
  const [windowRes, latestRes] = await Promise.all([
    db
      .from('ph_readings')
      .select('recorded_at, ph, water_temperature')
      .gte('recorded_at', since)
      .order('recorded_at', { ascending: true }),
    db
      .from('ph_readings')
      .select('recorded_at, ph, water_temperature')
      .order('recorded_at', { ascending: false })
      .limit(1)
  ]);

  if (windowRes.error) {
    return <main style={{ padding: 24 }}>Fejl: {windowRes.error.message}</main>;
  }

  const rows = (windowRes.data ?? []).map(r => ({
    t: new Date(r.recorded_at).getTime(),
    ph: r.ph,
    temp: r.water_temperature
  }));

  const latestRow = latestRes.data?.[0];
  const seed = latestRow
    ? {
        ph: latestRow.ph,
        temp: latestRow.water_temperature,
        updatedAt: new Date(latestRow.recorded_at).toISOString(),
        ageMs: now - new Date(latestRow.recorded_at).getTime()
      }
    : null;

  // Nedsampling for perioder længere end et døgn: bucket readings i tid og
  // plot medianen af hver bucket, så vi rammer højst ~MAX_POINTS punkter.
  const points =
    RANGES[range].ms > RANGES['1d'].ms ? downsample(rows, MAX_POINTS) : rows;

  return (
    <main style={{ padding: 24, maxWidth: 760, margin: '0 auto' }}>
      <h1 style={{ fontSize: 15, opacity: 0.6, fontWeight: 500, letterSpacing: 0.3 }}>
        HOVEDTANK
      </h1>

      <LiveReading initial={seed} />

      <RangeButtons active={range} />

      {rows.length === 0 ? (
        <p style={{ opacity: 0.6 }}>Ingen målinger i den valgte periode.</p>
      ) : (
        <>
          <ChartZoom points={points} windowStart={windowStart} windowEnd={now} />
          <Stats rows={rows} />
        </>
      )}
    </main>
  );
}

function RangeButtons({ active }) {
  const base = {
    display: 'inline-block',
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid #2a2e37',
    fontSize: 13,
    lineHeight: 1.2,
    textDecoration: 'none',
    color: '#e8eaed'
  };
  const selected = {
    ...base,
    background: '#4ade80',
    borderColor: '#4ade80',
    color: '#0f1115',
    fontWeight: 600
  };

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '4px 0 16px' }}>
      {Object.entries(RANGES).map(([key, { label }]) => (
        <a key={key} href={`/?range=${key}`} style={key === active ? selected : base}>
          {label}
        </a>
      ))}
    </div>
  );
}

function Stats({ rows }) {
  if (rows.length === 0) return null;
  const v = rows.map(r => r.ph);
  const min = Math.min(...v);
  const max = Math.max(...v);
  const avg = v.reduce((a, b) => a + b, 0) / v.length;

  const cell = { flex: 1 };
  const label = { fontSize: 11, opacity: 0.45, letterSpacing: 0.3 };
  const value = { fontSize: 20, fontWeight: 500 };

  return (
    <div style={{ display: 'flex', gap: 24, marginTop: 24 }}>
      <div style={cell}>
        <div style={label}>MIN</div>
        <div style={value}>{min.toFixed(2)}</div>
      </div>
      <div style={cell}>
        <div style={label}>GNS.</div>
        <div style={value}>{avg.toFixed(2)}</div>
      </div>
      <div style={cell}>
        <div style={label}>MAKS</div>
        <div style={value}>{max.toFixed(2)}</div>
      </div>
      <div style={cell}>
        <div style={label}>MÅLINGER</div>
        <div style={value}>{rows.length}</div>
      </div>
    </div>
  );
}

function median(sorted) {
  const n = sorted.length;
  const m = n >> 1;
  return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// Bucket readings i tid og returnér medianen af hver bucket (pH, temp og
// tidspunkt). Bruges kun til lange perioder for at holde punktantallet nede.
function downsample(rows, targetMax) {
  if (rows.length <= targetMax) return rows;

  const first = rows[0].t;
  const last = rows[rows.length - 1].t;
  const span = last - first || 1;
  const bucketMs = span / targetMax;

  const buckets = new Map();
  for (const r of rows) {
    let idx = Math.floor((r.t - first) / bucketMs);
    if (idx >= targetMax) idx = targetMax - 1;
    let bucket = buckets.get(idx);
    if (!bucket) {
      bucket = [];
      buckets.set(idx, bucket);
    }
    bucket.push(r);
  }

  const out = [];
  for (const idx of [...buckets.keys()].sort((a, b) => a - b)) {
    const bucket = buckets.get(idx);
    const phs = bucket.map(r => r.ph).sort((a, b) => a - b);
    const temps = bucket.map(r => r.temp).filter(v => v != null).sort((a, b) => a - b);
    const ts = bucket.map(r => r.t).sort((a, b) => a - b);
    out.push({
      t: median(ts),
      ph: median(phs),
      temp: temps.length ? median(temps) : null
    });
  }
  return out;
}
