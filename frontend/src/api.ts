import type { Health, JobResponse, MeshPayload } from "./types";

const KEY_STORAGE = "tribe-demo-key";

export function getDemoKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function setDemoKey(key: string): void {
  try {
    localStorage.setItem(KEY_STORAGE, key);
  } catch {
    // Private mode: the key lives for this page only.
  }
}

/** Turn a failed response body into a message a person can act on. */
function describeError(status: number, text: string): string {
  if (text.includes("modal-http")) {
    return "The Modal backend isn't running. Start it with `modal serve backend/app.py` and try again.";
  }
  try {
    const body = JSON.parse(text);
    if (typeof body.detail === "string") return body.detail;
  } catch {
    // not JSON
  }
  const snippet = text.trim().slice(0, 160);
  return snippet ? `${status}: ${snippet}` : `Request failed (${status})`;
}

async function errorText(res: Response): Promise<string> {
  return describeError(res.status, await res.text().catch(() => ""));
}

export async function fetchHealth(): Promise<Health> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

export async function fetchMesh(): Promise<MeshPayload> {
  const res = await fetch("/api/mesh");
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/** Upload with progress, since phone clips can be tens of MB. */
export function createJob(
  file: File,
  key: string,
  onProgress: (fraction: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/jobs");
    if (key) xhr.setRequestHeader("x-demo-key", key);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let jobId: string | undefined;
      try {
        jobId = JSON.parse(xhr.responseText).job_id;
      } catch {
        // handled below
      }
      if (xhr.status >= 200 && xhr.status < 300 && jobId) resolve(jobId);
      else reject(new Error(describeError(xhr.status, xhr.responseText)));
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export async function fetchJob(jobId: string): Promise<JobResponse> {
  const res = await fetch(`/api/jobs/${jobId}`);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

export async function fetchActivations(jobId: string): Promise<Uint8Array> {
  const res = await fetch(`/api/jobs/${jobId}/activations`);
  if (!res.ok) throw new Error(await errorText(res));
  return new Uint8Array(await res.arrayBuffer());
}
