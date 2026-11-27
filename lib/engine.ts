// Main-thread side: decoding, caching, vector drawing (masks, strokes, text)
// and compositing. Heavy per-pixel work is delegated to a Web Worker.

import * as px from "./pixels";
import type { LayerArgs, LayerOp, Paper } from "./pixels";
import type { WorkerRequest, WorkerResponse } from "./pixels.worker";

export type { Paper };
export type Ratio = "3:4" | "4:5";
export type Dims = { W: number; H: number };
export type StyleId = "belum" | "sketsa" | "catair" | "kuas" | "arsir" | "polos" | "batik";

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
  { id: "polos", label: "Bingkai polos (foto utuh)", slug: "polos" },
  { id: "batik", label: "Bingkai batik (foto utuh)", slug: "batik" },
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
  /** small camera info line under the caption (e.g. "Fujifilm X-T30 · 35mm · f/2 · 1/250s · ISO 400"); empty = none */
  meta: string;
  metaFontFamily: string;
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

  /** `font` is a CSS font shorthand, e.g. "600 80px Caveat". */
  private fonts(font: string) {
    let p = this.fontsLoaded.get(font);
    if (!p) {
      p = document.fonts.load(font).then(() => undefined, () => undefined);
      this.fontsLoaded.set(font, p);
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

    if (o.style === "polos" || o.style === "batik") {
      // whole photo, never cropped: fit (contain) the original inside the frame
      const m = await this.master(photo);
      const batik = o.style === "batik";
      ctx.drawImage(
        this.vector(`${batik ? "batik" : "paper"}|${W}x${H}|${F}|${o.paper}`, () => (batik ? batikBackdrop(g) : paperBackdrop(g))),
        0,
        0,
      );
      placeWhole(ctx, m, g, batik ? 16 * sc : 0);
      return this.finishText(c, ctx, g, o);
    }

    const src = await this.source(photo, o.dims);

    if (o.style === "belum") {
      const sk = await this.layer("sketch", photo, o.dims, lo);
      await tick();
      ctx.drawImage(sk, 0, 0);
      ctx.drawImage(masked(src.canvas, this.vector(`${photo.key}|m-belum|${W}x${H}|${F}|${bottom}`, () => belumMask(g))), 0, 0);
    } else if (o.style === "sketsa") {
      ctx.drawImage(await this.layer("sketchFull", photo, o.dims, lo), 0, 0);
      // without a caption, the camera info sits low in the border; keep the bottom line clear of it
      pencilFrame(ctx, g, !!o.meta && !o.showText);
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

    return this.finishText(c, ctx, g, o);
  }

  private async finishText(c: HTMLCanvasElement, ctx: CanvasRenderingContext2D, g: Geo, o: RenderOptions) {
    let captionWidth = 0;
    if (o.showText) {
      await this.fonts(`600 80px ${o.fontFamily}`);
      captionWidth = caption(ctx, g, o.caption, o.fontFamily);
    }
    if (o.meta) {
      await this.fonts(`500 30px ${o.metaFontFamily}`);
      metaBlock(ctx, g, o.meta, o.metaFontFamily, o.showText, captionWidth);
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

/* ── whole-photo styles (polos / batik) ── */

const SOGA: RGB = [112, 74, 42]; // batik brown

/** Plain paper with faint, seed-free grain (same for every photo, so it caches once per size). */
function paperBackdrop({ W, H, paper }: Geo) {
  const { c, ctx } = mk(W, H);
  const bg = px.paperRGB(paper);
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let y = 0, p = 0; y < H; y++) {
    for (let x = 0; x < W; x++, p += 4) {
      const n = (px.hash2(x, y, 977) - 0.5) * 6;
      d[p] = bg[0] + n;
      d[p + 1] = bg[1] + n;
      d[p + 2] = bg[2] + n;
      d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Kawung motif over the whole canvas, then a paper mat inside a band of batik. */
function batikBackdrop(g: Geo) {
  const { W, H, F, sc, paper } = g;
  const c = paperBackdrop(g);
  const ctx = c.getContext("2d")!;
  const bg = px.paperRGB(paper);
  // cloth tone: paper with a little soga mixed in
  ctx.fillStyle = rgb([0, 1, 2].map((i) => bg[i] * 0.88 + SOGA[i] * 0.12) as RGB);
  ctx.globalAlpha = 0.9;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;
  kawung(ctx, W, H, 66 * sc + 6, rgb(SOGA), sc);

  // paper mat
  const band = Math.max(F * 0.72, 18 * sc);
  ctx.save();
  ctx.shadowColor = "rgba(36,35,33,0.28)";
  ctx.shadowBlur = 14 * sc;
  ctx.shadowOffsetY = 3 * sc;
  ctx.drawImage(paperBackdrop(g), band, band, W - 2 * band, H - 2 * band, band, band, W - 2 * band, H - 2 * band);
  ctx.restore();
  // fine double rule along the mat edge, like a batik "pinggiran"
  ctx.strokeStyle = rgb(SOGA);
  ctx.lineWidth = Math.max(0.6, 1.4 * sc);
  for (const inset of [7 * sc, 12 * sc]) {
    ctx.globalAlpha = inset < 10 * sc ? 0.85 : 0.5;
    ctx.strokeRect(band + inset, band + inset, W - 2 * (band + inset), H - 2 * (band + inset));
  }
  ctx.globalAlpha = 1;
  return c;
}

/** Kawung: four-petal flowers on a square lattice, petals meeting tip-to-tip on the diagonals. */
function kawung(ctx: CanvasRenderingContext2D, W: number, H: number, s: number, col: string, sc: number) {
  const d = s * 0.3536, rx = s * 0.33, ry = s * 0.165;
  ctx.save();
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  const lw = Math.max(0.5, 1.6 * sc);
  for (let y = 0; y <= H + s; y += s) {
    for (let x = 0; x <= W + s; x += s) {
      for (let k = 0; k < 4; k++) {
        const a = Math.PI / 4 + (k * Math.PI) / 2;
        const cx = x + Math.cos(a) * d, cy = y + Math.sin(a) * d;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, a, 0, Math.PI * 2);
        ctx.globalAlpha = 0.2;
        ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = lw;
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx * 0.5, ry * 0.42, a, 0, Math.PI * 2);
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = lw * 0.7;
        ctx.stroke();
        // cecek: dots along the petal axis
        ctx.globalAlpha = 0.85;
        for (const t of [-0.72, 0, 0.72]) {
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * rx * t, cy + Math.sin(a) * rx * t, Math.max(0.5, (t ? 1.3 : 1.9) * sc), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // flower centre and the small diamond where four petals meet
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.arc(x, y, s * 0.06, 0, Math.PI * 2);
      ctx.stroke();
      const mx = x + s / 2, my = y + s / 2, q = s * 0.05;
      ctx.beginPath();
      ctx.moveTo(mx, my - q);
      ctx.lineTo(mx + q, my);
      ctx.lineTo(mx, my + q);
      ctx.lineTo(mx - q, my);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

/** Draw the full photo (no cropping) centred in the frame area, like a mounted print. */
function placeWhole(ctx: CanvasRenderingContext2D, img: Drawable, { W, H, F, bottom, sc }: Geo, inset: number) {
  const x0 = F + inset, y0 = F + inset, x1 = W - F - inset, y1 = H - bottom - inset;
  const s = Math.min((x1 - x0) / img.width, (y1 - y0) / img.height);
  const w = img.width * s, h = img.height * s;
  const x = x0 + (x1 - x0 - w) / 2, y = y0 + (y1 - y0 - h) / 2;
  ctx.save();
  ctx.shadowColor = "rgba(36,35,33,0.22)";
  ctx.shadowBlur = 16 * sc;
  ctx.shadowOffsetY = 5 * sc;
  ctx.fillStyle = "#fff";
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, x, y, w, h);
}

function masked(color: HTMLCanvasElement, mask: HTMLCanvasElement) {
  const { c, ctx } = mk(color.width, color.height);
  ctx.drawImage(color, 0, 0);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0);
  return c;
}

/** Handwritten caption, bottom-left. Returns its width so the camera info can avoid it. */
function caption(ctx: CanvasRenderingContext2D, { H, F, sc, paper }: Geo, text: string, family: string): number {
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
  const w = text ? ctx.measureText(text).width : 0;
  ctx.restore();
  return w;
}

/** Camera body vs. exposure settings: "Samsung A55 · f/1.8 · 1/25s · ISO 640" → ["Samsung A55", "f/1.8 · 1/25s · ISO 640"]. */
function splitMeta(text: string): string[] {
  const parts = text.split(/\s+·\s+/).filter(Boolean);
  const isSetting = (p: string) => /^(f\/|ISO\b|1\/|\d)/i.test(p);
  if (parts.length < 2 || isSetting(parts[0])) return [parts.join(" · ")];
  return [parts[0], parts.slice(1).join(" · ")];
}

/**
 * Camera info, bottom-right, right-aligned: camera on top, settings below.
 * With a caption it shares the caption's baseline; without one it sits low in the border.
 * Shrinks to fit beside the caption so the two never overlap.
 */
function metaBlock(
  ctx: CanvasRenderingContext2D,
  { W, H, F, sc, paper }: Geo,
  text: string,
  family: string,
  withCaption: boolean,
  captionWidth: number,
) {
  const lines = splitMeta(text);
  let size = 30 * sc;
  const font = (s: number) => `500 ${s}px ${family}`;
  ctx.save();
  ctx.font = font(size);
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const gap = 36 * sc;
  const room = W - 2 * F - (captionWidth ? captionWidth + gap : 0);
  if (widest > room) size = Math.max(16 * sc, (size * room) / widest);
  ctx.font = font(size);

  const lead = size * 1.25;
  const x = W - F;
  const baseY = withCaption ? H - F + 6 * sc : H - Math.max(F * 0.34, size * 0.9);
  ctx.textAlign = "right";
  ctx.lineJoin = "round";
  ctx.strokeStyle = rgb(px.paperRGB(paper));
  // soft paper patch behind the block so sketch lines don't run through the small letters
  const paperCss = rgb(px.paperRGB(paper));
  const blockW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const pad = 10 * sc;
  const top = baseY - (lines.length - 1) * lead - size * 0.85;
  ctx.save();
  ctx.fillStyle = paperCss;
  ctx.shadowColor = paperCss;
  ctx.shadowBlur = 18 * sc;
  ctx.globalAlpha = 0.88;
  ctx.fillRect(x - blockW - pad, top - pad, blockW + 2 * pad, baseY + size * 0.3 + pad - (top - pad));
  ctx.restore();

  ctx.fillStyle = rgb(px.INK);
  ctx.lineWidth = 6 * sc;
  lines.forEach((l, k) => {
    const y = baseY - (lines.length - 1 - k) * lead;
    ctx.globalAlpha = 1;
    ctx.strokeText(l, x, y);
    ctx.globalAlpha = k === 0 && lines.length > 1 ? 0.92 : 0.75; // camera name a touch stronger
    ctx.fillText(l, x, y);
  });
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
function pencilFrame(ctx: CanvasRenderingContext2D, { W, H, F, sc, seed }: Geo, roomForMeta = false) {
  const r = px.rng(seed * 17 + 9);
  const i = F / 2;
  // with a camera-info line, the bottom line drops below it instead of striking through
  const ib = roomForMeta ? Math.max(F * 0.16, 10 * sc) : i;
  const a: [number, number] = [i, i], b: [number, number] = [W - i, i];
  const cc: [number, number] = [W - i, H - ib], d: [number, number] = [i, H - ib];
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

/** "liburan.HEIC" → "liburan"; strips characters that are invalid in file names. */
export function baseName(fileName: string) {
  const stem = fileName.replace(/\.[^./\\]+$/, "");
  const clean = stem.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim();
  return clean || "foto";
}

/** Downloads as "{original name}_{style}.jpeg", e.g. aku.jpeg → aku_cat-air.jpeg */
export function downloadCanvas(c: HTMLCanvasElement, style: StyleId, name: string) {
  const a = document.createElement("a");
  a.download = `${name}_${styleOf(style).slug}.jpeg`;
  a.href = c.toDataURL("image/jpeg", 0.95);
  a.click();
}
