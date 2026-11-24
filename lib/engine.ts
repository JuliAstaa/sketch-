// Main-thread side: decoding, caching, vector drawing (masks, strokes, text)
// and compositing. Heavy per-pixel work is delegated to a Web Worker.

import * as px from "./pixels";
import type { LayerArgs, LayerOp, Paper } from "./pixels";
import type { WorkerRequest, WorkerResponse } from "./pixels.worker";

export type { Paper };
export type Ratio = "3:4" | "4:5";
export type Dims = { W: number; H: number };
export type StyleId = "belum" | "sketsa" | "catair" | "kuas" | "arsir";

export const DIMS: Record<Ratio, Dims> = {
  "3:4": { W: 1080, H: 1440 },
  "4:5": { W: 1080, H: 1350 },
};
export const THUMB: Dims = { W: 180, H: 240 };

export const STYLES: { id: StyleId; label: string; slug: string }[] = [
  { id: "belum", label: "Belum selesai diwarnai", slug: "belum-diwarnai" },
  { id: "sketsa", label: "Sketsa penuh", slug: "sketsa-penuh" },
  { id: "catair", label: "Cat air", slug: "cat-air" },
  { id: "kuas", label: "Sapuan kuas", slug: "sapuan-kuas" },
  { id: "arsir", label: "Arsir tinta", slug: "arsir-tinta" },
];
export const isStyle = (v: unknown): v is StyleId => STYLES.some((s) => s.id === v);
export const styleOf = (id: StyleId) => STYLES.find((s) => s.id === id)!;

/** A photo to render. `key` must be unique per item (cache key); `seed` should be stable per file. */
export type Photo = { key: string; seed: number; src: Blob | string };

export type RenderOptions = {
  style: StyleId;
  dims: Dims;
  frame: number;
  paper: Paper;
  showText: boolean;
  caption: string;
  fontFamily: string;
};

