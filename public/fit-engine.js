/* ============================================================
   FindBestFit calculation engine (browser) — v3.3c
   Replaces the former FastAPI backend (/api/fit/raw, /api/fit/histogram,
   /api/generate). Same rules as the backend (NumPy / SciPy):
   - bins: numpy.histogram_bin_edges (fd, sturges, scott, sqrt, auto)
   - MLE: SciPy fit with loc = 0 (Normal, Lognormal, Gamma, Weibull,
     Exponential, Beta on (0,1))
   - KS p-value: scipy.stats.kstest two-sided, exact distribution (kstwo.sf)
   - DirectHistFit: minimise sum (Pbin - P^)^2 / max(Pbin, 1e-6) (weighted)
     or sum (Pbin - P^)^2 (unweighted), P^ = model bin probabilities
     normalised to 1
   - scores: SSE_PDF (PDF at bin centres), SSE_PDF_Norm = SSE_PDF / sum(PDF),
     SSE_Pbin; MLE ranked by SSE_PDF_Norm, Direct ranked by SSE_Pbin
   Verified against backend exports (fit_results_v33c_backend_*.xlsx).
   © 2026 Nguyen Minh Quy – portlogistics.vn
   ============================================================ */
(function (root) {
"use strict";

const VERSION = "3.3c-browser";
const LOG_2PI = Math.log(2 * Math.PI);
const SQRT2PI = Math.sqrt(2 * Math.PI);
const DIRECT_WEIGHT_FLOOR = 1e-6;
const POSITIVE = new Set(["Lognormal", "Gamma", "Weibull", "Exponential"]);
const ALL_DISTRIBUTIONS = ["Normal", "Lognormal", "Gamma", "Weibull", "Exponential", "Beta"];
const PARAM_NAMES = {
  Normal: ["mu", "sigma"],
  Lognormal: ["muLog", "sigmaLog"],
  Gamma: ["shape", "scale"],
  Weibull: ["A_scale", "B_shape"],
  Exponential: ["mu"],
  Beta: ["a", "b"]
};

// ============================================================
// SPECIAL FUNCTIONS
// ============================================================

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
];

function lgamma(x) {
  if (x < 0.5) {
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  }
  if (x > 1e6) {
    // Stirling series
    const r = 1 / x;
    return (x - 0.5) * Math.log(x) - x + 0.5 * LOG_2PI +
      r * (1 / 12 - r * r * (1 / 360 - r * r / 1260));
  }
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * LOG_2PI + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function digamma(x) {
  let r = 0;
  while (x < 6) { r -= 1 / x; x += 1; }
  const f = 1 / (x * x);
  return r + Math.log(x) - 0.5 / x -
    f * (1 / 12 - f * (1 / 120 - f * (1 / 252 - f * (1 / 240 - f / 132))));
}

function trigamma(x) {
  let r = 0;
  while (x < 6) { r += 1 / (x * x); x += 1; }
  const f = 1 / (x * x);
  return r + 1 / x + f / 2 +
    f / x * (1 / 6 - f * (1 / 30 - f * (1 / 42 - f / 30)));
}

/** Regularised incomplete gamma: returns [P(a,x), Q(a,x)]. */
function gammaPQ(a, x) {
  if (!(x > 0)) return [0, 1];
  if (!Number.isFinite(x)) return [1, 0];
  const lnPre = -x + a * Math.log(x) - lgamma(a);
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 100000; n++) {
      ap += 1; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-17) break;
    }
    const p = sum * Math.exp(lnPre);
    return [Math.min(p, 1), Math.max(0, 1 - p)];
  }
  // Continued fraction (modified Lentz)
  const FPMIN = 1e-300;
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i < 100000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-17) break;
  }
  const q = Math.exp(lnPre) * h;
  return [Math.max(0, 1 - q), Math.min(q, 1)];
}

function betacf(x, a, b) {
  const FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < 100000; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a,b). */
function betaI(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbt = lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  if (x < (a + 1) / (a + b + 2)) return Math.exp(lbt) * betacf(x, a, b) / a;
  return 1 - Math.exp(lbt) * betacf(1 - x, b, a) / b;
}

// Standard normal CDF, W. J. Cody (as in R pnorm), ~1e-16 accuracy.
const PN_A = [2.2352520354606839287, 161.02823106855587881, 1067.6894854603709582, 18154.981253343561249, 0.065682337918207449113];
const PN_B = [47.20258190468824187, 976.09855173777669322, 10260.932208618978205, 45507.789335026729956];
const PN_C = [0.39894151208813466764, 8.8831497943883759412, 93.506656132177855979, 597.27027639480026226, 2494.5375852903726711, 6848.1904505362823326, 11602.651437647350124, 9842.7148383839780218, 1.0765576773720192317e-8];
const PN_D = [22.266688044328115691, 235.38790178262499861, 1519.377599407554805, 6485.558298266760755, 18615.571640885098091, 34900.952721145977266, 38912.003286093271411, 19685.429676859990727];
const PN_P = [0.21589853405795699, 0.1274011611602473639, 0.022235277870649807, 0.001421619193227893466, 2.9112874951168792e-5, 0.02307344176494017303];
const PN_Q = [1.28426009614491121, 0.468238212480865118, 0.0659881378689285515, 0.00378239633202758244, 7.29751555083966205e-5];
const M_1_SQRT_2PI = 0.398942280401432677939946059934;

/** Returns [Phi(x), 1 - Phi(x)] accurately in both tails. */
function pnormBoth(x) {
  if (Number.isNaN(x)) return [NaN, NaN];
  const y = Math.abs(x);
  let cum, ccum;
  if (y <= 0.67448975) {
    let xnum = 0, xden = 0;
    if (y > 1.1e-16) {
      const xsq = x * x;
      xnum = PN_A[4] * xsq; xden = xsq;
      for (let i = 0; i < 3; i++) { xnum = (xnum + PN_A[i]) * xsq; xden = (xden + PN_B[i]) * xsq; }
    }
    const temp = x * (xnum + PN_A[3]) / (xden + PN_B[3]);
    return [0.5 + temp, 0.5 - temp];
  }
  if (y <= 5.656854249492380195206754896838) {
    let xnum = PN_C[8] * y, xden = y;
    for (let i = 0; i < 7; i++) { xnum = (xnum + PN_C[i]) * y; xden = (xden + PN_D[i]) * y; }
    const temp = (xnum + PN_C[7]) / (xden + PN_D[7]);
    const xsq = Math.trunc(y * 16) / 16;
    const del = (y - xsq) * (y + xsq);
    cum = Math.exp(-xsq * xsq * 0.5) * Math.exp(-del * 0.5) * temp;
    ccum = 1 - cum;
  } else if (y < 50) {
    const xsq0 = 1 / (x * x);
    let xnum = PN_P[5] * xsq0, xden = xsq0;
    for (let i = 0; i < 4; i++) { xnum = (xnum + PN_P[i]) * xsq0; xden = (xden + PN_Q[i]) * xsq0; }
    let temp = xsq0 * (xnum + PN_P[4]) / (xden + PN_Q[4]);
    temp = (M_1_SQRT_2PI - temp) / y;
    const xsq = Math.trunc(x * 16) / 16;
    const del = (x - xsq) * (x + xsq);
    cum = Math.exp(-xsq * xsq * 0.5) * Math.exp(-del * 0.5) * temp;
    ccum = 1 - cum;
  } else {
    cum = 0; ccum = 1;
  }
  return x > 0 ? [ccum, cum] : [cum, ccum];
}

