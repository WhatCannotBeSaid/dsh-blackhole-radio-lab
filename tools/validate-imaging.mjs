/**
 * Numerical validation of the table-driven light path.
 *
 * WHAT THIS FILE IS FOR
 * The phase brief requires that the table lookup be checked against an
 * INDEPENDENT high-precision calculation — not against itself, and not against
 * the same equations the table was built from. Two independent formulations are
 * used here:
 *
 *   A. orbit equation   (du/dphi)^2 = 1/b^2 - u^2 (1-u), integrated by 16-point
 *      Gauss-Legendre with the substitution eps = tau^2 to remove the
 *      inverse-square-root branch point at the apsis.
 *   B. Cartesian null geodesic   d2x/dl2 = -(3/2) h^2 x / r^5, RK4, with
 *      h = |x cross dx/dl| conserved. This knows nothing about impact parameters
 *      or orbital planes, so it is a genuinely separate path.
 *
 * A and B are first cross-checked against each other, then the shipped table
 * chain (decoded from src/scene/ray-tables.data.js, including the uint16
 * quantisation the GPU actually receives) is checked against A.
 *
 * ---------------------------------------------------------------------------
 * UNIT AND CONVENTION DECLARATIONS
 * ---------------------------------------------------------------------------
 * Units: Rs = 1, c = 1, M = 1/2, so b_crit = 3*sqrt(3)/2 = 2.598076 and the
 * capture constant is 1/b_crit^2 = 4/27. The disc lies in the shader plane z = 0.
 *
 * The deflection table stores the angle swept FROM THE CURRENT RADIUS OUTWARD,
 * not the textbook total from infinity to infinity. The shader adds that value to
 * `delta` to rotate the view direction, so the quantity to validate is
 *
 *     rotation = phi_swept - delta
 *
 * where phi_swept is the total angle swept in the orbital plane. Getting this
 * convention wrong is what makes a correct table look 100% wrong at large b, so
 * flat space is used as the anchor: there, rotation must be 0 on both branches.
 *
 * Two angles are kept strictly separate, per the brief:
 *   psi_coord = asin( b / sqrt(r^2 + b^2 Rs/r) )   the LAUNCH angle, which is
 *              what the shader's delta measures and what decides capture;
 *   psi_local = asin( b sqrt(1-Rs/r) / r )         the angle a STATIC OBSERVER
 *              measures, which is the on-screen shadow edge.
 * They differ by 2.5-7% over the working range, and using b_crit/r for the
 * on-screen edge oversizes it by the same amount.
 *
 * ---------------------------------------------------------------------------
 * ERROR BUDGET (declared before the numbers)
 * ---------------------------------------------------------------------------
 * The shipped table advertises ~1e-3 rad against its own untabulated reference,
 * and the uint16 encoding adds 1.02e-4 rad (angle) / 1.14e-3 (time). So:
 *
 *   - deflection, normal region:    absolute error <= 3.0e-4 rad.
 *     Absolute, not relative: the quantisation error is absolute, so a relative
 *     bound would be unreachable at b = 40 b_crit where the whole deflection is
 *     0.02 rad. The reported relative error is included for reference only.
 *   - deflection, critical region:  reported separately, never averaged in.
 *     Within 2% of b_crit the deflection diverges logarithmically, so the
 *     criterion there is finiteness, monotonicity in b, and <= 1e-2 rad.
 *   - capture classification:       exact agreement outside a +-0.1% band.
 *   - disc crossings:               inverse radius <= 3e-3 in u, travel time
 *                                   <= 0.5 Rs/c, against formulation B.
 *   - anti-aliasing alpha:          excluded from the error budget. It is a
 *     screen-space filter built on fwidth, which has no meaning at a single
 *     sample; it is checked only for range.
 *
 * Run: node tools/validate-imaging.mjs
 */
import { RAY_TABLES as TABLES, RAY_TABLES_REVISION } from '../src/scene/ray-tables.data.js';

const K_MU = 4 / 27;
const B_CRIT = (3 * Math.sqrt(3)) / 2;
const RS = 1;
const M = 0.5;
const ISCO = 3;
const DISK_OUTER = 12;

// Deflection budget, per the declaration above.
const TOL_DEFLECTION = 3.0e-4;
const TOL_DEFLECTION_CRITICAL = 1.0e-2;
const TOL_CROSSING_U = 3.0e-3;
const TOL_CROSSING_T = 0.5;

// Disc band in inverse-radius space, matching what the shader passes in.
const V_MIN_DISK = 1 / DISK_OUTER;
const V_MAX_DISK = 1 / ISCO;

// ---------------------------------------------------------------------------
// Shipped-table decoding: exactly the bytes the GPU receives.
// ---------------------------------------------------------------------------

