// Pure pixel operations. No DOM / canvas APIs here, so this runs unchanged
// inside a Web Worker and on the main thread (fallback), and gives identical,
// seed-deterministic output on every browser (no reliance on ctx.filter,
// which Safari does not support).

export type RGB = [number, number, number];
export type Paper = "putih" | "krem";

export const INK: RGB = [36, 35, 33];
export const paperRGB = (paper: Paper): RGB =>
  paper === "krem" ? [239, 233, 220] : [246, 245, 241];

/* ───────────── deterministic noise ───────────── */

export function hash2(x: number, y: number, seed: number) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in 0..1. */
export function vnoise(x: number, y: number, seed: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Seeded PRNG (mulberry32), same as the one used for vector drawing. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, v: number) => {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/* ───────────── grayscale + gaussian (3-pass box) blur ───────────── */

export function gray(rgba: Uint8ClampedArray, n: number) {
  const g = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    g[i] = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
  }
  return g;
}

function boxSizes(sigma: number, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

function boxH(s: Float32Array, d: Float32Array, W: number, H: number, r: number) {
  const k = 1 / (r + r + 1);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += s[row + Math.min(W - 1, Math.max(0, i))];
    for (let x = 0; x < W; x++) {
      d[row + x] = acc * k;
      acc += s[row + Math.min(W - 1, x + r + 1)] - s[row + Math.max(0, x - r)];
    }
  }
}

function boxV(s: Float32Array, d: Float32Array, W: number, H: number, r: number) {
  const k = 1 / (r + r + 1);
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += s[Math.min(H - 1, Math.max(0, i)) * W + x];
    for (let y = 0; y < H; y++) {
      d[y * W + x] = acc * k;
      acc += s[Math.min(H - 1, y + r + 1) * W + x] - s[Math.max(0, y - r) * W + x];
    }
  }
}

export function blur(src: Float32Array, W: number, H: number, sigma: number) {
  const a = src.slice();
  if (sigma < 0.35) return a;
  const b = new Float32Array(a.length);
  for (const size of boxSizes(sigma)) {
    const r = (size - 1) >> 1;
    if (r < 1) continue;
    boxH(a, b, W, H, r);
    boxV(b, a, W, H, r);
  }
  return a;
}

/* ───────────── layers ───────────── */

export type LayerArgs = {
  rgba: Uint8ClampedArray;
  W: number;
  H: number;
  seed: number;
  paper: Paper;
  /** resolution scale relative to 1080 px wide */
  sc: number;
  F: number;
  bottom: number;
};

/** Pencil sketch (colour-dodge of gray with its inverted blur). */
export function sketch({ rgba, W, H, seed, paper, sc }: LayerArgs, hatchDark = false) {
  const n = W * H;
  const g = gray(rgba, n);
  const A = blur(g, W, H, 0.7 * sc);
  const inv = new Float32Array(n);
  for (let i = 0; i < n; i++) inv[i] = 255 - g[i];
  const B = blur(inv, W, H, 6 * sc);
  const L = hatchDark ? blur(g, W, H, 2.5 * sc) : null;

  const bg = paperRGB(paper);
  const out = new Uint8ClampedArray(n * 4);
  const sp = Math.max(2.5, 7 * sc);
  const wob = 50 * sc;
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const bl = B[i];
      let v = bl >= 254.5 ? 255 : (A[i] * 255) / (255 - bl);
      if (v > 255) v = 255;
      v = 255 - (255 - v) * 1.8;
      let t = clamp01(v / 255 + (hash2(x, y, seed) - 0.5) * 0.07);

      if (L) {
        // diagonal hatching in the darkest areas, so it reads as drawn
        const w = smooth(0.4, 0.18, L[i] / 255);
        if (w > 0) {
          const u = (x + y) * 0.7071 + (vnoise(x / wob, y / wob, seed + 7) - 0.5) * 5 * sc;
          const ink = lineInk(u, sp, Math.max(0.35, 0.6 * sc)) * brk(u, (x - y) * 0.7071, sp, sc, seed + 3);
          t = t * (1 - 0.18 * w * ink);
        }
      }
      const p = i * 4;
      out[p] = INK[0] + (bg[0] - INK[0]) * t;
      out[p + 1] = INK[1] + (bg[1] - INK[1]) * t;
      out[p + 2] = INK[2] + (bg[2] - INK[2]) * t;
      out[p + 3] = 255;
    }
  }
  return out;
}

/** Antialiased ink coverage of parallel lines spaced `sp` apart along `u`. */
function lineInk(u: number, sp: number, hw: number) {
  let m = u % sp;
  if (m < 0) m += sp;
  return clamp01(hw + 0.5 - Math.abs(m - sp * 0.5));
}

/** Breaks lines into dashes of varying length so hatching looks hand-drawn. */
function brk(u: number, v: number, sp: number, sc: number, seed: number) {
  const li = Math.floor(u / sp);
  const seg = Math.floor((v + hash2(li, 0, seed) * 300) / (90 * sc + 8));
  return hash2(li, seg, seed) < 0.14 ? 0 : 1;
}