function pnorm(x) { return pnormBoth(x)[0]; }

/** Inverse standard normal (Acklam start + Newton refinement). */
function qnorm(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let x;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    const q = p - 0.5, r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log1p(-p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  for (let i = 0; i < 2; i++) {
    const [P, Q] = pnormBoth(x);
    const err = p < 0.5 ? P - p : (1 - p) - Q;
    const u = err * SQRT2PI * Math.exp(x * x / 2);
    x = x - u / (1 + x * u / 2);
  }
  return x;
}

// ============================================================
// DISTRIBUTIONS
// ============================================================

function invertCdf(cdf, pdf, p, lo, hi) {
  // Bracketed Newton / bisection on cdf(x) = p
  let x = (Number.isFinite(lo) && Number.isFinite(hi)) ? 0.5 * (lo + hi) : (Number.isFinite(lo) ? lo + 1 : 1);
  let a = lo, b = hi;
  if (!Number.isFinite(b)) { b = Math.max(1, Math.abs(x)); while (cdf(b) < p) { a = b; b *= 2; if (b > 1e300) break; } }
  x = 0.5 * (a + b);
  for (let i = 0; i < 300; i++) {
    const f = cdf(x) - p;
    if (f > 0) b = x; else a = x;
    const dens = pdf(x);
    let nx = x - f / dens;
    if (!(nx > a && nx < b) || !Number.isFinite(nx)) nx = 0.5 * (a + b);
    if (Math.abs(nx - x) <= 1e-15 * Math.max(1, Math.abs(x))) return nx;
    x = nx;
  }
  return x;
}

function makeDistribution(name, params) {
  const p = params;
  switch (name) {
    case "Normal": {
      const mu = p[0], s = p[1];
      return {
        k: 2,
        logpdf: x => -0.5 * ((x - mu) / s) ** 2 - Math.log(s) - 0.5 * LOG_2PI,
        pdf: x => Math.exp(-0.5 * ((x - mu) / s) ** 2) / (s * SQRT2PI),
        cdf: x => pnorm((x - mu) / s),
        ppf: q => mu + s * qnorm(q),
        sample: rng => mu + s * rng.normal(),
        mean: mu, valid: s > 0 && Number.isFinite(mu)
      };
    }
    case "Lognormal": {
      const mu = p[0], s = p[1];
      const logpdf = x => x > 0 ? -0.5 * ((Math.log(x) - mu) / s) ** 2 - Math.log(s * x) - 0.5 * LOG_2PI : -Infinity;
      return {
        k: 2, logpdf,
        pdf: x => x > 0 ? Math.exp(logpdf(x)) : 0,
        cdf: x => x > 0 ? pnorm((Math.log(x) - mu) / s) : 0,
        ppf: q => Math.exp(mu + s * qnorm(q)),
        sample: rng => Math.exp(mu + s * rng.normal()),
        valid: s > 0 && Number.isFinite(mu)
      };
    }
    case "Gamma": {
      const a = p[0], sc = p[1];
      const lnorm = lgamma(a) + a * Math.log(sc);
      const logpdf = x => x > 0 ? (a - 1) * Math.log(x) - x / sc - lnorm : (x === 0 ? (a < 1 ? Infinity : a === 1 ? -Math.log(sc) : -Infinity) : -Infinity);
      const cdf = x => x > 0 ? gammaPQ(a, x / sc)[0] : 0;
      const pdf = x => x >= 0 ? Math.exp(logpdf(x)) : 0;
      return {
        k: 2, logpdf, pdf, cdf,
        ppf: q => invertCdf(cdf, pdf, q, 0, Infinity),
        sample: rng => sc * rng.gamma(a),
        valid: a > 0 && sc > 0
      };
    }
    case "Weibull": {
      const A = p[0], B = p[1];
      const logpdf = x => x > 0 ? Math.log(B / A) + (B - 1) * Math.log(x / A) - Math.pow(x / A, B) : (x === 0 ? (B < 1 ? Infinity : B === 1 ? -Math.log(A) : -Infinity) : -Infinity);
      return {
        k: 2, logpdf,
        pdf: x => x >= 0 ? Math.exp(logpdf(x)) : 0,
        cdf: x => x > 0 ? -Math.expm1(-Math.pow(x / A, B)) : 0,
        ppf: q => A * Math.pow(-Math.log1p(-q), 1 / B),
        sample: rng => A * Math.pow(-Math.log1p(-rng.uniform()), 1 / B),
        valid: A > 0 && B > 0
      };
    }
    case "Exponential": {
      const mu = p[0];
      const logpdf = x => x >= 0 ? -Math.log(mu) - x / mu : -Infinity;
      return {
        k: 1, logpdf,
        pdf: x => x >= 0 ? Math.exp(logpdf(x)) : 0,
        cdf: x => x > 0 ? -Math.expm1(-x / mu) : 0,
        ppf: q => -mu * Math.log1p(-q),
        sample: rng => -mu * Math.log1p(-rng.uniform()),
        valid: mu > 0
      };
    }
    case "Beta": {
      const a = p[0], b = p[1];
      const lB = lgamma(a) + lgamma(b) - lgamma(a + b);
      const logpdf = x => (x > 0 && x < 1) ? (a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - lB : -Infinity;
      const cdf = x => betaI(x, a, b);
      const pdf = x => Math.exp(logpdf(x));
      return {
        k: 2, logpdf, pdf, cdf,
        ppf: q => invertCdf(cdf, pdf, q, 0, 1),
        sample: rng => { const g1 = rng.gamma(a), g2 = rng.gamma(b); return g1 / (g1 + g2); },
        valid: a > 0 && b > 0
      };
    }
    default:
      throw new Error(`Unknown distribution: ${name}`);
  }
}

// ============================================================
// RANDOM NUMBERS (sfc32, seeded from crypto)
// ============================================================

function makeRng(seed) {
  let s;
  if (Array.isArray(seed) && seed.length >= 4) {
    s = seed.slice(0, 4).map(v => v >>> 0);
  } else if (Number.isFinite(seed)) {
    s = [0x9e3779b9, 0x243f6a88, 0xb7e15162, seed >>> 0];
  } else {
    s = new Uint32Array(4);
    const c = root.crypto || (typeof globalThis !== "undefined" && globalThis.crypto);
    if (c && c.getRandomValues) c.getRandomValues(s);
    else for (let i = 0; i < 4; i++) s[i] = Math.floor(Math.random() * 4294967296);
    s = Array.from(s);
  }
  let [a, b, c, d] = s;
  function next32() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  }
  for (let i = 0; i < 20; i++) next32();
  let spare = null;
  const rng = {
    uniform() { // (0,1), 53-bit
      let u;
      do { u = ((next32() >>> 5) * 67108864 + (next32() >>> 6)) / 9007199254740992; } while (u === 0);
      return u;
    },
    normal() {
      if (spare !== null) { const v = spare; spare = null; return v; }
      let u, v, s2;
      do { u = 2 * rng.uniform() - 1; v = 2 * rng.uniform() - 1; s2 = u * u + v * v; } while (s2 >= 1 || s2 === 0);
      const m = Math.sqrt(-2 * Math.log(s2) / s2);
      spare = v * m;
      return u * m;
    },
    gamma(shape) { // Marsaglia & Tsang
      if (shape < 1) return rng.gamma(shape + 1) * Math.pow(rng.uniform(), 1 / shape);
      const d0 = shape - 1 / 3, c0 = 1 / Math.sqrt(9 * d0);
      for (;;) {
        let x, v;
        do { x = rng.normal(); v = 1 + c0 * x; } while (v <= 0);
        v = v * v * v;
        const u = rng.uniform();
        if (u < 1 - 0.0331 * x ** 4) return d0 * v;
        if (Math.log(u) < 0.5 * x * x + d0 * (1 - v + Math.log(v))) return d0 * v;
      }
    }
  };
  return rng;
}

// ============================================================
// NUMPY-COMPATIBLE HISTOGRAM
// ============================================================

function lerp(a, b, t) { return t >= 0.5 ? b - (b - a) * (1 - t) : a + (b - a) * t; }

function percentileSorted(sorted, q) {
  const idx = (q / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.min(lo + 1, sorted.length - 1);
  return lerp(sorted[lo], sorted[hi], idx - lo);
}

function meanOf(v) { let s = 0; for (const x of v) s += x; return s / v.length; }

function stdOf(v, ddof = 0) {
  const m = meanOf(v);
  let s = 0;
  for (const x of v) s += (x - m) ** 2;
  return Math.sqrt(s / (v.length - ddof));
}

const BIN_WIDTH = {
  sqrt: (x, ptp) => ptp / Math.sqrt(x.length),
  sturges: (x, ptp) => ptp / (Math.log2(x.length) + 1),
  scott: (x) => Math.pow(24 * Math.sqrt(Math.PI) / x.length, 1 / 3) * stdOf(x),
  fd: (x, ptp, sorted) => 2 * (percentileSorted(sorted, 75) - percentileSorted(sorted, 25)) * Math.pow(x.length, -1 / 3),
  auto: (x, ptp, sorted) => {
    const fd = BIN_WIDTH.fd(x, ptp, sorted);
    const st = BIN_WIDTH.sturges(x, ptp);
    const sq = BIN_WIDTH.sqrt(x, ptp);
    return Math.min(Math.max(fd, sq / 2), st);
  }
};

/** numpy.histogram_bin_edges(x, method) */
function histogramBinEdges(x, method) {
  const fn = BIN_WIDTH[method];
  if (!fn) throw new Error(`Unknown bin method: ${method}`);
  const sorted = Float64Array.from(x).sort();
  let first = sorted[0], last = sorted[sorted.length - 1];
  if (first === last) { first -= 0.5; last += 0.5; }
  const width = fn(x, last - first, sorted);
  const nbins = width ? Math.ceil((last - first) / width) : 1;
  if (nbins > 100000) throw new Error(`Too many bins (${nbins}). Choose another bin method.`);
  const step = (last - first) / nbins;
  const edges = new Array(nbins + 1);
  for (let i = 0; i <= nbins; i++) edges[i] = i * step + first;
  edges[nbins] = last;
  return edges;
}

/** numpy.histogram(values, edges): [e_i, e_i+1), last bin closed. */
function histogramCounts(values, edges) {
  const nb = edges.length - 1;
  const counts = new Array(nb).fill(0);
  const lo = edges[0], hi = edges[nb];
  let outside = 0;
  for (const v of values) {
    if (!(v >= lo && v <= hi)) { outside++; continue; }
    let a = 0, b = nb; // find largest i with edges[i] <= v
    while (b - a > 1) { const m = (a + b) >> 1; if (edges[m] <= v) a = m; else b = m; }
    counts[Math.min(a, nb - 1)]++;
  }
  return { counts, outside };
}

function buildHistogram(edges, mass) {
  const nb = edges.length - 1;
  const centers = [], widths = [], pbin = [], pdf = [];
  let total = 0;
  for (const m of mass) total += m;
  for (let i = 0; i < nb; i++) {
    const w = edges[i + 1] - edges[i];
    centers.push((edges[i] + edges[i + 1]) / 2);
    widths.push(w);
    const p = total > 0 ? mass[i] / total : 0;
    pbin.push(p);
    pdf.push(p / w);
  }
  return { centers, edges: edges.slice(), widths, pbin, pdf };
}

// ============================================================
// KOLMOGOROV-SMIRNOV (port of scipy.stats._ksstats, two-sided exact)
// ============================================================

const E128 = 128, EP128 = Math.pow(2, 128), EM128 = Math.pow(2, -128);
const STIRLING = [-2.955065359477124183e-2, 6.4102564102564102564e-3, -1.9175269175269175269e-3,
  8.4175084175084175084e-4, -5.952380952380952381e-4, 7.9365079365079365079e-4,
  -2.7777777777777777778e-3, 8.3333333333333333333e-2];

function clip01(p) { return p < 0 ? 0 : p > 1 ? 1 : p; }

function ldexp(p, e) {
  while (e > 1000) { p *= Math.pow(2, 1000); e -= 1000; }
  while (e < -1000) { p *= Math.pow(2, -1000); e += 1000; }
  return p * Math.pow(2, e);
}

function logNfactDivNpowN(n) {
  const rn = 1 / n, z = rn / n;
  let poly = 0;
  for (const c of STIRLING) poly = poly * z + c;
  return Math.log(n) / 2 - n + LOG_2PI / 2 + rn * poly;
}

/** scipy.special.smirnov(n, d) = P(D+_n >= d), exact Birnbaum-Tingey sum. */
function smirnov(n, d) {
  if (!(d > 0)) return 1;
  if (d >= 1) return 0;
  const jmax = Math.floor(n * (1 - d) + 1e-12 * n);
  let logC = 0, maxL = -Infinity;
  const terms = [];
  for (let j = 0; j <= jmax; j++) {
    if (j > 0) logC += Math.log((n - j + 1) / j);
    const a = 1 - d - j / n;
    if (a <= 0) { if (n - j === 0) terms.push(logC + (j - 1) * Math.log(d + j / n)); continue; }
    const l = logC + (n - j) * Math.log(a) + (j - 1) * Math.log(d + j / n);
    terms.push(l);
    if (l > maxL) maxL = l;
  }
  for (const l of terms) if (l > maxL) maxL = l;
  let s = 0;
  for (const l of terms) s += Math.exp(l - maxL);
  return clip01(d * s * Math.exp(maxL));
}

function matmul(A, B, m) {
  const C = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let k = 0; k < m; k++) {
      const a = A[i * m + k];
      if (a === 0) continue;
      const bo = k * m, co = i * m;
      for (let j = 0; j < m; j++) C[co + j] += a * B[bo + j];
    }
  }
  return C;
}