/** Stable seed from file identity, so the same photo renders identically every time. */
export function seedFromFile(f: File) {
  const s = `${f.name}|${f.size}|${f.lastModified}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

type RGB = px.RGB;
const rgb = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

function mk(W: number, H: number) {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  return { c, ctx };
}

type Drawable = HTMLCanvasElement | ImageBitmap;

function cover(ctx: CanvasRenderingContext2D, img: Drawable, W: number, H: number) {
  const s = Math.max(W / img.width, H / img.height);
  const sw = W / s, sh = H / s;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, W, H);
}

/* ───────────────────────── worker client ───────────────────────── */

class PixelClient {
  private worker: Worker | null = null;
  private seq = 1;
  private pending = new Map<number, { resolve: (r: WorkerResponse) => void; fallback: () => WorkerResponse }>();

  constructor() {
    try {
      this.worker = new Worker(new URL("./pixels.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const p = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        p?.resolve(e.data);
      };
      this.worker.onerror = () => {
        // worker failed (e.g. could not boot): finish everything on the main thread
        this.worker?.terminate();
        this.worker = null;
        const waiting = [...this.pending.values()];
        this.pending.clear();
        for (const p of waiting) p.resolve(p.fallback());
      };
    } catch {
      this.worker = null;
    }
  }

  /** `make(buffer)` builds the request; the main-thread copy stays intact for the fallback. */
  private post(data: Uint8ClampedArray, make: (rgba: ArrayBuffer) => WorkerRequest): Promise<WorkerResponse> {
    const fallback = () => this.inline(make(data.slice().buffer as ArrayBuffer));
    if (!this.worker) return new Promise((resolve) => setTimeout(() => resolve(fallback()), 0));
    const req = make(data.slice().buffer as ArrayBuffer);
    return new Promise((resolve) => {
      this.pending.set(req.id, { resolve, fallback });
      this.worker!.postMessage(req, [req.args.rgba]);
    });
  }

  private inline(req: WorkerRequest): WorkerResponse {
    try {
      const rgba = new Uint8ClampedArray(req.args.rgba);
      if (req.op === "interest") return { id: req.id, ok: true, point: px.interest({ ...req.args, rgba }) };
      const out = px.runLayer(req.op, { ...req.args, rgba } as LayerArgs);
      return { id: req.id, ok: true, data: out.buffer as ArrayBuffer };
    } catch (err) {
      return { id: req.id, ok: false, error: String(err) };
    }
  }

  async layer(op: LayerOp, args: LayerArgs) {
    const id = this.seq++;
    const res = await this.post(args.rgba, (rgba) => ({ id, op, args: { ...args, rgba } }));
    if (!res.ok) throw new Error(res.error);
    return new Uint8ClampedArray(res.data!);
  }

  async interest(rgba: Uint8ClampedArray, W: number, H: number) {
    const id = this.seq++;
    const res = await this.post(rgba, (buf) => ({ id, op: "interest", args: { rgba: buf, W, H } }));
    if (!res.ok) throw new Error(res.error);
    return res.point!;
  }
}

/* ───────────────────────── engine ───────────────────────── */

const MAX_W = 1080, MAX_H = 1440;
// main-thread yield so long chains of work don't block input
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export class Engine {
  private client = new PixelClient();
  private cache = new Map<string, Promise<unknown>>();
  private fontsLoaded = new Map<string, Promise<void>>();

  private memo<T>(key: string, make: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = make();
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return p;
  }

  forget(photoKey: string) {
    for (const k of this.cache.keys()) if (k.startsWith(photoKey + "|")) this.cache.delete(k);
  }

  /** Decoded photo, downscaled once to just enough to cover the largest output. */
  private master(photo: Photo) {
    return this.memo(`${photo.key}|master`, async () => {
      const blob = typeof photo.src === "string" ? await (await fetch(photo.src)).blob() : photo.src;
      let img: Drawable;
      try {
        img = await createImageBitmap(blob);
      } catch {
        const url = URL.createObjectURL(blob);
        try {
          const el = new Image();
          el.src = url;
          await el.decode();
          const { c, ctx } = mk(el.naturalWidth, el.naturalHeight);
          ctx.drawImage(el, 0, 0);
          img = c;
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      const s = Math.min(1, Math.max(MAX_W / img.width, MAX_H / img.height));
      if (s >= 1 && img instanceof HTMLCanvasElement) return img;
      const { c, ctx } = mk(Math.round(img.width * s), Math.round(img.height * s));
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, c.width, c.height);
      if ("close" in img) img.close();
      return c;
    });
  }

  private source(photo: Photo, { W, H }: Dims) {
    return this.memo(`${photo.key}|src|${W}x${H}`, async () => {
      const m = await this.master(photo);
      const { c, ctx } = mk(W, H);
      cover(ctx, m, W, H);
      return { canvas: c, data: ctx.getImageData(0, 0, W, H).data };
    });
  }

  private layer(op: LayerOp, photo: Photo, dims: Dims, o: { paper: Paper; F: number; bottom: number }) {
    const geo = op === "watercolor" ? `|${o.F}|${o.bottom}` : "";
    return this.memo(`${photo.key}|${op}|${dims.W}x${dims.H}|${o.paper}${geo}`, async () => {
      const src = await this.source(photo, dims);
      const out = await this.client.layer(op, {
        rgba: src.data, W: dims.W, H: dims.H, seed: photo.seed, paper: o.paper,
        sc: dims.W / 1080, F: o.F, bottom: o.bottom,
      });
      const { c, ctx } = mk(dims.W, dims.H);
      ctx.putImageData(new ImageData(out as Uint8ClampedArray<ArrayBuffer>, dims.W, dims.H), 0, 0);
      return c;
    });
  }

  private interest(photo: Photo, dims: Dims) {
    return this.memo(`${photo.key}|interest|${dims.W}x${dims.H}`, async () => {
      const src = await this.source(photo, dims);
      return this.client.interest(src.data, dims.W, dims.H);
    });
  }

  private fonts(family: string) {
    let p = this.fontsLoaded.get(family);
    if (!p) {
      p = document.fonts.load(`600 80px ${family}`).then(() => undefined, () => undefined);
      this.fontsLoaded.set(family, p);
    }
    return p;
  }

  /** Render a photo in a style; resolves with a finished canvas (caller copies it to screen). */
  async compose(photo: Photo, o: RenderOptions): Promise<HTMLCanvasElement> {
    const { W, H } = o.dims;
    const sc = W / 1080;
    const F = o.frame * sc;
    const bottom = o.showText ? F + 120 * sc : F;
    const g = { W, H, F, bottom, sc, seed: photo.seed, paper: o.paper };
    const lo = { paper: o.paper, F, bottom };

    const { c, ctx } = mk(W, H);
    const src = await this.source(photo, o.dims);

    if (o.style === "belum") {
      const sk = await this.layer("sketch", photo, o.dims, lo);
      await tick();
      ctx.drawImage(sk, 0, 0);
      ctx.drawImage(masked(src.canvas, this.vector(`${photo.key}|m-belum|${W}x${H}|${F}|${bottom}`, () => belumMask(g))), 0, 0);
    } else if (o.style === "sketsa") {
      ctx.drawImage(await this.layer("sketchFull", photo, o.dims, lo), 0, 0);
      pencilFrame(ctx, g);
    } else if (o.style === "catair") {
      const [sk, wc] = await Promise.all([this.layer("sketch", photo, o.dims, lo), this.layer("watercolor", photo, o.dims, lo)]);
      ctx.drawImage(sk, 0, 0);
      ctx.drawImage(wc, 0, 0);
    } else if (o.style === "kuas") {
      const [sk, pt] = await Promise.all([this.layer("sketch", photo, o.dims, lo), this.interest(photo, o.dims)]);
      await tick();
      ctx.drawImage(sk, 0, 0);
      ctx.drawImage(masked(src.canvas, this.vector(`${photo.key}|m-kuas|${W}x${H}|${F}|${bottom}`, () => brushMask(g, pt))), 0, 0);
    } else {
      ctx.drawImage(await this.layer("hatch", photo, o.dims, lo), 0, 0);
      ctx.drawImage(masked(src.canvas, this.vector(`${photo.key}|m-arsir|${W}x${H}|${F}|${bottom}`, () => arsirMask(g))), 0, 0);
      constructionLines(ctx, g);
    }

    if (o.showText) {
      await this.fonts(o.fontFamily);
      caption(ctx, g, o.caption, o.fontFamily);
    }
    return c;
  }

  // synchronous vector masks, cached alongside the async layers
  private vectors = new Map<string, HTMLCanvasElement>();
  private vector(key: string, make: () => HTMLCanvasElement) {
    let v = this.vectors.get(key);
    if (!v) {
      v = make();
      this.vectors.set(key, v);
      if (this.vectors.size > 60) this.vectors.delete(this.vectors.keys().next().value!);
    }
    return v;
  }
}

let engine: Engine | null = null;
export const getEngine = () => (engine ??= new Engine());

/* ───────────────────────── compositing helpers ───────────────────────── */

type Geo = { W: number; H: number; F: number; bottom: number; sc: number; seed: number; paper: Paper };

function masked(color: HTMLCanvasElement, mask: HTMLCanvasElement) {
  const { c, ctx } = mk(color.width, color.height);
  ctx.drawImage(color, 0, 0);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0);
  return c;
}

function caption(ctx: CanvasRenderingContext2D, { H, F, sc, paper }: Geo, text: string, family: string) {
  const y = H - F + 6 * sc;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.strokeStyle = rgb(px.paperRGB(paper));
  ctx.fillStyle = rgb(px.INK);
  ctx.font = `600 ${92 * sc}px ${family}`;
  ctx.textAlign = "left";
  ctx.lineWidth = 18 * sc;
  ctx.strokeText(text, F, y);
  ctx.fillText(text, F, y);
  ctx.restore();
}

/** Gaya 0 — rough brushed rectangle (original). */
function belumMask({ W, H, F, bottom, sc, seed }: Geo) {
  const { c, ctx: x } = mk(W, H);
  const r = px.rng(seed * 31 + 5);
  const x0 = F, y0 = F, x1 = W - F, y1 = H - bottom;
  const step = Math.max(1.5, 9 * sc);
  x.fillStyle = "#000";
  x.strokeStyle = "#000";
  x.lineCap = "round";
  x.fillRect(x0 + 60 * sc, y0 + 60 * sc, x1 - x0 - 120 * sc, y1 - y0 - 120 * sc);
  for (let y = y0 + 8 * sc; y < y1 - 8 * sc; y += step) {
    x.lineWidth = (14 + r() * 16) * sc;
    x.globalAlpha = 0.5 + r() * 0.5;
    const l = x0 + (-20 + r() * 60) * sc, rr = x1 + (20 - r() * 60) * sc;
    x.beginPath();
    x.moveTo(l, y);
    x.quadraticCurveTo((l + rr) / 2, y + (r() - 0.5) * 14 * sc, rr, y + (r() - 0.5) * 10 * sc);
    x.stroke();
  }
  for (let xx = x0 + 8 * sc; xx < x1 - 8 * sc; xx += step) {
    x.lineWidth = (14 + r() * 16) * sc;
    x.globalAlpha = 0.5 + r() * 0.5;
    x.beginPath();
    x.moveTo(xx, y0 + (-20 + r() * 60) * sc);
    x.lineTo(xx + (r() - 0.5) * 10 * sc, y0 + 140 * sc);
    x.stroke();
    x.globalAlpha = 0.5 + r() * 0.5;
    x.beginPath();
    x.moveTo(xx, y1 - 140 * sc);
    x.lineTo(xx + (r() - 0.5) * 10 * sc, y1 + (20 - r() * 60) * sc);
    x.stroke();
  }
  for (let k = 0; k < 900; k++) {
    const side = Math.floor(r() * 4), off = (r() - 0.3) * 70 * sc;
    let pxx: number, py: number;
    if (side === 0) { pxx = x0 + r() * (x1 - x0); py = y0 - off; }
    else if (side === 1) { pxx = x0 + r() * (x1 - x0); py = y1 + off; }
    else if (side === 2) { pxx = x0 - off; py = y0 + r() * (y1 - y0); }
    else { pxx = x1 + off; py = y0 + r() * (y1 - y0); }
    x.globalAlpha = r() * 0.6;
    x.beginPath();
    x.arc(pxx, py, (1 + r() * 4) * sc, 0, Math.PI * 2);
    x.fill();
  }
  return c;
}

/** Wobbly hand-drawn line from a to b. */
function wobblyLine(ctx: CanvasRenderingContext2D, r: () => number, ax: number, ay: number, bx: number, by: number, sc: number, amp = 1.4) {
  const len = Math.hypot(bx - ax, by - ay);
  const nx = -(by - ay) / len, ny = (bx - ax) / len;
  const steps = Math.max(2, Math.round(len / (26 * sc + 4)));
  let drift = 0;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    drift += (r() - 0.5) * amp * sc;
    drift *= 0.85;
    const j = drift + (r() - 0.5) * 0.6 * sc;
    const x = ax + (bx - ax) * t + nx * j, y = ay + (by - ay) * t + ny * j;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/** Gaya 1 — two layers of shaky pencil lines at inset frame/2, overshooting corners. */
function pencilFrame(ctx: CanvasRenderingContext2D, { W, H, F, sc, seed }: Geo) {
  const r = px.rng(seed * 17 + 9);
  const i = F / 2;
  const a: [number, number] = [i, i], b: [number, number] = [W - i, i];
  const cc: [number, number] = [W - i, H - i], d: [number, number] = [i, H - i];
  const sides: [[number, number], [number, number]][] = [[a, b], [b, cc], [cc, d], [d, a]];
  ctx.save();
  ctx.strokeStyle = rgb(px.INK);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let layer = 0; layer < 2; layer++) {
    ctx.globalAlpha = layer === 0 ? 0.75 : 0.45;
    ctx.lineWidth = Math.max(0.6, (1.3 + r() * 0.6) * sc);
    const shift = layer === 0 ? 0 : (r() - 0.5) * 5 * sc;
    for (const [p, q] of sides) {
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
      const o1 = (8 + r() * 16) * sc, o2 = (8 + r() * 16) * sc;
      wobblyLine(ctx, r, p[0] - ux * o1 + shift, p[1] - uy * o1 + shift, q[0] + ux * o2 + shift, q[1] + uy * o2 + shift, sc);
    }
  }
  ctx.restore();
}

/** Gaya 3 — 1–2 wide diagonal dry-brush strokes aimed through the most interesting area. */
function brushMask({ W, H, F, bottom, sc, seed }: Geo, pt: { x: number; y: number }) {
  const { c, ctx } = mk(W, H);
  const r = px.rng(seed * 13 + 11);
  const x0 = F, y0 = F, x1 = W - F, y1 = H - bottom;
  const cx = Math.min(x1 - (x1 - x0) * 0.25, Math.max(x0 + (x1 - x0) * 0.25, pt.x * W));
  const cy = Math.min(y1 - (y1 - y0) * 0.25, Math.max(y0 + (y1 - y0) * 0.25, pt.y * H));
  const theta = ((20 + r() * 15) * Math.PI) / 180;
  const w = (0.35 + r() * 0.1) * W;

  const strokes: { cx: number; cy: number; w: number; th: number }[] = [{ cx, cy, w, th: theta }];
  if (r() < 0.6) {
    const w2 = w * (0.45 + r() * 0.2);
    const sign = r() < 0.5 ? -1 : 1;
    const off = (w / 2 + w2 / 2 + 6 * sc) * sign;
    strokes.push({ cx: cx + Math.sin(theta) * off, cy: cy + Math.cos(theta) * off, w: w2, th: theta + (r() - 0.5) * 0.08 });
  }

  // parameter range [ta, tb] where p + t·d lies inside the frame rectangle
  const clipT = (p: [number, number], d: [number, number]): [number, number] | null => {
    let ta = -Infinity, tb = Infinity;
    for (const [pv, dv, lo, hi] of [[p[0], d[0], x0, x1], [p[1], d[1], y0, y1]] as const) {
      if (Math.abs(dv) < 1e-9) {
        if (pv < lo || pv > hi) return null;
      } else {
        const t1 = (lo - pv) / dv, t2 = (hi - pv) / dv;
        ta = Math.max(ta, Math.min(t1, t2));
        tb = Math.min(tb, Math.max(t1, t2));
      }
    }
    return tb > ta ? [ta, tb] : null;
  };

  ctx.strokeStyle = "#000";
  ctx.lineCap = "round";
  for (const s of strokes) {
    const d: [number, number] = [Math.cos(s.th), -Math.sin(s.th)]; // bottom-left → top-right
    const n: [number, number] = [Math.sin(s.th), Math.cos(s.th)];
    const gap = Math.max(1, 2.4 * sc);
    const half = s.w / 2;
    for (let o = -half; o <= half; o += gap * (0.7 + r() * 0.6)) {
      const p: [number, number] = [s.cx + n[0] * o, s.cy + n[1] * o];
      const range = clipT(p, d);
      if (!range) continue;
      const L = range[1] - range[0];
      const edge = Math.pow(Math.abs(o) / half, 3);
      const start = range[0] + L * (r() * 0.05 + edge * 0.18);
      const end = range[1] - L * (r() * 0.15 + edge * 0.25);
      if (end <= start) continue;
      const base = (0.7 + r() * 0.3) * (1 - edge * 0.45);
      ctx.lineWidth = (3 + r() * 5) * sc + 0.4;
      const phase = r() * Math.PI * 2;
      const seg = 30 * sc + 3;
      const span = end - start;
      for (let t = start; t < end; t += seg) {
        const f = (t - start) / span;
        if (f > 0.55 && r() < (f - 0.55) * 1.6) continue; // tail breaks up
        if (r() < 0.03) continue; // dry gaps
        ctx.globalAlpha = base * (1 - 0.7 * Math.pow(f, 1.6));
        const t2 = Math.min(end, t + seg * (0.8 + r() * 0.5));
        const f2 = (t2 - start) / span;
        const w1 = Math.sin(f * Math.PI * 1.3 + phase) * 3 * sc;
        const w2 = Math.sin(f2 * Math.PI * 1.3 + phase) * 3 * sc;
        ctx.beginPath();
        ctx.moveTo(p[0] + d[0] * t + n[0] * w1, p[1] + d[1] * t + n[1] * w1);
        ctx.lineTo(p[0] + d[0] * t2 + n[0] * w2, p[1] + d[1] * t2 + n[1] * w2);
        ctx.stroke();
      }
    }
  }
  return c;
}

/** Gaya 4 — straight-edged colour rectangle whose colour slips slightly outside the line. */
function arsirMask({ W, H, F, bottom, sc, seed }: Geo) {
  const { c, ctx } = mk(W, H);
  const r = px.rng(seed * 19 + 7);
  const x0 = F, y0 = F, x1 = W - F, y1 = H - bottom;
  ctx.fillStyle = "#000";
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  const bleeds = 14 + Math.floor(r() * 9);
  for (let k = 0; k < bleeds; k++) {
    const side = Math.floor(r() * 4);
    const len = (8 + r() * 32) * sc;
    const off = r() * 6 * sc;
    let ex: number, ey: number, rx: number, ry: number;
    if (side === 0) { ex = x0 + r() * (x1 - x0); ey = y0; rx = len; ry = off; }
    else if (side === 1) { ex = x0 + r() * (x1 - x0); ey = y1; rx = len; ry = off; }
    else if (side === 2) { ex = x0; ey = y0 + r() * (y1 - y0); rx = off; ry = len; }
    else { ex = x1; ey = y0 + r() * (y1 - y0); rx = off; ry = len; }
    if (rx < 0.3 || ry < 0.3) continue;
    ctx.beginPath();
    ctx.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

/** Ruler edges, construction lines past each corner, and small corner crosses. */
function constructionLines(ctx: CanvasRenderingContext2D, { W, H, F, bottom, sc, seed }: Geo) {
  const r = px.rng(seed * 23 + 1);
  const x0 = F, y0 = F, x1 = W - F, y1 = H - bottom;
  const ink = rgb(px.INK);
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";

  // ruler-straight ink edge
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = Math.max(0.6, 1.6 * sc);
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);

  // thin pencil construction lines overshooting each corner by ~40px
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = Math.max(0.4, 0.9 * sc);
  const ext = () => (40 + (r() - 0.5) * 16) * sc;
  const jit = () => (r() - 0.5) * 1.6 * sc;
  const line = (ax: number, ay: number, bx: number, by: number) => {
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  };
  line(x0 - ext(), y0 + jit(), x1 + ext(), y0 + jit());
  line(x0 - ext(), y1 + jit(), x1 + ext(), y1 + jit());
  line(x0 + jit(), y0 - ext(), x0 + jit(), y1 + ext());
  line(x1 + jit(), y0 - ext(), x1 + jit(), y1 + ext());

  // corner crosses, nudged outward
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = Math.max(0.5, 1.2 * sc);
  const s = 7 * sc, o = 16 * sc;
  for (const [cx, cy, dx, dy] of [[x0, y0, -1, -1], [x1, y0, 1, -1], [x1, y1, 1, 1], [x0, y1, -1, 1]]) {
    const px0 = cx + dx * o, py0 = cy + dy * o;
    line(px0 - s, py0 - s, px0 + s, py0 + s);
    line(px0 - s, py0 + s, px0 + s, py0 - s);
  }
  ctx.restore();
}

export function downloadCanvas(c: HTMLCanvasElement, style: StyleId, index: number) {
  const a = document.createElement("a");
  a.download = `bingkai-${styleOf(style).slug}-${String(index + 1).padStart(2, "0")}.jpg`;
  a.href = c.toDataURL("image/jpeg", 0.95);
  a.click();
}
