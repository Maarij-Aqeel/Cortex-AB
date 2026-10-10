"""TRIBE v2 A/B brain-response demo on Modal.

    modal run backend/app.py::prefetch   # one-off: download model weights on a cheap CPU container
    modal run backend/app.py             # GPU smoke test on a sample clip
    modal serve backend/app.py           # temporary dev URL with hot reload
    modal deploy backend/app.py          # persistent URL (serves frontend/dist too, if built)
"""

# No `from __future__ import annotations` here: FastAPI resolves string annotations
# against module globals, and the route types (UploadFile, ...) are imported inside api().
import json
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

import modal

APP_NAME = "tribe-demo"
TRIBE_REPO = "facebook/tribev2"
# Commit of facebookresearch/tribev2 this demo was written against.
TRIBE_COMMIT = "af58661791a351a448a489042a28f6c37e1c14b7"
GPU = ["L40S", "A100-80GB"]  # first available wins; both have >= 48 GB VRAM
MAX_SECONDS = 90
MAX_UPLOAD_MB = 80
VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".mkv", ".avi"}

HERE = Path(__file__).parent
FRONTEND_DIST = HERE.parent / "frontend" / "dist"
CACHE = Path("/cache")

app = modal.App(APP_NAME)
cache_volume = modal.Volume.from_name("tribe-cache", create_if_missing=True)
jobs = modal.Dict.from_name("tribe-jobs", create_if_missing=True)
hf_secret = modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"])
demo_secret = modal.Secret.from_name("tribe-demo", required_keys=["DEMO_KEY"])

gpu_image = (
    # cuDNN in the base image: WhisperX (ctranslate2) looks for system cuDNN 9.
    modal.Image.from_registry("nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04", add_python="3.11")
    .apt_install("ffmpeg", "git")
    .uv_pip_install(
        f"tribev2[plotting] @ git+https://github.com/facebookresearch/tribev2.git@{TRIBE_COMMIT}",
        # tribev2 leaves transformers and huggingface_hub unpinned, so uv takes hub 2.x
        # and backtracks transformers to 4.12 (needs a Rust build of tokenizers 0.10).
        # 4.53 is the first release with V-JEPA2; neuralset still uses 4.x-era kwargs.
        "transformers>=4.53,<5",
        "uv",
    )
    # Fail at build time, not on the GPU, if the stack doesn't import.
    .run_commands("python -c 'import tribev2.demo_utils, transformers; print(\"transformers\", transformers.__version__)'")
    # tribev2 shells out to `uvx whisperx`; install it now so cold starts don't.
    .run_commands("uv tool install whisperx", "uvx whisperx --help > /dev/null")
    # neuralset downloads this spaCy model on first use otherwise.
    .run_commands("python -m spacy download en_core_web_lg")
    .env({
        "HF_HOME": str(CACHE / "hf"),
        "TORCH_HOME": str(CACHE / "torch"),
        "HF_HUB_DOWNLOAD_TIMEOUT": "300",
        "MPLBACKEND": "Agg",
    })
    .add_local_file(HERE / "brain_atlas.py", "/root/brain_atlas.py")
)

api_image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install("fastapi[standard]", "nibabel", "nilearn", "numpy")
    .add_local_file(HERE / "brain_atlas.py", "/root/brain_atlas.py", copy=True)
)


def _build_mesh_assets():
    import brain_atlas

    payload = brain_atlas.build_mesh_payload("/assets/atlas")
    Path("/assets/brain_mesh.json").write_text(json.dumps(payload))


api_image = api_image.run_function(_build_mesh_assets)
if FRONTEND_DIST.exists():
    api_image = api_image.add_local_dir(FRONTEND_DIST, "/assets/web")


def _update_job(job_id: str, **fields) -> None:
    jobs[job_id] = {**(jobs.get(job_id) or {}), **fields, "updated_at": time.time()}


# ---------------------------------------------------------------------------
# GPU worker
# ---------------------------------------------------------------------------