/** Watercolour: organic blob mask, soft-jagged edge, pigment ring, splatters. Returns RGBA with alpha. */
export function watercolor({ rgba, W, H, seed, paper, sc, F, bottom }: LayerArgs) {
  const n = W * H;
  const x0 = F, y0 = F, x1 = W - F, y1 = H - bottom;
  const cw = x1 - x0, ch = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const r = rng(seed * 7 + 3);
  const field = new Float32Array(n);

  const disc = (bx: number, by: number, rx: number, ry: number) => {
    const xa = Math.max(0, Math.floor(bx - rx)), xb = Math.min(W - 1, Math.ceil(bx + rx));
    const ya = Math.max(0, Math.floor(by - ry)), yb = Math.min(H - 1, Math.ceil(by + ry));
    for (let y = ya; y <= yb; y++) {
      const dy = (y - by) / ry;
      for (let x = xa; x <= xb; x++) {
        const dx = (x - bx) / rx;
        if (dx * dx + dy * dy <= 1) field[y * W + x] = 1;
      }
    }
  };

  disc(cx, cy, cw * 0.26, ch * 0.26);
  const minD = Math.min(cw, ch);
  for (let k = 0; k < 40; k++) {
    const a = r() * Math.PI * 2, d = 0.1 + Math.sqrt(r()) * 0.38;
    const rad = Math.min((0.08 + r() * 0.17) * minD, cw / 2, ch / 2);
    const bx = Math.min(x1 - rad, Math.max(x0 + rad, cx + Math.cos(a) * d * cw));
    const by = Math.min(y1 - rad, Math.max(y0 + rad, cy + Math.sin(a) * d * ch));
    disc(bx, by, rad, rad * (0.8 + r() * 0.4));
  }

  const V = blur(field, W, H, 25 * sc);
  const alpha = new Float32Array(n);
  const ring = new Float32Array(n);
  const s1 = 70 * sc + 2, s2 = 14 * sc + 1;
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const v = V[i];
      if (v < 0.2) continue;
      const t =
        0.5 +
        (vnoise(x / s1, y / s1, seed + 11) - 0.5) * 0.35 +
        (vnoise(x / s2, y / s2, seed + 13) - 0.5) * 0.15 +
        (hash2(x, y, seed + 17) - 0.5) * 0.04;
      const core = smooth(t - 0.025, t + 0.025, v);
      const bloom = 0.22 * smooth(t - 0.2, t - 0.02, v) * vnoise(x / s2, y / s2, seed + 61);
      alpha[i] = Math.max(core, bloom);
      const e = 1 - clamp01((v - t) / 0.12);
      ring[i] = core * e * e;
    }
  }

  // splatters outside the main wash
  const count = 5 + Math.floor(r() * 8); // 5–12
  for (let k = 0, tries = 0; k < count && tries < 200; tries++) {
    const px = x0 - F * 0.4 + r() * (cw + F * 0.8);
    const py = y0 - F * 0.4 + r() * (ch + F * 0.8);
    const rad = (2 + r() * r() * 12) * sc + 0.8;
    const ix = Math.round(px), iy = Math.round(py);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H || V[iy * W + ix] > 0.15) continue;
    k++;
    for (let y = Math.max(0, Math.floor(py - rad - 2)); y <= Math.min(H - 1, py + rad + 2); y++) {
      for (let x = Math.max(0, Math.floor(px - rad - 2)); x <= Math.min(W - 1, px + rad + 2); x++) {
        const d = Math.hypot(x - px, y - py);
        const a = clamp01(rad - d + (hash2(x, y, seed + 19) - 0.5) * 1.5);
        const i = y * W + x;
        if (a * 0.8 > alpha[i]) {
          alpha[i] = a * 0.8;
          ring[i] = clamp01(1 - (rad - d) / (rad * 0.6));
        }
      }
    }
  }

  const bg = paperRGB(paper);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = alpha[i];
    if (a <= 0) continue;
    const R = rgba[p], G = rgba[p + 1], B = rgba[p + 2];
    const l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const dark = (1 - 0.35 * ring[i]) * (1 - hash2(i, 0, seed + 23) * 0.04);
    out[p] = ((l + (R - l) * 0.85) * 0.9 + bg[0] * 0.1) * dark;
    out[p + 1] = ((l + (G - l) * 0.85) * 0.9 + bg[1] * 0.1) * dark;
    out[p + 2] = ((l + (B - l) * 0.85) * 0.9 + bg[2] * 0.1) * dark;
    out[p + 3] = a * 255;
  }
  return out;
}

