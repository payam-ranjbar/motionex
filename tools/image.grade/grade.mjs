// image.grade pixel math: sRGB, linear light and CIE L*a*b* (D65), Gaussian blurs from repeated box blurs, a
// Euclidean distance transform, the light mask, the grade steps, the glow layer, .cube parsing and the measurements.
// Pure functions on typed arrays, no I/O. A working image is interleaved RGB in encoded sRGB, nominally 0..1; values
// may leave that range between steps (an exposure push, say) and are clipped only when the result is written.
// Steps are already validated and carry their defaults (see the handler).

/** Clamp to 0..1; NaN becomes 0. */
const clamp01 = (v) => (v > 0 ? Math.min(v, 1) : 0);
/** Hermite smoothstep of t, clamped to 0..1. */
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Encoded sRGB -> linear light. Negative values mirror; values above 1 follow the same power. */
export function toLinear(v) {
  const a = v < 0 ? -v : v;
  const l = a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4;
  return v < 0 ? -l : l;
}

/** Linear light -> encoded sRGB (the inverse of toLinear). */
export function toEncoded(l) {
  const a = l < 0 ? -l : l;
  const v = a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055;
  return l < 0 ? -v : v;
}

/** Linear light of each 8-bit sRGB code. */
export const LIN8 = Float64Array.from({ length: 256 }, (_, i) => toLinear(i / 255));

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

// Linear sRGB -> XYZ (D65). The white point is the matrix applied to (1, 1, 1), so R = G = B is exactly neutral.
const M = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];
const MI = invert3(M);
const XN = M[0] + M[1] + M[2];
const YN = M[3] + M[4] + M[5];
const ZN = M[6] + M[7] + M[8];
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;
const fLab = (t) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
const fLabInv = (u) => {
  const c = u * u * u;
  return c > EPS ? c : (116 * u - 16) / KAPPA;
};

/** Linear RGB -> L*, a*, b* written to out[0..2]. */
export function labFromLinear(r, g, b, out) {
  const fx = fLab((M[0] * r + M[1] * g + M[2] * b) / XN);
  const fy = fLab((M[3] * r + M[4] * g + M[5] * b) / YN);
  const fz = fLab((M[6] * r + M[7] * g + M[8] * b) / ZN);
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
}

/** L*, a*, b* -> linear RGB written to out[0..2]. */
export function linearFromLab(L, a, b, out) {
  const fy = (L + 16) / 116;
  const X = fLabInv(fy + a / 500) * XN;
  const Y = fLabInv(fy) * YN;
  const Z = fLabInv(fy - b / 200) * ZN;
  out[0] = MI[0] * X + MI[1] * Y + MI[2] * Z;
  out[1] = MI[3] * X + MI[4] * Y + MI[5] * Z;
  out[2] = MI[6] * X + MI[7] * Y + MI[8] * Z;
}

/** Lab of pixel i of an encoded RGB buffer, into out. */
function labAt(rgb, i, out) {
  const o = i * 3;
  labFromLinear(toLinear(rgb[o]), toLinear(rgb[o + 1]), toLinear(rgb[o + 2]), out);
}

/** Write Lab back into pixel i of an encoded RGB buffer (tmp: scratch of 3). */
function setLab(rgb, i, L, a, b, tmp) {
  linearFromLab(L, a, b, tmp);
  const o = i * 3;
  rgb[o] = toEncoded(tmp[0]);
  rgb[o + 1] = toEncoded(tmp[1]);
  rgb[o + 2] = toEncoded(tmp[2]);
}

/** HSV hue in degrees [0, 360) of encoded r, g, b; -1 for a grey. */
export function hueOf(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  if (c <= 0) return -1;
  let h;
  if (max === r) h = (g - b) / c;
  else if (max === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

const inHueRange = (h, lo, hi) => (lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi);

// ---------------------------------------------------------------------------------------------------------------------
// Blur and distance

/** Radii of n box blurs whose sequence approximates a Gaussian of `sigma` pixels. */
function boxRadii(sigma, n = 3) {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => ((i < m ? wl : wu) - 1) / 2);
}

/** One box blur of radius r along rows (src -> dst), edges extended. */
function boxRows(src, dst, w, h, r) {
  if (r <= 0) {
    dst.set(src);
    return;
  }
  const inv = 1 / (2 * r + 1);
  const last = w - 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(Math.max(k, 0), last)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * inv;
      acc += src[row + Math.min(x + r + 1, last)] - src[row + Math.max(x - r, 0)];
    }
  }
}