function kolmognDMTW(n, d) {
  if (d >= 1) return 1;
  const nd = n * d;
  if (nd <= 0.5) return 0;
  const k = Math.ceil(nd), h = k - nd, m = 2 * k - 1;
  let H = new Float64Array(m * m);
  const v = new Float64Array(m), w = new Float64Array(m);
  let fac = 1;
  for (let j = 1; j <= m; j++) {
    w[j - 1] = fac;
    fac /= j;
    v[j - 1] = (1 - Math.pow(h, j)) * fac;
  }
  const tt = Math.pow(Math.max(2 * h - 1, 0), m) - 2 * Math.pow(h, m);
  v[m - 1] = (1 + tt) * fac;
  for (let i = 1; i < m; i++) for (let r = i - 1; r < m; r++) H[r * m + i] = w[r - (i - 1)];
  for (let r = 0; r < m; r++) H[r * m] = v[r];
  for (let c = 0; c < m; c++) H[(m - 1) * m + c] = v[m - 1 - c];
  let Hpwr = new Float64Array(m * m);
  for (let i = 0; i < m; i++) Hpwr[i * m + i] = 1;
  let nn = n, expnt = 0, Hexpnt = 0;
  while (nn > 0) {
    if (nn % 2) { Hpwr = matmul(Hpwr, H, m); expnt += Hexpnt; }
    H = matmul(H, H, m);
    Hexpnt *= 2;
    if (Math.abs(H[(k - 1) * m + (k - 1)]) > EP128) {
      for (let i = 0; i < H.length; i++) H[i] /= EP128;
      Hexpnt += E128;
    }
    nn = Math.floor(nn / 2);
  }
  let p = Hpwr[(k - 1) * m + (k - 1)];
  for (let i = 1; i <= n; i++) {
    p = i * p / n;
    if (Math.abs(p) < EM128) { p *= EP128; expnt -= E128; }
  }
  if (expnt !== 0) p = ldexp(p, expnt);
  return clip01(p);
}

