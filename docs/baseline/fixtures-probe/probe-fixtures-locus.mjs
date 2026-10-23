// Precise image locus per fixture: scans a screen window at 1 px, follows every
// crossing branch, and interpolates the row where the traced ray crosses the
// emitter's radius. Reports the columns that also satisfy the azimuth, i.e. the
// actual image of the finite patch. Read-only.

const PROJECT = 'file:///C:/Yu/dsh-blackhole-radio-lab';
const quiet = async (s) => { const o = console.log; console.log = () => {}; try { return await import(s); } finally { console.log = o; } };
const { integrateCartesian } = await quiet(`${PROJECT}/tools/validate-imaging.mjs`);

const RSW = 2 / (3 * Math.sqrt(3));
const W = 1280, H = 720, TAN = Math.tan((42 * Math.PI) / 360), ASPECT = W / H;
const CAM = [0.856, 0.401, 8.146];
const C = [CAM[0] / RSW, -CAM[2] / RSW, CAM[1] / RSW];
const R_CAM = Math.hypot(...C);
const SQ = Math.sqrt(1 - 1 / R_CAM);
const ER = C.map((x) => x / R_CAM);
const n = (v) => { const m = Math.hypot(...v); return v.map((x) => x / m); };
const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const fwd = n(C.map((x) => -x));
const right = n(cr(fwd, [0, 0, 1]));
const camUp = cr(right, fwd);

function trace(px, py) {
  const u = (2 * px) / W - 1, v = 1 - (2 * py) / H;
  const d = n([
    fwd[0] + right[0] * u * TAN * ASPECT + camUp[0] * v * TAN,
    fwd[1] + right[1] * u * TAN * ASPECT + camUp[1] * v * TAN,
    fwd[2] + right[2] * u * TAN * ASPECT + camUp[2] * v * TAN,
  ]);
  const dr = d[0] * ER[0] + d[1] * ER[1] + d[2] * ER[2];
  const chart = [d[0] + (SQ - 1) * dr * ER[0], d[1] + (SQ - 1) * dr * ER[1], d[2] + (SQ - 1) * dr * ER[2]];
  const res = integrateCartesian(C, chart, { rMax: 200 });
  return res.crossings.map((c, i) => {
    const xw = c.point[0] * RSW, zw = -c.point[1] * RSW;
    return { branch: i + 1, r: Math.hypot(xw, zw), phi: Math.atan2(xw, zw) };
  });
}

const thetaCam = Math.atan2(CAM[0], CAM[2]);
const RHO = 0.04;
const fixtures = [
  { id: 'N_near', r: 2.6, phi: thetaCam + 0.55, py: 377, px0: 790, px1: 920 },
  { id: 'F_far', r: 3.2, phi: thetaCam + Math.PI + 0.55, py: 349, px0: 400, px1: 620 },
  { id: 'A_axis_b1', r: 1.6, phi: thetaCam + Math.PI, py: 206, px0: 540, px1: 740, branch: 1 },
  { id: 'A_axis_b2', r: 1.6, phi: thetaCam + Math.PI, py: 510, px0: 540, px1: 740, branch: 2 },
  { id: 'W_weak', r: 4.2, phi: thetaCam + 1.5, py: 362, px0: 1100, px1: 1270 },
];

const dphi = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

for (const fx of fixtures) {
  const hits = new Map();
  for (let px = fx.px0; px <= fx.px1; px += 1) {
    const samples = new Map();
    for (let y = fx.py - 70; y <= fx.py + 70; y += 1) {
      for (const c of trace(px, y)) {
        if (!samples.has(c.branch)) samples.set(c.branch, []);
        samples.get(c.branch).push({ y, ...c });
      }
    }
    for (const [branch, list] of samples) {
      if (fx.branch && branch !== fx.branch) continue;
      for (let i = 1; i < list.length; i += 1) {
        const a = list[i - 1], b = list[i];
        const ga = a.r - fx.r, gb = b.r - fx.r;
        if (!(ga === 0 || (ga < 0) !== (gb < 0))) continue;
        if (Math.abs(b.y - a.y) > 1.01) continue;
        const t = ga / (ga - gb);
        const y = a.y + t * (b.y - a.y);
        const c = trace(px, y).find((c) => c.branch === branch);
        if (!c) break;
        const arc = fx.r * dphi(c.phi, fx.phi);
        if (Math.abs(arc) <= RHO) {
          if (!hits.has(branch)) hits.set(branch, []);
          hits.get(branch).push({ px, py: y, r: c.r, arc });
        }
        break;
      }
    }
  }
  const images = [];
  for (const [branch, pts] of hits) {
    const xs = pts.map((p) => p.px), ys = pts.map((p) => p.py), rs = pts.map((p) => p.r);
    images.push({
      branch, pxRange: [Math.min(...xs), Math.max(...xs)], widthPx: Math.max(...xs) - Math.min(...xs) + 1,
      pyMean: +(ys.reduce((a, b) => a + b, 0) / ys.length).toFixed(2),
      pyRange: [+Math.min(...ys).toFixed(2), +Math.max(...ys).toFixed(2)],
      centroidPx: [+(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2), +(ys.reduce((a, b) => a + b, 0) / ys.length).toFixed(2)],
      rMean: +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(4),
      samples: pts.filter((p, i) => i % Math.max(1, Math.floor(pts.length / 4)) === 0).map((p) => [+p.px, +p.py.toFixed(2)]),
    });
  }
  console.log(JSON.stringify({ id: fx.id, r: fx.r, phi: +fx.phi.toFixed(6), imageCount: images.length, images }));
}