/** One box blur of radius r along columns (src -> dst), edges extended. */
function boxCols(src, dst, w, h, r) {
  if (r <= 0) {
    dst.set(src);
    return;
  }
  const inv = 1 / (2 * r + 1);
  const last = h - 1;
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[Math.min(Math.max(k, 0), last) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * inv;
      acc += src[Math.min(y + r + 1, last) * w + x] - src[Math.max(y - r, 0) * w + x];
    }
  }
}

/**
 * Gaussian blur of one plane (three box blurs per direction).
 * @param {Float32Array} src @param {number} w @param {number} h @param {number} sigma pixels
 * @returns {Float32Array} a new plane
 */
export function gaussianBlur(src, w, h, sigma) {
  const out = Float32Array.from(src);
  if (!(sigma > 0.3)) return out;
  const tmp = new Float32Array(src.length);
  for (const r of boxRadii(sigma)) {
    boxRows(out, tmp, w, h, r);
    boxCols(tmp, out, w, h, r);
  }
  return out;
}

const FAR = 1e20;

/** 1-D squared distance transform of f (Felzenszwalb & Huttenlocher) into d. */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = Number.NEGATIVE_INFINITY;
  z[1] = Number.POSITIVE_INFINITY;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Number.POSITIVE_INFINITY;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Euclidean distance in pixels from every pixel to the nearest feature pixel (0 on a feature; about 1e10 when there
 * is no feature at all).
 * @param {Uint8Array} feature 1 = feature @param {number} w @param {number} h
 * @returns {Float32Array}
 */
export function distanceTo(feature, w, h) {
  const g = new Float32Array(w * h);
  const len = Math.max(w, h);
  const f = new Float64Array(len);
  const d = new Float64Array(len);
  const v = new Int32Array(len);
  const z = new Float64Array(len + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let any = false;
    for (let x = 0; x < w; x++) {
      const on = feature[row + x] !== 0;
      f[x] = on ? 0 : FAR;
      any ||= on;
    }
    if (!any) {
      g.fill(FAR, row, row + w);
      continue;
    }
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[row + x] = d[x];
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = Math.sqrt(d[y]);
  }
  return g;
}

// ---------------------------------------------------------------------------------------------------------------------
// Masks

/**
 * The subject matte from a decoded RGBA mask: its alpha when any pixel is not opaque, else its luminance.
 * @param {Uint8Array} px RGBA @param {number} n pixels
 * @returns {{mask: Float32Array, source: 'alpha'|'luminance'}}
 */
export function maskFrom(px, n) {
  let alpha = false;
  for (let i = 0; i < n; i++) {
    if (px[i * 4 + 3] !== 255) {
      alpha = true;
      break;
    }
  }
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    mask[i] = alpha ? px[o + 3] / 255 : clamp01((0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) / 255);
  }
  return { mask, source: alpha ? 'alpha' : 'luminance' };
}

/**
 * The light mask of an image as it entered the grade: pixels that are bright and saturated within the hue range,
 * plus near-white cores connected to them, widened by `spread` and feathered over the same distance again.
 * @param {Float32Array} rgb encoded @param {number} w @param {number} h
 * @param {{hue_min_deg: number, hue_max_deg: number, min_value: number, min_saturation: number, core_value: number,
 *   spread: number}} o
 * @returns {{raw: Uint8Array, soft: Float32Array}} raw = the light pixels themselves; soft = the widened mask 0..1
 */