function pomeranzJ1J2(i, n, ll, ceilf, roundf) {
  let j1, j2;
  if (i === 0) {
    j1 = -ll - ceilf - 1; j2 = ll + ceilf - 1;
  } else {
    const ip1div2 = Math.floor((i + 1) / 2), ip1mod2 = (i + 1) % 2;
    if (ip1mod2 === 0) {
      if (ip1div2 === n + 1) { j1 = n - ll - ceilf - 1; j2 = n + ll + ceilf - 1; }
      else { j1 = ip1div2 - 1 - ll - roundf - 1; j2 = ip1div2 + ll - 1 + ceilf - 1; }
    } else {
      j1 = ip1div2 - 1 - ll - 1; j2 = ip1div2 + ll + roundf - 1;
    }
  }
  return [Math.max(j1 + 2, 0), Math.min(j2, n)];
}

function kolmognPomeranz(n, x) {
  const t = n * x, ll = Math.floor(t), f = t - ll, g = Math.min(f, 1 - f);
  const ceilf = f > 0 ? 1 : 0, roundf = f > 0.5 ? 1 : 0;
  const npwrs = 2 * (ll + 1);
  const gp = new Float64Array(npwrs), tgp = new Float64Array(npwrs), omp = new Float64Array(npwrs);
  gp[0] = tgp[0] = omp[0] = 1;
  let expnt = 0;
  const gn = g / n, tgn = 2 * g / n, omn = (1 - 2 * g) / n;
  for (let m = 1; m < npwrs; m++) {
    gp[m] = gp[m - 1] * gn / m;
    tgp[m] = tgp[m - 1] * tgn / m;
    omp[m] = omp[m - 1] * omn / m;
  }
  let V0 = new Float64Array(npwrs), V1 = new Float64Array(npwrs);
  V1[0] = 1;
  let V0s = 0, V1s = 0;
  let [j1, j2] = pomeranzJ1J2(0, n, ll, ceilf, roundf);
  for (let i = 1; i < 2 * n + 2; i++) {
    const k1 = j1;
    [V0, V1] = [V1, V0];
    [V0s, V1s] = [V1s, V0s];
    V1.fill(0);
    [j1, j2] = pomeranzJ1J2(i, n, ll, ceilf, roundf);
    const pw = (i === 1 || i === 2 * n + 1) ? gp : (i % 2 ? tgp : omp);
    const ln2 = j2 - k1 + 1;
    if (ln2 > 0) {
      const aStart = k1 - V0s;
      const aLen = Math.max(0, Math.min(ln2, npwrs - aStart));
      const bLen = Math.min(ln2, npwrs);
      const convLen = aLen + bLen - 1;
      const conv = new Float64Array(Math.max(convLen, 0));
      for (let p = 0; p < aLen; p++) {
        const av = V0[aStart + p];
        if (av === 0) continue;
        for (let q = 0; q < bLen; q++) conv[p + q] += av * pw[q];
      }
      const convStart = j1 - k1, cl = j2 - j1 + 1;
      for (let q = 0; q < cl && convStart + q < conv.length; q++) V1[q] = conv[convStart + q];
      let mx = 0;
      for (let q = 0; q < npwrs; q++) if (V1[q] > mx) mx = V1[q];
      if (mx > 0 && mx < EM128) { for (let q = 0; q < npwrs; q++) V1[q] *= EP128; expnt -= E128; }
      V1s = V0s + j1 - k1;
    }
  }
  let ans = V1[n - V1s];
  for (let m = 1; m <= n; m++) {
    if (Math.abs(ans) > EP128) { ans *= EM128; expnt += E128; }
    ans *= m;
  }
  if (expnt !== 0) ans = ldexp(ans, expnt);
  return clip01(ans);
}

