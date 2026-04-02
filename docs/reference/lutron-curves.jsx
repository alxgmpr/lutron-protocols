import { useState, useMemo, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

// ─── CORRECTED: Domain is 0–0x7FFF (32767), NOT 0–0xFFFF ────────────
// The 0xFFFF values in knot arrays are padding/sentinel, not part of the curve.
// Evidence: repeated "end clamp" knots are at 0x7FFF, curves visually collapsed
// at 50% because we were evaluating past the end of the real domain.

const DOMAIN_MAX = 32767; // 0x7FFF = 100% brightness

const CURVES = {
  curve1: {
    name: "Curve 1 – Modified Halogen",
    short: "Modified Halogen",
    color: "#ff6b35",
    cct: {
      // Note: Curve 1 uses 0x7F7F (32639) not 0x7FFF (32767) — slightly different endpoint
      knots: [3, 3, 3, 208, 639, 1305, 2206, 8489, 32639, 32639, 65535],
      coeffs: [1798, 1794, 1940, 2047, 2117, 2397, 2691, 2802],
    },
    xy: {
      knots: [7, 7, 7, 58, 279, 885, 2593, 8644, 32767, 32767, 65535],
      x: [4917, 4637, 4561, 4326, 4220, 3979, 3781, 3711],
      y: [3222, 3274, 3367, 3375, 3417, 3405, 3388, 3365],
    },
  },
  curve2: {
    name: "Curve 2 – Finiré 2700K",
    short: "Finiré 2700K",
    color: "#e8c547",
    cct: {
      knots: [32, 32, 32, 1948, 4345, 7663, 18518, 32767, 32767, 65535, 65535],
      coeffs: [1784, 1760, 1999, 2226, 2520, 2688, 2720, null],
    },
  },
  curve3: {
    name: "Curve 3 – Finiré 3000K",
    short: "Finiré 3000K",
    color: "#7ecfb0",
    cct: {
      knots: [32, 32, 32, 1756, 7243, 18570, 32767, 32767, 65535, 65535, 65535],
      coeffs: [1794, 1764, 2278, 2759, 2991, 3040, null, null],
    },
  },
  curve5: {
    name: "Curve 5 – Default Warm Dim",
    short: "Default Warm Dim",
    color: "#a78bfa",
    cct: {
      knots: [32, 32, 32, 187, 607, 2162, 4713, 8223, 32767, 32767, 65535],
      coeffs: [1800, 1859, 1944, 2086, 2239, 2417, 2683, 2800],
    },
  },
};

// ─── B-Spline ────────────────────────────────────────────────────────

function bsplineBasis(knots, i, p, t) {
  if (p === 0) {
    // Special handling for last span
    if (i === knots.length - 2) return (t >= knots[i] && t <= knots[i + 1]) ? 1 : 0;
    return (t >= knots[i] && t < knots[i + 1]) ? 1 : 0;
  }
  let left = 0, right = 0;
  const d1 = knots[i + p] - knots[i];
  if (d1 > 0) left = ((t - knots[i]) / d1) * bsplineBasis(knots, i, p - 1, t);
  const d2 = knots[i + p + 1] - knots[i + 1];
  if (d2 > 0) right = ((knots[i + p + 1] - t) / d2) * bsplineBasis(knots, i + 1, p - 1, t);
  return left + right;
}

function evalBSpline(knots, coeffs, t) {
  const degree = knots.length - coeffs.length - 1;
  let val = 0;
  for (let i = 0; i < coeffs.length; i++) {
    val += coeffs[i] * bsplineBasis(knots, i, degree, t);
  }
  return val;
}

function getValidSpline(curve) {
  const { knots, coeffs } = curve.cct;
  const vc = coeffs.filter(c => c !== null);
  const numKnots = vc.length + 3; // degree 2: knots = coeffs + degree + 1
  const vk = knots.slice(0, numKnots);
  // Find the actual domain end (the repeated "clamp" knot, NOT the 0xFFFF padding)
  // For clamped degree-2: domain is [vk[2], vk[numKnots-3]]
  const domainEnd = vk[numKnots - 3]; // the start of the end-clamp repetition
  return { vk, vc, domainEnd, domainStart: vk[2] };
}

// ─── HA Automation: de Boor with normalized control points ───────────
// This is EXACTLY what the Jinja2 template computes

function evalHAAutomation(bri255, tMin, tMax) {
  const bri = Math.max(bri255, 1);
  const kn = [3.0, 3.0, 3.0, 208.0, 639.0, 1305.0, 2206.0, 8489.0, 32639.0, 32639.0, 65535.0];
  const cp = [0.0, -0.003984, 0.141434, 0.248008, 0.317729, 0.596614, 0.889442, 1.0];

  const t = 3.0 + (bri - 1.0) / 254.0 * 32636.0;

  // Find knot span
  let s = 2;
  if      (t >= kn[7]) s = 7;
  else if (t >= kn[6]) s = 6;
  else if (t >= kn[5]) s = 5;
  else if (t >= kn[4]) s = 4;
  else if (t >= kn[3]) s = 3;

  // De Boor: 3 lerps
  const a1 = (kn[s+1] !== kn[s-1]) ? (t - kn[s-1]) / (kn[s+1] - kn[s-1]) : 0;
  const a2 = (kn[s+2] !== kn[s])   ? (t - kn[s])   / (kn[s+2] - kn[s])   : 0;
  const a3 = (kn[s+1] !== kn[s])   ? (t - kn[s])   / (kn[s+1] - kn[s])   : 0;
  const d1 = (1 - a1) * cp[s-2] + a1 * cp[s-1];
  const d2 = (1 - a2) * cp[s-1] + a2 * cp[s];
  const v  = (1 - a3) * d1       + a3 * d2;

  return Math.round(tMin + Math.max(v, 0) * (tMax - tMin));
}

// ─── Reference Curves ────────────────────────────────────────────────

function stefanBoltzmann(pct, tMin, tMax) {
  if (pct <= 0) return tMin;
  if (pct >= 1) return tMax;
  const pMin = Math.pow(tMin / tMax, 4);
  const pFrac = pMin + pct * (1 - pMin);
  return tMax * Math.pow(pFrac, 0.25);
}

function mccaseyPower(pct, cctMin, cctMax, bend) {
  if (pct <= 0) return cctMin;
  if (pct >= 1) return cctMax;
  const ratio = (bend - cctMin) / (cctMax - cctMin);
  const gamma = Math.log(ratio) / Math.log(0.5);
  return cctMin + (cctMax - cctMin) * Math.pow(pct, gamma);
}

// ─── Planckian Locus ─────────────────────────────────────────────────

function planckianXY(T) {
  let x;
  if (T >= 1667 && T <= 4000) {
    x = -0.2661239e9/(T*T*T) - 0.2343589e6/(T*T) + 0.8776956e3/T + 0.179910;
  } else {
    x = -3.0258469e9/(T*T*T) + 2.1070379e6/(T*T) + 0.2226347e3/T + 0.24039;
  }
  let y;
  if (T >= 1667 && T <= 2222) {
    y = -1.1063814*x*x*x - 1.34811020*x*x + 2.18555832*x - 0.20219683;
  } else if (T <= 4000) {
    y = -0.9549476*x*x*x - 1.37418593*x*x + 2.09137015*x - 0.16748867;
  } else {
    y = 3.0817580*x*x*x - 5.87338670*x*x + 3.75112997*x - 0.37001483;
  }
  return { x, y };
}

// ─── Data Generation ─────────────────────────────────────────────────

// generateData is now inlined in the component's useMemo for reactivity to sbMin/sbMax

function generateXY(steps = 300) {
  const arr = [];
  const c = CURVES.curve1;
  const { knots, x: xC, y: yC } = c.xy;
  // XY domain: knots[2] to the repeated clamp knot
  const domainStart = knots[2]; // 7
  const domainEnd = knots[8]; // 32767
  for (let i = 0; i <= steps; i++) {
    const pct = i / steps;
    const t = domainStart + pct * (domainEnd - domainStart);
    if (t >= knots[0] && t <= knots[knots.length - 1]) {
      try {
        const cx = evalBSpline(knots, xC, t) / 10000;
        const cy = evalBSpline(knots, yC, t) / 10000;
        if (isFinite(cx) && isFinite(cy) && cx > 0.2 && cx < 0.7) {
          arr.push({ pct: Math.round(pct*1000)/10, x: cx, y: cy });
        }
      } catch(e) {}
    }
  }
  return arr;
}

function generatePlanckian() {
  const arr = [];
  for (let T = 1500; T <= 7000; T += 20) {
    const { x, y } = planckianXY(T);
    arr.push({ T, x, y });
  }
  return arr;
}

// ─── Knot percentage helper ──────────────────────────────────────────

function getKnotPcts(curve) {
  const { vk, vc, domainEnd, domainStart } = getValidSpline(curve);
  const range = domainEnd - domainStart;
  return vk.map((k, i) => ({
    raw: k,
    pct: Math.min(100, Math.max(0, ((k - domainStart) / range) * 100)),
    isCP: i < vc.length,
    cct: i < vc.length ? vc[i] : null,
  }));
}

// ─── Labels & Config ─────────────────────────────────────────────────

const LABELS = {
  curve1: "Modified Halogen", curve2: "Finiré 2700K", curve3: "Finiré 3000K", curve5: "Default Warm Dim",
  sb_custom: "Stefan-Boltzmann T⁴", ha_deboor: "HA Automation (de Boor)", mc_power: "McCasey (2500→5000K)",
};

const LINES = [
  { key: "curve1", color: "#ff6b35", w: 2.5 },
  { key: "ha_deboor", color: "#00e5ff", w: 2, dash: "6 3" },
  { key: "curve5", color: "#a78bfa", w: 2 },
  { key: "curve2", color: "#e8c547", w: 2 },
  { key: "curve3", color: "#7ecfb0", w: 2 },
  { key: "sb_custom", color: "#ffffff", w: 1.5, dash: "8 4" },
  { key: "mc_power", color: "#ff4d6a", w: 2, dash: "4 2" },
];

// ─── Components ──────────────────────────────────────────────────────

const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#12121e", border: "1px solid #2a2a3e", borderRadius: 6, padding: "7px 11px", fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.7 }}>
      <div style={{ color: "#555", marginBottom: 2 }}>{label}% brightness</div>
      {payload.filter(p => p.value != null && p.value > 500).map((p, i) => (
        <div key={i} style={{ color: p.stroke }}>{p.name || LABELS[p.dataKey] || p.dataKey}: <b>{p.value}K</b></div>
      ))}
    </div>
  );
};

