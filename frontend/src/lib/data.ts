import type { HemiPayload, Summary } from "../types";

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface Hemi {
  positions: Float32Array;
  faces: Uint16Array;
  sulc: Uint8Array;
  areaIndex: Uint8Array;
  groupIndex: Uint8Array;
  offset: [number, number, number];
  nVertices: number;
}

export function decodeHemi(h: HemiPayload): Hemi {
  return {
    positions: new Float32Array(b64ToBytes(h.positions).buffer),
    faces: new Uint16Array(b64ToBytes(h.faces).buffer),
    sulc: b64ToBytes(h.sulc),
    areaIndex: b64ToBytes(h.area_index),
    groupIndex: b64ToBytes(h.group_index),
    offset: h.offset,
    nVertices: h.n_vertices,
  };
}

/** Bracketing timesteps and blend weight for time t (seconds). */
export function frameAt(times: number[], t: number): { i0: number; i1: number; w: number } {
  const n = times.length;
  if (n === 0) return { i0: 0, i1: 0, w: 0 };
  if (t <= times[0]) return { i0: 0, i1: 0, w: 0 };
  if (t >= times[n - 1]) return { i0: n - 1, i1: n - 1, w: 0 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo] || 1;
  return { i0: lo, i1: hi, w: (t - times[lo]) / span };
}

/** Dequantised, time-interpolated activity for every vertex at time t. */
export function sampleFrame(
  activations: Uint8Array,
  summary: Summary,
  t: number,
  out: Float32Array,
): Float32Array {
  const nv = summary.n_vertices;
  const { lo, hi } = summary.quant;
  const scale = (hi - lo) / 255;
  const { i0, i1, w } = frameAt(summary.times, t);
  const a = i0 * nv;
  const b = i1 * nv;
  for (let v = 0; v < nv; v++) {
    const q = activations[a + v] * (1 - w) + activations[b + v] * w;
    out[v] = lo + q * scale;
  }
  return out;
}

/** Value of a per-timestep series at time t, interpolated. */
export function seriesAt(times: number[], values: number[], t: number): number {
  const { i0, i1, w } = frameAt(times, t);
  return values[i0] * (1 - w) + values[i1] * w;
}

/** Percentile of |value| over a whole clip, from a 256-bin histogram of the quantised data. */
export function absPercentile(activations: Uint8Array, summary: Summary, p: number): number {
  const counts = new Float64Array(256);
  for (let i = 0; i < activations.length; i++) counts[activations[i]]++;
  const { lo, hi } = summary.quant;
  const bins = Array.from({ length: 256 }, (_, q) => ({
    v: Math.abs(lo + (q / 255) * (hi - lo)),
    c: counts[q],
  })).sort((x, y) => x.v - y.v);
  const target = p * activations.length;
  let acc = 0;
  for (const bin of bins) {
    acc += bin.c;
    if (acc >= target) return bin.v;
  }
  return bins[bins.length - 1].v;
}

/** Robust scale for A−B maps: percentile of |A−B| over shared timesteps, on a vertex subsample. */
export function diffPercentile(
  a: { activations: Uint8Array; summary: Summary },
  b: { activations: Uint8Array; summary: Summary },
  p: number,
): number {
  const end = Math.min(a.summary.duration_s, b.summary.duration_s);
  const nv = a.summary.n_vertices;
  const fa = new Float32Array(nv);
  const fb = new Float32Array(nv);
  const samples: number[] = [];
  const steps = Math.min(40, Math.max(1, Math.floor(end)));
  for (let s = 0; s < steps; s++) {
    const t = (s / steps) * end;
    sampleFrame(a.activations, a.summary, t, fa);
    sampleFrame(b.activations, b.summary, t, fb);
    for (let v = 0; v < nv; v += 7) samples.push(Math.abs(fa[v] - fb[v]));
  }
  samples.sort((x, y) => x - y);
  return samples[Math.min(samples.length - 1, Math.floor(p * samples.length))] || 1;
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

/** Mean of a series over [0, windowS) seconds. */
export function windowMean(times: number[], values: number[], windowS: number): number {
  const picked = values.filter((_, i) => times[i] < windowS);
  return picked.length ? mean(picked) : values[0] ?? 0;
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

export function formatValue(v: number): string {
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;
}
