import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createJob, fetchActivations, fetchHealth, fetchJob, fetchMesh, getDemoKey, setDemoKey } from "./api";
import type { ClipState, Health, MeshPayload, SlotId } from "./types";
import { absPercentile, diffPercentile } from "./lib/data";
import BrainViewer, { type BrainMode, type BrainView } from "./components/BrainViewer";
import ClipSlot from "./components/ClipSlot";
import HookTable from "./components/HookTable";
import RegionGrid from "./components/RegionGrid";
import Segmented from "./components/Segmented";
import TimeStrip, { type Sound } from "./components/TimeStrip";

const IDS = ["A", "B"] as const;
const JOBS_STORAGE = "tribe-demo-jobs";
const EMPTY: ClipState = {
  status: "idle",
  stage: "",
  elapsedS: 0,
  error: null,
  jobId: null,
  fileName: null,
  videoUrl: null,
  summary: null,
  activations: null,
};

type SavedJobs = Partial<Record<SlotId, { jobId: string; fileName: string }>>;

function loadSavedJobs(): SavedJobs {
  try {
    return JSON.parse(localStorage.getItem(JOBS_STORAGE) ?? "{}");
  } catch {
    return {};
  }
}

function saveJob(id: SlotId, job: { jobId: string; fileName: string } | null) {
  try {
    const saved = loadSavedJobs();
    if (job) saved[id] = job;
    else delete saved[id];
    localStorage.setItem(JOBS_STORAGE, JSON.stringify(saved));
  } catch {
    // Storage unavailable: jobs just won't survive a reload.
  }
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [mesh, setMesh] = useState<MeshPayload | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [demoKey, setKey] = useState(getDemoKey);
  const [clips, setClips] = useState<Record<SlotId, ClipState>>(() => {
    const saved = loadSavedJobs();
    const init = { A: EMPTY, B: EMPTY };
    for (const id of IDS) {
      const job = saved[id];
      if (job) init[id] = { ...EMPTY, status: "queued", stage: "Checking job", jobId: job.jobId, fileName: job.fileName };
    }
    return init;
  });
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hookS, setHookS] = useState(5);
  const [sound, setSound] = useState<Sound>("A");
  const [mode, setMode] = useState<BrainMode>("A");
  const [view, setView] = useState<BrainView>("lateral");
  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const videos = { A: videoA, B: videoB };

  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const update = useCallback((id: SlotId, patch: Partial<ClipState>) => {
    setClips((c) => ({ ...c, [id]: { ...c[id], ...patch } }));
  }, []);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch((e) => setApiError(`Can't reach the API (${e.message}).`));
    fetchMesh()
      .then(setMesh)
      .catch((e) => setApiError(`Couldn't load the brain mesh (${e.message}).`));
  }, []);

  // Poll running jobs; fetch activations once a job finishes.
  useEffect(() => {
    const inflight: Record<SlotId, boolean> = { A: false, B: false };
    const tick = async () => {
      for (const id of IDS) {
        const c = clipsRef.current[id];
        if (!c.jobId || (c.status !== "queued" && c.status !== "running") || inflight[id]) continue;
        inflight[id] = true;
        const jobId = c.jobId;
        try {
          const job = await fetchJob(jobId);
          if (clipsRef.current[id].jobId !== jobId) continue;
          if (job.status === "done" && job.summary) {
            const activations = await fetchActivations(jobId);
            if (clipsRef.current[id].jobId !== jobId) continue;
            update(id, { status: "done", stage: "Done", summary: job.summary, activations });
          } else if (job.status === "error") {
            update(id, { status: "error", error: job.error ?? "Analysis failed." });
          } else {
            update(id, { status: job.status, stage: job.stage, elapsedS: job.elapsed_s ?? 0 });
          }
        } catch (e) {
          const message = (e as Error).message;
          // An unknown job won't come back; anything else is likely transient, so keep polling.
          if (message.includes("Unknown job")) {
            saveJob(id, null);
            update(id, { status: "error", error: "This job no longer exists on the server. Upload the clip again." });
          }
        } finally {
          inflight[id] = false;
        }
      }
    };
    tick();
    const iv = setInterval(tick, 3000);
    return () => clearInterval(iv);
  }, [update]);

  const upload = async (id: SlotId, file: File) => {
    const videoUrl = URL.createObjectURL(file);
    if (clipsRef.current[id].videoUrl) URL.revokeObjectURL(clipsRef.current[id].videoUrl!);
    update(id, { ...EMPTY, status: "uploading", stage: "Uploading 0%", fileName: file.name, videoUrl });
    try {
      const jobId = await createJob(file, demoKey, (f) => update(id, { stage: `Uploading ${Math.round(f * 100)}%` }));
      update(id, { status: "queued", stage: "Waiting for GPU", jobId });
      saveJob(id, { jobId, fileName: file.name });
    } catch (e) {
      update(id, { status: "error", error: (e as Error).message });
    }
  };

  const clear = (id: SlotId) => {
    if (clipsRef.current[id].videoUrl) URL.revokeObjectURL(clipsRef.current[id].videoUrl!);
    saveJob(id, null);
    update(id, EMPTY);
  };

  const attachVideo = (id: SlotId, file: File) => update(id, { videoUrl: URL.createObjectURL(file) });

  // Shared clock.
  const duration = Math.max(0, ...IDS.map((id) => clips[id].summary?.duration_s ?? 0));
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setTime((t) => Math.min(duration, t + dt));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration]);

  useEffect(() => {
    if (playing && time >= duration) setPlaying(false);
  }, [playing, time, duration]);

  // Keep both videos on the shared clock.
  useEffect(() => {
    for (const id of IDS) {
      const v = videos[id].current;
      if (!v) continue;
      if (playing && time < (v.duration || Infinity)) v.play().catch(() => undefined);
      else v.pause();
    }
  }, [playing]);

  useEffect(() => {
    for (const id of IDS) {
      const v = videos[id].current;
      if (!v || !Number.isFinite(v.duration)) continue;
      const target = Math.min(time, v.duration);
      if (Math.abs(v.currentTime - target) > (playing ? 0.3 : 0.04)) v.currentTime = target;
    }
  }, [time, playing]);

  const togglePlay = useCallback(() => {
    if (duration <= 0) return;
    setPlaying((p) => {
      if (!p && time >= duration - 0.05) setTime(0);
      return !p;
    });
  }, [duration, time]);

  const seek = useCallback((t: number) => setTime(t), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.code !== "Space" || el.closest("input, textarea, button, [role=slider], select")) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  // Colour scales shared by both clips, so A and B are drawn on the same terms.
  const scale = useMemo(() => {
    const ready = IDS.filter((id) => clips[id].summary && clips[id].activations);
    const single = Math.max(
      1e-3,
      ...ready.map((id) => absPercentile(clips[id].activations!, clips[id].summary!, 0.99)),
    );
    const diff =
      ready.length === 2
        ? diffPercentile(
            { activations: clips.A.activations!, summary: clips.A.summary! },
            { activations: clips.B.activations!, summary: clips.B.summary! },
            0.99,
          )
        : 1;
    return { single, diff };
  }, [clips.A.activations, clips.B.activations, clips.A.summary, clips.B.summary]);

  // Reveal the comparison the first time both clips are ready.
  const bothReady = clips.A.status === "done" && clips.B.status === "done";
  const revealed = useRef(false);
  useEffect(() => {
    if (bothReady && !revealed.current) {
      revealed.current = true;
      setMode("diff");
    }
    if (!bothReady) revealed.current = false;
  }, [bothReady]);

  const ready = (id: SlotId) => clips[id].status === "done";
  const effectiveMode: BrainMode =
    mode === "diff" ? (bothReady ? "diff" : ready("A") ? "A" : "B") : ready(mode) ? mode : ready("A") ? "A" : ready("B") ? "B" : mode;

  const locked = Boolean(health?.auth_required && !demoKey);
  const limits = { maxSeconds: health?.max_seconds ?? 90, maxUploadMb: health?.max_upload_mb ?? 80 };

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <h1>Cortex A/B</h1>
          <p>
            Upload two versions of a clip. Meta's TRIBE v2 predicts how an average brain responds to each, second by
            second, so you can see where the versions differ.
          </p>
        </div>
        <div className="masthead-side">
          {health?.auth_required && (
            <label className="keyfield">
              <span>Demo key</span>
              <input
                type="password"
                value={demoKey}
                autoComplete="off"
                onChange={(e) => {
                  setKey(e.target.value);
                  setDemoKey(e.target.value);
                }}
              />
            </label>
          )}
          <p className="disclaimer">Predicted activity for an average viewer. Not a measurement, and not a virality score.</p>
        </div>
      </header>

      {apiError && (
        <div className="banner" role="alert">
          {apiError} Start the backend with <code>modal serve backend/app.py</code> and run the frontend with{" "}
          <code>TRIBE_API_URL=&lt;printed url&gt; npm run dev</code>.
        </div>
      )}

      <main>
        <div className="stage">
          <ClipSlot
            id="A"
            clip={clips.A}
            videoRef={videoA}
            muted={sound !== "A"}
            limits={limits}
            locked={locked}
            onUpload={(f) => upload("A", f)}
            onAttachVideo={(f) => attachVideo("A", f)}
            onClear={() => clear("A")}
          />

          <section className="viewer" aria-label="Predicted cortical activity">
            <div className="viewer-bar">
              <Segmented<BrainMode>
                label="Show"
                value={effectiveMode}
                onChange={setMode}
                options={[
                  { value: "A", label: "Clip A", disabled: !ready("A") },
                  { value: "B", label: "Clip B", disabled: !ready("B") },
                  { value: "diff", label: "A − B", disabled: !bothReady },
                ]}
              />
              <Segmented<BrainView>
                label="View"
                value={view}
                onChange={setView}
                options={[
                  { value: "lateral", label: "Outer" },
                  { value: "medial", label: "Inner" },
                  { value: "top", label: "Top" },
                ]}
              />
            </div>
            {mesh ? (
              <BrainViewer mesh={mesh} clips={clips} time={time} mode={effectiveMode} view={view} scale={scale} />
            ) : (
              <div className="brain-canvas brain-loading">{apiError ? "No cortex to show." : "Loading cortex…"}</div>
            )}
            <div className="viewer-foot">
              <ScaleKey mode={effectiveMode} active={ready("A") || ready("B")} />
              <p className="viewer-hint">Drag to rotate. Scroll to zoom. Point at the cortex to name a region.</p>
            </div>
          </section>

          <ClipSlot
            id="B"
            clip={clips.B}
            videoRef={videoB}
            muted={sound !== "B"}
            limits={limits}
            locked={locked}
            onUpload={(f) => upload("B", f)}
            onAttachVideo={(f) => attachVideo("B", f)}
            onClear={() => clear("B")}
          />
        </div>

        <TimeStrip
          clips={clips}
          time={time}
          duration={duration}
          playing={playing}
          hookS={hookS}
          sound={sound}
          onTogglePlay={togglePlay}
          onSeek={seek}
          onHookS={setHookS}
          onSound={setSound}
        />

        <div className="analysis">
          <HookTable clips={clips} groups={mesh?.groups ?? []} hookS={hookS} />
          <RegionGrid clips={clips} groups={mesh?.groups ?? []} duration={duration} hookS={hookS} time={time} onSeek={seek} />
        </div>
      </main>

      <footer className="colophon">
        <p>
          Brain model: TRIBE v2 by Meta FAIR (CC BY-NC 4.0, non-commercial use only). Regions: HCP-MMP1 parcellation
          (Glasser et al., 2016) on the fsaverage5 cortex. Predictions cover the cortex only, not deep structures such
          as the nucleus accumbens.
        </p>
      </footer>
    </div>
  );
}

function ScaleKey({ mode, active }: { mode: BrainMode; active: boolean }) {
  if (!active) return <p className="scale-key muted">Analyse a clip to colour the cortex.</p>;
  if (mode === "diff") {
    return (
      <div className="scale-key" aria-label="Colour key: orange where clip B is higher, blue where clip A is higher">
        <span>B higher</span>
        <span className="ramp ramp-diff" aria-hidden />
        <span>A higher</span>
      </div>
    );
  }
  return (
    <div className="scale-key" aria-label={`Colour key: grey is baseline, brighter is a stronger predicted response in clip ${mode}`}>
      <span>Baseline</span>
      <span className={`ramp ramp-${mode.toLowerCase()}`} aria-hidden />
      <span>Strong response in clip {mode}</span>
    </div>
  );
}
