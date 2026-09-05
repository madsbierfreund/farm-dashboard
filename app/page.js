import { createClient } from '@supabase/supabase-js';
import LiveReading from './LiveReading';
import ChartZoom from './ChartZoom';
import SettingsPanel from './SettingsPanel';
import BottleGauge from './BottleGauge';

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
  const from_ts = new Date(windowStart).toISOString();
  const to_ts = new Date(now).toISOString();

  // Bucketing sker i databasen (RPC), så vi ikke rammer Supabases 1000-rækkers
  // loft — en direkte select ville tavst afkorte lange vinduer. Statistikken
  // beregnes også i databasen over hele vinduet, ikke kun de plottede punkter.
  const [bucketRes, statsRes, latestRes, doseRes, settingsRes, refillRes] =
    await Promise.all([
      db.rpc('readings_bucketed', { from_ts, to_ts, buckets: MAX_POINTS }),
      db.rpc('readings_stats', { from_ts, to_ts }),
      db
        .from('ph_readings')
        .select('recorded_at, ph, water_temperature, ec')
        .order('recorded_at', { ascending: false })
        .limit(1),
      db
        .from('dose_events')
        .select('dosed_at, ml, kind')
        .gte('dosed_at', from_ts)
        .order('dosed_at', { ascending: true })
        .limit(2000),
      db.from('doser_settings').select('*').eq('id', 1).maybeSingle(),
      db.rpc('dose_remaining', { p_kind: 'ph_down' })
    ]);

  if (bucketRes.error) {
    return <main style={{ padding: 24 }}>Fejl: {bucketRes.error.message}</main>;
  }

  // bucket_at → tidsstempel, ph / water_temperature / ec → de tre serier.
  // Buckets uden temperatur eller EC giver temp/ec=null, hvilket fortsat bryder
  // de respektive linjer i segmenter i ChartBody.
  const points = (bucketRes.data ?? []).map(r => ({
    t: new Date(r.bucket_at).getTime(),
    ph: r.ph,
    temp: r.water_temperature,
    ec: r.ec
  }));

  const statsRow = statsRes.data?.[0];
  const stats = {
    min: statsRow?.min_ph,
    avg: statsRow?.avg_ph,
    max: statsRow?.max_ph,
    count: Number(statsRow?.n ?? 0)
  };

  const doses = (doseRes.data ?? []).map(d => ({
    t: new Date(d.dosed_at).getTime(),
    ml: d.ml,
    kind: d.kind
  }));
  // pH-down og gødning holdes adskilt — de har hver deres skala og total.
  const totalPhMl = doses
    .filter(d => d.kind === 'ph_down')
    .reduce((sum, d) => sum + d.ml, 0);
  const totalFertMl = doses
    .filter(d => d.kind !== 'ph_down')
    .reduce((sum, d) => sum + d.ml, 0);

  // Doseringerne bucketes på samme gitter som RPC'ens buckets: hele vinduet
  // delt i MAX_POINTS buckets.
  const bucketMs = RANGES[range].ms / MAX_POINTS;

  const latestRow = latestRes.data?.[0];
  const seed = latestRow
    ? {
        ph: latestRow.ph,
        temp: latestRow.water_temperature,
        ec: latestRow.ec,
        updatedAt: new Date(latestRow.recorded_at).toISOString(),
        ageMs: now - new Date(latestRow.recorded_at).getTime()
      }
    : null;

  return (
    <main style={{ padding: 24, maxWidth: 760, margin: '0 auto' }}>
      <h1 style={{ fontSize: 15, opacity: 0.6, fontWeight: 500, letterSpacing: 0.3 }}>
        HOVEDTANK
      </h1>

      <LiveReading initial={seed} />

      <RangeButtons active={range} />

      {points.length === 0 ? (
        <p style={{ opacity: 0.6 }}>Ingen målinger i den valgte periode.</p>
      ) : (
        <>
          <ChartZoom
            points={points}
            doses={doses}
            bucketMs={bucketMs}
            windowStart={windowStart}
            windowEnd={now}
          />
          <Stats stats={stats} totalPhMl={totalPhMl} totalFertMl={totalFertMl} />
        </>
      )}

      <BottleGauge initial={refillRes.data?.[0] ?? null} now={now} />

      <SettingsPanel initial={settingsRes.data ?? null} />
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

function Stats({ stats, totalPhMl, totalFertMl }) {
  const { min, avg, max, count } = stats;
  const ml = v => `${v.toFixed(1).replace('.', ',')} ml`;

  const cell = { flex: 1 };
  const label = { fontSize: 11, opacity: 0.45, letterSpacing: 0.3 };
  const value = { fontSize: 20, fontWeight: 500 };

  return (
    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 24 }}>
      <div style={cell}>
        <div style={label}>MIN</div>
        <div style={value}>{Number(min).toFixed(2)}</div>
      </div>
      <div style={cell}>
        <div style={label}>GNS.</div>
        <div style={value}>{Number(avg).toFixed(2)}</div>
      </div>
      <div style={cell}>
        <div style={label}>MAKS</div>
        <div style={value}>{Number(max).toFixed(2)}</div>
      </div>
      <div style={cell}>
        <div style={label}>MÅLINGER</div>
        <div style={value}>{count}</div>
      </div>
      <div style={cell}>
        <div style={label}>PH-NED</div>
        <div style={value}>{ml(totalPhMl)}</div>
      </div>
      <div style={cell}>
        <div style={label}>GØDNING</div>
        <div style={value}>{ml(totalFertMl)}</div>
      </div>
    </div>
  );
}
