export type SlotId = "A" | "B";

export interface RegionGroup {
  key: string;
  label: string;
  hemi: "both" | "left" | "right";
  areas: string[];
  blurb: string;
}

export interface HemiPayload {
  positions: string; // base64 Float32 xyz, centred on the hemisphere
  faces: string; // base64 Uint16 triangles
  sulc: string; // base64 Uint8 curvature, 0 = deep sulcus
  area_index: string; // base64 Uint8 index into area_names, 255 = none
  group_index: string; // base64 Uint8 index into groups, 255 = none
  offset: [number, number, number];
  n_vertices: number;
  n_faces: number;
}

export interface MeshPayload {
  mesh: string;
  n_vertices: number;
  hemis: { left: HemiPayload; right: HemiPayload };
  area_names: string[];
  groups: RegionGroup[];
}

export interface TranscriptWord {
  start: number;
  text: string;
}

export interface Summary {
  job_id: string;
  filename: string;
  duration_s: number;
  source_duration_s: number;
  n_timesteps: number;
  n_vertices: number;
  times: number[];
  quant: { lo: number; hi: number };
  rois: Record<string, number[]>;
  transcript: TranscriptWord[];
  warnings: string[];
  elapsed_s: number;
}

export type JobStatus = "idle" | "uploading" | "queued" | "running" | "done" | "error";

export interface JobResponse {
  job_id: string;
  status: Exclude<JobStatus, "idle" | "uploading">;
  stage: string;
  elapsed_s?: number;
  error?: string;
  summary?: Summary;
}

export interface Health {
  ok: boolean;
  auth_required: boolean;
  max_seconds: number;
  max_upload_mb: number;
}

/** Everything the UI knows about one clip. */
export interface ClipState {
  status: JobStatus;
  stage: string;
  elapsedS: number;
  error: string | null;
  jobId: string | null;
  fileName: string | null;
  videoUrl: string | null;
  summary: Summary | null;
  activations: Uint8Array | null;
}
