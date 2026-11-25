// Minimal EXIF reader for JPEG (camera make/model, ISO, aperture, shutter, focal length).
// Runs entirely in the browser; only the first 256 KB of the file is read.

export type CameraInfo = {
  make?: string;
  model?: string;
  iso?: number;
  fNumber?: number;
  exposure?: number; // seconds
  focal?: number; // mm (actual)
  focal35?: number; // mm (35 mm equivalent)
};

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

export async function readExif(file: Blob): Promise<CameraInfo | null> {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    return parseJpeg(new DataView(buf));
  } catch {
    return null;
  }
}

function parseJpeg(v: DataView): CameraInfo | null {
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let p = 2;
  while (p + 4 <= v.byteLength) {
    if (v.getUint8(p) !== 0xff) return null;
    const marker = v.getUint8(p + 1);
    if (marker === 0xda || marker === 0xd9) return null; // image data starts: no EXIF
    const len = v.getUint16(p + 2);
    // APP1 "Exif\0\0"
    if (marker === 0xe1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === 0x45786966 && v.getUint16(p + 8) === 0) {
      return parseTiff(v, p + 10, Math.min(v.byteLength, p + 2 + len));
    }
    p += 2 + len;
  }
  return null;
}

function parseTiff(v: DataView, base: number, end: number): CameraInfo | null {
  const order = v.getUint16(base);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const le = order === 0x4949;
  const u16 = (o: number) => v.getUint16(o, le);
  const u32 = (o: number) => v.getUint32(o, le);
  if (u16(base + 2) !== 42) return null;

  type Entry = { type: number; count: number; at: number };
  const readIfd = (off: number) => {
    const out = new Map<number, Entry>();
    const start = base + off;
    if (start + 2 > end) return out;
    const n = u16(start);
    for (let i = 0; i < n; i++) {
      const e = start + 2 + i * 12;
      if (e + 12 > end) break;
      const type = u16(e + 2), count = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      const at = size <= 4 ? e + 8 : base + u32(e + 8);
      if (at + size <= end) out.set(u16(e), { type, count, at });
    }
    return out;
  };

  const ascii = (e?: Entry) => {
    if (!e || e.type !== 2) return undefined;
    let s = "";
    for (let i = 0; i < e.count; i++) {
      const c = v.getUint8(e.at + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim() || undefined;
  };
  const num = (e?: Entry) => {
    if (!e) return undefined;
    switch (e.type) {
      case 3: return u16(e.at);
      case 4: return u32(e.at);
      case 9: return v.getInt32(e.at, le);
      case 5: { const d = u32(e.at + 4); return d ? u32(e.at) / d : undefined; }
      case 10: { const d = v.getInt32(e.at + 4, le); return d ? v.getInt32(e.at, le) / d : undefined; }
    }
    return undefined;
  };

  const ifd0 = readIfd(u32(base + 4));
  const exifPtr = num(ifd0.get(0x8769));
  const exif = exifPtr ? readIfd(exifPtr) : new Map<number, Entry>();

  const info: CameraInfo = {
    make: ascii(ifd0.get(0x010f)),
    model: ascii(ifd0.get(0x0110)),
    exposure: num(exif.get(0x829a)),
    fNumber: num(exif.get(0x829d)),
    iso: num(exif.get(0x8827)),
    focal: num(exif.get(0x920a)),
    focal35: num(exif.get(0xa405)),
  };
  return Object.values(info).some((x) => x !== undefined && x !== 0) ? info : null;
}

const CORP = /\b(corporation|corp\.?|co\.?,?\s*ltd\.?|ltd\.?|inc\.?|imaging|optical|company|electronics)\b/gi;

/** e.g. "Samsung Galaxy A55 5G · 24mm · f/1.8 · 1/25s · ISO 640" */
export function formatExif(i: CameraInfo | null): string {
  if (!i) return "";
  const parts: string[] = [];

  const make = i.make?.replace(CORP, "").replace(/[\s,]+$/, "").trim();
  const model = i.model?.trim();
  let camera = "";
  if (make && model) camera = model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
  else camera = model || make || "";
  // brand word in all-lower/all-caps ("samsung", "NIKON") → "Samsung", "Nikon"; model kept as written
  camera = camera.replace(/^([A-Za-z]{4,})(?=\s|$)/, (w) =>
    w === w.toLowerCase() || w === w.toUpperCase() ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w,
  );
  if (camera) parts.push(camera);

  // prefer the 35 mm equivalent; a tiny real focal length (phone sensors, e.g. 5.5mm) without it would mislead
  const focal = i.focal35 || (i.focal && i.focal >= 12 ? i.focal : 0);
  if (focal) parts.push(`${Math.round(focal)}mm`);
  if (i.fNumber) parts.push(`f/${+i.fNumber.toFixed(1)}`);
  if (i.exposure) {
    parts.push(i.exposure >= 1 ? `${+i.exposure.toFixed(1)}s` : `1/${Math.round(1 / i.exposure)}s`);
  }
  if (i.iso) parts.push(`ISO ${i.iso}`);
  return parts.join(" · ");
}