export function lightMask(rgb, w, h, o) {
  const n = w * h;
  const raw = new Uint8Array(n);
  const core = new Uint8Array(n);
  let anyRaw = false;
  let anyCore = false;
  for (let i = 0; i < n; i++) {
    const r = clamp01(rgb[i * 3]);
    const g = clamp01(rgb[i * 3 + 1]);
    const b = clamp01(rgb[i * 3 + 2]);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max > 0 ? (max - min) / max : 0;
    if (sat < o.min_saturation) {
      // Too pale to be coloured light; bright enough, it is a near-white core candidate.
      if (max >= o.core_value) {
        core[i] = 1;
        anyCore = true;
      }
      continue;
    }
    if (max < o.min_value) continue;
    const hue = hueOf(r, g, b);
    if (hue >= 0 && inHueRange(hue, o.hue_min_deg, o.hue_max_deg)) {
      raw[i] = 1;
      anyRaw = true;
    }
  }
  const spreadPx = o.spread * w;
  if (anyRaw && anyCore) {
    // Near-white cores (a blown lamp centre) count when they touch the coloured light, within the spread.
    const near = distanceTo(raw, w, h);
    const reach = Math.max(spreadPx, 1.5);
    const queue = new Int32Array(n);
    let qt = 0;
    for (let i = 0; i < n; i++) {
      if (core[i] && !raw[i] && near[i] <= reach) {
        raw[i] = 1;
        queue[qt++] = i;
      }
    }
    for (let qh = 0; qh < qt; qh++) {
      const i = queue[qh];
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (core[j] && !raw[j]) {
            raw[j] = 1;
            queue[qt++] = j;
          }
        }
      }
    }
  }
  const soft = new Float32Array(n);
  if (!anyRaw) return { raw, soft };
  if (spreadPx < 0.5) {
    for (let i = 0; i < n; i++) soft[i] = raw[i];
    return { raw, soft };
  }
  const d = distanceTo(raw, w, h);
  for (let i = 0; i < n; i++) {
    soft[i] = d[i] <= spreadPx ? 1 : 1 - smooth((d[i] - spreadPx) / spreadPx);
  }
  return { raw, soft };
}

// ---------------------------------------------------------------------------------------------------------------------
// Steps. Each returns null when done (or when it has nothing to do) and a reason string when it skipped this image.

/**
 * @typedef {{width: number, height: number, rgb: Float32Array, lights: Float32Array, mask: Float32Array|null,
 *   subjectDistance?: Float32Array}} GradeImage
 */

const NO_MASK = (what) => `${what} but this image has no mask`;

/** Per-pixel keep weights (1 = untouched) for a protect value, null for none, or a skip reason. */
function protection(img, protect) {
  if (!protect || protect === 'none') return null;
  if (protect === 'lights') return img.lights;
  return img.mask ?? NO_MASK('protect is "mask"');
}

function cast(img, s) {
  const keep = protection(img, s.protect);
  if (typeof keep === 'string') return keep;
  if (s.amount === 0) return null;
  const { rgb } = img;
  const n = rgb.length / 3;
  const ci = s.axis === 'yellow' || s.axis === 'blue' ? 2 : 1;
  const sign = s.axis === 'yellow' || s.axis === 'red' ? 1 : -1;
  const T = new Float64Array(3);
  const U = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    labAt(rgb, i, T);
    const v = T[ci];
    if (v * sign <= 0) continue;
    const k = keep ? s.amount * (1 - keep[i]) : s.amount;
    if (k <= 0) continue;
    T[ci] = v * (1 - k);
    setLab(rgb, i, T[0], T[1], T[2], U);
  }
  return null;
}

function saturation(img, s) {
  const { rgb } = img;
  const n = rgb.length / 3;
  const hue = s.hue;
  const rest = s.rest ?? 1;
  if (s.amount === 1 && (!hue || rest === 1)) return null;
  const half = hue ? hue.width_deg / 2 : 0;
  const T = new Float64Array(3);
  const U = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    let k = s.amount;
    if (hue) {
      const h = hueOf(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
      if (h < 0) continue; // grey: no chroma to scale
      const delta = Math.abs(((h - hue.center_deg + 540) % 360) - 180);
      // Full strength within a quarter of the width of the centre, fading out at half the width.
      const wgt = 1 - smooth((delta - half / 2) / (half / 2));
      k = rest + wgt * (s.amount - rest);
    }
    if (k === 1) continue;
    labAt(rgb, i, T);
    setLab(rgb, i, T[0], T[1] * k, T[2] * k, U);
  }
  return null;
}

/** The per-channel curve function of a curve step, or null when it changes nothing. */
export function curveFunction(s) {
  const shoulder = s.shoulder ?? 0;
  const gamma = s.gamma ?? 1;
  const contrast = s.contrast ?? 0;
  const lift = s.lift ?? 0;
  const pivot = s.pivot ?? 0.5;
  if (shoulder === 0 && gamma === 1 && contrast === 0 && lift === 0) return null;
  const knee = 1 - shoulder;
  const clip = gamma !== 1 || contrast !== 0;
  const e = 1 / gamma;
  const k = 1 + contrast;
  return (v) => {
    if (shoulder > 0 && v > knee) v = knee + shoulder * (1 - Math.exp(-(v - knee) / shoulder));
    if (clip) v = clamp01(v);
    if (gamma !== 1) v **= e;
    if (contrast !== 0) v = v <= pivot ? pivot * (v / pivot) ** k : 1 - (1 - pivot) * ((1 - v) / (1 - pivot)) ** k;
    if (lift > 0) v = lift + (1 - lift) * v;
    else if (lift < 0) v = (v + lift) / (1 + lift);
    return v;
  };
}