/** Pen & ink: tonal cross-hatching + Sobel contour lines. Opaque RGBA. */
export function hatch({ rgba, W, H, seed, paper, sc }: LayerArgs) {
  const n = W * H;
  const g = gray(rgba, n);
  const L = blur(g, W, H, 1.2 * sc + 0.3);
  const E = blur(g, W, H, 2 * sc + 0.4);

  // Sobel magnitude on the smoother luminance (0..1 scale)
  const mag = new Float32Array(n);
  let sum = 0, sum2 = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const tl = E[i - W - 1], t = E[i - W], tr = E[i - W + 1];
      const l = E[i - 1], rr = E[i + 1];
      const bl = E[i + W - 1], b = E[i + W], br = E[i + W + 1];
      const gx = (tr + 2 * rr + br - tl - 2 * l - bl) / 255;
      const gy = (bl + 2 * b + br - tl - 2 * t - tr) / 255;
      const m = Math.sqrt(gx * gx + gy * gy);
      mag[i] = m;
      sum += m;
      sum2 += m * m;
    }
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const T = Math.max(0.12, mean + 1.8 * std);

  const bg = paperRGB(paper);
  const out = new Uint8ClampedArray(n * 4);
  const sp = Math.max(2.8, 9.5 * sc);
  const hw = Math.max(0.28, 0.45 * sc);
  const wob = 40 * sc + 3, tone = 30 * sc + 2;
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const lj =
        L[i] / 255 + (hash2(x, y, seed + 29) - 0.5) * 0.05 + (vnoise(x / tone, y / tone, seed + 31) - 0.5) * 0.06;
      let ink = 0;
      if (lj < 0.7) {
        const w = (vnoise(x / wob, y / wob, seed + 37) - 0.5) * 4 * sc;
        const d1 = (x + y) * 0.7071 + w;
        ink = lineInk(d1, sp, hw) * brk(d1, (x - y) * 0.7071, sp, sc, seed + 41);
        if (lj < 0.5) {
          const d2 = (x - y) * 0.7071 + w;
          ink = Math.max(ink, lineInk(d2, sp, hw) * brk(d2, (x + y) * 0.7071, sp, sc, seed + 43));
        }
        if (lj < 0.3) {
          const d3 = y + w;
          ink = Math.max(ink, lineInk(d3, sp * 0.9, hw) * brk(d3, x, sp, sc, seed + 47));
        }
        if (lj < 0.15) {
          const d4 = x + w;
          ink = Math.max(ink, lineInk(d4, sp * 0.9, hw) * brk(d4, y, sp, sc, seed + 53));
        }
        ink *= 0.85;
      }
      ink = Math.max(ink, smooth(T, T * 1.7, mag[i]));
      const tex = 1 - hash2(x, y, seed + 59) * 0.03;
      const p = i * 4;
      out[p] = (bg[0] + (INK[0] - bg[0]) * ink) * tex;
      out[p + 1] = (bg[1] + (INK[1] - bg[1]) * ink) * tex;
      out[p + 2] = (bg[2] + (INK[2] - bg[2]) * ink) * tex;
      out[p + 3] = 255;
    }
  }
  return out;
}

/** Most interesting region on an 8×8 grid (saturation + contrast), normalized 0..1. */
export function interest({ rgba, W, H }: Pick<LayerArgs, "rgba" | "W" | "H">) {
  const G = 8;
  let best = -1, bx = 0.5, by = 0.5;
  const step = Math.max(1, Math.floor(Math.min(W, H) / 200));
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      const xa = Math.floor((gx * W) / G), xb = Math.floor(((gx + 1) * W) / G);
      const ya = Math.floor((gy * H) / G), yb = Math.floor(((gy + 1) * H) / G);
      let s = 0, l = 0, l2 = 0, c = 0;
      for (let y = ya; y < yb; y += step) {
        for (let x = xa; x < xb; x += step) {
          const p = (y * W + x) * 4;
          const R = rgba[p], Gc = rgba[p + 1], B = rgba[p + 2];
          const mx = Math.max(R, Gc, B), mn = Math.min(R, Gc, B);
          s += mx ? (mx - mn) / mx : 0;
          const lum = (0.2126 * R + 0.7152 * Gc + 0.0722 * B) / 255;
          l += lum;
          l2 += lum * lum;
          c++;
        }
      }
      if (!c) continue;
      const sat = s / c, mean = l / c, std = Math.sqrt(Math.max(0, l2 / c - mean * mean));
      const cxn = (gx + 0.5) / G, cyn = (gy + 0.5) / G;
      const centre = 1 - 0.35 * Math.hypot(cxn - 0.5, cyn - 0.5);
      const score = (sat + 2 * std) * centre;
      if (score > best) {
        best = score;
        bx = cxn;
        by = cyn;
      }
    }
  }
  return { x: bx, y: by };
}

export type LayerOp = "sketch" | "sketchFull" | "watercolor" | "hatch";

export function runLayer(op: LayerOp, args: LayerArgs) {
  switch (op) {
    case "sketch":
      return sketch(args);
    case "sketchFull":
      return sketch(args, true);
    case "watercolor":
      return watercolor(args);
    case "hatch":
      return hatch(args);
  }
}
