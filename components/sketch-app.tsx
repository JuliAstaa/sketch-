"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { caveat } from "@/app/fonts";
import {
  DIMS,
  STYLES,
  THUMB,
  baseName,
  downloadCanvas,
  getEngine,
  isStyle,
  seedFromFile,
  styleOf,
  type Paper,
  type Photo,
  type Ratio,
  type StyleId,
} from "@/lib/engine";

const FRAME = 90; // px (at 1080 wide) of sketch border around the coloured area
const PAPER: Paper = "putih";
const RATIOS: Ratio[] = ["3:4", "4:5"];
const FONT = caveat.style.fontFamily;
const STORE_KEY = "bingkai-sketsa:gaya";
const DEMO: Photo = { key: "demo", seed: 20251124, src: "/demo.jpg" };

const SHORT: Record<StyleId, string> = {
  belum: "Belum diwarnai",
  sketsa: "Sketsa",
  catair: "Cat air",
  kuas: "Kuas",
  arsir: "Arsir",
};

type Item = { id: number; name: string; photo: Photo; caption: string; style: StyleId | null };

const btn = "border border-ink cursor-pointer transition-colors";
const btnSolid = `${btn} bg-ink text-paper hover:bg-ink-soft`;
const btnGhost = `${btn} bg-transparent text-ink hover:bg-ink/5`;
const label = "text-[11px] uppercase tracking-[1px] text-muted";
const shadow = "shadow-[0_1px_2px_rgba(28,27,25,0.12),0_12px_30px_-12px_rgba(28,27,25,0.25)]";

function readStoredStyle(): StyleId {
  if (typeof window === "undefined") return "belum";
  try {
    const v = window.localStorage.getItem(STORE_KEY);
    return isStyle(v) ? v : "belum";
  } catch {
    return "belum";
  }
}

/**
 * Renders `photo` in a style into the returned canvas ref (off the critical path:
 * pixel work runs in a worker). `busy` is true while a style/size change is in flight;
 * caption edits redraw without flagging busy.
 */