function kolmognPelzGood(n, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const z = Math.sqrt(n) * x;
  const z2 = z * z, z3 = z2 * z, z4 = z2 * z2, z6 = z4 * z2;
  const PI2 = Math.PI ** 2, PI4 = PI2 * PI2, PI6 = PI4 * PI2;
  const qlog = -PI2 / 8 / z2;
  if (qlog < -708) return 0;
  let q = Math.exp(qlog);
  const k1a = -z2, k1b = PI2 / 4;
  const k2a = 6 * z6 + 2 * z4, k2b = (2 * z4 - 5 * z2) * PI2 / 4, k2c = PI4 * (1 - 2 * z2) / 16;
  const k3d = PI6 * (5 - 30 * z2) / 64, k3c = PI4 * (-60 * z2 + 212 * z4) / 16;
  const k3b = PI2 * (135 * z4 - 96 * z6) / 4, k3a = -30 * z6 - 90 * z ** 8;
  const K = [0, 0, 0, 0];
  const maxk = Math.ceil(16 * z / Math.PI);
  for (let k = maxk; k > 0; k--) {
    const m = 2 * k - 1, m2 = m * m, m4 = m2 * m2, m6 = m4 * m2;
    const qp = Math.pow(q, 8 * k);
    const co = [1, k1a + k1b * m2, k2a + k2b * m2 + k2c * m4, k3a + k3b * m2 + k3c * m4 + k3d * m6];
    for (let i = 0; i < 4; i++) K[i] = K[i] * qp + co[i];
  }
  const div = [z, 6 * z4, 72 * z ** 7, 6480 * z ** 10];
  for (let i = 0; i < 4; i++) K[i] = K[i] * q * SQRT2PI / div[i];
  q = Math.exp(-PI2 / 2 / z2);
  let k2extra = 0, k3extra = 0;
  const sqrt3z = Math.sqrt(3) * z;
  for (let k = maxk; k > 0; k--) {
    const ks2 = k * k, qp = Math.pow(q, ks2), kspi = Math.PI * k;
    k2extra += ks2 * qp;
    k3extra += (sqrt3z + kspi) * (sqrt3z - kspi) * ks2 * qp;
  }
  K[2] += k2extra * PI2 * SQRT2PI / (-36 * z3);
  K[3] += k3extra * PI2 * SQRT2PI / (216 * z6);
  let s = 0;
  for (let i = 0; i < 4; i++) s += K[i] / Math.pow(n, i / 2);
  return s;
}

/** scipy.stats.kstwo.sf(d, n) */
function kolmogorovSf(n, x) {
  if (x >= 1) return 0;
  if (x <= 0) return 1;
  const t = n * x;
  if (t <= 1) {
    if (t <= 0.5) return 1;
    let prob;
    if (n <= 140) { prob = 1; for (let i = 1; i <= n; i++) prob *= i * (1 / n) * (2 * t - 1); }
    else prob = Math.exp(logNfactDivNpowN(n) + n * Math.log(2 * t - 1));
    return clip01(1 - prob);
  }
  if (t >= n - 1) return clip01(2 * Math.pow(1 - x, n));
  if (x >= 0.5) return clip01(2 * smirnov(n, x));
  const nxsq = t * x;
  if (n <= 140) {
    if (nxsq <= 0.754693) return clip01(1 - kolmognDMTW(n, x));
    if (nxsq <= 4) return clip01(1 - kolmognPomeranz(n, x));
    return clip01(2 * smirnov(n, x));
  }
  if (nxsq >= 370) return 0;
  if (nxsq >= 2.2) return clip01(2 * smirnov(n, x));
  let cdf;
  if (nxsq >= 18) cdf = 1;
  else if (n <= 100000 && n * Math.pow(x, 1.5) <= 1.4) cdf = kolmognDMTW(n, x);
  else cdf = kolmognPelzGood(n, x);
  return clip01(1 - cdf);
}

/** scipy.stats.kstest(x, cdf) two-sided, method auto (exact). */
function ksTest(values, cdf) {
  const x = Float64Array.from(values).sort();
  const n = x.length;
  let dPlus = 0, dMinus = 0;
  for (let i = 0; i < n; i++) {
    const c = cdf(x[i]);
    dPlus = Math.max(dPlus, (i + 1) / n - c);
    dMinus = Math.max(dMinus, c - i / n);
  }
  const D = Math.max(dPlus, dMinus);
  return { statistic: D, pValue: kolmogorovSf(n, D) };
}

// ============================================================
// MAXIMUM LIKELIHOOD (SciPy fit with loc = 0)
// ============================================================

function brent(f, a, b, tol = 1e-14, maxIter = 300) {
  let fa = f(a), fb = f(b);
  if (fa * fb > 0) throw new Error("Root not bracketed");
  let c = a, fc = fa, d = b - a, e = d;
  for (let i = 0; i < maxIter; i++) {
    if (fb * fc > 0) { c = a; fc = fa; d = e = b - a; }
    if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c; c = a; fa = fb; fb = fc; fc = fa; }
    const tol1 = 2 * 2.2e-16 * Math.abs(b) + 0.5 * tol, xm = 0.5 * (c - b);
    if (Math.abs(xm) <= tol1 || fb === 0) return b;
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa;
      let p, q;
      if (a === c) { p = 2 * xm * s; q = 1 - s; }
      else {
        const qq = fa / fc, r = fb / fc;
        p = s * (2 * xm * qq * (qq - r) - (b - a) * (r - 1));
        q = (qq - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q; else p = -p;
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) { e = d; d = p / q; }
      else { d = xm; e = d; }
    } else { d = xm; e = d; }
    a = b; fa = fb;
    b += Math.abs(d) > tol1 ? d : (xm > 0 ? tol1 : -tol1);
    fb = f(b);
  }
  return b;
}

function mleGamma(x) {
  const m = meanOf(x);
  let ml = 0; for (const v of x) ml += Math.log(v); ml /= x.length;
  const s = Math.log(m) - ml;
  if (!(s > 0)) throw new Error("Gamma MLE: data has zero spread.");
  const f = a => Math.log(a) - digamma(a) - s;
  const aest = (3 - s + Math.sqrt((s - 3) ** 2 + 24 * s)) / (12 * s);
  let lo = aest * 0.6, hi = aest * 1.4;
  while (f(lo) < 0) lo /= 2;
  while (f(hi) > 0) hi *= 2;
  const a = brent(f, lo, hi, 1e-15);
  return [a, m / a];
}

function mleWeibull(x) {
  let mx = 0; for (const v of x) if (v > mx) mx = v;
  const y = x.map(v => v / mx), ly = y.map(Math.log);
  const mly = meanOf(ly);
  const g = k => {
    let s0 = 0, s1 = 0;
    for (let i = 0; i < y.length; i++) { const yk = Math.pow(y[i], k); s0 += yk; s1 += yk * ly[i]; }
    return s1 / s0 - 1 / k - mly;
  };
  let lo = 0.5, hi = 2;
  while (g(lo) > 0 && lo > 1e-6) lo /= 2;
  while (g(hi) < 0 && hi < 1e6) hi *= 2;
  const k = brent(g, lo, hi, 1e-15);
  let s = 0; for (const v of y) s += Math.pow(v, k);
  return [mx * Math.pow(s / y.length, 1 / k), k];
}