function curve(img, s) {
  const fn = curveFunction(s);
  if (!fn) return null;
  const { rgb } = img;
  for (let i = 0; i < rgb.length; i++) rgb[i] = fn(rgb[i]);
  return null;
}

function exposure(img, s) {
  if (s.ev === 0) return null;
  const k = 2 ** s.ev;
  const { rgb } = img;
  for (let i = 0; i < rgb.length; i++) rgb[i] = toEncoded(toLinear(rgb[i]) * k);
  return null;
}

function clarity(img, s) {
  const sigma = s.radius * img.width;
  if (s.amount === 0 || !(sigma > 0.3)) return null;
  const { rgb, width: w, height: h } = img;
  const n = w * h;
  const lab = new Float32Array(n * 3);
  const L = new Float32Array(n);
  const T = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    labAt(rgb, i, T);
    lab[i * 3] = T[0];
    lab[i * 3 + 1] = T[1];
    lab[i * 3 + 2] = T[2];
    L[i] = T[0];
  }
  const blur = gaussianBlur(L, w, h, sigma);
  for (let i = 0; i < n; i++) {
    const detail = L[i] - blur[i];
    if (detail === 0) continue;
    setLab(rgb, i, L[i] + s.amount * detail, lab[i * 3 + 1], lab[i * 3 + 2], T);
  }
  return null;
}

/** Distance from every pixel to the subject (mask >= 0.5), computed once per image. */
function subjectDistance(img) {
  if (!img.subjectDistance) {
    const n = img.width * img.height;
    const feature = new Uint8Array(n);
    for (let i = 0; i < n; i++) feature[i] = img.mask[i] >= 0.5 ? 1 : 0;
    img.subjectDistance = distanceTo(feature, img.width, img.height);
  }
  return img.subjectDistance;
}

/** Weight of "outside the subject" per pixel: (1 - mask), held off the subject by grow and faded in over feather. */
export function outsideWeights(img, grow, feather) {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const g = grow * img.width;
  const f = feather * img.width;
  if (g + f <= 0) {
    for (let i = 0; i < n; i++) out[i] = 1 - img.mask[i];
    return out;
  }
  const d = subjectDistance(img);
  for (let i = 0; i < n; i++) {
    const ramp = f > 0 ? smooth((d[i] - g) / f) : d[i] > g ? 1 : 0;
    out[i] = (1 - img.mask[i]) * ramp;
  }
  return out;
}

function tint(img, s) {
  const keep = protection(img, s.protect);
  if (typeof keep === 'string') return keep;
  if (s.where !== 'everywhere' && !img.mask) return NO_MASK(`where is "${s.where}"`);
  if (s.amount === 0) return null;
  const outside = s.where === 'everywhere' ? null : outsideWeights(img, s.grow, s.feather);
  const [cr, cg, cb] = s.color;
  const { rgb } = img;
  const n = rgb.length / 3;
  const inside = s.where === 'inside-mask';
  for (let i = 0; i < n; i++) {
    let wgt = s.amount;
    if (outside) wgt *= inside ? 1 - outside[i] : outside[i];
    if (keep) wgt *= 1 - keep[i];
    if (wgt <= 0) continue;
    const o = i * 3;
    rgb[o] += wgt * (cr - rgb[o]);
    rgb[o + 1] += wgt * (cg - rgb[o + 1]);
    rgb[o + 2] += wgt * (cb - rgb[o + 2]);
  }
  return null;
}

function vignette(img, s) {
  if (s.amount === 0) return null;
  const { rgb, width: w, height: h } = img;
  const r0 = 1 - s.softness;
  const span = 1 - r0;
  for (let y = 0; y < h; y++) {
    const ny = (y + 0.5 - h / 2) / (h / 2);
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5 - w / 2) / (w / 2);
      const r = Math.sqrt((nx * nx + ny * ny) / 2); // 0 at the centre, 1 at the corners
      const f = 1 - s.amount * smooth((r - r0) / span);
      if (f === 1) continue;
      const o = (y * w + x) * 3;
      rgb[o] *= f;
      rgb[o + 1] *= f;
      rgb[o + 2] *= f;
    }
  }
  return null;
}

