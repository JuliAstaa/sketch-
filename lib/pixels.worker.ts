/// <reference lib="webworker" />
import { interest, runLayer, type LayerArgs, type LayerOp } from "./pixels";

export type WorkerRequest =
  | { id: number; op: LayerOp; args: Omit<LayerArgs, "rgba"> & { rgba: ArrayBuffer } }
  | { id: number; op: "interest"; args: { rgba: ArrayBuffer; W: number; H: number } };

export type WorkerResponse =
  | { id: number; ok: true; data?: ArrayBuffer; point?: { x: number; y: number } }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    const rgba = new Uint8ClampedArray(msg.args.rgba);
    if (msg.op === "interest") {
      const res: WorkerResponse = { id: msg.id, ok: true, point: interest({ ...msg.args, rgba }) };
      ctx.postMessage(res);
      return;
    }
    const out = runLayer(msg.op, { ...msg.args, rgba });
    const res: WorkerResponse = { id: msg.id, ok: true, data: out.buffer as ArrayBuffer };
    ctx.postMessage(res, [out.buffer as ArrayBuffer]);
  } catch (err) {
    const res: WorkerResponse = { id: msg.id, ok: false, error: String(err) };
    ctx.postMessage(res);
  }
};