def _probe_has_audio(path: Path) -> bool:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
         "stream=index", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    return bool(out.stdout.strip())


def _probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def _normalize_video(src: Path, dst: Path, max_seconds: int) -> bool:
    """Trim, downscale and re-encode to H.264/AAC so every phone format works.

    Clips without an audio track get silence, since TRIBE's pipeline always
    extracts audio. Returns whether the source had audio.
    """
    has_audio = _probe_has_audio(src)
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src)]
    if not has_audio:
        cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=16000"]
    cmd += [
        "-t", str(max_seconds),
        "-map", "0:v:0", "-map", "0:a:0" if has_audio else "1:a:0",
        "-vf", "scale=w=min(854\\,iw):h=min(854\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-shortest", str(dst),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Could not read this video with ffmpeg: {result.stderr.strip()[-500:]}")
    return has_audio


@app.cls(
    gpu=GPU,
    image=gpu_image,
    volumes={CACHE: cache_volume},
    secrets=[hf_secret],
    cpu=4,
    memory=32768,
    timeout=30 * 60,
    scaledown_window=5 * 60,
    max_containers=1,  # A/B jobs queue on one warm GPU instead of paying two cold starts
)
class Tribe:
    @modal.enter()
    def load(self):
        import brain_atlas
        from tribev2.demo_utils import TribeModel

        t0 = time.time()
        # Feature cache stays on local disk; only weights live on the volume.
        self.model = TribeModel.from_pretrained(TRIBE_REPO, cache_folder="/tmp/tribe-features")
        self.rois = brain_atlas.roi_indices(brain_atlas.hcp_vertex_labels(CACHE / "atlas"))
        cache_volume.commit()
        print(f"Model ready in {time.time() - t0:.0f}s")

    @modal.method()
    def analyze(self, job_id: str, video: bytes, filename: str) -> dict:
        import brain_atlas
        import numpy as np

        t0 = time.time()
        try:
            _update_job(job_id, status="running", stage="Preparing video")
            work = Path(tempfile.mkdtemp(prefix=f"job-{job_id}-"))
            src = work / f"source{Path(filename).suffix.lower() or '.mp4'}"
            src.write_bytes(video)
            clip = work / "clip.mp4"
            has_audio = _normalize_video(src, clip, MAX_SECONDS)
            source_duration = _probe_duration(src)
            clip_duration = _probe_duration(clip)

            _update_job(job_id, stage="Transcribing speech and extracting events")
            events = self.model.get_events_dataframe(video_path=str(clip))

            _update_job(job_id, stage="Predicting brain response")
            preds, segments = self.model.predict(events=events, verbose=False)
            preds = np.asarray(preds, dtype=np.float32)
            times = np.array([float(s.start) for s in segments])
            order = np.argsort(times)
            preds, times = preds[order], times[order]

            _update_job(job_id, stage="Summarising regions")
            activations, lo, hi = brain_atlas.quantize(preds)
            words = events[events["type"] == "Word"] if "type" in events else events.iloc[0:0]
            transcript = [
                {"start": round(float(r.start), 2), "text": str(r.text).strip()}
                for r in words.itertuples()
            ][:3000]

            warnings = []
            if clip_duration < 15:
                warnings.append("Clips under ~15 s give weak, noisy predictions.")
            if source_duration > MAX_SECONDS + 0.5:
                warnings.append(f"Only the first {MAX_SECONDS} s were analysed.")
            if not has_audio:
                warnings.append(
                    "This file has no audio track, so it was analysed as silent. Sound and speech "
                    "regions will read low; compare it only with other silent clips."
                )
            elif not transcript:
                warnings.append("No speech detected; language regions will be quiet.")

            summary = {
                "job_id": job_id,
                "filename": filename,
                "duration_s": round(clip_duration, 2),
                "source_duration_s": round(source_duration, 2),
                "n_timesteps": int(preds.shape[0]),
                "n_vertices": int(preds.shape[1]),
                "times": np.round(times, 3).tolist(),
                "quant": {"lo": lo, "hi": hi},
                "rois": brain_atlas.summarize(preds, self.rois),
                "transcript": transcript,
                "warnings": warnings,
                "elapsed_s": round(time.time() - t0, 1),
            }

            # Keep raw predictions for later experiments (e.g. virality modelling).
            out_dir = CACHE / "results" / job_id
            out_dir.mkdir(parents=True, exist_ok=True)
            np.save(out_dir / "preds.npy", preds.astype(np.float16))
            (out_dir / "summary.json").write_text(json.dumps(summary))
            cache_volume.commit()

            _update_job(job_id, status="done", stage="Done")
            return {"summary": summary, "activations": activations}
        except Exception as exc:
            _update_job(job_id, status="error", stage="Failed", error=str(exc)[-1000:])
            raise


@app.function(image=gpu_image, volumes={CACHE: cache_volume}, secrets=[hf_secret], timeout=60 * 60)
def prefetch():
    """Download every model the GPU worker needs, on CPU, so GPU time isn't spent on downloads."""
    from huggingface_hub import snapshot_download

    repos = [
        TRIBE_REPO,
        "meta-llama/Llama-3.2-3B",
        "facebook/w2v-bert-2.0",
        "facebook/vjepa2-vitg-fpc64-256",
        "Systran/faster-whisper-large-v3",  # WhisperX "large-v3"
    ]
    # Skip duplicate raw checkpoints (V-JEPA2's original/model.pth alone is 16 GB);
    # transformers loads the safetensors files.
    ignore = ["original/*", "*.pt", "*.pth", "*.ipynb"]
    for repo in repos:
        t0 = time.time()
        snapshot_download(repo, ignore_patterns=ignore)
        print(f"{repo}: {time.time() - t0:.0f}s")
    cache_volume.commit()


# ---------------------------------------------------------------------------
# HTTP API (+ static frontend)
# ---------------------------------------------------------------------------


@app.function(image=api_image, secrets=[demo_secret], scaledown_window=10 * 60)
@modal.concurrent(max_inputs=50)
@modal.asgi_app()
def api():
    import os
    from collections import OrderedDict

    from fastapi import FastAPI, Header, HTTPException, UploadFile
    from fastapi.middleware.gzip import GZipMiddleware
    from fastapi.responses import FileResponse, Response
    from fastapi.staticfiles import StaticFiles

    demo_key = os.environ.get("DEMO_KEY", "")
    results: OrderedDict[str, dict] = OrderedDict()  # small LRU of finished jobs

    web = FastAPI(title="TRIBE v2 demo")
    web.add_middleware(GZipMiddleware, minimum_size=1024)

    def check_key(key: str | None) -> None:
        if demo_key and key != demo_key:
            raise HTTPException(401, "Missing or wrong demo key")

    def load_result(job_id: str) -> tuple[str, dict | str | None]:
        """("done", result) | ("running", None) | ("error", message) for a job."""
        if job_id in results:
            results.move_to_end(job_id)
            return "done", results[job_id]
        call_id = jobs.get(f"{job_id}:call")
        if call_id is None:
            raise HTTPException(404, "Unknown job")
        try:
            result = modal.FunctionCall.from_id(call_id).get(timeout=0)
        except (TimeoutError, modal.exception.TimeoutError):
            return "running", None
        except modal.exception.OutputExpiredError:
            return "error", "Result expired (results are kept 7 days). Run the clip again."
        except Exception as exc:
            meta = jobs.get(job_id) or {}
            return "error", meta.get("error") or str(exc) or type(exc).__name__
        results[job_id] = result
        if len(results) > 32:
            results.popitem(last=False)
        return "done", result

    @web.get("/api/health")
    def health():
        return {"ok": True, "auth_required": bool(demo_key), "max_seconds": MAX_SECONDS,
                "max_upload_mb": MAX_UPLOAD_MB}

    @web.get("/api/mesh")
    def mesh():
        return FileResponse("/assets/brain_mesh.json", media_type="application/json",
                            headers={"Cache-Control": "public, max-age=86400"})

    @web.post("/api/jobs")
    def create_job(file: UploadFile, x_demo_key: str | None = Header(default=None)):
        check_key(x_demo_key)
        filename = Path(file.filename or "clip.mp4").name
        if Path(filename).suffix.lower() not in VIDEO_SUFFIXES:
            raise HTTPException(415, f"Use one of: {', '.join(sorted(VIDEO_SUFFIXES))}")
        data = file.file.read(MAX_UPLOAD_MB * 1024 * 1024 + 1)
        if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
            raise HTTPException(413, f"Max upload is {MAX_UPLOAD_MB} MB")
        if not data:
            raise HTTPException(400, "Empty file")

        job_id = uuid.uuid4().hex
        jobs[job_id] = {"status": "queued", "stage": "Waiting for GPU", "filename": filename,
                        "created_at": time.time(), "updated_at": time.time()}
        call = Tribe().analyze.spawn(job_id, data, filename)
        # Separate key: the worker owns jobs[job_id] once it starts.
        jobs[f"{job_id}:call"] = call.object_id
        return {"job_id": job_id}

    @web.get("/api/jobs/{job_id}")
    def job_status(job_id: str):
        state, payload = load_result(job_id)
        if state == "done":
            return {"job_id": job_id, "status": "done", "stage": "Done", "summary": payload["summary"]}
        if state == "error":
            return {"job_id": job_id, "status": "error", "stage": "Failed", "error": payload}
        meta = jobs.get(job_id) or {}
        elapsed = time.time() - meta.get("created_at", time.time())
        return {"job_id": job_id, "status": meta.get("status", "queued"),
                "stage": meta.get("stage", ""), "elapsed_s": round(elapsed, 1)}

    @web.get("/api/jobs/{job_id}/activations")
    def job_activations(job_id: str):
        state, payload = load_result(job_id)
        if state != "done":
            raise HTTPException(409, "Job not finished yet")
        return Response(payload["activations"], media_type="application/octet-stream",
                        headers={"Cache-Control": "private, max-age=86400"})

    if Path("/assets/web").exists():
        web.mount("/", StaticFiles(directory="/assets/web", html=True), name="web")

    return web


# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------


@app.local_entrypoint()
def smoke(
    url: str = "https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4",
    video: str = "",
):
    """Run one clip end to end on the GPU and print the region summary.

    modal run backend/app.py                       # Sintel trailer
    modal run backend/app.py --video ~/clip.mp4    # a local file
    """
    import urllib.request

    if video:
        path = Path(video).expanduser()
        data, name = path.read_bytes(), path.name
        print(f"Read {path} ({len(data) / 1e6:.1f} MB)")
    else:
        print(f"Downloading {url}")
        # Some hosts (blender.org included) reject Python's default user agent.
        req = urllib.request.Request(url, headers={"User-Agent": "tribe-demo/0.1"})
        data, name = urllib.request.urlopen(req, timeout=120).read(), Path(url).name
    job_id = f"smoke-{uuid.uuid4().hex[:8]}"
    t0 = time.time()
    out = Tribe().analyze.remote(job_id, data, name)
    s = out["summary"]
    print(f"\nDone in {time.time() - t0:.0f}s (worker {s['elapsed_s']}s)")
    print(f"timesteps={s['n_timesteps']} vertices={s['n_vertices']} duration={s['duration_s']}s")
    print(f"words transcribed={len(s['transcript'])} warnings={s['warnings']}")
    print("\nMean predicted activity, first 5 s vs whole clip:")
    for key, values in s["rois"].items():
        hook = sum(values[:5]) / max(len(values[:5]), 1)
        full = sum(values) / max(len(values), 1)
        print(f"  {key:10s} hook={hook:+.3f}  full={full:+.3f}")