/** Trilinear lookup of encoded r, g, b in a parsed LUT, into out[0..2]. */
export function lutLookup(lut, r, g, b, out) {
  const { size: n, table: t, min, max } = lut;
  const fr = clamp01((r - min[0]) / (max[0] - min[0])) * (n - 1);
  const fg = clamp01((g - min[1]) / (max[1] - min[1])) * (n - 1);
  const fb = clamp01((b - min[2]) / (max[2] - min[2])) * (n - 1);
  const r0 = Math.min(Math.floor(fr), n - 2);
  const g0 = Math.min(Math.floor(fg), n - 2);
  const b0 = Math.min(Math.floor(fb), n - 2);
  const dr = fr - r0;
  const dg = fg - g0;
  const db = fb - b0;
  const sr = 3;
  const sg = n * 3;
  const sb = n * n * 3;
  const base = b0 * sb + g0 * sg + r0 * sr;
  for (let c = 0; c < 3; c++) {
    const p = base + c;
    const c00 = t[p] + dr * (t[p + sr] - t[p]);
    const c10 = t[p + sg] + dr * (t[p + sg + sr] - t[p + sg]);
    const c01 = t[p + sb] + dr * (t[p + sb + sr] - t[p + sb]);
    const c11 = t[p + sb + sg] + dr * (t[p + sb + sg + sr] - t[p + sb + sg]);
    const c0 = c00 + dg * (c10 - c00);
    const c1 = c01 + dg * (c11 - c01);
    out[c] = c0 + db * (c1 - c0);
  }
}

function lut(img, s) {
  const amount = s.amount ?? 1;
  if (amount === 0) return null;
  const { rgb } = img;
  const n = rgb.length / 3;
  const T = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    lutLookup(s.lut, rgb[o], rgb[o + 1], rgb[o + 2], T);
    rgb[o] += amount * (T[0] - rgb[o]);
    rgb[o + 1] += amount * (T[1] - rgb[o + 1]);
    rgb[o + 2] += amount * (T[2] - rgb[o + 2]);
  }
  return null;
}

const STEPS = { cast, saturation, curve, exposure, clarity, tint, vignette, lut };

/**
 * Apply one validated step to an image in place.
 * @param {GradeImage} img @param {object} step
 * @returns {string|null} a reason when the step was skipped for this image
 */
export function applyStep(img, step) {
  return STEPS[step.op](img, step);
}

// ---------------------------------------------------------------------------------------------------------------------
// Glow, LUT files, measurements

/**
 * A bloom layer: the graded colour of the light pixels in linear light, blurred at each radius, averaged, normalised so
 * its brightest channel reaches `strength`, and encoded as sRGB on black.
 * @param {Float32Array} rgb encoded graded image @param {number} w @param {number} h @param {Uint8Array} raw light pixels
 * @param {number[]} sigmas pixels @param {number} strength
 * @returns {{rgb: Float32Array, peak: number}} peak = the brightest linear value before normalising
 */
export function glowLayer(rgb, w, h, raw, sigmas, strength) {
  const n = w * h;
  const planes = [0, 1, 2].map((c) => {
    const p = new Float32Array(n);
    for (let i = 0; i < n; i++) if (raw[i]) p[i] = toLinear(clamp01(rgb[i * 3 + c]));
    return p;
  });
  const sum = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (const sigma of sigmas) {
    for (let c = 0; c < 3; c++) {
      const b = gaussianBlur(planes[c], w, h, sigma);
      const s = sum[c];
      for (let i = 0; i < n; i++) s[i] += b[i];
    }
  }
  let top = 0;
  for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) if (sum[c][i] > top) top = sum[c][i];
  const scale = top > 0 ? strength / top : 0;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[i * 3 + c] = toEncoded(clamp01(sum[c][i] * scale));
  }
  return { rgb: out, peak: top / sigmas.length };
}

/**
 * Parse an Adobe/Resolve .cube 3D LUT.
 * @param {string} text
 * @returns {{size: number, min: number[], max: number[], table: Float32Array, title: string|null}}
 * @throws {Error} with a plain-English message
 */