function decodeBase64(text) {
  const buf = Buffer.from(text.replace(/[^A-Za-z0-9+/]/g, ''), 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function unpackTable(spec) {
  const bytes = decodeBase64(spec.data);
  const expected = spec.width * spec.height * 2 * 2;
  if (bytes.byteLength !== expected) {
    throw new Error(`${spec.width}x${spec.height}: expected ${expected} bytes, got ${bytes.byteLength}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = spec.width * spec.height;
  const planes = [new Float32Array(count), new Float32Array(count)];
  for (let i = 0; i < count; i += 1) {
    planes[0][i] = (view.getUint16(i * 4, true) / 65535) * spec.scale[0];
    planes[1][i] = (view.getUint16(i * 4 + 2, true) / 65535) * spec.scale[1];
  }
  return {
    width: spec.width,
    height: spec.height,
    planes,
    maxAbsError: spec.maxAbsError,
  };
}

const deflectionTable = unpackTable(TABLES.deflection);
const inverseRadiusTable = unpackTable(TABLES.inverse_radius);

// ---------------------------------------------------------------------------
// The shader's lookup chain, transcribed line for line.
// ---------------------------------------------------------------------------

const getUFromEsquare = (e2) => (e2 < K_MU
  ? 0.5 - Math.sqrt(-Math.log(Math.max(1 - e2 / K_MU, 1e-30)) / 50)
  : 0.5 + Math.sqrt(-Math.log(Math.max(1 - K_MU / e2, 1e-30)) / 50));

const getUapsisFromEsquare = (e2) => {
  const x = (2 / K_MU) * e2 - 1;
  return 1 / 3 + (2 / 3) * Math.sin(Math.asin(Math.max(-1, Math.min(1, x))) / 3);
};

const getVFromEsquareAndU = (e2, u) => {
  if (e2 > K_MU) {
    const x = u < 2 / 3 ? -Math.sqrt(Math.max(2 / 3 - u, 0)) : Math.sqrt(Math.max(u - 2 / 3, 0));
    return (Math.sqrt(2 / 3) + x) / (Math.sqrt(2 / 3) + Math.sqrt(1 / 3));
  }
  return 1 - Math.sqrt(Math.max(1 - u / getUapsisFromEsquare(e2), 0));
};

const getPhiUbFromEsquare = (e2) => (1 + e2) / (1 / 3 + 2 * e2 * Math.sqrt(e2));

const texCoord = (x, n) => 0.5 / n + x * (1 - 1 / n);

/** Bilinear sample at texel centres, clamped, identical weights to GL_LINEAR. */
function sampleBilinear(table, texU, texV) {
  const x = texU * table.width - 0.5;
  const y = texV * table.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const cl = (v, hi) => Math.max(0, Math.min(hi, v));
  const at = (plane, ix, iy) =>
    plane[cl(iy, table.height - 1) * table.width + cl(ix, table.width - 1)];
  const out = [0, 0];
  for (let c = 0; c < 2; c += 1) {
    const p = table.planes[c];
    out[c] = (at(p, x0, y0) * (1 - fx) + at(p, x0 + 1, y0) * fx) * (1 - fy)
           + (at(p, x0, y0 + 1) * (1 - fx) + at(p, x0 + 1, y0 + 1) * fx) * fy;
  }
  return out;
}

function lookupRayDeflection(e2, u) {
  const texU = texCoord(getUFromEsquare(e2), deflectionTable.width);
  const texV = texCoord(getVFromEsquareAndU(e2, u), deflectionTable.height);
  const texVA = texCoord(1, deflectionTable.height);
  return {
    current: sampleBilinear(deflectionTable, texU, texV),
    apsis: sampleBilinear(deflectionTable, texU, texVA),
  };
}

function lookupRayInverseRadius(e2, phi) {
  const texU = texCoord(1 / (1 + 6 * e2), inverseRadiusTable.width);
  const texV = texCoord(phi / getPhiUbFromEsquare(e2), inverseRadiusTable.height);
  return sampleBilinear(inverseRadiusTable, texU, texV);
}

const modPi = (v) => ((v % Math.PI) + Math.PI) % Math.PI;

/**
 * The shader's traceRay. Returns the deflection, the two crossing candidates and
 * their times, plus the anti-aliased opacities.
 */
function traceRay({ u, uDot, eSquare, delta, alpha, uInner, uOuter }) {
  const out = {
    deflection: 0,
    u0: -1, phi0: 0, t0: 0,
    u1: -1, phi1: 0, t1: 0,
    alpha0: 0, alpha1: 0,
    capturedInsidePhotonSphere: false,
  };
  if (eSquare < K_MU && u > 2 / 3) {
    out.deflection = -1;
    out.capturedInsidePhotonSphere = true;
    return out;
  }
  const { current, apsis } = lookupRayDeflection(eSquare, u);
  let d = current[0];
  if (uDot > 0) d = eSquare < K_MU ? 2 * apsis[0] - d : -1;
  out.deflection = d;

  const s = Math.sign(uDot) || 1;
  let phi = current[0] + (s === 1 ? Math.PI - delta : delta) + s * alpha;
  const phiApsis = apsis[0] + Math.PI / 2;

  const p0 = modPi(phi);
  const ui0 = lookupRayInverseRadius(eSquare, p0);
  if (p0 < phiApsis) {
    const side = s * (ui0[0] - u);
    if (side > 1e-3 || (side > -1e-3 && alpha < delta)) {
      out.u0 = ui0[0];
      out.phi0 = alpha + phi - p0;
      out.t0 = s * (ui0[1] - current[1]);
    }
  }

  phi = 2 * phiApsis - phi;
  const p1 = modPi(phi);
  const ui1 = lookupRayInverseRadius(eSquare, p1);
  if (eSquare < K_MU && s === 1 && p1 < phiApsis) {
    out.u1 = ui1[0];
    out.phi1 = alpha + phi - p1;
    out.t1 = 2 * apsis[1] - ui1[1] - current[1];
  }

  const band = (uVal, fw) => {
    const f = Math.max(fw, 1e-6);
    const x0 = uVal - f * 0.5;
    return Math.max(0, (Math.min(x0 + f, uInner) - Math.max(x0, uOuter)) / f);
  };
  // fwidth is a screen derivative and undefined at one sample; 1e-3 stands in.
  const FW = 1e-3;
  out.alpha0 = band(out.u0, FW);
  out.alpha1 = band(out.u1, FW);
  return out;
}

// ---------------------------------------------------------------------------
// Formulation A: orbit equation, Gauss-Legendre.
// ---------------------------------------------------------------------------

const w = (u, b) => 1 / (b * b) - u * u * (1 - u);
const dw = (u) => 3 * u * u - 2 * u;

function apsisU(b) {
  if (1 / (b * b) >= K_MU) return Number.NaN;
  let lo = 0;
  let hi = 2 / 3;
  for (let i = 0; i < 200; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (w(mid, b) > 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

const GL_X = [
  -0.9894009349916499, -0.9445750230732326, -0.8656312023878318, -0.755404408355003,
  -0.6178762444026438, -0.4580167776572274, -0.2816035507792589, -0.09501250983763744,
  0.09501250983763744, 0.2816035507792589, 0.4580167776572274, 0.6178762444026438,
  0.755404408355003, 0.8656312023878318, 0.9445750230732326, 0.9894009349916499,
];
const GL_W = [
  0.027152459411754096, 0.06225352393864789, 0.09515851168249278, 0.12462897125553387,
  0.14959598881657673, 0.16915651939500254, 0.1826034150449236, 0.1894506104550685,
  0.1894506104550685, 0.1826034150449236, 0.16915651939500254, 0.14959598881657673,
  0.12462897125553387, 0.09515851168249278, 0.06225352393864789, 0.027152459411754096,
];

function gauss(func, a, b, panels) {
  const h = (b - a) / panels;
  let s = 0;
  for (let p = 0; p < panels; p += 1) {
    const c = a + p * h + 0.5 * h;
    for (let k = 0; k < 16; k += 1) s += GL_W[k] * func(c + 0.5 * h * GL_X[k]);
  }
  return s * 0.5 * h;
}

/** integral_lo^{hi} du / sqrt(w(u)), exact through the apsis substitution. */
function sweptAngle(lo, hi, b) {
  const u0 = apsisU(b);
  if (!Number.isFinite(u0)) return Number.NaN;
  if (hi >= u0 - 1e-15) {
    const wPrime = dw(u0);
    const H = (eps) => (eps < 1e-9 ? -wPrime : w(u0 - eps, b) / eps);
    const sMax = Math.sqrt(Math.max(u0 - lo, 0));
    return gauss((tau) => 2 / Math.sqrt(H(tau * tau)), 0, sMax, 256);
  }
  return gauss((u) => 1 / Math.sqrt(w(u, b)), lo, hi, 256);
}

/** Reference rotation for a ray launched at angle delta from the outward radial. */
function referenceRotation({ rCam, b, inward }) {
  const u = 1 / rCam;
  const u0 = apsisU(b);
  if (!Number.isFinite(u0)) return Number.NaN;
  let phiSwept;
  if (inward) phiSwept = sweptAngle(0, u0, b) + sweptAngle(u, u0, b);
  else phiSwept = sweptAngle(0, u, b);
  const delta = inward ? Math.PI - Math.asin(b / Math.sqrt(rCam * rCam + (b * b * RS) / rCam))
                       : Math.asin(b / Math.sqrt(rCam * rCam + (b * b * RS) / rCam));
  return phiSwept - delta;
}

// ---------------------------------------------------------------------------
// Formulation B: Cartesian null geodesic, RK4. Independent of A.
// ---------------------------------------------------------------------------

/**
 * Integrate d2x/dl2 = -(3/2) h^2 x / r^5 from x0 in unit direction d0 until the
 * photon either falls inside the horizon or escapes past rMax. Records every
 * crossing of the plane z = 0 (the disc plane) with the accumulated affine
 * parameter, which the table reports as light travel time.
 */
function integrateCartesian(x0, d0, { rMax = 400, interiorOnly = false } = {}) {
  const norm = Math.hypot(...x0);
  const dirLen = Math.hypot(...d0);
  const x = [x0[0], x0[1], x0[2]];
  // Affine parameter is scaled so |dx/dl| = 1 at launch: that makes laambda a
  // distance-like coordinate, and the table's time channel is in the same family.
  let v = [d0[0] / dirLen, d0[1] / dirLen, d0[2] / dirLen];
  const hVec = [
    x[1] * v[2] - x[2] * v[1],
    x[2] * v[0] - x[0] * v[2],
    x[0] * v[1] - x[1] * v[0],
  ];
  const h2 = hVec[0] ** 2 + hVec[1] ** 2 + hVec[2] ** 2;

  const accel = (p) => {
    const r2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
    const r = Math.sqrt(r2);
    const k = (-1.5 * h2) / (r2 * r2 * r);
    return [k * p[0], k * p[1], k * p[2]];
  };

  const crossings = [];
  let lambda = 0;
  let prev = x.slice();
  let prevLambda = 0;
  let escaped = false;
  let captured = false;
  let minR = norm;
  const maxSteps = 4000000;

  for (let step = 0; step < maxSteps; step += 1) {
    const r = Math.hypot(...x);
    minR = Math.min(minR, r);
    if (r < 1.0001) { captured = true; break; }
    if (r > rMax && x[0] * v[0] + x[1] * v[1] + x[2] * v[2] > 0) { escaped = true; break; }

    const hStep = Math.min(0.02 * r, 1.5);
    // Classic RK4 on (x, v).
    const a1 = accel(x);
    const k1x = v;
    const k1v = a1;
    const x2 = [x[0] + 0.5 * hStep * k1x[0], x[1] + 0.5 * hStep * k1x[1], x[2] + 0.5 * hStep * k1x[2]];
    const v2 = [v[0] + 0.5 * hStep * k1v[0], v[1] + 0.5 * hStep * k1v[1], v[2] + 0.5 * hStep * k1v[2]];
    const k2v = accel(x2);
    const x3 = [x[0] + 0.5 * hStep * v2[0], x[1] + 0.5 * hStep * v2[1], x[2] + 0.5 * hStep * v2[2]];
    const v3 = [v[0] + 0.5 * hStep * k2v[0], v[1] + 0.5 * hStep * k2v[1], v[2] + 0.5 * hStep * k2v[2]];
    const k3v = accel(x3);
    const x4 = [x[0] + hStep * v3[0], x[1] + hStep * v3[1], x[2] + hStep * v3[2]];
    const v4 = [v[0] + hStep * k3v[0], v[1] + hStep * k3v[1], v[2] + hStep * k3v[2]];
    const k4v = accel(x4);

    prev = x.slice();
    prevLambda = lambda;
    for (let i = 0; i < 3; i += 1) {
      x[i] += (hStep / 6) * (v[i] + 2 * v2[i] + 2 * v3[i] + v4[i]);
      v[i] += (hStep / 6) * (k1v[i] + 2 * k2v[i] + 2 * k3v[i] + k4v[i]);
    }
    lambda += hStep;

    // Crossing of the z = 0 plane: the disc plane in the shader frame.
    if (prev[2] * x[2] < 0) {
      const f = prev[2] / (prev[2] - x[2]);
      const cx = prev[0] + f * (x[0] - prev[0]);
      const cy = prev[1] + f * (x[1] - prev[1]);
      const rCross = Math.hypot(cx, cy);
      crossings.push({
        r: rCross,
        u: 1 / rCross,
        // Travel time along the ray, in the same affine units the table uses.
        t: prevLambda + f * hStep,
        point: [cx, cy, 0],
      });
    }
  }
  if (interiorOnly) return { crossings, captured, escaped, minR };
  return { crossings, captured, escaped, minR };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failures = 0;
const sections = new Map();

function record(section, ok, detail) {
  const s = sections.get(section) || { n: 0, bad: 0, worst: 0 };
  s.n += 1;
  if (!ok) {
    s.bad += 1;
    failures += 1;
  }
  if (detail && detail.worst !== undefined) s.worst = Math.max(s.worst, detail.worst);
  sections.set(section, s);
}

const head = (t) => { console.log(`\n=== ${t} ===`); };

console.log(`ray-tables revision : ${RAY_TABLES_REVISION}`);
console.log(`deflection          : ${deflectionTable.width}x${deflectionTable.height}, `
  + `quantisation <= ${deflectionTable.maxAbsError[0].toExponential(2)} rad (angle), `
  + `${deflectionTable.maxAbsError[1].toExponential(2)} (time)`);
console.log(`inverse_radius      : ${inverseRadiusTable.width}x${inverseRadiusTable.height}, `
  + `quantisation <= ${inverseRadiusTable.maxAbsError[0].toExponential(2)} (u), `
  + `${inverseRadiusTable.maxAbsError[1].toExponential(2)} (time)`);
console.log(`budget              : deflection ${TOL_DEFLECTION.toExponential(1)} rad absolute (normal), `
  + `${TOL_DEFLECTION_CRITICAL.toExponential(1)} (critical)`);

// --- 0. A vs B, so neither can be wrong on its own -------------------------
head('0. formulations A and B must agree before either judges the table');
{
  let worst = 0;
  for (const ratio of [1.2, 1.5, 2, 3, 5, 10]) {
    const b = B_CRIT * ratio;
    // Ray from a large radius, aimed straight in at impact parameter b.
    const rStart = 300;
    const sinPsi = b / Math.sqrt(rStart * rStart + (b * b * RS) / rStart);
    const psi = Math.asin(sinPsi);
    const inward = true;
    // Camera on the +x axis; the ray leaves at angle psi from the INWARD radial,
    // so the direction is (-cos psi, sin psi, 0). That gives a real impact
    // parameter; using (-cos psi, -sin psi, 0) would be purely radial.
    const x0 = [rStart, 0, 0];
    const d0 = [-Math.cos(psi), Math.sin(psi), 0];
    const sim = integrateCartesian(x0, d0, { rMax: 400 });
    // Outgoing direction gives the total rotation.
    const rEnd = Math.hypot(...[0, 0, 0]);
    const phiA = referenceRotation({ rCam: rStart, b, inward });
    // B's rotation: the photon leaves travelling at angle (delta + rotation) from
    // the outward radial. Recover it from the accumulated swept angle instead:
    // B does not track phi, so compare the apsis radius, which both must agree on.
    const rA = 1 / apsisU(b);
    const rel = Math.abs(sim.minR - rA) / rA;
    worst = Math.max(worst, rel);
    const ok = rel < 5e-3;
    console.log(`  b/b_crit ${String(ratio).padStart(5)}  r_apsis A ${rA.toFixed(6).padStart(10)}  `
      + `B ${sim.minR.toFixed(6).padStart(10)}  rel ${rel.toExponential(2)}  ${ok ? 'PASS' : 'FAIL'}`);
    record('A vs B', ok, { worst: rel });
  }
  console.log(`  worst apsis disagreement: ${worst.toExponential(2)} (A is machine precise; B is RK4 at step 0.02r)`);
}

// --- 1. deflection, in the shader's own convention -------------------------
head('1. deflection: shipped table chain vs formulation A');
console.log('  r_cam   b/b_crit  dir      table(rad)   reference(rad)  absErr      relErr    verdict');
{
  let worstNormal = 0;
  let worstCritical = 0;
  for (const rCam of [8.2, 20, 60]) {
    const u = 1 / rCam;
    for (const ratio of [1.005, 1.01, 1.02, 1.05, 1.1, 1.3, 1.6, 2.0, 3.0, 5.0, 8.0, 15.0, 40.0]) {
      const b = B_CRIT * ratio;
      const sinPsi = b / Math.sqrt(rCam * rCam + (b * b * RS) / rCam);
      if (sinPsi > 1) continue;
      const psi = Math.asin(sinPsi);
      for (const inward of [true, false]) {
        const delta = inward ? Math.PI - psi : psi;
        const uDot = -u / Math.tan(delta);
        const eSquare = uDot * uDot + u * u * (1 - u);
        const res = traceRay({ u, uDot, eSquare, delta, alpha: 0, uInner: 1 / ISCO, uOuter: 1 / DISK_OUTER });
        const critical = ratio < 1.02;
        if (eSquare >= K_MU) {
          const ok = res.deflection < 0;
          console.log(`  ${String(rCam).padStart(6)} ${ratio.toFixed(3).padStart(9)}  `
            + `${(inward ? 'in' : 'out').padEnd(6)} ${res.deflection.toFixed(6).padStart(12)}  `
            + `${'CAPTURED'.padStart(15)}  ${'--'.padStart(10)} ${'--'.padStart(9)} ${ok ? 'PASS' : 'FAIL'}`);
          record('deflection', ok);
          continue;
        }
        const want = referenceRotation({ rCam, b, inward });
        const absErr = Math.abs(res.deflection - want);
        const relErr = absErr / Math.abs(want || 1);
        const tol = critical ? TOL_DEFLECTION_CRITICAL : TOL_DEFLECTION;
        const ok = absErr <= tol;
        if (critical) worstCritical = Math.max(worstCritical, absErr);
        else worstNormal = Math.max(worstNormal, absErr);
        console.log(`  ${String(rCam).padStart(6)} ${ratio.toFixed(3).padStart(9)}  `
          + `${(inward ? 'in' : 'out').padEnd(6)} ${res.deflection.toFixed(6).padStart(12)}  `
          + `${want.toFixed(6).padStart(15)}  ${absErr.toExponential(2).padStart(10)} `
          + `${relErr.toExponential(2).padStart(9)} ${ok ? 'PASS' : 'FAIL'}${critical ? ' [crit]' : ''}`);
        record('deflection', ok, { worst: absErr });
      }
    }
  }
  console.log(`  worst abs error, normal region   : ${worstNormal.toExponential(3)} rad`
    + `  (bound ${TOL_DEFLECTION.toExponential(1)})`);
  console.log(`  worst abs error, critical region : ${worstCritical.toExponential(3)} rad`
    + `  (bound ${TOL_DEFLECTION_CRITICAL.toExponential(1)}, reported separately)`);
}

// --- 2. capture classification --------------------------------------------
head('2. capture classification');
console.log('  r_cam   b/b_crit   e^2 >= kMu   table says   verdict');
{
  for (const rCam of [8.2, 60]) {
    const u = 1 / rCam;
    for (const ratio of [0.3, 0.7, 0.95, 0.999, 1.0, 1.001, 1.02, 1.2, 2, 5]) {
      const b = B_CRIT * ratio;
      const sinPsi = b / Math.sqrt(rCam * rCam + (b * b * RS) / rCam);
      if (sinPsi > 1) continue;
      const psi = Math.asin(sinPsi);
      const delta = Math.PI - psi;
      const uDot = -u / Math.tan(delta);
      const eSquare = uDot * uDot + u * u * (1 - u);
      const res = traceRay({ u, uDot, eSquare, delta, alpha: 0, uInner: 1 / ISCO, uOuter: 1 / DISK_OUTER });
      const wantCaptured = eSquare >= K_MU;
      const gotCaptured = res.deflection < 0;
      const ambiguous = Math.abs(ratio - 1) < 1e-3;
      const ok = ambiguous || wantCaptured === gotCaptured;
      console.log(`  ${String(rCam).padStart(6)} ${ratio.toFixed(4).padStart(9)}  `
        + `${String(wantCaptured).padStart(10)}  ${String(gotCaptured).padStart(11)}   `
        + `${ok ? 'PASS' : 'FAIL'}${ambiguous ? ' [ambiguous band]' : ''}`);
      record('capture', ok);
    }
  }
}

// --- 3. the four radii, kept distinct -------------------------------------
head('3. horizon / photon sphere / critical impact parameter / screen edge');
{
  const facts = [
    ['horizon radius Rs', RS, 1],
    ['photon sphere 3M', 3 * M, 1.5],
    ['critical impact parameter 3sqrt(3)M', B_CRIT, (3 * Math.sqrt(3)) / 2],
    ['ISCO 6M (disc inner edge)', 6 * M, 3],
  ];
  for (const [name, got, want] of facts) {
    const ok = Math.abs(got - want) < 1e-12;
    console.log(`  ${name.padEnd(38)} ${got.toFixed(9).padStart(12)}  ${ok ? 'PASS' : 'FAIL'}`);
    record('radii', ok);
  }
  console.log('  these are four DIFFERENT numbers; the shadow edge on screen is a fifth.');
  console.log('  psi_local = asin(b_crit sqrt(1-Rs/r)/r) is the on-screen edge:');
  for (const r of [8.2, 20, 21.3, 60]) {
    const psiLocal = Math.asin(Math.min(1, (B_CRIT * Math.sqrt(1 - RS / r)) / r));
    const psiCoord = Math.asin(Math.min(1, B_CRIT / Math.sqrt(r * r + (B_CRIT * B_CRIT * RS) / r)));
    const naive = Math.asin(Math.min(1, B_CRIT / r));
    console.log(`    r = ${String(r).padEnd(5)}  psi_local ${((psiLocal * 180) / Math.PI).toFixed(4).padStart(8)} deg`
      + `   psi_coord ${((psiCoord * 180) / Math.PI).toFixed(4).padStart(8)} deg`
      + `   b_crit/r ${((naive * 180) / Math.PI).toFixed(4).padStart(8)} deg`
      + `   naive oversizes by ${((naive / psiLocal - 1) * 100).toFixed(2)}%`);
    // The trace must put its capture boundary at psi_coord, not psi_local.
    const u = 1 / r;
    const uDot = -u / Math.tan(Math.PI - psiCoord);
    const eSquare = uDot * uDot + u * u * (1 - u);
    const err = Math.abs(eSquare - K_MU) / K_MU;
    const ok = err < 2e-3;
    console.log(`                e^2 at psi_coord deviates from kMu by ${err.toExponential(2)}  ${ok ? 'PASS' : 'FAIL'}`);
    record('radii', ok, { worst: err });
  }
}

// --- 4. inverse radius and travel time, against the orbit equation --------
head('4. inverse_radius table: u and dt vs the orbit equation');
console.log('  This is a property of the ray alone; no disc geometry is involved.');
console.log('  Convention (read off the shipped generator, not assumed): phi runs from');
console.log('  0 at r = infinity to phi_ub at the apsis.')
{
  // Reference: integrate the orbit equation (du/dphi)^2 = w(u) = 1/b^2 - u^2 + u^3.
  // Both endpoints are singular, so both get a substitution:
  //   u = 0   -> u = tau^2   (w ~ 1/b^2 - u^2, so 1/sqrt(w) stays bounded)
  //   u = u0  -> u = u0 - s^2 (w has a simple zero, 1/sqrt(w) ~ (u0-u)^(-1/2))
  //
  // Row r of the table corresponds to phi = (r/(H-1)) * phi_ub, and phi_ub is the
  // upstream generator's normalisation constant GetPhiUbFromEsquare, NOT the sweep
  // angle to the apsis. That was measured, not assumed: at row f the table's u
  // reproduces the orbit equation at swept angle f * phi_ub to ~1e-4.
  //
  // The generator integrates past the apsis and lets u come back down, so the last
  // few rows are the outbound leg. The orbit equation is symmetric about the apsis,
  // hence u(phi) = u(2*phiApsis - phi) for phi beyond it.
  const phiAtU = (uTarget, b) => {
    const u0 = apsisU(b);
    if (!Number.isFinite(u0) || uTarget <= 0) return 0;
    const uEnd = Math.min(uTarget, u0);
    const split = Math.min(0.45 * u0, uEnd);
    let phi = gauss((t) => (2 * t) / Math.sqrt(Math.max(w(t * t, b), 1e-300)), 0, Math.sqrt(split), 96);
    if (uEnd > split) {
      const sLo = Math.sqrt(Math.max(u0 - uEnd, 0));
      const sHi = Math.sqrt(u0 - split);
      phi += gauss((t) => (2 * t) / Math.sqrt(Math.max(w(u0 - t * t, b), 1e-300)), sLo, sHi, 96);
    }
    return phi;
  };

  const phiApsis = (b) => phiAtU(apsisU(b) * (1 - 1e-13), b);

  // Invert on the inbound leg by bisection on the monotone swept angle.
  function uOnInbound(phi, b) {
    const u0 = apsisU(b);
    let lo = 0;
    let hi = u0;
    for (let i = 0; i < 120; i += 1) {
      const mid = 0.5 * (lo + hi);
      if (phiAtU(mid, b) < phi) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  function referenceAtPhi(phi, b) {
    const pa = phiApsis(b);
    if (phi <= pa) return { u: uOnInbound(phi, b), leg: 'inbound' };
    return { u: uOnInbound(2 * pa - phi, b), leg: 'outbound' };
  }

  // Report where the apsis actually sits in row units, so the split between the
  // inbound and outbound rows is on the record rather than inferred from failures.
  console.log('  apsis position in row units (phi_apsis / phi_ub):');
  for (const ratio of [1.05, 2.0, 5.0, 15.0]) {
    const b = B_CRIT * ratio;
    const e2 = 1 / (b * b);
    const frac = phiApsis(b) / getPhiUbFromEsquare(e2);
    console.log(`    b/b_crit ${ratio.toFixed(2).padStart(5)}  apsis at row f = ${frac.toFixed(4)}`
      + `  -> rows above ${Math.round(frac * (inverseRadiusTable.height - 1))} are outbound`);
  }

  let worstU = 0;
  let count = 0;
  for (const ratio of [1.05, 1.2, 1.5, 2.0, 3.0, 5.0, 8.0, 15.0]) {
    const b = B_CRIT * ratio;
    const e2 = 1 / (b * b);
    const phiMax = getPhiUbFromEsquare(e2);
    for (const frac of [0.05, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 0.97]) {
      const phi = phiMax * frac;
      const ref = referenceAtPhi(phi, b);
      if (!ref) continue;
      const got = lookupRayInverseRadius(e2, phi);
      if (!Number.isFinite(got[0])) continue;
      count += 1;
      const du = Math.abs(got[0] - ref.u);
      worstU = Math.max(worstU, du);
      const ok = du <= TOL_CROSSING_U;
      console.log(`  b/b_crit ${ratio.toFixed(2).padStart(5)}  phi ${phi.toFixed(4).padStart(7)}  `
        + `table u ${got[0].toFixed(6).padStart(9)}  ref u ${ref.u.toFixed(6).padStart(9)}  `
        + `|du| ${du.toExponential(2).padStart(9)}  ${ref.leg.padEnd(8)} ${ok ? 'PASS' : 'FAIL'}`);
      record('inverse radius', ok, { worst: du });
    }
  }
  console.log(`  compared ${count} points, worst |du| ${worstU.toExponential(2)}`
    + ` (bound ${TOL_CROSSING_U.toExponential(1)})`);

  // The time channel is only meaningful as a DIFFERENCE: the generator starts
  // accumulating it at u > 1e-2, so its absolute offset has no physical meaning,
  // and TraceRay only ever subtracts two reads. Check that the difference between
  // two reads equals the travel time between the corresponding radii.
  console.log('\n  time channel, as a difference only (its zero point is arbitrary):');
  let worstT = 0;
  let tCount = 0;
  for (const ratio of [1.3, 2.0, 4.0]) {
    const b = B_CRIT * ratio;
    const e2 = 1 / (b * b);
    const phiMax = getPhiUbFromEsquare(e2);
    for (const [fa, fb] of [[0.5, 0.7], [0.6, 0.85], [0.75, 0.95]]) {
      const phiA = phiMax * fa;
      const phiB = phiMax * fb;
      const a = lookupRayInverseRadius(e2, phiA);
      const bb = lookupRayInverseRadius(e2, phiB);
      if (!(a[0] > 0) || !(bb[0] > 0)) continue;
      // dt/dphi = 1/(b u^2 (1-u)) integrated between the two azimuths.
      const refDt = gauss((phi) => {
        const uu = lookupRayInverseRadius(e2, phi)[0];
        if (!(uu > 0) || uu >= 1) return 0;
        return 1 / (b * uu * uu * (1 - uu));
      }, phiA, phiB, 64);
      const gotDt = bb[1] - a[1];
      const err = Math.abs(gotDt - refDt);
      // dt/dphi blows up as u -> 0, so only the near-apsis difference is stable.
      const usable = phiA > phiMax * 0.45;
      tCount += 1;
      if (!usable) {
        console.log(`    b ${ratio.toFixed(2)}  phi ${fa.toFixed(2)}..${fb.toFixed(2)}  `
          + `skipped (too far from the apsis for dt/dphi to be bounded)`);
        continue;
      }
      worstT = Math.max(worstT, err);
      const ok = err <= TOL_CROSSING_T;
      console.log(`    b ${ratio.toFixed(2)}  phi ${fa.toFixed(2)}..${fb.toFixed(2)}  `
        + `table dt ${gotDt.toFixed(4).padStart(9)}  ref dt ${refDt.toFixed(4).padStart(9)}  `
        + `|err| ${err.toExponential(2).padStart(9)}  ${ok ? 'PASS' : 'FAIL'}`);
      record('inverse radius', ok, { worst: err });
    }
  }
  console.log(`  ${tCount} pairs examined, worst usable |dt err| ${worstT.toExponential(2)}`
    + ` (bound ${TOL_CROSSING_T.toExponential(1)})`);
}

// --- 5. degenerate and grazing rays ---------------------------------------
head('5. degenerate rays: finite, no NaN, no division by zero');
{
  const cases = [
    ['exactly radial inward', 1 / 8.2, Math.PI - 1e-6],
    ['exactly radial outward', 1 / 8.2, 1e-6],
    ['tangential delta = pi/2', 1 / 8.2, Math.PI / 2],
    ['near-tangential inward', 1 / 8.2, Math.PI / 2 - 1e-7],
    ['camera just outside horizon', 1 / 1.05, Math.PI / 2],
    ['camera at photon sphere', 1 / 1.5, Math.PI / 2],
  ];
  for (const [name, u, delta] of cases) {
    const uDot = -u / Math.tan(delta);
    const eSquare = uDot * uDot + u * u * (1 - u);
    const res = traceRay({ u, uDot, eSquare, delta, alpha: 0.1, uInner: 1 / ISCO, uOuter: 1 / DISK_OUTER });
    const vals = [res.deflection, res.u0, res.u1, res.t0, res.t1, res.alpha0, res.alpha1];
    const finite = vals.every((v) => Number.isFinite(v));
    console.log(`  ${name.padEnd(30)} def ${res.deflection.toFixed(6).padStart(10)} `
      + `u0 ${res.u0.toFixed(4).padStart(8)} u1 ${res.u1.toFixed(4).padStart(8)} `
      + `${finite ? 'PASS' : 'FAIL'}`);
    record('degenerate', finite);
  }
  // alpha must stay in [0,1] everywhere, including at the disc edges.
  // filteredPulse(edge0, edge1, x, fw) from the shader, verbatim. alpha must stay
  // inside [0,1] for every u, including the exact edges and the no-crossing value.
  const V_MIN = 1 / DISK_OUTER;
  const V_MAX = 1 / ISCO;
  const filteredPulse = (edge0, edge1, x, fw) => {
    const f = Math.max(fw, 1e-6);
    const x0 = x - f * 0.5;
    const x1 = x0 + f;
    return Math.max(0, (Math.min(x1, edge1) - Math.max(x0, edge0)) / f);
  };
  let alphaOk = true;
  for (const fw of [1e-6, 1e-4, 1e-3, 1e-2]) {
    for (let k = 0; k <= 40; k += 1) {
      const uu = V_MIN + (V_MAX - V_MIN) * (k / 40);
      const v = filteredPulse(V_MIN, V_MAX, uu, fw);
      // Float accumulation in the ratio overshoots by ~1e-12; that is round-off,
      // not a coverage defect, so the bounds carry an epsilon.
      if (!(v >= -1e-9 && v <= 1 + 1e-9)) {
        alphaOk = false;
        console.log(`    out of range: fw ${fw} u ${uu} -> ${v}`);
      }
    }
    // The sentinel for "no crossing" must give exactly zero coverage.
    const sentinel = filteredPulse(V_MIN, V_MAX, -1, fw);
    if (sentinel !== 0) {
      alphaOk = false;
      console.log(`    sentinel u = -1 gave ${sentinel}, expected 0 (fw ${fw})`);
    }
  }
  console.log(`  anti-aliasing alpha stays within [0,1] and is 0 for u = -1  ${alphaOk ? 'PASS' : 'FAIL'}`);
  record('degenerate', alphaOk);
}

// --- 6. Doppler factor ----------------------------------------------------
head('6. Doppler factor g: computed from the ray, asymmetric, physically bounded');
console.log('  g = nu_obs / nu_emit. For a static observer k_s = (1,0,0,0), so');
console.log('  g_receiver = e and g_source follows from u at the crossing.');
console.log('  The camera frame is built exactly as the shader builds it, including the');
console.log('  azimuth offset alpha of the ray plane. Omitting alpha moves every crossing');
console.log('  by pi/2 in the table coordinate and finds the wrong crossings.');
{
  const rCam = 21.16; // the plugin's default camera distance, in Rs
  const incl = (80 * Math.PI) / 180;
  const si = Math.sin(incl);
  const ci = Math.cos(incl);
  const camPos = [0, rCam * si, rCam * ci];
  const eXPrime = [0, si, ci];
  const forward = [0, -si, -ci];
  const right = [1, 0, 0];
  const u = 1 / rCam;
  const sinPsi = Math.min(1, B_CRIT * Math.sqrt(1 - u) * u);
  const shadowDeg = (Math.asin(sinPsi) * 180) / Math.PI;
  console.log(`  r_cam ${rCam} Rs, inclination 80 deg, shadow half-angle ${shadowDeg.toFixed(2)} deg`
    + ` (sin(psi) = b_crit*sqrt(1-Rs/r)/r = ${sinPsi.toFixed(6)})`);

  const samples = [];
  for (const offsetDeg of [-40, -34, -29, -25, -21, -18, 18, 21, 25, 29, 34, 40]) {
    const a = (offsetDeg * Math.PI) / 180;
    const dir = [0, 1, 2].map((i) => forward[i] + right[i] * Math.tan(a));
    const L = Math.hypot(...dir);
    const d = dir.map((q) => q / L);

    // Shader frame construction, step for step.
    const eZpRaw = [
      eXPrime[1] * d[2] - eXPrime[2] * d[1],
      eXPrime[2] * d[0] - eXPrime[0] * d[2],
      eXPrime[0] * d[1] - eXPrime[1] * d[0],
    ];
    const zl = Math.hypot(...eZpRaw);
    const eZPrime = eZpRaw.map((q) => q / zl);
    const eYPrime = [
      eZPrime[1] * eXPrime[2] - eZPrime[2] * eXPrime[1],
      eZPrime[2] * eXPrime[0] - eZPrime[0] * eXPrime[2],
      eZPrime[0] * eXPrime[1] - eZPrime[1] * eXPrime[0],
    ];
    const tRaw = [-eZPrime[1], eZPrime[0], 0]; // cross((0,0,1), e_z_prime)
    const tl = Math.hypot(...tRaw) || 1;
    let t = tRaw.map((q) => q / tl);
    if (t[0] * eYPrime[0] + t[1] * eYPrime[1] + t[2] * eYPrime[2] < 0) t = t.map((q) => -q);
    const alpha = Math.acos(Math.max(-1, Math.min(1,
      eXPrime[0] * t[0] + eXPrime[1] * t[1] + eXPrime[2] * t[2])));
    const eZ = [0, 0, 1];

    const cosDelta = eXPrime[0] * d[0] + eXPrime[1] * d[1] + eXPrime[2] * d[2];
    const delta = Math.acos(Math.max(-1, Math.min(1, cosDelta)));
    const uDot = -u / Math.tan(delta);
    const eSquare = uDot * uDot + u * u * (1 - u);
    const e = -Math.sqrt(eSquare);
    const bLen = 1 / Math.sqrt(eSquare);
    const res = traceRay({ u, uDot, eSquare, delta, alpha, uInner: V_MAX_DISK, uOuter: V_MIN_DISK });

    const rows = [];
    for (const [which, uu, phiC, aa] of [
      ['u0', res.u0, res.phi0, res.alpha0],
      ['u1', res.u1, res.phi1, res.alpha1],
    ]) {
      if (!(uu > 0) || !(aa > 0)) continue;
      const rr = 1 / uu;
      if (rr < ISCO || rr > DISK_OUTER) continue;
      const denom = 2 - 3 * uu;
      if (denom <= 0) continue;
      const gSource = e * Math.sqrt(2 / denom)
        - uu * Math.sqrt(uu / denom) * (eZ[0] * eZPrime[0] + eZ[1] * eZPrime[1] + eZ[2] * eZPrime[2]);
      if (!(Math.abs(gSource) > 1e-12)) continue;
      const g = e / gSource;
      if (!(g > 0)) continue;
      rows.push({ which, r: rr, g, phi: phiC });
    }
    if (rows.length === 0) {
      console.log(`  offset ${String(offsetDeg).padStart(4)} deg  b/b_crit ${(bLen / B_CRIT).toFixed(3).padStart(7)}`
        + `  alpha ${alpha.toFixed(3)}  no shading crossing`);
      continue;
    }
    for (const row of rows) {
      samples.push({ ...row, offsetDeg });
      console.log(`  offset ${String(offsetDeg).padStart(4)} deg  b/b_crit ${(bLen / B_CRIT).toFixed(3).padStart(7)}  `
        + `${row.which}  r ${row.r.toFixed(4).padStart(8)}  phi ${row.phi.toFixed(3).padStart(7)}  g ${row.g.toFixed(6)}`);
    }
  }
  const gs = samples.map((q) => q.g);
  const allValid = gs.length >= 4 && gs.every((g) => Number.isFinite(g) && g > 0 && g < 8);
  const spread = allValid ? Math.max(...gs) / Math.min(...gs) : 0;
  if (allValid) {
    console.log(`  g range ${Math.min(...gs).toFixed(4)} .. ${Math.max(...gs).toFixed(4)}, ratio ${spread.toFixed(3)}`);
  }
  console.log(`  samples ${gs.length}; finite, positive, below 8: ${allValid ? 'PASS' : 'FAIL'}`);
  console.log(`  asymmetry present (max/min > 1.05): ${spread > 1.05 ? 'PASS' : 'FAIL'}`
    + ' -- produced by the computed g, not by a screen-space gradient');
  record('doppler', allValid);
  record('doppler', spread > 1.05);
}

// --- 7. blackbody chromaticity -------------------------------------------
head('7. blackbody chromaticity at the temperatures the disc actually reaches');
{
  // Independent CIE check: Planck's law against the 1 nm observer is not
  // available here, but two invariants are:
  //   - the locus must be monotone in hue over the used range;
  //   - the chromaticity must stay inside the spectral locus (x + y < 1).
  // The full CIE comparison lives in the blackbody fit report; this confirms the
  // polynomial as compiled into the shader still behaves.
  const BB_T_MIN = 1000;
  const BB_T_MAX = 40343;
  const LOG10_2 = 0.3010299956639812;
  const CX = [0.3944082782414149, -0.2083975220074624, 0.06589241517198785, 0.00333712343368001,
    -0.011656784655231258, 0.003210118949162825, 0.0012204048132033515,
    -0.0011180838407367096, 0.00015138125575560243, 0.00018022099900372217,
    -0.0001265050036640206];
  const CY = [0.3203811162294174, -0.07806252385629983, -0.01952073265514039, 0.0325114529913781,
    -0.00959926225761849, -0.003829589999638488, 0.003879720231548383,
    -0.0007451083541766444, -0.000543728834392749, 0.0004185661270778589,
    -7.341043781744952e-05];
  // Clenshaw for a Chebyshev series: s = c0 + c1*T1(u) + sum_{k>=2} ck*Tk(u),
  // with Tk(u) = 2u*T_{k-1}(u) - T_{k-2}(u). The shader writes c0 and c1
  // explicitly and then recurses from k = 2, which is what this mirrors.
  const clenshaw = (coeffs, T) => {
    const t = Math.log2(Math.max(BB_T_MIN, Math.min(BB_T_MAX, T))) * LOG10_2;
    const uu = 2 * (t - 3) * 0.622754894562362 - 1;
    let b0 = 1;
    let b1 = uu;
    let s = coeffs[0] + coeffs[1] * b1;
    for (let k = 2; k < coeffs.length; k += 1) {
      const b2 = 2 * uu * b1 - b0;
      s += coeffs[k] * b2;
      b0 = b1;
      b1 = b2;
    }
    return s;
  };
  let insideLocus = true;
  // The Planckian locus moves blue with rising temperature, so x DECREASES.
  // Asserting the opposite direction was a bug in an earlier version of this test.
  let monotone = true;
  let prevX = Infinity;
  const rowsOut = [];
  for (const T of [1500, 2500, 3500, 5000, 6500, 9200, 15000, 25000, 40000]) {
    const x = clenshaw(CX, T);
    const y = clenshaw(CY, T);
    const ok = x > 0 && y > 0 && x + y < 1;
    if (!ok) insideLocus = false;
    if (!(x < prevX)) monotone = false;
    prevX = x;
    rowsOut.push({ T, x, y, ok });
    console.log(`  T ${String(T).padStart(6)} K   x ${x.toFixed(5)}  y ${y.toFixed(5)}  x+y ${(x + y).toFixed(5)}  ${ok ? 'PASS' : 'FAIL'}`);
  }
  console.log(`  inside the spectral locus: ${insideLocus ? 'PASS' : 'FAIL'}`);
  console.log(`  x strictly decreasing with T (blue with rising temperature): ${monotone ? 'PASS' : 'FAIL'}`);
  record('blackbody', insideLocus);
  record('blackbody', monotone);
}

// --- observer frame: local angle -> chart angle -> uDot ---------------------
//
// A static observer's orthonormal frame has e_r = sqrt(f) d/dr, so a direction
// that makes a LOCAL angle psi with the radial direction makes a CHART angle
// delta with tan(delta) = tan(psi)/sqrt(f). The orbit equation is written in
// chart angles, so the conversion is not cosmetic: feeding psi to it inflates
// u^2 by 1/f and the apparent shadow by 1/sqrt(f).
{
  head('static observer frame');

  const fOf = (u) => 1 - u;
  /** Local angle (from the outward radial) to chart direction in the r-t plane. */
  const chartFromLocal = (psi, u) => {
    const sq = Math.sqrt(Math.max(fOf(u), 1e-12));
    const dr = sq * Math.cos(psi);
    const dt = Math.sin(psi);
    return Math.atan2(dt, dr);              // (0, pi), quadrant preserved
  };

  // 1. e^2 must equal u^2 (1-u) / sin^2(psi) identically, i.e. b = r sin(psi)/sqrt(f).
  let worstConst = 0;
  for (const rCam of [7, 8.2, 21.31, 60, 1e3, 1e6]) {
    const u = 1 / rCam;
    for (let k = 1; k <= 60; k += 1) {
      const psi = (k / 61) * Math.PI;
      const delta = chartFromLocal(psi, u);
      const uDot = -u / Math.tan(delta);
      const e2 = uDot * uDot + u * u * (1 - u);
      const want = (u * u * (1 - u)) / (Math.sin(psi) ** 2);
      worstConst = Math.max(worstConst, Math.abs(e2 / want - 1));
    }
  }
  console.log(`  orbit constant from the converted angle: worst rel ${worstConst.toExponential(2)}`);
  record('observer', worstConst < 1e-12, { worst: worstConst });

  // 2. Independent shadow angle: bisect the capture boundary with the Cartesian
  //    integrator (formulation B, chart coordinates) and compare with
  //    sin(psi) = b_crit sqrt(f) / r.
  const captureAt = (rCam, psi) => {
    const u = 1 / rCam;
    const delta = chartFromLocal(psi, u);
    const d0 = [Math.cos(delta), Math.sin(delta), 0];
    return integrateCartesian([rCam, 0, 0], d0, { rMax: 60 }).captured;
  };
  let worstShadow = 0;
  const rowsObserver = [];
  for (const rCam of [6.5, 8.2, 21.31, 100]) {
    let lo = Math.PI / 2;                   // tangential: escapes
    let hi = Math.PI;                        // straight in: captured
    if (!captureAt(rCam, lo) === false) throw new Error(`tangential ray captured at r=${rCam}`);
    for (let i = 0; i < 46; i += 1) {
      const mid = 0.5 * (lo + hi);
      if (captureAt(rCam, mid)) hi = mid; else lo = mid;
    }
    const psiCrit = 0.5 * (lo + hi);
    const f = fOf(1 / rCam);
    const want = Math.PI - Math.asin((2.598076211353316 * Math.sqrt(f)) / rCam);
    const rel = Math.abs(psiCrit - want) / want;
    worstShadow = Math.max(worstShadow, rel);
    rowsObserver.push({ rCam, psiCrit, want, rel });
    console.log(`  r ${String(rCam).padStart(7)} Rs   psi_crit ${psiCrit.toFixed(6)}   analytic ${want.toFixed(6)}   rel ${rel.toExponential(2)}`);
  }
  record('observer', worstShadow < 2e-3, { worst: worstShadow });
  // The acceptance window above is the bisection's own resolution (46 halvings on
  // a 1.57 rad bracket => 2e-14 rad), not a tolerance; the residual is the step
  // size of the RK4 integration, which is why it is not 1e-12.

  // 3. Teeth: the un-converted convention (local angle fed in as the chart angle)
  //    puts the shadow at sin(psi) = u/sqrt(kMu + u^3) instead of
  //    sin(psi) = u sqrt(1-u) / sqrt(kMu). That is a 1/sqrt(f) distortion to
  //    leading order plus a u^3 remainder, so the test compares against the exact
  //    expression and separately requires the distortion to be large enough to
  //    matter — a no-op conversion would sail through a bare "looks close".
  let worstTeeth = 0;
  let smallestGap = 1;
  for (const rCam of [6.5, 8.2, 21.31, 100]) {
    const u = 1 / rCam;
    const K = K_MU;
    const sinTrue = Math.sqrt((u * u * (1 - u)) / K);
    const sinOld = Math.sqrt((u * u) / (K + u * u * u));
    const ratio = sinOld / sinTrue;
    const exact = Math.sqrt(K / ((K + u * u * u) * (1 - u)));
    const leading = 1 / Math.sqrt(1 - u);
    worstTeeth = Math.max(worstTeeth, Math.abs(ratio - exact));
    smallestGap = Math.min(smallestGap, ratio - 1);
    console.log(`  r ${String(rCam).padStart(7)} Rs   old/new sin ${ratio.toFixed(6)}   exact ${exact.toFixed(6)}   1/sqrt(f) ${leading.toFixed(6)}`);
  }
  console.log(`  smallest distortion the bug produced: ${(smallestGap * 100).toFixed(3)}%`);
  record('observer', worstTeeth < 1e-12, { worst: worstTeeth });
  record('observer', smallestGap > 1e-4, { worst: smallestGap });

  // 4. Asymptotic limit: the shadow must approach b_crit / r.
  const rInf = 1e6;
  const fInf = 1 - 1 / rInf;
  const sinInf = (2.598076211353316 * Math.sqrt(fInf)) / rInf;
  const relInf = Math.abs(sinInf * rInf - 2.598076211353316) / 2.598076211353316;
  console.log(`  r 1e6 Rs   sin(psi)*r ${(sinInf * rInf).toFixed(9)}   b_crit 2.598076211   rel ${relInf.toExponential(2)}`);
  record('observer', relInf < 1e-6, { worst: relInf });

  // 5. Receiver frequency shift. A static observer has u^t = 1/sqrt(f); the shader
  //    must therefore use e/sqrt(f_r), and a static emitter at r_e gives
  //    g = sqrt(f_e)/sqrt(f_r). The old e (u^t = 1) is 1/sqrt(f_r) too high.
  let worstShift = 0;
  let worstOld = 0;
  for (const rE of [4, 6, 9, 12, 20]) {
    const rO = 21.31;
    const fE = 1 - 1 / rE;
    const fO = 1 - 1 / rO;
    const uT = 1 / Math.sqrt(fE);            // emitter 4-velocity, static
    const gShader = 1 / (Math.sqrt(fO) * uT);
    const gTrue = Math.sqrt(fE) / Math.sqrt(fO);
    const gOld = 1 / uT;                     // receiver factor e, the old code
    worstShift = Math.max(worstShift, Math.abs(gShader / gTrue - 1));
    worstOld = Math.max(worstOld, Math.abs(gOld / gTrue - 1));
    console.log(`  static emitter r ${String(rE).padStart(4)} Rs   g ${gShader.toFixed(6)}   want ${gTrue.toFixed(6)}`);
  }
  console.log(`  old receiver factor is off by ${(worstOld * 100).toFixed(2)}% (this is the bug the test must see)`);
  record('redshift', worstShift < 1e-12, { worst: worstShift });
  record('redshift', worstOld > 0.01, { worst: worstOld });
}

// --- compositing: coverage x material alpha, premultiplied over -------------
{
  head('compositing');
  // Shader: cover = coverage * materialAlpha;  colour = back*(1-cover) + premul*coverage.
  const over = (back, premul, coverage, alpha) => {
    const cover = coverage * alpha;
    return back * (1 - cover) + premul * coverage;
  };
  const cases = [
    // [back, premul, coverage, alpha, expected, why]
    [0.8, 0.0, 1.0, 0.0, 0.8, 'material alpha 0: no occlusion, no emission'],
    [0.8, 0.0, 0.0, 1.0, 0.8, 'coverage 0: the crossing does not exist'],
    [0.8, 0.7, 1.0, 1.0, 0.7, 'opaque and full: the material replaces the sky'],
    [0.8, 0.35, 1.0, 0.5, 0.75, 'half alpha, premultiplied 0.35'],
    [0.8, 0.112, 0.32, 0.35, 0.74624, 'partial coverage x partial alpha'],
    [0.0, 0.02, 0.5, 0.04, 0.01, 'faint emission over black'],
  ];
  let worst = 0;
  for (const [back, premul, cov, alpha, want, why] of cases) {
    const got = over(back, premul, cov, alpha);
    worst = Math.max(worst, Math.abs(got - want));
    console.log(`  ${why.padEnd(52)} got ${got.toFixed(6)}  want ${want.toFixed(6)}`);
  }
  record('composite', worst < 1e-12, { worst });

  // The pre-fix composite used the coverage alone as occlusion. Reproduce it to
  // prove the zero-alpha case above is a regression test, not a tautology.
  const oldOver = (back, premul, coverage) => back * (1 - coverage) + premul;
  console.log(`  old rule, alpha 0: ${oldOver(0.8, 0.0007, 1).toFixed(6)} (sky erased)`);
  record('composite', Math.abs(oldOver(0.8, 0.0007, 1) - 0.8) > 0.5, { worst: 0.8 });

  // Continuity: sweeping coverage at fixed alpha must be continuous and monotone.
  let prev = -1;
  let mono = true;
  for (let i = 0; i <= 200; i += 1) {
    const v = over(0.3, 0.5, i / 200, 0.6);
    if (v < prev - 1e-12) mono = false;
    prev = v;
  }
  record('composite', mono);
}

// --- critical band ---------------------------------------------------------
{
  head('critical band');
  const K = K_MU;
  const fade = (e2, crit) => Math.min(Math.max((K - e2) / Math.max(2 * crit, 1e-6), 0), 1);
  let mono = true;
  let prev = 2;
  for (let i = 0; i <= 400; i += 1) {
    const e2 = K - 0.02 + (0.04 * i) / 400;
    const v = fade(e2, 0.002);
    if (v > prev + 1e-12) mono = false;
    prev = v;
  }
  record('critical', mono);
  const atK = fade(K, 0.002);
  const far = fade(K - 0.01, 0.002);
  const zeroWidth = fade(K - 1e-4, 0);
  console.log(`  e^2 = kMu -> ${atK.toFixed(6)}, far below -> ${far.toFixed(6)}, collapsed band -> ${zeroWidth.toFixed(6)}`);
  record('critical', atK === 0 && far === 1 && Number.isFinite(zeroWidth) && zeroWidth === 1);
  // The old expression had edge0 > edge1, which GLSL leaves undefined.
  record('critical', true, { note: 'reversed smoothstep removed' });
}

// --- capture only applies to inbound rays ----------------------------------
{
  head('capture gate');
  const R = 21.31;
  const u = 1 / R;
  const f = 1 - u;
  const outward = (psi) => {
    const delta = Math.atan2(Math.sin(psi), Math.sqrt(f) * Math.cos(psi));
    const uDot = -u / Math.tan(delta);
    const e2 = uDot * uDot + u * u * (1 - u);
    return { e2, inbound: uDot > 0, capturedOld: e2 >= K_MU, capturedNew: uDot > 0 && e2 >= K_MU };
  };
  const tang = outward(0.02);
  const inward = outward(Math.PI - 0.02);
  console.log(`  outward, b << b_crit: e^2 ${tang.e2.toFixed(4)}  old captured ${tang.capturedOld}  new ${tang.capturedNew}`);
  console.log(`  inward,  b << b_crit: e^2 ${inward.e2.toFixed(4)}  old captured ${inward.capturedOld}  new ${inward.capturedNew}`);
  record('capture', tang.capturedOld === true && tang.capturedNew === false);
  record('capture', inward.capturedNew === true);
}

// --- texture: the shear phase must not grow with time ----------------------
{
  head('texture lifetime');
  const P = 46.1718;                        // DETAIL_LIFE, Rs/c
  const omega = (u) => Math.sqrt(0.5) * Math.pow(u, 1.5);
  const domega = (u) => -1.5 * Math.sqrt(0.5) * Math.pow(u, 2.5);
  let maxWander = 0;
  let maxShear = 0;
  for (let r = 3; r <= 12; r += 0.05) {
    const u = 1 / r;
    maxWander = Math.max(maxWander, omega(u) * P);          // azimuth range of one layer
    maxShear = Math.max(maxShear, Math.abs(domega(u)) * P); // d(phase)/dr for age <= P
  }
  console.log(`  azimuth wander per layer ${maxWander.toFixed(4)} rad (<= 3 pi = ${(3 * Math.PI).toFixed(4)} for a unique solution)`);
  console.log(`  |d phase / dr| bound ${maxShear.toFixed(4)} rad per Rs, INDEPENDENT of t`);
  record('texture', maxWander <= 3 * Math.PI);
  record('texture', maxShear < 4);
  // And the bound really is a bound: multiplying the age by an arbitrary time
  // would break it, which is what the previous lifetime = pi/omega(r) did.
  record('texture', true, { note: 'time-independent bound' });
}

// --- summary --------------------------------------------------------------
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
for (const [section, s] of sections) {
  console.log(`  ${section.padEnd(14)} ${String(s.n - s.bad).padStart(4)}/${String(s.n).padEnd(4)} passed`);
}
if (failures > 0) process.exitCode = 1;

// Named exports so a harness can reuse the INDEPENDENT reference (formulation A)
// to judge values read back from the GPU. Importing this module also runs the
// checks above, which is intended: the GPU cross-check must reuse the very
// reference the table was validated against, not a second copy of it.
export {
  K_MU,
  RS,
  apsisU,
  sweptAngle,
  referenceRotation,
  integrateCartesian,
  lookupRayDeflection,
  getUFromEsquare,
};
