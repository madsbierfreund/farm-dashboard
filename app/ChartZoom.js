'use client';

import { useRef, useState } from 'react';

const TZ = 'Europe/Copenhagen';
const TARGET_LO = 5.8;
const TARGET_HI = 6.3;

const W = 760, H = 280;
const PADL = 38, PADR = 44, PADT = 12, PADB = 28;

// Interaktiv indpakning: håndterer træk-for-at-zoome og genbruger ChartBody
// til selve tegningen, så der kun findes én implementering af graf-koden.
export default function ChartZoom({ points, windowStart, windowEnd }) {
  const svgRef = useRef(null);
  const [zoom, setZoom] = useState(null); // { start, end } i ms, eller null
  const [drag, setDrag] = useState(null); // { x0, x1 } i bruger-koordinater (0..W)

  const view0 = zoom ? zoom.start : windowStart;
  const view1 = zoom ? zoom.end : windowEnd;

  const clampPx = px => Math.max(PADL, Math.min(W - PADR, px));

  const pxOfClient = clientX => {
    const rect = svgRef.current.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * W;
  };

  const timeOfPx = px => {
    const frac = (px - PADL) / (W - PADL - PADR);
    const clamped = Math.max(0, Math.min(1, frac));
    return view0 + clamped * (view1 - view0);
  };

  function onDown(e) {
    const px = pxOfClient(e.clientX);
    setDrag({ x0: px, x1: px });
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onMove(e) {
    if (!drag) return;
    setDrag(d => (d ? { ...d, x1: pxOfClient(e.clientX) } : d));
  }

  function onUp() {
    if (!drag) return;
    const { x0, x1 } = drag;
    setDrag(null);
    // Kræv en meningsfuld markering: mindst 8 px bred og over 1 minut.
    if (Math.abs(x1 - x0) >= 8) {
      const a = timeOfPx(Math.min(x0, x1));
      const b = timeOfPx(Math.max(x0, x1));
      if (b - a > 60e3) setZoom({ start: a, end: b });
    }
  }

  const visible = points.filter(p => p.t >= view0 && p.t <= view1);
  const hasTemp = visible.some(p => p.temp != null);

  const legendItem = { display: 'flex', alignItems: 'center', gap: 6, opacity: 0.7 };
  const swatch = c => ({ width: 14, height: 2, background: c, display: 'inline-block' });

  let selX = 0, selW = 0;
  if (drag) {
    const a = clampPx(Math.min(drag.x0, drag.x1));
    const b = clampPx(Math.max(drag.x0, drag.x1));
    selX = a;
    selW = b - a;
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 18, marginBottom: 8, fontSize: 12, alignItems: 'center' }}>
        <span style={legendItem}>
          <span style={swatch('#4ade80')} /> pH
        </span>
        {hasTemp && (
          <span style={legendItem}>
            <span style={swatch('#f59e0b')} /> Vandtemperatur
          </span>
        )}
        {zoom && (
          <button
            onClick={() => setZoom(null)}
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: '1px solid #2a2e37',
              color: '#e8eaed',
              borderRadius: 6,
              padding: '4px 10px',
              fontSize: 12,
              cursor: 'pointer'
            }}
          >
            Nulstil zoom
          </button>
        )}
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{
          width: '100%',
          height: 'auto',
          overflow: 'visible',
          touchAction: 'none',
          userSelect: 'none',
          cursor: 'crosshair'
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => setDrag(null)}
      >
        <ChartBody points={visible} view0={view0} view1={view1} />
        {selW > 0 && (
          <rect x={selX} y={PADT} width={selW} height={H - PADT - PADB} fill="#e8eaed" opacity="0.12" />
        )}
      </svg>
    </div>
  );
}