export function parseCube(text) {
  let size = 0;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  let title = null;
  let table = null;
  let count = 0;
  const lines = String(text).split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (!line || line.startsWith('#')) continue;
    if (/^[A-Za-z]/.test(line)) {
      const [key, ...rest] = line.split(/\s+/);
      const nums = rest.map(Number);
      if (key === 'LUT_3D_SIZE') {
        size = Number(rest[0]);
        if (!Number.isInteger(size) || size < 2 || size > 129) {
          throw new Error(`LUT_3D_SIZE must be an integer from 2 to 129 (got ${rest[0]})`);
        }
      } else if (key === 'LUT_1D_SIZE') {
        throw new Error('this is a 1D LUT; only 3D LUTs (LUT_3D_SIZE) are supported');
      } else if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
        if (nums.length !== 3 || nums.some((v) => !Number.isFinite(v))) {
          throw new Error(`${key} needs three numbers (line ${ln + 1})`);
        }
        if (key === 'DOMAIN_MIN') min = nums;
        else max = nums;
      } else if (key === 'LUT_3D_INPUT_RANGE') {
        if (nums.length !== 2 || nums.some((v) => !Number.isFinite(v))) {
          throw new Error(`LUT_3D_INPUT_RANGE needs two numbers (line ${ln + 1})`);
        }
        min = [nums[0], nums[0], nums[0]];
        max = [nums[1], nums[1], nums[1]];
      } else if (key === 'TITLE') {
        title = rest.join(' ').replace(/^"|"$/g, '');
      }
      continue;
    }
    if (!size) throw new Error(`data before LUT_3D_SIZE (line ${ln + 1})`);
    table ??= new Float32Array(size * size * size * 3);
    const vals = line.split(/\s+/).map(Number);
    if (vals.length !== 3 || vals.some((v) => !Number.isFinite(v))) {
      throw new Error(`line ${ln + 1} is not three numbers: "${line.slice(0, 60)}"`);
    }
    if (count >= size * size * size) throw new Error(`more than ${size}^3 = ${size ** 3} entries`);
    table[count * 3] = vals[0];
    table[count * 3 + 1] = vals[1];
    table[count * 3 + 2] = vals[2];
    count++;
  }
  if (!size) throw new Error('no LUT_3D_SIZE line');
  if (count !== size * size * size) throw new Error(`has ${count} entries; LUT_3D_SIZE ${size} needs ${size ** 3}`);
  for (let c = 0; c < 3; c++) {
    if (!(max[c] > min[c])) throw new Error('DOMAIN_MAX must be above DOMAIN_MIN on every channel');
  }
  return { size, min, max, table, title };
}

/**
 * Mean L* of the frame, mean a* and b* outside the light mask, and (with a mask) mean L* inside and outside the
 * subject. Transparent pixels count by their alpha.
 * @param {Uint8Array} buf 8-bit RGB or RGBA @param {number} stride 3 or 4 @param {number} n pixels
 * @param {Float32Array} lights soft light mask @param {Float32Array|null} alpha 0..1 @param {Float32Array|null} mask
 * @returns {{luma: number, cast_a: number, cast_b: number, luma_in: number|null, luma_out: number|null}}
 */
export function measure(buf, stride, n, lights, alpha, mask) {
  const T = new Float64Array(3);
  let sw = 0;
  let sl = 0;
  let sa = 0;
  let sb = 0;
  let cw = 0;
  let ca = 0;
  let cb = 0;
  let mi = 0;
  let li = 0;
  let mo = 0;
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    labFromLinear(LIN8[buf[o]], LIN8[buf[o + 1]], LIN8[buf[o + 2]], T);
    const a = alpha ? alpha[i] : 1;
    sw += a;
    sl += a * T[0];
    sa += a * T[1];
    sb += a * T[2];
    const wc = a * (1 - lights[i]);
    cw += wc;
    ca += wc * T[1];
    cb += wc * T[2];
    if (mask) {
      const m = a * mask[i];
      mi += m;
      li += m * T[0];
      mo += a - m;
      lo += (a - m) * T[0];
    }
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  const outside = cw > 1e-6 * n;
  return {
    luma: sw > 0 ? r2(sl / sw) : 0,
    cast_a: outside ? r2(ca / cw) : sw > 0 ? r2(sa / sw) : 0,
    cast_b: outside ? r2(cb / cw) : sw > 0 ? r2(sb / sw) : 0,
    luma_in: mask && mi > 0 ? r2(li / mi) : null,
    luma_out: mask && mo > 0 ? r2(lo / mo) : null,
  };
}
