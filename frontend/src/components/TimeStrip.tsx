import { useMemo, useRef } from "react";
import type { ClipState, SlotId } from "../types";
import { formatTime } from "../lib/data";
import Segmented from "./Segmented";

export type Sound = SlotId | "off";

interface Props {
  clips: Record<SlotId, ClipState>;
  time: number;
  duration: number;
  playing: boolean;
  hookS: number;
  sound: Sound;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onHookS: (s: number) => void;
  onSound: (s: Sound) => void;
}

const W = 1000;
const H = 72;
const PAD = 6;

function overallPath(times: number[], values: number[], duration: number, lo: number, hi: number): string {
  return values
    .map((v, i) => {
      const x = (times[i] / duration) * W;
      const y = PAD + (1 - (v - lo) / (hi - lo || 1)) * (H - 2 * PAD);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join("");
}

export default function TimeStrip(props: Props) {
  const { clips, time, duration, playing, hookS, sound, onTogglePlay, onSeek, onHookS, onSound } = props;
  const trackRef = useRef<HTMLDivElement>(null);
  const ready = (["A", "B"] as const).filter((id) => clips[id].summary);

  const paths = useMemo(() => {
    const all = ready.flatMap((id) => clips[id].summary!.rois.overall);
    if (!all.length || duration <= 0) return {} as Partial<Record<SlotId, string>>;
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const out: Partial<Record<SlotId, string>> = {};
    for (const id of ready) {
      const s = clips[id].summary!;
      out[id] = overallPath(s.times, s.rois.overall, duration, lo, hi);
    }
    return out;
  }, [clips.A.summary, clips.B.summary, duration]);

  const captionClip: SlotId | null = sound !== "off" && clips[sound].summary ? sound : ready[0] ?? null;
  const caption = useMemo(() => {
    if (!captionClip) return [];
    return clips[captionClip].summary!.transcript.filter((w) => w.start >= time - 3 && w.start <= time + 1.5);
  }, [captionClip, clips, time]);

  const seekFromPointer = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    onSeek(Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration)));
  };

  const disabled = duration <= 0;
  const x = duration > 0 ? (time / duration) * 100 : 0;
  const hookX = duration > 0 ? Math.min(100, (hookS / duration) * 100) : 0;

  return (
    <section className="timestrip" aria-label="Timeline">
      <div className="timestrip-controls">
        <button type="button" className="btn-play" onClick={onTogglePlay} disabled={disabled}>
          {playing ? "Pause" : "Play"}
        </button>
        <span className="timestrip-clock">
          {formatTime(time)} <span className="muted">/ {formatTime(duration)}</span>
        </span>
        <Segmented<Sound>
          label="Sound"
          value={sound}
          onChange={onSound}
          options={[
            { value: "A", label: "A", disabled: !clips.A.videoUrl },
            { value: "B", label: "B", disabled: !clips.B.videoUrl },
            { value: "off", label: "Off" },
          ]}
        />
        <Segmented<number>
          label="Hook window"
          value={hookS}
          onChange={onHookS}
          options={[3, 5, 8].map((s) => ({ value: s, label: `${s} s` }))}
        />
      </div>

      <div
        ref={trackRef}
        className={`timestrip-track${disabled ? " is-disabled" : ""}`}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={formatTime(time)}
        onPointerDown={(e) => {
          if (disabled) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromPointer(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) seekFromPointer(e.clientX);
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 5 : 1;
          if (e.key === "ArrowRight") onSeek(Math.min(duration, time + step));
          else if (e.key === "ArrowLeft") onSeek(Math.max(0, time - step));
          else if (e.key === "Home") onSeek(0);
          else if (e.key === "End") onSeek(duration);
          else return;
          e.preventDefault();
        }}
      >
        <div className="timestrip-hook" style={{ width: `${hookX}%` }} aria-hidden />
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
          {(["A", "B"] as const).map(
            (id) => paths[id] && <path key={id} d={paths[id]} className={`line line-${id.toLowerCase()}`} />,
          )}
        </svg>
        {!disabled && <div className="timestrip-head" style={{ left: `${x}%` }} aria-hidden />}
        {!ready.length && <p className="timestrip-empty">Whole-cortex response appears here once a clip is analysed.</p>}
      </div>
      <div className="timestrip-axis" aria-hidden>
        <span>0:00</span>
        <span>Whole-cortex response over time</span>
        <span>{formatTime(duration)}</span>
      </div>

      <p className="caption" aria-live="off">
        {captionClip && caption.length > 0 ? (
          <>
            <span className="caption-who">Clip {captionClip} says</span>{" "}
            {caption.map((w, i) => (
              <span key={`${w.start}-${i}`} className={w.start <= time && w.start > time - 0.6 ? "is-now" : undefined}>
                {w.text}{" "}
              </span>
            ))}
          </>
        ) : (
          <span className="muted">{captionClip ? "No speech at this moment." : " "}</span>
        )}
      </p>
    </section>
  );
}
