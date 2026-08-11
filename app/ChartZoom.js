'use client';

import { useRef, useState } from 'react';

const TZ = 'Europe/Copenhagen';
// Acceptabelt pH-interval, og det optimale "sweet spot" indeni til tomater.
const TARGET_LO = 5.8;
const TARGET_HI = 6.3;
const OPT_LO = 6.0;
const OPT_HI = 6.2;
const BAND = '#4ade80';

const W = 760, H = 280;
const PADL = 38, PADR = 44, PADT = 12, PADB = 28;

// Interaktiv indpakning: håndterer træk-for-at-zoome og genbruger ChartBody
// til selve tegningen, så der kun findes én implementering af graf-koden.
export default function ChartZoom({ points, windowStart, windowEnd }) {
  const svgRef = useRef(null);
  const [zoom, setZoom] = useState(null); // { start, end } i ms, eller null
  const [drag, setDrag] = useState(null); // { x0, x1 } i bruger-koordinater (0..W)
  const [hover, setHover] = useState(null); // nærmeste punkt under markøren, eller null

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
    setHover(null);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onMove(e) {
    if (drag) {
      setDrag(d => (d ? { ...d, x1: pxOfClient(e.clientX) } : d));
      return;
    }
    if (!visible.length) {
      setHover(null);
      return;
    }
    const t = timeOfPx(pxOfClient(e.clientX));
    let nearest = visible[0];
    let best = Math.abs(nearest.t - t);
    for (const p of visible) {
      const d = Math.abs(p.t - t);
      if (d < best) {
        best = d;
        nearest = p;
      }
    }
    setHover(nearest);
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
  const bandSwatch = alpha => ({
    width: 14,
    height: 10,
    borderRadius: 2,
    background: `rgba(74, 222, 128, ${alpha})`,
    display: 'inline-block'
  });

  let selX = 0, selW = 0;
  if (drag) {
    const a = clampPx(Math.min(drag.x0, drag.x1));
    const b = clampPx(Math.max(drag.x0, drag.x1));
    selX = a;
    selW = b - a;
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, rowGap: 6, marginBottom: 8, fontSize: 12, alignItems: 'center' }}>
        <span style={legendItem}>
          <span style={swatch('#4ade80')} /> pH
        </span>
        {hasTemp && (
          <span style={legendItem}>
            <span style={swatch('#f59e0b')} /> Vandtemperatur
          </span>
        )}
        <span style={legendItem}>
          <span style={bandSwatch(0.18)} /> Acceptabelt 5,8–6,3
        </span>
        <span style={legendItem}>
          <span style={bandSwatch(0.4)} /> Optimalt 6,0–6,2
        </span>
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
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => {
          setDrag(null);
          setHover(null);
        }}
      >
        <ChartBody points={visible} view0={view0} view1={view1} hover={drag ? null : hover} />
        {selW > 0 && (
          <rect x={selX} y={PADT} width={selW} height={H - PADT - PADB} fill="#e8eaed" opacity="0.12" />
        )}
      </svg>
    </div>
  );
}

// Ren tegnefunktion: akser, målbånd, gitter og de to kurver for et givet
// tidsvindue. Skalaerne tilpasses de synlige punkter, så zoom også omregner Y.
function ChartBody({ points, view0, view1, hover }) {
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

  // Hover-udlæsning: lodret guide ved nærmeste punkt + tooltip med tidspunkt,
  // pH og vandtemperatur. Tooltip'en vendes til venstre for guiden, hvis den
  // ellers ville løbe ud over højre kant.
  let hoverEls = null;
  if (hover) {
    const hx = x(hover.t);
    const tsStr = new Date(hover.t).toLocaleString('da-DK', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: TZ
    });
    const lines = [
      { text: tsStr, fill: '#e8eaed', opacity: 0.7 },
      { text: `pH ${hover.ph.toFixed(2)}`, fill: '#4ade80', opacity: 1 }
    ];
    if (hover.temp != null) {
      lines.push({ text: `${hover.temp.toFixed(1)} °C`, fill: '#f59e0b', opacity: 1 });
    }

    const boxW = Math.max(...lines.map(l => l.text.length)) * 6.6 + 16;
    const boxH = lines.length * 15 + 8;
    let bx = hx + 10;
    if (bx + boxW > W - PADR) bx = hx - 10 - boxW;
    bx = Math.max(PADL, Math.min(bx, W - PADR - boxW));
    const by = PADT + 4;

    hoverEls = (
      <g>
        <line x1={hx} y1={PADT} x2={hx} y2={H - PADB} stroke="#e8eaed" strokeWidth="1" opacity="0.35" />
        <circle cx={hx} cy={y(hover.ph)} r="3.5" fill="#4ade80" />
        {hover.temp != null && <circle cx={hx} cy={yT(hover.temp)} r="3.5" fill="#f59e0b" />}
        <rect x={bx} y={by} width={boxW} height={boxH} rx="4" fill="#0f1115" opacity="0.92" stroke="#2a2e37" strokeWidth="1" />
        {lines.map((l, i) => (
          <text key={i} x={bx + 8} y={by + 16 + i * 15} fill={l.fill} opacity={l.opacity} fontSize="11">
            {l.text}
          </text>
        ))}
      </g>
    );
  }

  return (
    <>
      <rect
        x={PADL}
        y={y(TARGET_HI)}
        width={W - PADL - PADR}
        height={y(TARGET_LO) - y(TARGET_HI)}
        fill={BAND}
        opacity="0.10"
      />

      <rect
        x={PADL}
        y={y(OPT_HI)}
        width={W - PADL - PADR}
        height={y(OPT_LO) - y(OPT_HI)}
        fill={BAND}
        opacity="0.18"
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

      {hoverEls}
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
