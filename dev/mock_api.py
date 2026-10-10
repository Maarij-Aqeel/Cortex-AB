"""Local stand-in for the Modal backend: the real cortex mesh, synthetic predictions.

Lets you work on the frontend without a GPU or a Modal account:

    pip install -r requirements-dev.txt
    python dev/mock_api.py
    cd frontend && TRIBE_API_URL=http://localhost:8765 npm run dev

Any uploaded file "finishes" after ~5 s with made-up activity. Nothing here is a
real TRIBE prediction.
"""

import argparse
import json
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(__file__).resolve().parent / ".cache"
sys.path.insert(0, str(ROOT / "backend"))
import brain_atlas  # noqa: E402

WORDS = "so here is the thing nobody tells you about this clip".split()


def synth_predictions(seed: int, duration: int, rois: dict) -> np.ndarray:
    """Smooth, region-shaped fake activity so the UI has something to draw."""
    rng = np.random.default_rng(seed)
    t = np.arange(duration)
    preds = rng.normal(0, 0.15, (duration, brain_atlas.N_VERTICES)).astype(np.float32)
    for idx in rois.values():
        phase, freq, amp = rng.uniform(0, 6), rng.uniform(0.08, 0.3), rng.uniform(0.3, 1.2)
        preds[:, idx] += (amp * np.sin(freq * t + phase))[:, None]
    return preds


class MockState:
    def __init__(self):
        CACHE.mkdir(exist_ok=True)
        mesh_path = CACHE / "brain_mesh.json"
        if not mesh_path.exists():
            print("Building cortex mesh (one-off download of the HCP atlas)...", flush=True)
            mesh_path.write_text(json.dumps(brain_atlas.build_mesh_payload(CACHE / "atlas")))
        self.mesh = mesh_path.read_bytes()
        self.rois = brain_atlas.roi_indices(brain_atlas.hcp_vertex_labels(CACHE / "atlas"))
        self.jobs: dict[str, dict] = {}

    def create_job(self, filename: str) -> str:
        job_id = uuid.uuid4().hex
        seed = len(self.jobs) + 1
        duration = 30
        preds = synth_predictions(seed, duration, self.rois)
        activations, lo, hi = brain_atlas.quantize(preds)
        summary = {
            "job_id": job_id,
            "filename": filename,
            "duration_s": float(duration),
            "source_duration_s": float(duration),
            "n_timesteps": duration,
            "n_vertices": brain_atlas.N_VERTICES,
            "times": [float(x) for x in range(duration)],
            "quant": {"lo": lo, "hi": hi},
            "rois": brain_atlas.summarize(preds, self.rois),
            "transcript": [{"start": 0.4 * i + 0.5, "text": w} for i, w in enumerate(WORDS * 6)][: duration * 2],
            "warnings": ["Mock backend: synthetic data, not a real prediction."],
            "elapsed_s": 5.0,
        }
        self.jobs[job_id] = {"created": time.time(), "summary": summary, "activations": activations}
        return job_id


def make_handler(state: MockState):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, body: bytes, content_type: str, code: int = 200):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, code: int = 200):
            self._send(json.dumps(obj).encode(), "application/json", code)

        def do_GET(self):
            parts = self.path.split("?")[0].strip("/").split("/")
            if parts == ["api", "health"]:
                return self._json({"ok": True, "auth_required": False, "max_seconds": 90, "max_upload_mb": 80})
            if parts == ["api", "mesh"]:
                return self._send(state.mesh, "application/json")
            if len(parts) >= 3 and parts[:2] == ["api", "jobs"]:
                job = state.jobs.get(parts[2])
                if job is None:
                    return self._json({"detail": "Unknown job"}, 404)
                if len(parts) == 4 and parts[3] == "activations":
                    return self._send(job["activations"], "application/octet-stream")
                age = time.time() - job["created"]
                if age < 5:
                    stage = "Waiting for GPU" if age < 2 else "Predicting brain response"
                    return self._json({"job_id": parts[2], "status": "running", "stage": stage, "elapsed_s": age})
                return self._json({"job_id": parts[2], "status": "done", "stage": "Done", "summary": job["summary"]})
            return self._json({"detail": "Not found"}, 404)

        def do_POST(self):
            if self.path.split("?")[0].rstrip("/") != "/api/jobs":
                return self._json({"detail": "Not found"}, 404)
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            return self._json({"job_id": state.create_job("clip.mp4")})

        def log_message(self, *args):
            pass

    return Handler


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(MockState()))
    print(f"Mock API on http://localhost:{args.port}  (Ctrl-C to stop)", flush=True)
    server.serve_forever()
