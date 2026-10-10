"""HTTP API tests with Modal's Dict, GPU class and FunctionCall replaced by fakes.

No Modal account or GPU needed:  pip install -r requirements-dev.txt && pytest
"""

import sys
from pathlib import Path

import modal
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402

VIDEO = ("clip.mp4", b"fake-video-bytes", "video/mp4")


class FakeCall:
    def __init__(self, store: dict, call_id: str):
        self.store, self.object_id = store, call_id

    def get(self, timeout=None):
        result = self.store[self.object_id]
        if result == "running":
            raise modal.exception.TimeoutError()
        if isinstance(result, Exception):
            raise result
        return result


@pytest.fixture
def backend(monkeypatch):
    calls: dict = {}
    jobs: dict = {}

    class FakeAnalyze:
        def spawn(self, job_id, data, filename):
            call_id = f"fc-{job_id}"
            calls[call_id] = "running"
            return FakeCall(calls, call_id)

    class FakeTribe:
        analyze = FakeAnalyze()

    monkeypatch.setattr(app, "jobs", jobs)
    monkeypatch.setattr(app, "Tribe", FakeTribe)
    monkeypatch.setattr(modal.FunctionCall, "from_id", staticmethod(lambda cid: FakeCall(calls, cid)))
    return calls, jobs


def client(monkeypatch, key: str = "") -> TestClient:
    monkeypatch.setenv("DEMO_KEY", key)
    return TestClient(app.api._raw_f_())


def test_upload_is_multipart_and_header_keyed(monkeypatch):
    op = client(monkeypatch).app.openapi()["paths"]["/api/jobs"]["post"]
    assert [(p["name"], p["in"]) for p in op["parameters"]] == [("x-demo-key", "header")]
    assert "multipart/form-data" in op["requestBody"]["content"]


def test_health_reports_auth(monkeypatch):
    assert client(monkeypatch).get("/api/health").json()["auth_required"] is False
    assert client(monkeypatch, "secret").get("/api/health").json()["auth_required"] is True


def test_demo_key_is_enforced(monkeypatch, backend):
    c = client(monkeypatch, "secret")
    assert c.post("/api/jobs", files={"file": VIDEO}).status_code == 401
    assert c.post("/api/jobs", files={"file": VIDEO}, headers={"x-demo-key": "wrong"}).status_code == 401
    assert c.post("/api/jobs", files={"file": VIDEO}, headers={"x-demo-key": "secret"}).status_code == 200


def test_rejects_non_video(monkeypatch, backend):
    r = client(monkeypatch).post("/api/jobs", files={"file": ("notes.txt", b"x", "text/plain")})
    assert r.status_code == 415


def test_job_lifecycle(monkeypatch, backend):
    calls, jobs = backend
    c = client(monkeypatch)
    job_id = c.post("/api/jobs", files={"file": VIDEO}).json()["job_id"]

    assert c.get(f"/api/jobs/{job_id}").json()["status"] == "queued"
    assert c.get(f"/api/jobs/{job_id}/activations").status_code == 409

    calls[jobs[f"{job_id}:call"]] = {"summary": {"job_id": job_id}, "activations": b"\x01\x02"}
    body = c.get(f"/api/jobs/{job_id}").json()
    assert body["status"] == "done" and body["summary"] == {"job_id": job_id}
    assert c.get(f"/api/jobs/{job_id}/activations").content == b"\x01\x02"


def test_failed_job_reports_worker_error(monkeypatch, backend):
    calls, jobs = backend
    c = client(monkeypatch)
    job_id = c.post("/api/jobs", files={"file": VIDEO}).json()["job_id"]
    jobs[job_id] = {"status": "error", "error": "whisperx failed: boom"}
    calls[jobs[f"{job_id}:call"]] = RuntimeError("remote failure")
    body = c.get(f"/api/jobs/{job_id}").json()
    assert body["status"] == "error" and "whisperx failed" in body["error"]


def test_unknown_job_is_404(monkeypatch, backend):
    assert client(monkeypatch).get("/api/jobs/does-not-exist").status_code == 404
