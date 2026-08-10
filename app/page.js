import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await db
    .from('ph_readings')
    .select('recorded_at, ph, water_temperature')
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: true });

  if (error) {
    return <main style={{ padding: 24 }}>Fejl: {error.message}</main>;
  }

  const rows = data ?? [];
  const latest = rows[rows.length - 1];

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ fontSize: 18, opacity: 0.7, fontWeight: 500 }}>Hovedtank</h1>

      {latest ? (
        <>
          <div style={{ fontSize: 72, fontWeight: 600, lineHeight: 1.1 }}>
            {latest.ph.toFixed(2)}
          </div>
          <div style={{ opacity: 0.6, marginBottom: 32 }}>
            {latest.water_temperature != null
              ? `${latest.water_temperature.toFixed(1)} °C · `
              : ''}
            {new Date(latest.recorded_at).toLocaleString('da-DK')}
          </div>
          <Chart rows={rows} />
          <div style={{ marginTop: 16, opacity: 0.5, fontSize: 13 }}>
            {rows.length} målinger seneste døgn
          </div>
        </>
      ) : (
        <p style={{ opacity: 0.6 }}>Ingen målinger endnu.</p>
      )}
    </main>
  );
}

function Chart({ rows }) {
  if (rows.length < 2) return null;

  const w = 680, h = 200, pad = 8;
  const values = rows.map(r => r.ph);
  const lo = Math.min(...values, 5.5) - 0.2;
  const hi = Math.max(...values, 7.0) + 0.2;

  const x = i => pad + (i / (rows.length - 1)) * (w - 2 * pad);
  const y = v => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);

  const points = rows.map((r, i) => `${x(i)},${y(r.ph)}`).join(' ');
  const bandTop = y(6.3);
  const bandBottom = y(5.8);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto' }}>
      <rect x={pad} y={bandTop} width={w - 2 * pad} height={bandBottom - bandTop}
            fill="#4ade80" opacity="0.12" />
      <polyline points={points} fill="none" stroke="#4ade80" strokeWidth="2" />
    </svg>
  );
}