const KnotBar = ({ curve }) => {
  const pcts = getKnotPcts(curve);
  const vc = curve.cct.coeffs.filter(c => c !== null);
  const seen = new Set();
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: curve.color }} />
        <span style={{ color: "#bbb", fontSize: 11.5 }}>{curve.short}</span>
        <span style={{ color: "#555", fontSize: 10, fontFamily: "monospace" }}>{vc[0]}K → {vc[vc.length-1]}K</span>
      </div>
      <div style={{ position: "relative", height: 26, background: "#0a0a14", borderRadius: 3, border: "1px solid #1a1a2e" }}>
        <div style={{ position: "absolute", inset: 0, background: `linear-gradient(to right, ${curve.color}18, ${curve.color}05)` }} />
        {pcts.map((k, i) => {
          const s = k.pct.toFixed(1);
          if (seen.has(s) || k.pct > 100) return null;
          seen.add(s);
          return (
            <div key={i} style={{ position: "absolute", left: `${k.pct}%`, top: 0, bottom: 0 }}>
              <div style={{ width: 2, height: "100%", background: curve.color, opacity: 0.8 }} />
              {k.pct > 1 && k.pct < 99 && (
                <div style={{ position: "absolute", top: -14, left: -8, fontSize: 8, color: "#666", fontFamily: "monospace", whiteSpace: "nowrap" }}>
                  {Math.round(k.pct)}%
                </div>
              )}
            </div>
          );
        })}
        {[25, 50, 75].map(m => (
          <div key={m} style={{ position: "absolute", left: `${m}%`, top: 0, bottom: 0, width: 1, background: "#fff", opacity: 0.06 }} />
        ))}
        <div style={{ position: "absolute", left: 4, bottom: 2, fontSize: 9, color: "#444" }}>0%</div>
        <div style={{ position: "absolute", right: 4, bottom: 2, fontSize: 9, color: "#444" }}>100%</div>
      </div>
    </div>
  );
};

