'use client';

import { useRef, useState } from 'react';

const TZ = 'Europe/Copenhagen';
// Acceptabelt pH-interval, og det optimale "sweet spot" indeni (centreret om
// idealet 5,8). Bemærk: alle labels udledes af disse konstanter, så teksten
// aldrig kan drive ud af sync med båndene.
const TARGET_LO = 5.5;
const TARGET_HI = 6.2;
const OPT_LO = 5.7;
const OPT_HI = 5.9;
const BAND = '#4ade80';

// Formatér et pH-tal med dansk decimalkomma til labels.
const phLabel = v => v.toLocaleString('da-DK', { minimumFractionDigits: 1 });
// pH-down doseringssøjler i violet — tydeligt adskilt fra den grønne og gule kurve.
const DOSE = '#a78bfa';
// EC-linje i cyan — adskilt fra grøn pH, gul temperatur og violette søjler.
const EC = '#38bdf8';
// Gødningsfarver — indbyrdes distinkte og adskilt fra pH-down (violet).
const FERT = { micro: '#ec4899', grow: '#2dd4bf', bloom: '#fb923c' };
const FERT_LABELS = { micro: 'Micro', grow: 'Grow', bloom: 'Bloom' };
const FERT_ORDER = ['micro', 'grow', 'bloom']; // stakkes nedefra og op
// Andel af plothøjden nederst, der er reserveret til hver doseringsstribe.
const DOSE_BAND = 0.15;

const W = 760, H = 280;
// Bred højremargin til to højreakser (temperatur inderst, EC yderst).
const PADL = 38, PADR = 80, PADT = 12, PADB = 28;
const AXIS_GAP = 40; // afstand fra temperaturaksen ud til EC-aksen

