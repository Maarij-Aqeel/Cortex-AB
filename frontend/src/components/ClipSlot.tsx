import { useRef, useState, type RefObject } from "react";
import type { ClipState, SlotId } from "../types";
import { formatTime } from "../lib/data";

interface Props {
  id: SlotId;
  clip: ClipState;
  videoRef: RefObject<HTMLVideoElement | null>;
  muted: boolean;
  limits: { maxSeconds: number; maxUploadMb: number };
  locked: boolean;
  onUpload: (file: File) => void;
  onAttachVideo: (file: File) => void;
  onClear: () => void;
}

const ACCEPT = "video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,.mp4,.mov,.webm,.mkv,.avi";

function statusLine(clip: ClipState): string {
  switch (clip.status) {
    case "uploading":
      return clip.stage;
    case "queued":
    case "running":
      return `${clip.stage || "Waiting for GPU"} (${formatTime(clip.elapsedS).replace(/\.\d$/, "")})`;
    case "done":
      return clip.summary ? `Analysed ${clip.summary.duration_s.toFixed(0)} s in ${clip.summary.elapsed_s.toFixed(0)} s` : "";
    default:
      return "";
  }
}

export default function ClipSlot({ id, clip, videoRef, muted, limits, locked, onUpload, onAttachVideo, onClear }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const busy = clip.status === "uploading" || clip.status === "queued" || clip.status === "running";
  const empty = clip.status === "idle";

  const pick = (files: FileList | null, handler: (f: File) => void) => {
    const file = files?.[0];
    if (file) handler(file);
  };

  return (
    <section className={`clip clip-${id.toLowerCase()}`} aria-label={`Clip ${id}`}>
      <header className="clip-head">
        <h2>
          <i className={`swatch swatch-${id.toLowerCase()}`} aria-hidden />
          Clip {id}
        </h2>
        {!empty && !busy && (
          <button type="button" className="link" onClick={onClear}>
            Remove
          </button>
        )}
      </header>

      {empty ? (
        <label
          className={`drop${dragging ? " is-dragging" : ""}${locked ? " is-locked" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!locked) pick(e.dataTransfer.files, onUpload);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            disabled={locked}
            onChange={(e) => pick(e.target.files, onUpload)}
          />
          <span className="drop-title">{locked ? "Enter the demo key first" : "Drop a video or choose a file"}</span>
          <span className="drop-note">
            MP4, MOV or WebM. The first {limits.maxSeconds} s are analysed; files up to {limits.maxUploadMb} MB.
          </span>
        </label>
      ) : (
        <div className="clip-media">
          {clip.videoUrl ? (
            <video ref={videoRef} src={clip.videoUrl} muted={muted} playsInline preload="auto" />
          ) : (
            <div className="clip-novideo">
              <p>{clip.fileName ?? "This clip"} was analysed earlier. Choose the same file to play it alongside.</p>
              <input ref={attachRef} type="file" accept={ACCEPT} hidden onChange={(e) => pick(e.target.files, onAttachVideo)} />
              <button type="button" className="btn-quiet" onClick={() => attachRef.current?.click()}>
                Choose file
              </button>
            </div>
          )}
          {busy && <div className="clip-progress" aria-hidden><span /></div>}
        </div>
      )}

      {!empty && (
        <div className="clip-meta">
          {clip.fileName && <p className="clip-file" title={clip.fileName}>{clip.fileName}</p>}
          {clip.status === "error" ? (
            <p className="clip-error" role="alert">
              {clip.error}
              <button type="button" className="link" onClick={onClear}>
                Try another clip
              </button>
            </p>
          ) : (
            <p className="clip-status" aria-live="polite">
              {statusLine(clip)}
            </p>
          )}
          {clip.summary?.warnings.map((w) => (
            <p key={w} className="clip-warning">
              {w}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