const CPTable = ({ curve }) => {
  const pcts = getKnotPcts(curve);
  const vc = curve.cct.coeffs.filter(c => c !== null);
  const { domainStart, domainEnd } = getValidSpline(curve);
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ color: curve.color, fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{curve.name}</div>
      <div style={{ fontSize: 10, color: "#555", marginBottom: 6, fontFamily: "monospace" }}>
        Domain: {domainStart}–{domainEnd} (0x{domainStart.toString(16)}–0x{domainEnd.toString(16)})
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" }}>
        <thead><tr>{["CP#", "CCT (K)", "Hex", "≈ Brightness"].map(h =>
          <th key={h} style={{ textAlign: "left", padding: "3px 8px", color: "#555", borderBottom: "1px solid #1a1a2e", fontWeight: 500 }}>{h}</th>
        )}</tr></thead>
        <tbody>{vc.map((c, i) => (
          <tr key={i}>
            <td style={{ padding: "2px 8px", color: "#777" }}>{i}</td>
            <td style={{ padding: "2px 8px", color: curve.color }}>{c}K</td>
            <td style={{ padding: "2px 8px", color: "#444" }}>0x{c.toString(16).toUpperCase()}</td>
            <td style={{ padding: "2px 8px", color: "#888" }}>~{Math.round(pcts[i]?.pct || 0)}%</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
};

// ─── Comparison Table for HA automation ──────────────────────────────

const ComparisonTable = ({ sbMin, sbMax }) => {
  const pcts = [1, 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100];

  const rows = pcts.map(p => {
    const pct = p / 100;
    const row = { pct: p };

    for (const [key, curve] of Object.entries(CURVES)) {
      const { vk, vc, domainEnd, domainStart } = getValidSpline(curve);
      const t = domainStart + pct * (domainEnd - domainStart);
      if (t >= vk[0] && t <= vk[vk.length - 1]) {
        try {
          const v = evalBSpline(vk, vc, t);
          if (isFinite(v) && v > 500) row[key] = Math.round(v);
        } catch(e) {}
      }
    }

    row.sb_custom = Math.round(stefanBoltzmann(pct, sbMin, sbMax));
    row.ha_deboor = evalHAAutomation(Math.max(1, Math.round(p * 255 / 100)), sbMin, sbMax);
    return row;
  });

  const cols = [
    { key: "pct", label: "Brightness", color: "#888" },
    { key: "curve1", label: "Mod. Halogen", color: "#ff6b35" },
    { key: "ha_deboor", label: "HA Automation", color: "#00e5ff" },
    { key: "curve5", label: "Default", color: "#a78bfa" },
    { key: "curve2", label: "Finiré 2700", color: "#e8c547" },
    { key: "curve3", label: "Finiré 3000", color: "#7ecfb0" },
    { key: "sb_custom", label: `T⁴ ${sbMin}→${sbMax}K`, color: "#fff" },
  ];

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: "'IBM Plex Mono', monospace" }}>
        <thead><tr>{cols.map(c => (
          <th key={c.key} style={{ textAlign: "right", padding: "4px 6px", color: c.color, borderBottom: "1px solid #1a1a2e", fontWeight: 600, fontSize: 10 }}>{c.label}</th>
        ))}</tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.pct} style={{ borderBottom: "1px solid #0e0e18" }}>
            {cols.map(c => (
              <td key={c.key} style={{ textAlign: "right", padding: "3px 6px", color: c.key === "pct" ? "#888" : c.color }}>
                {c.key === "pct" ? `${r.pct}%` : (r[c.key] ? `${r[c.key]}K` : "—")}
              </td>
            ))}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
};