// Ren tegnefunktion: akser, målbånd, gitter og de to kurver for et givet
// tidsvindue. Skalaerne tilpasses de synlige punkter, så zoom også omregner Y.
function ChartBody({ points, view0, view1 }) {
  const span = view1 - view0;

  // pH-akse (venstre) — inkludér altid målbåndet og lidt luft om data.
  const phv = points.map(p => p.ph);
  let lo = Math.min(...phv, TARGET_LO) - 0.15;
  let hi = Math.max(...phv, TARGET_HI) + 0.15;
  if (hi - lo < 1) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.5;
    hi = mid + 0.5;
  }

  // Temperaturakse (højre) — uafhængig skala tilpasset data.
  const temps = points.filter(p => p.temp != null).map(p => p.temp);
  const hasTemp = temps.length > 0;
  let tLo = 0, tHi = 1;
  if (hasTemp) {
    tLo = Math.min(...temps);
    tHi = Math.max(...temps);
    let s = tHi - tLo;
    if (s < 0.5) {
      const mid = (tHi + tLo) / 2;
      tLo = mid - 0.25;
      tHi = mid + 0.25;
      s = tHi - tLo;
    }
    const pad = s * 0.1;
    tLo -= pad;
    tHi += pad;
  }

  const x = t => PADL + ((t - view0) / (view1 - view0)) * (W - PADL - PADR);
  const y = v => PADT + (1 - (v - lo) / (hi - lo)) * (H - PADT - PADB);
  const yT = v => PADT + (1 - (v - tLo) / (tHi - tLo)) * (H - PADT - PADB);

  const step = hi - lo < 2.5 ? 0.25 : 0.5;
  const yTicks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    yTicks.push(Number(v.toFixed(2)));
  }

  const tTicks = [];
  if (hasTemp) {
    const tStep = niceStep(tHi - tLo);
    for (let v = Math.ceil(tLo / tStep) * tStep; v <= tHi + 1e-9; v += tStep) {
      tTicks.push(Number(v.toFixed(2)));
    }
  }

  const xTicks = [0, 1, 2, 3, 4].map(i => view0 + (i / 4) * span);

  const phLine = points.map(p => `${x(p.t).toFixed(1)},${y(p.ph).toFixed(1)}`).join(' ');

  // Temperaturkurven brydes i segmenter hen over huller (manglende værdier).
  const tempSegments = [];
  let seg = [];
  for (const p of points) {
    if (p.temp == null) {
      if (seg.length) {
        tempSegments.push(seg);
        seg = [];
      }
    } else {
      seg.push([x(p.t), yT(p.temp)]);
    }
  }
  if (seg.length) tempSegments.push(seg);

  return (
    <>
      <rect
        x={PADL}
        y={y(TARGET_HI)}
        width={W - PADL - PADR}
        height={y(TARGET_LO) - y(TARGET_HI)}
        fill="#4ade80"
        opacity="0.10"
      />

      {yTicks.map(v => (
        <g key={`ph-${v}`}>
          <line x1={PADL} y1={y(v)} x2={W - PADR} y2={y(v)} stroke="#e8eaed" strokeWidth="1" opacity="0.08" />
          <text x={PADL - 8} y={y(v)} textAnchor="end" dominantBaseline="middle" fill="#4ade80" opacity="0.7" fontSize="11">
            {v.toFixed(1)}
          </text>
        </g>
      ))}

      {tTicks.map(v => (
        <g key={`t-${v}`}>
          <line x1={W - PADR} y1={yT(v)} x2={W - PADR + 4} y2={yT(v)} stroke="#f59e0b" strokeWidth="1" opacity="0.5" />
          <text x={W - PADR + 8} y={yT(v)} textAnchor="start" dominantBaseline="middle" fill="#f59e0b" opacity="0.75" fontSize="11">
            {v.toFixed(1)}
          </text>
        </g>
      ))}

      {xTicks.map((t, i) => (
        <g key={`x-${i}`}>
          <line x1={x(t)} y1={PADT} x2={x(t)} y2={H - PADB} stroke="#e8eaed" strokeWidth="1" opacity="0.06" />
          <text
            x={x(t)}
            y={H - PADB + 16}
            textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}
            fill="#e8eaed"
            opacity="0.45"
            fontSize="11"
          >
            {fmtAxis(t, span)}
          </text>
        </g>
      ))}

      {tempSegments.map((s, i) =>
        s.length >= 2 ? (
          <polyline
            key={`ts-${i}`}
            points={s.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}
            fill="none"
            stroke="#f59e0b"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity="0.9"
          />
        ) : (
          <circle key={`ts-${i}`} cx={s[0][0]} cy={s[0][1]} r="3" fill="#f59e0b" />
        )
      )}

      {points.length >= 2 && (
        <polyline points={phLine} fill="none" stroke="#4ade80" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      )}

      {points.length === 1 && (
        <circle cx={x(points[0].t)} cy={y(points[0].ph)} r="4" fill="#4ade80" />
      )}
    </>
  );
}

// X-akse-etiketter tilpasset det synlige spænd: klokkeslæt for timer,
// ugedag + klokkeslæt for et døgn, dato for uge/måned.
function fmtAxis(t, spanMs) {
  const d = new Date(t);
  if (spanMs <= 12 * 3600e3) {
    return d.toLocaleString('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  }
  if (spanMs <= 3 * 24 * 3600e3) {
    return d.toLocaleString('da-DK', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });
  }
  return d.toLocaleString('da-DK', { day: 'numeric', month: 'short', timeZone: TZ });
}

// Pænt aksespring (1/2/5 × 10ⁿ) så temperaturaksen får ca. 4 mærker.
function niceStep(range, target = 4) {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let s;
  if (norm < 1.5) s = 1;
  else if (norm < 3) s = 2;
  else if (norm < 7) s = 5;
  else s = 10;
  return s * mag;
}