function mleBeta(x) {
  let l1 = 0, l2 = 0;
  for (const v of x) { l1 += Math.log(v); l2 += Math.log1p(-v); }
  l1 /= x.length; l2 /= x.length;
  const m = meanOf(x), v = stdOf(x) ** 2;
  let c = m * (1 - m) / v - 1;
  if (!(c > 0)) c = 1;
  let a = m * c, b = (1 - m) * c;
  for (let it = 0; it < 200; it++) {
    const dab = digamma(a + b), tab = trigamma(a + b);
    const f1 = digamma(a) - dab - l1, f2 = digamma(b) - dab - l2;
    const j11 = trigamma(a) - tab, j12 = -tab, j22 = trigamma(b) - tab;
    const det = j11 * j22 - j12 * j12;
    let da = (j22 * f1 - j12 * f2) / det, db = (j11 * f2 - j12 * f1) / det;
    let step = 1;
    while ((a - step * da <= 0 || b - step * db <= 0) && step > 1e-10) step /= 2;
    a -= step * da; b -= step * db;
    if (Math.abs(da) < 1e-15 * a && Math.abs(db) < 1e-15 * b) break;
  }
  return [a, b];
}

function fitMLE(name, x) {
  switch (name) {
    case "Normal": return [meanOf(x), stdOf(x, 0)];
    case "Lognormal": { const l = x.map(Math.log); return [meanOf(l), stdOf(l, 0)]; }
    case "Gamma": return mleGamma(x);
    case "Weibull": return mleWeibull(x);
    case "Exponential": return [meanOf(x)];
    case "Beta": return mleBeta(x);
  }
  throw new Error(`Unknown distribution: ${name}`);
}

/** Starting values from (weighted) moments, used in histogram mode. */
function momentStart(name, m, v) {
  const sd = Math.sqrt(v);
  switch (name) {
    case "Normal": return [m, sd];
    case "Lognormal": { const s2 = Math.log(1 + v / (m * m)); return [Math.log(m) - s2 / 2, Math.sqrt(s2)]; }
    case "Gamma": return [m * m / v, v / m];
    case "Weibull": { const k = Math.pow(sd / m, -1.086); return [m / Math.exp(lgamma(1 + 1 / k)), k]; }
    case "Exponential": return [m];
    case "Beta": { let c = m * (1 - m) / v - 1; if (!(c > 0)) c = 1; return [m * c, (1 - m) * c]; }
  }
  throw new Error(`Unknown distribution: ${name}`);
}

// ============================================================
// NELDER-MEAD (scipy.optimize.minimize semantics)
// ============================================================

function nelderMead(f, x0, opts = {}) {
  const xatol = opts.xatol ?? 1e-10, fatol = opts.fatol ?? 1e-15;
  const n = x0.length, maxiter = opts.maxiter ?? 400 * n * 50, maxfev = opts.maxfev ?? 400 * n * 50;
  const rho = 1, chi = 2, psi = 0.5, sigma = 0.5;
  let sim = [x0.slice()];
  for (let k = 0; k < n; k++) {
    const y = x0.slice();
    y[k] = y[k] !== 0 ? 1.05 * y[k] : 0.00025;
    sim.push(y);
  }
  let fsim = sim.map(f);
  let fcalls = n + 1, iter = 0;
  const order = () => {
    const idx = fsim.map((v, i) => i).sort((a, b) => fsim[a] - fsim[b]);
    sim = idx.map(i => sim[i]); fsim = idx.map(i => fsim[i]);
  };
  order();
  while (fcalls < maxfev && iter < maxiter) {
    let xd = 0, fd = 0;
    for (let i = 1; i <= n; i++) {
      for (let j = 0; j < n; j++) xd = Math.max(xd, Math.abs(sim[i][j] - sim[0][j]));
      fd = Math.max(fd, Math.abs(fsim[0] - fsim[i]));
    }
    if (xd <= xatol && fd <= fatol) break;
    const xbar = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) xbar[j] += sim[i][j] / n;
    const xr = xbar.map((v, j) => (1 + rho) * v - rho * sim[n][j]);
    const fxr = f(xr); fcalls++;
    let doShrink = false;
    if (fxr < fsim[0]) {
      const xe = xbar.map((v, j) => (1 + rho * chi) * v - rho * chi * sim[n][j]);
      const fxe = f(xe); fcalls++;
      if (fxe < fxr) { sim[n] = xe; fsim[n] = fxe; } else { sim[n] = xr; fsim[n] = fxr; }
    } else if (fxr < fsim[n - 1]) {
      sim[n] = xr; fsim[n] = fxr;
    } else if (fxr < fsim[n]) {
      const xc = xbar.map((v, j) => (1 + psi * rho) * v - psi * rho * sim[n][j]);
      const fxc = f(xc); fcalls++;
      if (fxc <= fxr) { sim[n] = xc; fsim[n] = fxc; } else doShrink = true;
    } else {
      const xcc = xbar.map((v, j) => (1 - psi) * v + psi * sim[n][j]);
      const fxcc = f(xcc); fcalls++;
      if (fxcc < fsim[n]) { sim[n] = xcc; fsim[n] = fxcc; } else doShrink = true;
    }
    if (doShrink) {
      for (let i = 1; i <= n; i++) {
        sim[i] = sim[0].map((v, j) => v + sigma * (sim[i][j] - v));
        fsim[i] = f(sim[i]); fcalls++;
      }
    }
    iter++;
    order();
  }
  return { x: sim[0], fun: fsim[0], nfev: fcalls, nit: iter };
}

// Optimisation coordinates: positive parameters on log scale.
const POSITIVE_PARAM = {
  Normal: [false, true], Lognormal: [false, true], Gamma: [true, true],
  Weibull: [true, true], Exponential: [true], Beta: [true, true]
};
const toOpt = (name, p) => p.map((v, i) => POSITIVE_PARAM[name][i] ? Math.log(v) : v);
const fromOpt = (name, z) => z.map((v, i) => POSITIVE_PARAM[name][i] ? Math.exp(v) : v);

function modelBinProbabilities(dist, edges) {
  const nb = edges.length - 1;
  const P = new Array(nb);
  let prev = dist.cdf(edges[0]), sum = 0;
  for (let i = 0; i < nb; i++) {
    const cur = dist.cdf(edges[i + 1]);
    P[i] = cur - prev; prev = cur; sum += P[i];
  }
  return { P, sum };
}

function directFit(name, hist, start, mode) {
  const weighted = String(mode || "weighted").toLowerCase() !== "unweighted";
  const pb = hist.pbin, edges = hist.edges;
  const wts = pb.map(p => weighted ? 1 / Math.max(p, DIRECT_WEIGHT_FLOOR) : 1);
  const obj = z => {
    const params = fromOpt(name, z);
    if (params.some(v => !Number.isFinite(v))) return 1e10;
    let dist;
    try { dist = makeDistribution(name, params); } catch { return 1e10; }
    if (!dist.valid) return 1e10;
    const { P, sum } = modelBinProbabilities(dist, edges);
    if (!(sum > 0) || !Number.isFinite(sum)) return 1e10;
    let s = 0;
    for (let i = 0; i < P.length; i++) s += wts[i] * (pb[i] - P[i] / sum) ** 2;
    return Number.isFinite(s) ? s : 1e10;
  };
  let z = toOpt(name, start);
  let res = nelderMead(obj, z);
  // Restart once from the optimum (guards against early simplex collapse).
  for (let r = 0; r < 3; r++) {
    const res2 = nelderMead(obj, res.x);
    const improved = res2.fun < res.fun - 1e-15 * Math.abs(res.fun);
    res = res2.fun <= res.fun ? res2 : res;
    if (!improved) break;
  }
  return fromOpt(name, res.x);
}