// ─── Main ────────────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState("cct");
  const [zoom, setZoom] = useState("full");
  const [sbMin, setSbMin] = useState(1900);
  const [sbMax, setSbMax] = useState(2900);
  const [show, setShow] = useState({
    curve1: true, curve2: false, curve3: false, curve5: false,
    ha_deboor: true, sb_custom: true, mc_power: false,
  });

  const data = useMemo(() => {
    const arr = [];
    for (let i = 0; i <= 600; i++) {
      const pct = i / 600;
      const pctR = Math.round(pct * 1000) / 10;
      const pt = { pct: pctR };

      pt.sb_custom = Math.round(stefanBoltzmann(pct, sbMin, sbMax));

      // HA automation output (de Boor with normalized CPs)
      const bri255 = Math.max(1, Math.round(pct * 255));
      pt.ha_deboor = evalHAAutomation(bri255, sbMin, sbMax);

      pt.mc_power = Math.round(mccaseyPower(pct, 2500, 5000, 2900));

      for (const [key, curve] of Object.entries(CURVES)) {
        const { vk, vc, domainEnd, domainStart } = getValidSpline(curve);
        const t = domainStart + pct * (domainEnd - domainStart);
        if (t >= vk[0] && t <= vk[vk.length - 1]) {
          try {
            const v = evalBSpline(vk, vc, t);
            if (isFinite(v) && v > 500 && v < 10000) pt[key] = Math.round(v);
          } catch(e) {}
        }
      }
      arr.push(pt);
    }
    return arr;
  }, [sbMin, sbMax]);
  const xyData = useMemo(() => generateXY(400), []);
  const planckian = useMemo(() => generatePlanckian(), []);
  const toggle = useCallback(k => setShow(s => ({ ...s, [k]: !s[k] })), []);

  const filtered = zoom === "low20" ? data.filter(d => d.pct <= 20)
    : zoom === "low5" ? data.filter(d => d.pct <= 5) : data;

  const tabs = [
    { id: "cct", label: "CCT vs Intensity" },
    { id: "xy", label: "CIE xy Chromaticity" },
    { id: "knots", label: "Knot Distribution" },
    { id: "data", label: "Control Points" },
    { id: "table", label: "HA Lookup Table" },
  ];

  const S = { bg: "#08080f", card: "#0c0c16", border: "#1a1a2e", accent: "#ff6b35" };

  return (
    <div style={{ minHeight: "100vh", background: S.bg, color: "#ddd", fontFamily: "'IBM Plex Sans', system-ui", padding: "20px 16px" }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <div style={{ maxWidth: 940, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <div style={{ width: 4, height: 24, background: S.accent, borderRadius: 2 }} />
            <h1 style={{ fontSize: 19, fontWeight: 600, margin: 0, letterSpacing: "-0.02em" }}>Lutron Warm Dim Curve Explorer</h1>
          </div>
          <p style={{ color: "#555", fontSize: 11, margin: "2px 0 0 14px", fontFamily: "'IBM Plex Mono', monospace" }}>
            SqlModelInfo.mdf v26.1.0.112 · Quadratic B-spline (deg 2) · Domain: 0–0x7FFF
          </p>
          <div style={{ margin: "8px 0 0 14px", padding: "8px 12px", background: "#1a0a00", border: "1px solid #3a2000", borderRadius: 4, fontSize: 11, color: "#ff9955" }}>
            ⚠ <strong>Corrected:</strong> Knot domain is 0–0x7FFF (32767), not 0–0xFFFF. The trailing 0xFFFF values are padding.
            This fixes the "cliff at 50%" — what appeared as 50% was actually 100% brightness.
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 2, marginBottom: 14, background: "#0e0e18", borderRadius: 6, padding: 3, border: `1px solid ${S.border}` }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setView(t.id)} style={{
              flex: 1, padding: "6px 6px", border: "none", borderRadius: 4, fontSize: 11, fontWeight: 500, cursor: "pointer",
              background: view === t.id ? S.accent : "transparent", color: view === t.id ? "#fff" : "#666",
            }}>{t.label}</button>
          ))}
        </div>

        {/* ── CCT ── */}
        {view === "cct" && <>
          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
            {LINES.map(({ key, color }) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 10.5 }}>
                <input type="checkbox" checked={show[key]} onChange={() => toggle(key)} style={{ accentColor: color, width: 12, height: 12 }} />
                <span style={{ color: show[key] ? color : "#444" }}>{LABELS[key]}</span>
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 3, marginBottom: 10 }}>
            {[["full","0–100%"],["low20","0–20%"],["low5","0–5%"]].map(([z,l]) => (
              <button key={z} onClick={() => setZoom(z)} style={{
                padding: "3px 9px", border: `1px solid ${zoom===z ? S.accent : S.border}`, borderRadius: 3, fontSize: 10, cursor: "pointer",
                background: zoom===z ? `${S.accent}20` : "transparent", color: zoom===z ? S.accent : "#555",
              }}>{l}</button>
            ))}
          </div>

          {/* Stefan-Boltzmann Parameter Controls */}
          <div style={{ marginBottom: 12, padding: "10px 14px", background: "#0e0e18", borderRadius: 6, border: `1px solid ${S.border}`, display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#fff", whiteSpace: "nowrap" }}>T⁴ Curve</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 200 }}>
              <label style={{ fontSize: 10, color: "#888", whiteSpace: "nowrap", minWidth: 28 }}>Min</label>
              <input type="range" min={1400} max={2400} step={25} value={sbMin}
                onChange={e => setSbMin(Number(e.target.value))}
                style={{ flex: 1, accentColor: "#fff", height: 4 }} />
              <span style={{ fontSize: 11, fontFamily: "monospace", color: "#fff", minWidth: 48, textAlign: "right" }}>{sbMin}K</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 200 }}>
              <label style={{ fontSize: 10, color: "#888", whiteSpace: "nowrap", minWidth: 28 }}>Max</label>
              <input type="range" min={2400} max={5000} step={25} value={sbMax}
                onChange={e => setSbMax(Number(e.target.value))}
                style={{ flex: 1, accentColor: "#fff", height: 4 }} />
              <span style={{ fontSize: 11, fontFamily: "monospace", color: "#fff", minWidth: 48, textAlign: "right" }}>{sbMax}K</span>
            </div>
            <button onClick={() => { setSbMin(1800); setSbMax(2800); }} style={{
              padding: "3px 8px", border: `1px solid ${S.border}`, borderRadius: 3, fontSize: 9, cursor: "pointer",
              background: "transparent", color: "#555",
            }}>1800–2800</button>
            <button onClick={() => { setSbMin(1900); setSbMax(2900); }} style={{
              padding: "3px 8px", border: `1px solid ${S.border}`, borderRadius: 3, fontSize: 9, cursor: "pointer",
              background: "transparent", color: "#555",
            }}>1900–2900</button>
            <button onClick={() => { setSbMin(1800); setSbMax(3000); }} style={{
              padding: "3px 8px", border: `1px solid ${S.border}`, borderRadius: 3, fontSize: 9, cursor: "pointer",
              background: "transparent", color: "#555",
            }}>1800–3000</button>
            <button onClick={() => { setSbMin(2000); setSbMax(3500); }} style={{
              padding: "3px 8px", border: `1px solid ${S.border}`, borderRadius: 3, fontSize: 9, cursor: "pointer",
              background: "transparent", color: "#555",
            }}>2000–3500</button>
          </div>
          <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 8, padding: "10px 2px 2px 0" }}>
            <ResponsiveContainer width="100%" height={440}>
              <LineChart data={filtered} margin={{ top: 8, right: 14, left: 6, bottom: 18 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#13131f" />
                <XAxis dataKey="pct" stroke="#333" fontSize={10} tickFormatter={v => `${v}%`}
                  label={{ value: "Brightness (%)", position: "bottom", offset: 0, style: { fill: "#444", fontSize: 10 } }} />
                <YAxis stroke="#333" fontSize={10} domain={['dataMin - 50', 'dataMax + 100']} tickFormatter={v => `${v}K`}
                  label={{ value: "CCT (Kelvin)", angle: -90, position: "insideLeft", offset: 10, style: { fill: "#444", fontSize: 10 } }} />
                <Tooltip content={<Tip />} />
                {LINES.map(({ key, color, w, dash }) =>
                  show[key] && <Line key={key} type="monotone" dataKey={key} stroke={color} strokeWidth={w}
                    strokeDasharray={dash} dot={false} connectNulls isAnimationActive={false}
                    name={key === "sb_custom" ? `T⁴ (${sbMin}→${sbMax}K)` : key === "ha_deboor" ? `HA Automation (${sbMin}→${sbMax}K)` : LABELS[key]} />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div style={{ padding: 10, background: "#0e0e18", borderRadius: 6, border: `1px solid ${S.border}`, fontSize: 11, color: "#888", lineHeight: 1.7 }}>
              <div style={{ fontWeight: 600, color: "#fff", marginBottom: 4 }}>Stefan-Boltzmann T⁴ (white dashed)</div>
              Currently set to <strong style={{ color: "#fff" }}>{sbMin}K → {sbMax}K</strong>. Use the sliders above to shape-match against the Lutron curves. The T⁴ curve is pure physics — you can see where Lutron deviates from it to better match human perception.
            </div>
            <div style={{ padding: 10, background: "#0e0e18", borderRadius: 6, border: `1px solid ${S.border}`, fontSize: 11, color: "#888", lineHeight: 1.7 }}>
              <div style={{ fontWeight: 600, color: "#00e5ff", marginBottom: 4 }}>HA Automation Overlay (cyan dashed)</div>
              The <span style={{ color: "#00e5ff" }}>cyan dashed line</span> is the exact output of your Jinja2 template — de Boor's algorithm with normalized control points, scaled to {sbMin}K → {sbMax}K. When endpoints match Curve 1's native range (1800/2800), it should overlap the orange line exactly. Adjust the sliders to see how the curve shape scales to different ranges.
            </div>
          </div>
        </>}

        {/* ── CIE xy ── */}
        {view === "xy" && <>
          <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 8, padding: "10px 2px 2px 0" }}>
            <ResponsiveContainer width="100%" height={460}>
              <LineChart margin={{ top: 8, right: 14, left: 6, bottom: 18 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#13131f" />
                <XAxis dataKey="x" type="number" domain={[0.3, 0.56]} stroke="#333" fontSize={10} tickCount={10}
                  label={{ value: "CIE x", position: "bottom", offset: 0, style: { fill: "#444", fontSize: 10 } }} />
                <YAxis dataKey="y" type="number" domain={[0.3, 0.44]} stroke="#333" fontSize={10} tickCount={8}
                  label={{ value: "CIE y", angle: -90, position: "insideLeft", offset: 10, style: { fill: "#444", fontSize: 10 } }} />
                <Tooltip content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0]?.payload;
                  return (
                    <div style={{ background: "#12121e", border: "1px solid #2a2a3e", borderRadius: 6, padding: "6px 10px", fontSize: 11, fontFamily: "monospace" }}>
                      {p.T && <div style={{ color: "#666" }}>{p.T}K</div>}
                      {p.pct != null && <div style={{ color: S.accent }}>{p.pct}% brightness</div>}
                      <div style={{ color: "#ccc" }}>x={p.x?.toFixed(4)} y={p.y?.toFixed(4)}</div>
                    </div>
                  );
                }} />
                <Line data={planckian} dataKey="y" stroke="#444" strokeWidth={3} dot={false} isAnimationActive={false} />
                <Line data={xyData} dataKey="y" stroke={S.accent} strokeWidth={2.5} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div style={{ marginTop: 10, padding: 12, background: "#0e0e18", borderRadius: 6, border: `1px solid ${S.border}`, fontSize: 11, color: "#888", lineHeight: 1.7 }}>
            <span style={{ fontWeight: 600, color: S.accent }}>Curve 1 sits below the Planckian locus</span> — matching real halogen chromaticity.
            The xy coefficients (÷10000) give x: 0.37–0.49, y: 0.32–0.34. A pure black body at these CCTs would have y≈0.38–0.41.
            This intentional shift toward amber/pink is only achievable with Ketra's RGBW emitter.
            Your Wiz bulb (CCT-only) will stay on the Planckian locus regardless — the xy data is interesting for understanding Lutron's approach but won't affect your automation.
          </div>
        </>}

        {/* ── Knots ── */}
        {view === "knots" && <>
          <div style={{ padding: 14, background: S.card, border: `1px solid ${S.border}`, borderRadius: 8 }}>
            <div style={{ fontSize: 11, color: "#555", marginBottom: 12 }}>
              Knot positions mapped to 0–100% brightness (corrected domain). Dense clustering = more spline resolution.
            </div>
            {Object.entries(CURVES).map(([k,c]) => <KnotBar key={k} curve={c} />)}
          </div>
          <div style={{ marginTop: 10, padding: 12, background: "#0e0e18", borderRadius: 6, border: `1px solid ${S.border}`, fontSize: 11, color: "#888", lineHeight: 1.7 }}>
            With the corrected domain, Curve 5's knots land at: <strong style={{ color: "#e0e0e0" }}>0.6%, 1.9%, 6.6%, 14.4%, 25.1%, 100%</strong>.
            This is a much more sensible distribution — heavy resolution in the bottom quarter where color shift is most visible,
            then a single long span from 25% to 100% where the eye is less sensitive to CCT changes at higher brightness.
          </div>
        </>}

        {/* ── Control Points ── */}
        {view === "data" && (
          <div style={{ padding: 14, background: S.card, border: `1px solid ${S.border}`, borderRadius: 8 }}>
            {Object.entries(CURVES).map(([k,c]) => <CPTable key={k} curve={c} />)}
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${S.border}` }}>
              <div style={{ color: "#ff4d6a", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Curve 4 – McCasey</div>
              <div style={{ fontSize: 11, fontFamily: "monospace", color: "#aaa" }}>
                cctMin: <span style={{ color: "#7ecfb0" }}>2500K</span> · cctMax: <span style={{ color: "#7ecfb0" }}>5000K</span> · bend: <span style={{ color: "#7ecfb0" }}>2900</span>
              </div>
              <div style={{ fontSize: 11, color: "#555", marginTop: 4 }}>No spline. Different use case — tunable white "Daylight" mode, not warm dim.</div>
            </div>
          </div>
        )}

        {/* ── HA Lookup Table ── */}
        {view === "table" && (
          <div style={{ padding: 14, background: S.card, border: `1px solid ${S.border}`, borderRadius: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: S.accent, marginBottom: 4 }}>CCT Lookup Table for Home Assistant</div>
            <div style={{ fontSize: 11, color: "#666", marginBottom: 12 }}>
              Evaluated at common brightness levels. Use these values for piecewise-linear interpolation in your Jinja template.
            </div>
            <ComparisonTable sbMin={sbMin} sbMax={sbMax} />
            <div style={{ marginTop: 12, fontSize: 11, color: "#555", lineHeight: 1.6 }}>
              T⁴ column uses your configured range ({sbMin}K → {sbMax}K). Adjust the sliders on the CCT chart tab to tune.
              For your Wiz bulb, set Min to your desired warmest point and Max to your desired coolest point.
            </div>
          </div>
        )}

        <div style={{ marginTop: 20, borderTop: "1px solid #111", paddingTop: 10, fontSize: 10, color: "#333", fontFamily: "monospace" }}>
          Lutron Designer v26.1.0.112 · Domain corrected: 0x0000–0x7FFF · Trailing 0xFFFF = padding
        </div>
      </div>
    </div>
  );
}
