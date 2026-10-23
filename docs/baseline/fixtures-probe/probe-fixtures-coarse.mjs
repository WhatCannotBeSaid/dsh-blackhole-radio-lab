// Fixture golden generator for phase 1 of the black-hole radio migration.
// Read-only: imports the validator's independent reference (formulation B),
// traces camera rays, and reports where each planar emitter is actually imaged.
// Nothing here is wired into the renderer.

const PROJECT = 'file:///C:/Yu/dsh-blackhole-radio-lab';

// Importing the validator runs its 197 checks; silence that so stdout stays clean.
const quiet = async (spec) => {
  const orig = console.log;
  console.log = () => {};
  try {
    return await import(spec);
  } finally {
    console.log = orig;
  }
};

const { integrateCartesian } = await quiet(`${PROJECT}/tools/validate-imaging.mjs`);
// The validator works in Rs units (its RS export is 1); the scene's world unit is b_crit.
const RS = 2 / (3 * Math.sqrt(3));

const W = 1280;
const H = 720;
const DPR = 1;
const FOV_Y = 42;
const TAN_HALF = Math.tan((FOV_Y * Math.PI) / 360);
const ASPECT = W / H;

// Camera home, world units (dimensions.js CAMERA_HOME) -> shader frame (Rs units).
// world -> shader: (x, y, z)_s = (x_w, -z_w, y_w) / RS
const CAM_W = [0.856, 0.401, 8.146];
const toS = (v) => [v[0] / RS, -v[2] / RS, v[1] / RS];
const dirToS = (v) => [v[0], -v[2], v[1]];

const C = toS(CAM_W);
const R_CAM = Math.hypot(...C);
const F = 1 - 1 / R_CAM;          // 1 - Rs/r, Rs = 1
const SQRT_F = Math.sqrt(F);
const E_R = C.map((x) => x / R_CAM);

const fwdW = CAM_W.map((x) => -x / Math.hypot(...CAM_W));
let fwd = toS(fwdW);
fwd = fwd.map((x) => x / Math.hypot(...fwd));
const upS = [0, 0, 1];            // world +Y is shader +Z
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const right = norm(cross(fwd, upS));
const camUp = cross(right, fwd);

const thetaCam = Math.atan2(CAM_W[0], CAM_W[2]);

// screen pixel (continuous centre coordinates, origin top-left) -> local unit dir
function rayDir(px, py) {
  const u = (2 * px) / W - 1;
  const v = 1 - (2 * py) / H;
  const d = [
    fwd[0] + right[0] * (u * TAN_HALF * ASPECT) + camUp[0] * (v * TAN_HALF),
    fwd[1] + right[1] * (u * TAN_HALF * ASPECT) + camUp[1] * (v * TAN_HALF),
    fwd[2] + right[2] * (u * TAN_HALF * ASPECT) + camUp[2] * (v * TAN_HALF),
  ];
  return norm(d);
}

// static observer: local direction -> coordinate (chart) direction
function chartDir(d) {
  const dr = d[0] * E_R[0] + d[1] * E_R[1] + d[2] * E_R[2];
  const k = SQRT_F - 1;
  return [d[0] + k * dr * E_R[0], d[1] + k * dr * E_R[1], d[2] + k * dr * E_R[2]];
}

// crossing point (Rs, shader frame) -> world radius / azimuth
const crossToWorld = (p) => {
  const xw = p[0] * RS;
  const zw = -p[1] * RS;
  return { r: Math.hypot(xw, zw), phi: Math.atan2(xw, zw) };
};

function trace(px, py) {
  const d = rayDir(px, py);
  const r = integrateCartesian(C, chartDir(d), { rMax: 200 });
  return {
    captured: r.captured,
    crossings: r.crossings.map((c, i) => ({ i: i + 1, ...crossToWorld(c.point), rRs: c.r })),
  };
}

// --- fixtures -------------------------------------------------------------
const RHO = 0.04;   // patch radius, world units (diameter 0.08 U)
const fixtures = [
  { id: 'N_near', r: 2.6, phi: thetaCam + 0.55, note: 'near side, 31.5 deg off the camera axis' },
  { id: 'F_far', r: 3.2, phi: thetaCam + Math.PI + 0.55, note: 'far side, 31.5 deg off the anti-camera axis' },
  { id: 'A_axis', r: 1.6, phi: thetaCam + Math.PI, note: 'exactly behind the hole, near axis' },
  { id: 'W_weak', r: 4.2, phi: thetaCam + 1.50, note: 'large impact parameter, relative weak field' },
];