// Interaktiv indpakning: håndterer træk-for-at-zoome og genbruger ChartBody
// til selve tegningen, så der kun findes én implementering af graf-koden.
export default function ChartZoom({ points, doses = [], bucketMs, windowStart, windowEnd }) {
  const svgRef = useRef(null);
  const [zoom, setZoom] = useState(null); // { start, end } i ms, eller null
  const [drag, setDrag] = useState(null); // { x0, x1 } i bruger-koordinater (0..W)
  const [hover, setHover] = useState(null); // nærmeste punkt under markøren, eller null
  const [hidden, setHidden] = useState({}); // { ph, temp, ec } → true når serien er skjult

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
  const hasEc = visible.some(p => p.ec != null);

  // Bucket doseringerne på det samme gitter som målingernes nedsampling: hele
  // vinduet delt i nB buckets, forankret til vinduets start, så de ikke flytter
  // sig ved zoom. pH-down og gødning holdes adskilt (hver sin skala). For
  // gødning summeres pr. kind, så bucketen kan stakkes Micro/Grow/Bloom.
  const bMs = bucketMs || (windowEnd - windowStart) / 400;
  const nB = Math.max(1, Math.round((windowEnd - windowStart) / bMs));
  const phBuckets = new Map();   // idx -> ml (ph_down)
  const fertBuckets = new Map(); // idx -> { micro, grow, bloom }
  for (const d of doses) {
    let idx = Math.floor((d.t - windowStart) / bMs);
    if (idx < 0) idx = 0;
    if (idx >= nB) idx = nB - 1;
    if (d.kind === 'ph_down') {
      phBuckets.set(idx, (phBuckets.get(idx) || 0) + d.ml);
    } else {
      const name = String(d.kind || '').split('-').pop(); // pump3-micro -> micro
      if (FERT_ORDER.includes(name)) {
        let b = fertBuckets.get(idx);
        if (!b) {
          b = { micro: 0, grow: 0, bloom: 0 };
          fertBuckets.set(idx, b);
        }
        b[name] += d.ml;
      }
    }
  }
  const phMax = phBuckets.size ? Math.max(...phBuckets.values()) : 0;
  const fertMax = fertBuckets.size
    ? Math.max(...[...fertBuckets.values()].map(b => b.micro + b.grow + b.bloom))
    : 0;
  const hasPh = phBuckets.size > 0;
  const hasFert = fertBuckets.size > 0;

  const legendItem = { display: 'flex', alignItems: 'center', gap: 6, opacity: 0.7 };
  const swatch = c => ({ width: 14, height: 2, background: c, display: 'inline-block' });

  // Klikbare serie-knapper: skjuler/viser en serie (og dermed dens akse).
  const toggle = key => setHidden(h => ({ ...h, [key]: !h[key] }));
  const seriesToggle = (color, label, key) => (
    <button
      onClick={() => toggle(key)}
      title={hidden[key] ? 'Vis' : 'Skjul'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'transparent',
        border: 'none',
        padding: 0,
        fontSize: 12,
        cursor: 'pointer',
        color: '#e8eaed',
        opacity: hidden[key] ? 0.35 : 0.85,
        textDecoration: hidden[key] ? 'line-through' : 'none'
      }}
    >
      <span style={swatch(color)} /> {label}
    </button>
  );
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
        {seriesToggle('#4ade80', 'pH', 'ph')}
        {hasTemp && seriesToggle('#f59e0b', 'Vandtemperatur', 'temp')}
        {hasEc && seriesToggle(EC, 'EC (mS/cm)', 'ec')}
        <span style={legendItem}>
          <span style={bandSwatch(0.18)} /> Acceptabelt {phLabel(TARGET_LO)}–{phLabel(TARGET_HI)}
        </span>
        <span style={legendItem}>
          <span style={bandSwatch(0.4)} /> Optimalt {phLabel(OPT_LO)}–{phLabel(OPT_HI)}
        </span>
        {hasPh && (
          <span style={legendItem}>
            <span style={{ width: 10, height: 12, background: DOSE, borderRadius: 1, display: 'inline-block' }} /> pH-ned (ml)
          </span>
        )}
        {hasFert && FERT_ORDER.map(name => (
          <span key={name} style={legendItem}>
            <span style={{ width: 10, height: 12, background: FERT[name], borderRadius: 1, display: 'inline-block' }} /> {FERT_LABELS[name]} (ml)
          </span>
        ))}
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
        <ChartBody
          points={visible}
          view0={view0}
          view1={view1}
          hover={drag ? null : hover}
          hidden={hidden}
          phBuckets={phBuckets}
          phMax={phMax}
          fertBuckets={fertBuckets}
          fertMax={fertMax}
          bucketMs={bMs}
          windowStart={windowStart}
          nB={nB}
        />
        {selW > 0 && (
          <rect x={selX} y={PADT} width={selW} height={H - PADT - PADB} fill="#e8eaed" opacity="0.12" />
        )}
      </svg>
    </div>
  );
}