// ============================================================
// SCORING / FORMATTING
// ============================================================

function fmt8g(v) {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(Number(v.toPrecision(8)))));
  if (exp < -4 || exp >= 8) {
    let [mant, e] = v.toExponential(7).split("e");
    if (mant.includes(".")) mant = mant.replace(/0+$/, "").replace(/\.$/, "");
    const en = Number(e);
    return `${mant}e${en < 0 ? "-" : "+"}${String(Math.abs(en)).padStart(2, "0")}`;
  }
  let s = v.toPrecision(8);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

function paramString(name, params) {
  return PARAM_NAMES[name].map((k, i) => `${k}=${fmt8g(params[i])}`).join("; ");
}

function finiteOrNull(v) { return Number.isFinite(v) ? v : null; }

function scoreModel(name, fitType, params, hist, xplot, rawValues) {
  const dist = makeDistribution(name, params);
  const modelPdfAtBins = hist.centers.map(c => dist.pdf(c));
  let sse = 0, sumPdf = 0;
  for (let i = 0; i < hist.centers.length; i++) {
    sse += (hist.pdf[i] - modelPdfAtBins[i]) ** 2;
    sumPdf += hist.pdf[i];
  }
  const { P, sum } = modelBinProbabilities(dist, hist.edges);
  let ssePbin = 0;
  for (let i = 0; i < P.length; i++) ssePbin += (hist.pbin[i] - P[i] / sum) ** 2;
  const out = {
    Distribution: name,
    FitType: fitType,
    Params: params.slice(),
    ParamNames: PARAM_NAMES[name].slice(),
    ParamString: paramString(name, params),
    SSE_PDF: sse,
    SSE_PDF_Norm: sse / sumPdf,
    SSE_Pbin: ssePbin,
    LogLikelihood: null, AIC: null, BIC: null, KS_pValue: null,
    Rank: null,
    curve: {
      pdf: xplot.map(x => finiteOrNull(dist.pdf(x))),
      cdf: xplot.map(x => finiteOrNull(dist.cdf(x)))
    },
    modelPdfAtBins: modelPdfAtBins.map(finiteOrNull)
  };
  if (rawValues) {
    let ll = 0;
    for (const v of rawValues) ll += dist.logpdf(v);
    const n = rawValues.length, k = dist.k;
    out.LogLikelihood = ll;
    out.AIC = 2 * k - 2 * ll;
    out.BIC = k * Math.log(n) - 2 * ll;
    out.KS_pValue = ksTest(rawValues, dist.cdf).pValue;
  }
  return out;
}

function rankGroup(list, key) {
  const sorted = list.slice().sort((a, b) => {
    const va = Number.isFinite(a[key]) ? a[key] : Infinity;
    const vb = Number.isFinite(b[key]) ? b[key] : Infinity;
    return va - vb;
  });
  sorted.forEach((r, i) => { r.Rank = i + 1; });
  return sorted;
}

function linspace(a, b, n) {
  const out = new Array(n);
  const step = (b - a) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = a + i * step;
  out[n - 1] = b;
  return out;
}

const QQ_PROBABILITIES = linspace(0.01, 0.99, 99);

function supportCheck(name, minV, maxV) {
  if (POSITIVE.has(name) && !(minV > 0)) return `${name} skipped: requires all values > 0.`;
  if (name === "Beta" && !(minV > 0 && maxV < 1)) return "Beta skipped: requires all values strictly between 0 and 1.";
  return null;
}

function cleanDistributions(list) {
  const chosen = (Array.isArray(list) && list.length ? list : ALL_DISTRIBUTIONS)
    .filter(d => ALL_DISTRIBUTIONS.includes(d));
  if (!chosen.length) throw new Error("Please select at least one distribution.");
  return chosen;
}

function qqFor(fit) {
  const dist = makeDistribution(fit.Distribution, fit.Params);
  return QQ_PROBABILITIES.map(p => { try { return finiteOrNull(dist.ppf(p)); } catch { return null; } });
}

// ============================================================
// PUBLIC API (same payloads/results as the former backend)
// ============================================================

function divergenceWarning(name, params, edges) {
  const span = Math.max(Math.abs(edges[0]), Math.abs(edges[edges.length - 1]), edges[edges.length - 1] - edges[0]);
  if (params.some(v => !Number.isFinite(v) || Math.abs(v) > 1e6 * span)) {
    return `${name} DirectHistFit diverged (the model becomes flat over the bins, ` +
      `parameters ${paramString(name, params)}); the shape does not fit these data - ignore this row.`;
  }
  return null;
}

/** Former POST /api/fit/raw */
function fitRaw({ values, binMethod = "fd", directMode = "weighted", distributions } = {}) {
  const x = (values || []).map(Number).filter(Number.isFinite);
  if (x.length < 10) throw new Error("At least 10 valid numeric observations are required.");
  const chosen = cleanDistributions(distributions);
  const warnings = [];
  const edges = histogramBinEdges(x, String(binMethod || "fd").toLowerCase());
  const counts = histogramCounts(x, edges).counts;
  const hist = buildHistogram(edges, counts);
  hist.counts = counts;
  hist.binMethod = binMethod;
  const xplot = linspace(edges[0], edges[edges.length - 1], 400);
  let minV = Infinity, maxV = -Infinity;
  for (const v of x) { if (v < minV) minV = v; if (v > maxV) maxV = v; }

  const mle = [], direct = [];
  for (const name of chosen) {
    const skip = supportCheck(name, minV, maxV);
    if (skip) { warnings.push(skip); continue; }
    try {
      const pM = fitMLE(name, x);
      mle.push(scoreModel(name, "MLE", pM, hist, xplot, x));
      const pD = directFit(name, hist, pM, directMode);
      const dw = divergenceWarning(name, pD, edges);
      if (dw) warnings.push(dw);
      direct.push(scoreModel(name, "DirectHistFit", pD, hist, xplot, null));
    } catch (err) {
      warnings.push(`${name} failed: ${err.message}`);
    }
  }
  if (!mle.length) throw new Error("No distribution could be fitted to these data. " + warnings.join(" "));
  const mleRanked = rankGroup(mle, "SSE_PDF_Norm");
  const directRanked = rankGroup(direct, "SSE_Pbin");
  const bestMLE = mleRanked[0], bestDirect = directRanked[0];
  return {
    engineVersion: VERSION,
    mode: "RawData",
    values: x,
    histogram: hist,
    xplot,
    results: [...mleRanked, ...directRanked],
    bestMLE, bestDirect,
    bestGenerateFit: bestDirect,
    qqProbabilities: QQ_PROBABILITIES.slice(),
    qqModel: qqFor(bestMLE),
    qqModelSource: "bestMLE",
    directMode: String(directMode).toLowerCase(),
    warnings
  };
}