for (const fx of fixtures) {
  fx.pos = [fx.r * Math.sin(fx.phi), 0, fx.r * Math.cos(fx.phi)];
  const d = fx.pos.map((x, i) => x - CAM_W[i]);
  const dist = Math.hypot(...d);
  const bGeom = Math.hypot(...cross(CAM_W, norm(d)));
  const z = d[0] * fwdW[0] + d[1] * fwdW[1] + d[2] * fwdW[2];
  const xr = d[0] * norm(cross(fwdW, [0, 1, 0]))[0] + d[1] * norm(cross(fwdW, [0, 1, 0]))[1] + d[2] * norm(cross(fwdW, [0, 1, 0]))[2];
  const rw = cross(norm(cross(fwdW, [0, 1, 0])), fwdW);
  const yu = d[0] * rw[0] + d[1] * rw[1] + d[2] * rw[2];
  const px = ((xr / z) / (TAN_HALF * ASPECT) * 0.5 + 0.5) * W;
  const py = (0.5 - (yu / z) / TAN_HALF * 0.5) * H;
  fx.geom = { dist, bGeom, pinhole: [px, py], pxPerUnit: (H / 2 / TAN_HALF) / z };
  fx.rhoPx = RHO * fx.geom.pxPerUnit;
}

const hit = (fx, c) => {
  if (c.rRs <= 1 || c.rRs > 400) return false;
  const dr = c.r - fx.r;
  let dphi = c.phi - fx.phi;
  while (dphi > Math.PI) dphi -= 2 * Math.PI;
  while (dphi < -Math.PI) dphi += 2 * Math.PI;
  const arc = fx.r * dphi;
  return Math.hypot(dr, arc) <= RHO;
};

// --- screen scan ----------------------------------------------------------
const STEP = Number(process.env.STEP || 4);
const t0 = Date.now();
const hitMap = new Map(); // key "px,py" -> [{fxId, branch}]
let rays = 0;
for (let py = STEP / 2; py < H; py += STEP) {
  for (let px = STEP / 2; px < W; px += STEP) {
    rays += 1;
    const t = trace(px, py);
    for (const fx of fixtures) {
      for (const c of t.crossings) {
        if (hit(fx, c)) {
          const key = `${px.toFixed(1)},${py.toFixed(1)}`;
          if (!hitMap.has(key)) hitMap.set(key, []);
          hitMap.get(key).push({ fx: fx.id, branch: c.i, r: c.r });
        }
      }
    }
  }
}

// cluster hit points per fixture+branch, BFS on the coarse grid
function blobs(points) {
  const key = (p) => `${p.px.toFixed(1)},${p.py.toFixed(1)}`;
  const set = new Map(points.map((p) => [key(p), p]));
  const seen = new Set();
  const out = [];
  for (const cur of points) {
    if (seen.has(key(cur))) continue;
    const stack = [cur];
    const comp = [];
    seen.add(key(cur));
    while (stack.length) {
      const p = stack.pop();
      comp.push(p);
      for (let dy = -STEP; dy <= STEP; dy += STEP) {
        for (let dx = -STEP; dx <= STEP; dx += STEP) {
          const nk = `${(p.px + dx).toFixed(1)},${(p.py + dy).toFixed(1)}`;
          const n = set.get(nk);
          if (n && !seen.has(nk)) { seen.add(nk); stack.push(n); }
        }
      }
    }
    out.push(comp);
  }
  return out;
}

const byKey = new Map();
for (const [k, arr] of hitMap) {
  const [px, py] = k.split(',').map(Number);
  for (const h of arr) {
    const id = `${h.fx}#${h.branch}`;
    if (!byKey.has(id)) byKey.set(id, []);
    byKey.get(id).push({ px, py, r: h.r });
  }
}

const report = [];
for (const [id, pts] of byKey) {
  for (const comp of blobs(pts)) {
    const xs = comp.map((p) => p.px);
    const ys = comp.map((p) => p.py);
    report.push({
      fixture: id.split('#')[0],
      branch: Number(id.split('#')[1]),
      n: comp.length,
      centroid: [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length],
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      areaPx: comp.length * STEP * STEP,
      rRange: [Math.min(...comp.map((p) => p.r)), Math.max(...comp.map((p) => p.r))],
    });
  }
}

console.log(JSON.stringify({
  grid_step: STEP,
  rays,
  seconds: (Date.now() - t0) / 1000,
  camera: { rCam: R_CAM, sqrF: SQRT_F, thetaCam },
  fixtures: fixtures.map((f) => ({
    id: f.id, r: f.r, phi: f.phi, pos: f.pos, rho: RHO,
    dist: f.geom.dist, bGeom: f.geom.bGeom, pinhole: f.geom.pinhole,
    rhoPx: f.rhoPx, note: f.note,
  })),
  images: report.sort((a, b) => a.fixture.localeCompare(b.fixture) || a.branch - b.branch),
}, null, 2));