function useRendered(
  photo: Photo | null,
  style: StyleId,
  W: number,
  H: number,
  showText: boolean,
  caption: string,
  delay = 0,
) {
  const ref = useRef<HTMLCanvasElement>(null);
  const heavy = photo ? `${photo.key}|${style}|${W}x${H}|${showText}` : "";
  const [done, setDone] = useState("");

  useEffect(() => {
    if (!photo) return;
    let alive = true;
    const timer = setTimeout(() => {
      getEngine()
        .compose(photo, { style, dims: { W, H }, frame: FRAME, paper: PAPER, showText, caption, fontFamily: FONT })
        .then((out) => {
          const c = ref.current;
          if (!alive || !c) return;
          c.width = out.width;
          c.height = out.height;
          c.getContext("2d")!.drawImage(out, 0, 0);
          setDone(heavy);
        })
        .catch((err) => console.error("[bingkai] render gagal", err));
    }, delay);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [photo, style, W, H, showText, caption, delay, heavy]);

  return { ref, busy: done !== heavy };
}

export default function SketchApp() {
  const [items, setItems] = useState<Item[]>([]);
  const [ratio, setRatio] = useState<Ratio>("3:4");
  const [showText, setShowText] = useState(true);
  const [style, setStyle] = useState<StyleId>(readStoredStyle);

  const fileRef = useRef<HTMLInputElement>(null);
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const nextId = useRef(1);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORE_KEY, style);
    } catch {
      /* private mode etc. — not essential */
    }
  }, [style]);

  const addFiles = useCallback((files: FileList | null) => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    const added = list.map((file) => {
      const id = nextId.current++;
      return {
        id,
        name: baseName(file.name),
        photo: { key: `p${id}`, seed: seedFromFile(file), src: file },
        caption: "",
        style: null,
      };
    });
    setItems((s) => [...s, ...added]);
  }, []);

  const openPicker = () => fileRef.current?.click();

  const update = (id: number, patch: Partial<Item>) =>
    setItems((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const remove = (it: Item) => {
    getEngine().forget(it.photo.key);
    canvases.current.delete(it.id);
    setItems((s) => s.filter((x) => x.id !== it.id));
  };

  const downloadAll = () =>
    items.forEach((it, i) =>
      setTimeout(() => {
        const c = canvases.current.get(it.id);
        if (c) downloadCanvas(c, it.style ?? style, it.name);
      }, i * 400),
    );

  const first = items[0]?.photo ?? null;

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
      className="mx-auto box-border flex min-h-screen max-w-[1180px] flex-col gap-9 px-6 pt-7 pb-14 font-mono text-[13px]"
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <header className="flex flex-wrap items-baseline justify-between gap-4 border-b border-ink pb-3.5">
        <span className="font-hand text-[34px] leading-none font-semibold">Bingkai sketsa.</span>
        <span className="text-xs text-muted">foto diproses di perangkatmu — tidak diunggah ke mana pun</span>
      </header>

      {items.length === 0 ? (
        <section className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] items-center gap-12">
          <div className="flex flex-col gap-[22px]">
            <h1 className="m-0 font-hand text-[clamp(52px,8vw,88px)] leading-[0.95] font-semibold tracking-[-0.5px] text-balance">
              Fotomu, seperti lukisan yang belum selesai diwarnai.
            </h1>
            <p className="m-0 max-w-[440px] leading-[1.7] text-pretty text-ink-soft">
              Upload foto, bagian tepinya otomatis berubah jadi gambar pensil hitam putih. Warnanya tinggal di
              tengah. Siap diposting ke Instagram.
            </p>
            <button onClick={openPicker} className={`${btnSolid} self-start px-[26px] py-4 text-sm`}>
              Pilih foto
            </button>
            <span className="text-xs text-muted">atau seret foto ke halaman ini · bisa beberapa sekaligus</span>
          </div>
          <div className="flex w-full max-w-[440px] flex-col gap-2.5 justify-self-center">
            <Demo />
            <span className="text-right text-[11px] text-muted">contoh hasil</span>
          </div>
        </section>
      ) : (
        <section className="flex flex-col gap-7">
          <div className="flex flex-wrap items-end gap-7 border-b border-rule pb-[18px]">
            <div className="flex flex-col gap-2">
              <span className={label}>Gaya · untuk semua foto</span>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Gaya">
                {STYLES.map((s) => (
                  <StyleButton
                    key={s.id}
                    id={s.id}
                    photo={first}
                    active={style === s.id}
                    onPick={() => setStyle(s.id)}
                  />
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className={label}>Rasio</span>
              <div className="flex gap-1.5">
                {RATIOS.map((r) => (
                  <button
                    key={r}
                    onClick={() => setRatio(r)}
                    aria-pressed={ratio === r}
                    className={`${ratio === r ? btnSolid : btnGhost} px-3 py-2`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className={label}>Tulisan tangan</span>
              <button
                onClick={() => setShowText((v) => !v)}
                aria-pressed={showText}
                className={`${btnGhost} px-3 py-2`}
              >
                {showText ? "Tampil" : "Sembunyi"}
              </button>
            </div>

            <div className="ml-auto flex flex-wrap gap-2">
              <button onClick={openPicker} className={`${btnGhost} px-4 py-2.5`}>
                + Tambah foto
              </button>
              <button onClick={downloadAll} className={`${btnSolid} px-4 py-2.5`}>
                {items.length > 1 ? `Unduh semua (${items.length})` : "Unduh"}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-7">
            {items.map((it, idx) => (
              <Card
                key={it.id}
                item={it}
                index={idx}
                globalStyle={style}
                ratio={ratio}
                showText={showText}
                onCanvas={(el) => {
                  if (el) canvases.current.set(it.id, el);
                }}
                onChange={(patch) => update(it.id, patch)}
                onRemove={() => remove(it)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StyleButton({
  id,
  photo,
  active,
  onPick,
}: {
  id: StyleId;
  photo: Photo | null;
  active: boolean;
  onPick: () => void;
}) {
  // thumbnails wait a moment so the full-size cards get the worker first
  const { ref, busy } = useRendered(photo, id, THUMB.W, THUMB.H, false, "", 700);
  return (
    <button
      role="radio"
      aria-checked={active}
      onClick={onPick}
      title={styleOf(id).label}
      className={`${active ? "border-ink bg-ink text-paper" : "border-line text-ink hover:border-ink"} flex w-[86px] cursor-pointer flex-col items-stretch gap-1.5 border p-1.5 text-left transition-colors`}
    >
      <span className="relative block aspect-[3/4] w-full bg-canvas">
        <canvas ref={ref} aria-hidden className="block h-full w-full" />
        {busy && <span className="absolute inset-0 animate-pulse bg-canvas" />}
      </span>
      <span className="text-[11px] leading-tight">{SHORT[id]}</span>
    </button>
  );
}

function Demo() {
  const { ref } = useRendered(DEMO, "belum", 1080, 1440, true, "Mond.");
  return (
    <canvas
      ref={ref}
      aria-label="Contoh hasil: foto dengan tepi sketsa pensil"
      className="block aspect-[3/4] h-auto w-full rotate-[1.2deg] bg-canvas shadow-[0_1px_2px_rgba(28,27,25,0.12),0_18px_40px_-16px_rgba(28,27,25,0.3)]"
    />
  );
}

function Card({
  item,
  index,
  globalStyle,
  ratio,
  showText,
  onCanvas,
  onChange,
  onRemove,
}: {
  item: Item;
  index: number;
  globalStyle: StyleId;
  ratio: Ratio;
  showText: boolean;
  onCanvas: (el: HTMLCanvasElement | null) => void;
  onChange: (patch: Partial<Item>) => void;
  onRemove: () => void;
}) {
  const style = item.style ?? globalStyle;
  const { W, H } = DIMS[ratio];
  const { ref, busy } = useRendered(item.photo, style, W, H, showText, item.caption);
  const [open, setOpen] = useState(false);
  const n = String(index + 1).padStart(2, "0");

  return (
    <div className="flex flex-col gap-3">
      <div className={`relative bg-canvas ${shadow}`} style={{ aspectRatio: ratio === "4:5" ? "4/5" : "3/4" }}>
        <canvas
          ref={(el) => {
            ref.current = el;
            onCanvas(el);
          }}
          aria-label={`Foto ${n}, gaya ${styleOf(style).label}`}
          className="block h-full w-full"
        />
        {busy && (
          <span
            role="status"
            className="absolute inset-0 flex items-center justify-center bg-paper/60 text-xs text-ink-soft backdrop-blur-[1px]"
          >
            memproses…
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-muted">{n}</span>
        <input
          value={item.caption}
          onChange={(e) => onChange({ caption: e.target.value })}
          placeholder="tulis sesuatu…"
          aria-label={`Tulisan untuk foto ${n}`}
          className="min-w-0 flex-1 border-0 border-b border-line bg-transparent px-0.5 py-1.5 font-hand text-2xl text-ink outline-none focus:border-ink"
        />
      </div>

      <div className="flex flex-col gap-2">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="cursor-pointer self-start text-[11px] text-muted underline decoration-line underline-offset-4 hover:text-ink"
        >
          {item.style ? `gaya foto ini: ${SHORT[item.style]} · ubah` : "ganti gaya untuk foto ini saja"}
        </button>
        {open && (
          <div className="flex flex-wrap gap-1">
            <Chip active={item.style === null} onClick={() => onChange({ style: null })}>
              ikut semua
            </Chip>
            {STYLES.map((s) => (
              <Chip key={s.id} active={item.style === s.id} onClick={() => onChange({ style: s.id })}>
                {SHORT[s.id]}
              </Chip>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button onClick={onRemove} className={`${btnGhost} px-3 py-[9px]`}>
          Hapus
        </button>
        <button
          onClick={() => ref.current && downloadCanvas(ref.current, style, item.name)}
          disabled={busy}
          className={`${btnSolid} flex-1 px-3 py-[9px] disabled:cursor-wait disabled:opacity-60`}
        >
          Unduh
        </button>
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`${active ? "border-ink bg-ink text-paper" : "border-line text-ink hover:border-ink"} cursor-pointer border px-2 py-1 text-[11px] transition-colors`}
    >
      {children}
    </button>
  );
}