/** Histogram edges from bin centres (midpoints, half-spacing at both ends). */
function edgesFromCenters(c) {
  const n = c.length, e = new Array(n + 1);
  for (let i = 1; i < n; i++) e[i] = (c[i - 1] + c[i]) / 2;
  e[0] = c[0] - (c[1] - c[0]) / 2;
  e[n] = c[n - 1] + (c[n - 1] - c[n - 2]) / 2;
  return e;
}

/** Former POST /api/fit/histogram */
function fitHistogram({ centers, values, histCol2Type = "Percent", directMode = "weighted", distributions } = {}) {
  const pairs = [];
  for (let i = 0; i < (centers || []).length; i++) {
    const c = Number(centers[i]), v = Number((values || [])[i]);
    if (Number.isFinite(c) && Number.isFinite(v)) pairs.push([c, v]);
  }
  if (pairs.length < 5) throw new Error("Histogram mode requires at least 5 bins.");
  for (let i = 1; i < pairs.length; i++) {
    if (!(pairs[i][0] > pairs[i - 1][0])) throw new Error("Bin centers must be strictly increasing.");
  }
  if (pairs.some(p => p[1] < 0)) throw new Error("Histogram column 2 must not contain negative values.");
  const c = pairs.map(p => p[0]), mass = pairs.map(p => p[1]);
  const total = mass.reduce((s, v) => s + v, 0);
  if (!(total > 0)) throw new Error("Histogram column 2 must have a positive total.");
  const chosen = cleanDistributions(distributions);
  const warnings = [];
  const type = String(histCol2Type || "Percent");
  if (type === "Percent" && Math.abs(total - 100) > 0.5) {
    warnings.push(`Percent column sums to ${fmt8g(total)} (not 100); values were normalised to 1.`);
  }
  const edges = edgesFromCenters(c);
  const hist = buildHistogram(edges, mass);
  hist.col2Type = type;
  hist.inputValues = mass.slice();
  const xplot = linspace(edges[0], edges[edges.length - 1], 400);

  let m = 0, v = 0;
  for (let i = 0; i < c.length; i++) m += hist.pbin[i] * c[i];
  for (let i = 0; i < c.length; i++) v += hist.pbin[i] * (c[i] - m) ** 2;
  if (!(v > 0)) v = (hist.widths[0] ** 2) / 12;

  const direct = [];
  for (const name of chosen) {
    const skip = supportCheck(name, c[0], c[c.length - 1]);
    if (skip) { warnings.push(skip.replace("values", "bin centers")); continue; }
    try {
      const start = momentStart(name, m, v);
      const pD = directFit(name, hist, start, directMode);
      const dw = divergenceWarning(name, pD, edges);
      if (dw) warnings.push(dw);
      direct.push(scoreModel(name, "DirectHistFit", pD, hist, xplot, null));
    } catch (err) {
      warnings.push(`${name} failed: ${err.message}`);
    }
  }
  if (!direct.length) throw new Error("No distribution could be fitted to this histogram. " + warnings.join(" "));
  const ranked = rankGroup(direct, "SSE_Pbin");
  const bestDirect = ranked[0];
  return {
    engineVersion: VERSION,
    mode: "Hist2Col",
    values: [],
    histogram: hist,
    xplot,
    results: ranked,
    bestMLE: null,
    bestDirect,
    bestGenerateFit: bestDirect,
    qqProbabilities: QQ_PROBABILITIES.slice(),
    qqModel: qqFor(bestDirect),
    qqModelSource: "bestDirect",
    directMode: String(directMode).toLowerCase(),
    warnings
  };
}

/** Former POST /api/generate */
function generate({ mode, bestFit, histogram, originalValues = [], sampleSize = 50000, seed } = {}) {
  if (!bestFit || !bestFit.Params) throw new Error("Please run a fit first.");
  const n = Math.max(1000, Math.min(200000, Math.round(Number(sampleSize) || 50000)));
  const rng = makeRng(seed);
  const dist = makeDistribution(bestFit.Distribution, bestFit.Params);
  const generated = new Array(n);
  for (let i = 0; i < n; i++) generated[i] = dist.sample(rng);

  const edges = histogram.edges;
  const { counts, outside } = histogramCounts(generated, edges);
  const hg = buildHistogram(edges, counts);
  hg.counts = counts;
  hg.outOfRange = outside;

  let mo, so, mino, maxo;
  if (mode === "RawData" && originalValues.length) {
    mo = meanOf(originalValues); so = stdOf(originalValues, 1);
    mino = Math.min(...originalValues); maxo = Math.max(...originalValues);
  } else {
    const c = histogram.centers, p = histogram.pbin;
    mo = 0; for (let i = 0; i < c.length; i++) mo += p[i] * c[i];
    let v = 0; for (let i = 0; i < c.length; i++) v += p[i] * (c[i] - mo) ** 2;
    so = Math.sqrt(v);
    const nz = c.filter((_, i) => p[i] > 0);
    mino = nz[0]; maxo = nz[nz.length - 1];
  }
  let mg = 0; for (const v of generated) mg += v; mg /= n;
  let vg = 0, ming = Infinity, maxg = -Infinity;
  for (const v of generated) { vg += (v - mg) ** 2; if (v < ming) ming = v; if (v > maxg) maxg = v; }
  const sg = Math.sqrt(vg / (n - 1));
  const metrics = [
    ["Mean_Orig", mo], ["Std_Orig", so], ["Min_Orig", mino], ["Max_Orig", maxo],
    ["Mean_Gen", mg], ["Std_Gen", sg], ["Min_Gen", ming], ["Max_Gen", maxg],
    ["Mean_Abs_Diff", Math.abs(mg - mo)], ["Std_Abs_Diff", Math.abs(sg - so)]
  ];
  return {
    engineVersion: VERSION,
    sampleSize: n,
    distribution: bestFit.Distribution,
    params: bestFit.Params.slice(),
    generated,
    histogramGenerated: hg,
    metrics
  };
}

const API = {
  version: VERSION,
  distributions: ALL_DISTRIBUTIONS.slice(),
  fitRaw, fitHistogram, generate,
  // exposed for tests
  _internal: {
    lgamma, digamma, trigamma, gammaPQ, betaI, pnorm, qnorm, smirnov,
    kolmogorovSf, kolmognDMTW, kolmognPomeranz, kolmognPelzGood, ksTest,
    histogramBinEdges, histogramCounts, edgesFromCenters, fitMLE, directFit,
    makeDistribution, makeRng, fmt8g, nelderMead
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = API;
root.FitEngine = API;
})(typeof window !== "undefined" ? window : globalThis);
