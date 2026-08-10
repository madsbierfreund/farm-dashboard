import { createClient } from '@supabase/supabase-js';
import LiveReading from './LiveReading';

export const dynamic = 'force-dynamic';

const TZ = 'Europe/Copenhagen';
const TARGET_LO = 5.8;
const TARGET_HI = 6.3;

export default async function Page() {
  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const now = Date.now();
  const since = new Date(now - 24 * 3600 * 1000).toISOString();

  const { data, error } = await db
    .from('ph_readings')
    .select('recorded_at, ph, water_temperature')
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: true });

  if (error) {
    return <main style={{ padding: 24 }}>Fejl: {error.message}</main>;
  }

  const rows = (data ?? []).map(r => ({
    t: new Date(r.recorded_at).getTime(),
    ph: r.ph,
    temp: r.water_temperature
  }));

  const latest = rows[rows.length - 1];

  return (
    <main style={{ padding: 24, maxWidth: 760, margin: '0 auto' }}>
      <h1 style={{ fontSize: 15, opacity: 0.6, fontWeight: 500, letterSpacing: 0.3 }}>
        HOVEDTANK
      </h1>

      {!latest ? (
        <p style={{ opacity: 0.6 }}>Ingen målinger endnu.</p>
      ) : (
        <>
          <LiveReading
            initial={{
              ph: latest.ph,
              temp: latest.temp,
              updatedAt: new Date(latest.t).toISOString(),
              ageMs: now - latest.t
            }}
          />

          <Chart rows={rows} now={now} />

          <Stats rows={rows} />
        </>
      )}
    </main>
  );
}

function Chart({ rows, now }) {
  const w = 760, h = 280;
  const padL = 38, padR = 12, padT = 12, padB = 28;
  const t0 = now - 24 * 3600 * 1000;

  const values = rows.map(r => r.ph);
  let lo = Math.min(...values, TARGET_LO) - 0.15;
  let hi = Math.max(...values, TARGET_HI) + 0.15;
  if (hi - lo < 1) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.5;
    hi = mid + 0.5;
  }

  const x = t => padL + ((t - t0) / (now - t0)) * (w - padL - padR);
  const y = v => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);

  const step = hi - lo < 2.5 ? 0.25 : 0.5;
  const yTicks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    yTicks.push(Number(v.toFixed(2)));
  }

  const xTicks = [0, 1, 2, 3, 4].map(i => t0 + (i / 4) * (now - t0));

  const points = rows
    .filter(r => r.t >= t0)
    .map(r => `${x(r.t).toFixed(1)},${y(r.ph).toFixed(1)}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto', overflow: 'visible' }}>
      <rect
        x={padL}
        y={y(TARGET_HI)}
        width={w - padL - padR}
        height={y(TARGET_LO) - y(TARGET_HI)}
        fill="#4ade80"
        opacity="0.10"
      />

      {yTicks.map(v => (
        <g key={v}>
          <line x1={padL} y1={y(v)} x2={w - padR} y2={y(v)}
                stroke="#e8eaed" strokeWidth="1" opacity="0.08" />
          <text x={padL - 8} y={y(v)} textAnchor="end" dominantBaseline="middle"
                fill="#e8eaed" opacity="0.45" fontSize="11">
            {v.toFixed(1)}
          </text>
        </g>
      ))}

      {xTicks.map((t, i) => (
        <g key={i}>
          <line x1={x(t)} y1={padT} x2={x(t)} y2={h - padB}
                stroke="#e8eaed" strokeWidth="1" opacity="0.06" />
          <text x={x(t)} y={h - padB + 16}
                textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}
                fill="#e8eaed" opacity="0.45" fontSize="11">
            {fmtClock(t)}
          </text>
        </g>
      ))}

      {rows.length >= 2 && (
        <polyline points={points} fill="none" stroke="#4ade80"
                  strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      )}

      {rows.length === 1 && (
        <circle cx={x(rows[0].t)} cy={y(rows[0].ph)} r="4" fill="#4ade80" />
      )}
    </svg>
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

function fmtClock(t) {
  return new Date(t).toLocaleTimeString('da-DK', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ
  });
}