// Ren tegnefunktion: akser, målbånd, gitter og kurverne for et givet
// tidsvindue. Skalaerne tilpasses de synlige punkter, så zoom også omregner Y.
// hidden.{ph,temp,ec} skjuler en serie og dens akse.
function ChartBody({ points, view0, view1, hover, hidden, phBuckets, phMax, fertBuckets, fertMax, bucketMs, windowStart, nB }) {
  const span = view1 - view0;
  const h = hidden || {};

  // Reservér separate striber nederst: pH-down nederst (uændret track/skala),
  // gødning ovenover med sin egen ml-skala, så en lille gødningsdosis er
  // læsbar ved siden af en større pH-down-dosis. Kun de striber, der har data,
  // reserveres — så kurverne beholder mest mulig plads.
  const fullH = H - PADT - PADB;
  const hasPh = phBuckets && phBuckets.size > 0;
  const hasFert = fertBuckets && fertBuckets.size > 0;
  const trackH = fullH * DOSE_BAND;
  const doseGap = 6;
  const baseline = H - PADB;
  const phBaseline = baseline;                                          // pH-down nederst
  const fertBaseline = hasPh ? baseline - trackH - doseGap : baseline;  // gødning ovenover
  let lineBottom = H - PADB;
  if (hasFert) lineBottom = fertBaseline - trackH - doseGap;
  else if (hasPh) lineBottom = baseline - trackH - doseGap;

  // pH-akse (venstre) er altid den lodrette ramme (målbånd, gitter). Selve
  // pH-linjen og aksens tal skjules, når pH er slået fra.
  const showPh = !h.ph;
  const phv = points.map(p => p.ph);
  let lo = Math.min(...phv, TARGET_LO) - 0.15;
  let hi = Math.max(...phv, TARGET_HI) + 0.15;
  if (hi - lo < 1) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.5;
    hi = mid + 0.5;
  }

  // Tilpas en uafhængig skala til data med lidt luft (og et minimumsspænd, så
  // en flad kurve ikke klistrer til kanten).
  const fitScale = (vals, minSpan) => {
    let a = Math.min(...vals);
    let b = Math.max(...vals);
    let s = b - a;
    if (s < minSpan) {
      const mid = (a + b) / 2;
      a = mid - minSpan / 2;
      b = mid + minSpan / 2;
      s = minSpan;
    }
    const pad = s * 0.1;
    return [a - pad, b + pad];
  };

  // Temperaturakse (indre højreakse).
  const temps = points.filter(p => p.temp != null).map(p => p.temp);
  const showTemp = temps.length > 0 && !h.temp;
  const [tLo, tHi] = showTemp ? fitScale(temps, 0.5) : [0, 1];

  // EC-akse (ydre højreakse) — egen skala, forskudt udad fra temperaturaksen.
  const ecs = points.filter(p => p.ec != null).map(p => p.ec);
  const showEc = ecs.length > 0 && !h.ec;
  const [eLo, eHi] = showEc ? fitScale(ecs, 0.2) : [0, 1];

  const x = t => PADL + ((t - view0) / (view1 - view0)) * (W - PADL - PADR);
  const y = v => PADT + (1 - (v - lo) / (hi - lo)) * (lineBottom - PADT);
  const yT = v => PADT + (1 - (v - tLo) / (tHi - tLo)) * (lineBottom - PADT);
  const yE = v => PADT + (1 - (v - eLo) / (eHi - eLo)) * (lineBottom - PADT);

  const tempAxisX = W - PADR;        // indre højreakse
  const ecAxisX = W - PADR + AXIS_GAP; // ydre højreakse

  const step = hi - lo < 2.5 ? 0.25 : 0.5;
  const yTicks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    yTicks.push(Number(v.toFixed(2)));
  }

  const ticksFor = (from, to) => {
    const st = niceStep(to - from);
    const dec = st < 0.1 ? 2 : 1;
    const out = [];
    for (let v = Math.ceil(from / st) * st; v <= to + 1e-9; v += st) {
      out.push({ v: Number(v.toFixed(3)), dec });
    }
    return out;
  };
  const tTicks = showTemp ? ticksFor(tLo, tHi) : [];
  const eTicks = showEc ? ticksFor(eLo, eHi) : [];

  const xTicks = [0, 1, 2, 3, 4].map(i => view0 + (i / 4) * span);

  const phLine = points.map(p => `${x(p.t).toFixed(1)},${y(p.ph).toFixed(1)}`).join(' ');

  // Bryd en kurve i segmenter hen over huller (manglende værdier), så linjen
  // ikke trækkes ned til nul. EC mangler for alt før i dag, så det er reglen.
  const segmentsOf = (key, yfn) => {
    const out = [];
    let seg = [];
    for (const p of points) {
      if (p[key] == null) {
        if (seg.length) {
          out.push(seg);
          seg = [];
        }
      } else {
        seg.push([x(p.t), yfn(p[key])]);
      }
    }
    if (seg.length) out.push(seg);
    return out;
  };
  const tempSegments = showTemp ? segmentsOf('temp', yT) : [];
  const ecSegments = showEc ? segmentsOf('ec', yE) : [];

  const renderSegments = (segs, color, prefix) =>
    segs.map((s, i) =>
      s.length >= 2 ? (
        <polyline
          key={`${prefix}-${i}`}
          points={s.map(pt => `${pt[0].toFixed(1)},${pt[1].toFixed(1)}`).join(' ')}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity="0.9"
        />
      ) : (
        <circle key={`${prefix}-${i}`} cx={s[0][0]} cy={s[0][1]} r="3" fill={color} />
      )
    );

  // Hover-udlæsning: lodret guide ved nærmeste punkt + tooltip med tidspunkt og
  // de synlige serier. Tooltip'en vendes til venstre, hvis den ellers ville
  // løbe ud over plotområdets højre kant.
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
    const lines = [{ text: tsStr, fill: '#e8eaed', opacity: 0.7 }];
    if (showPh) {
      lines.push({ text: `pH ${hover.ph.toFixed(2)}`, fill: '#4ade80', opacity: 1 });
    }
    if (showTemp && hover.temp != null) {
      lines.push({ text: `${hover.temp.toFixed(1)} °C`, fill: '#f59e0b', opacity: 1 });
    }
    if (showEc && hover.ec != null) {
      lines.push({ text: `EC ${hover.ec.toFixed(2)} mS/cm`, fill: EC, opacity: 1 });
    }
    // Doseringer i den bucket guiden står over — pH-down og hver gødningskind.
    let hidx = Math.floor((hover.t - windowStart) / bucketMs);
    if (hidx < 0) hidx = 0;
    if (hidx >= nB) hidx = nB - 1;
    const phMl = phBuckets.get(hidx);
    if (phMl) {
      lines.push({ text: `pH-ned ${phMl.toFixed(1).replace('.', ',')} ml`, fill: DOSE, opacity: 1 });
    }
    const fb = fertBuckets.get(hidx);
    if (fb) {
      for (const name of FERT_ORDER) {
        if (fb[name] > 0) {
          lines.push({
            text: `${FERT_LABELS[name]} ${fb[name].toFixed(1).replace('.', ',')} ml`,
            fill: FERT[name],
            opacity: 1
          });
        }
      }
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
        {showPh && <circle cx={hx} cy={y(hover.ph)} r="3.5" fill="#4ade80" />}
        {showTemp && hover.temp != null && <circle cx={hx} cy={yT(hover.temp)} r="3.5" fill="#f59e0b" />}
        {showEc && hover.ec != null && <circle cx={hx} cy={yE(hover.ec)} r="3.5" fill={EC} />}
        <rect x={bx} y={by} width={boxW} height={boxH} rx="4" fill="#0f1115" opacity="0.92" stroke="#2a2e37" strokeWidth="1" />
        {lines.map((l, i) => (
          <text key={i} x={bx + 8} y={by + 16 + i * 15} fill={l.fill} opacity={l.opacity} fontSize="11">
            {l.text}
          </text>
        ))}
      </g>
    );
  }

  // Doseringssøjler: pH-down nederst (violet, egen skala) og gødning ovenover
  // (stakket Micro/Grow/Bloom, egen skala). Hver stribe har sit eget ml-loft.
  const barWidthAt = tc => {
    const wPx = x(tc + bucketMs / 2) - x(tc - bucketMs / 2);
    return Math.max(1.5, Math.min(wPx * 0.7, 10));
  };
  let doseEls = null;
  if (hasPh || hasFert) {
    const els = [];
    if (hasPh) {
      els.push(
        <line key="ph-base" x1={PADL} y1={phBaseline} x2={W - PADR} y2={phBaseline} stroke="#e8eaed" strokeWidth="1" opacity="0.08" />,
        <text key="ph-max" x={PADL - 8} y={phBaseline - trackH} textAnchor="end" dominantBaseline="middle" fill={DOSE} opacity="0.8" fontSize="10">
          {phMax.toFixed(1).replace('.', ',')} ml
        </text>,
        <text key="ph-0" x={PADL - 8} y={phBaseline} textAnchor="end" dominantBaseline="middle" fill={DOSE} opacity="0.6" fontSize="10">
          0
        </text>
      );
      for (const [idx, ml] of phBuckets) {
        const tc = windowStart + (idx + 0.5) * bucketMs;
        if (tc < view0 || tc > view1) continue;
        const cx = x(tc);
        const barW = barWidthAt(tc);
        const barH = phMax > 0 ? (ml / phMax) * trackH : 0;
        els.push(<rect key={`ph-${idx}`} x={cx - barW / 2} y={phBaseline - barH} width={barW} height={barH} fill={DOSE} opacity="0.85" />);
      }
    }
    if (hasFert) {
      els.push(
        <line key="f-base" x1={PADL} y1={fertBaseline} x2={W - PADR} y2={fertBaseline} stroke="#e8eaed" strokeWidth="1" opacity="0.08" />,
        <text key="f-max" x={PADL - 8} y={fertBaseline - trackH} textAnchor="end" dominantBaseline="middle" fill="#e8eaed" opacity="0.55" fontSize="10">
          {fertMax.toFixed(1).replace('.', ',')} ml
        </text>
      );
      for (const [idx, b] of fertBuckets) {
        const tc = windowStart + (idx + 0.5) * bucketMs;
        if (tc < view0 || tc > view1) continue;
        const cx = x(tc);
        const barW = barWidthAt(tc);
        let yTop = fertBaseline;
        for (const name of FERT_ORDER) {
          const segMl = b[name];
          if (segMl <= 0) continue;
          const segH = fertMax > 0 ? (segMl / fertMax) * trackH : 0;
          els.push(<rect key={`f-${idx}-${name}`} x={cx - barW / 2} y={yTop - segH} width={barW} height={segH} fill={FERT[name]} opacity="0.9" />);
          yTop -= segH;
        }
      }
    }
    doseEls = <g>{els}</g>;
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
          {showPh && (
            <text x={PADL - 8} y={y(v)} textAnchor="end" dominantBaseline="middle" fill="#4ade80" opacity="0.7" fontSize="11">
              {v.toFixed(1)}
            </text>
          )}
        </g>
      ))}

      {tTicks.map(({ v, dec }) => (
        <g key={`t-${v}`}>
          <line x1={tempAxisX} y1={yT(v)} x2={tempAxisX + 4} y2={yT(v)} stroke="#f59e0b" strokeWidth="1" opacity="0.5" />
          <text x={tempAxisX + 8} y={yT(v)} textAnchor="start" dominantBaseline="middle" fill="#f59e0b" opacity="0.75" fontSize="11">
            {v.toFixed(dec)}
          </text>
        </g>
      ))}

      {eTicks.map(({ v, dec }) => (
        <g key={`e-${v}`}>
          <line x1={ecAxisX} y1={yE(v)} x2={ecAxisX + 4} y2={yE(v)} stroke={EC} strokeWidth="1" opacity="0.5" />
          <text x={ecAxisX + 8} y={yE(v)} textAnchor="start" dominantBaseline="middle" fill={EC} opacity="0.8" fontSize="11">
            {v.toFixed(dec)}
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

      {renderSegments(ecSegments, EC, 'es')}
      {renderSegments(tempSegments, '#f59e0b', 'ts')}

      {showPh && points.length >= 2 && (
        <polyline points={phLine} fill="none" stroke="#4ade80" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      )}

      {showPh && points.length === 1 && (
        <circle cx={x(points[0].t)} cy={y(points[0].ph)} r="4" fill="#4ade80" />
      )}

      {doseEls}
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
