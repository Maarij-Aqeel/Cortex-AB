import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ClipState, MeshPayload, SlotId } from "../types";
import { decodeHemi, formatValue, sampleFrame, type Hemi } from "../lib/data";
import { CORTEX_GYRUS, CORTEX_SULCUS, glow, mixInto, tokenRgb, type RGB } from "../lib/colors";

export type BrainMode = SlotId | "diff";
export type BrainView = "lateral" | "medial" | "top";

interface Props {
  mesh: MeshPayload;
  clips: Record<SlotId, ClipState>;
  time: number;
  mode: BrainMode;
  view: BrainView;
  scale: { single: number; diff: number };
}

interface HoverInfo {
  x: number;
  y: number;
  area: string;
  group: string | null;
  values: Partial<Record<SlotId, number>>;
}

const HEMIS = ["left", "right"] as const;
const N_LEFT = 10242;

/** RAS millimetres -> three.js (x right, y up, z toward a viewer standing behind the head). */
function toThree(positions: Float32Array): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i];
    out[i + 1] = positions[i + 2];
    out[i + 2] = -positions[i + 1];
  }
  return out;
}

function layout(groups: Record<string, THREE.Group>, hemis: Record<string, Hemi>, view: BrainView, aspect: number) {
  for (const side of HEMIS) {
    const g = groups[side];
    const sign = side === "left" ? -1 : 1;
    g.rotation.set(0, 0, 0);
    g.position.set(0, 0, 0);
    if (view === "top") {
      g.rotation.x = Math.PI / 2;
      g.position.x = hemis[side].offset[0];
    } else {
      // Lateral: each hemisphere turns its outer face to the camera; medial: its inner face.
      const outward = view === "lateral" ? 1 : -1;
      g.rotation.y = (-sign * outward * Math.PI) / 2;
    }
  }
  if (view !== "top") {
    const boxL = new THREE.Box3().setFromObject(groups.left);
    const boxR = new THREE.Box3().setFromObject(groups.right);
    const gap = 8;
    if (aspect < 1.2) {
      // Portrait frames (phones): stack left above right.
      groups.left.position.set(-(boxL.min.x + boxL.max.x) / 2, -boxL.min.y + gap / 2, 0);
      groups.right.position.set(-(boxR.min.x + boxR.max.x) / 2, -boxR.max.y - gap / 2, 0);
    } else {
      groups.left.position.x = -(boxL.max.x + gap / 2);
      groups.right.position.x = -boxR.min.x + gap / 2;
    }
  }
}

/** Move the camera back until both hemispheres fit the frame. */
function fitCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, groups: Record<string, THREE.Group>) {
  const box = new THREE.Box3().setFromObject(groups.left).union(new THREE.Box3().setFromObject(groups.right));
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const forHeight = size.y / 2 / tanHalf;
  const forWidth = size.x / 2 / (tanHalf * camera.aspect);
  const distance = Math.max(forHeight, forWidth) * 1.08 + size.z / 2;
  camera.position.set(center.x, center.y, center.z + distance);
  controls.target.copy(center);
  controls.update();
}

export default function BrainViewer({ mesh, clips, time, mode, view, scale }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    groups: Record<string, THREE.Group>;
    meshes: Record<string, THREE.Mesh>;
    colors: Record<string, Float32Array>;
  } | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const hemis = useMemo(
    () => ({ left: decodeHemi(mesh.hemis.left), right: decodeHemi(mesh.hemis.right) }),
    [mesh],
  );
  const frames = useRef<Record<SlotId, Float32Array>>({
    A: new Float32Array(mesh.n_vertices),
    B: new Float32Array(mesh.n_vertices),
  });

  // Scene setup, once per mesh.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 1, 4000);
    camera.position.set(0, 0, 560);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404650, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(0.3, 0.6, 1);
    camera.add(key);
    scene.add(camera);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 150;
    controls.maxDistance = 2500;

    const groups: Record<string, THREE.Group> = {};
    const meshes: Record<string, THREE.Mesh> = {};
    const colors: Record<string, Float32Array> = {};
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    for (const side of HEMIS) {
      const h = hemis[side];
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(toThree(h.positions), 3));
      geometry.setIndex(new THREE.BufferAttribute(h.faces, 1));
      geometry.computeVertexNormals();
      colors[side] = new Float32Array(h.nVertices * 3);
      geometry.setAttribute("color", new THREE.BufferAttribute(colors[side], 3));
      const m = new THREE.Mesh(geometry, material);
      m.userData.side = side;
      const g = new THREE.Group();
      g.add(m);
      scene.add(g);
      groups[side] = g;
      meshes[side] = m;
    }

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
      layout(groups, hemis, viewRef.current, camera.aspect);
      fitCamera(camera, controls, groups);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    stateRef.current = { renderer, camera, controls, groups, meshes, colors };
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      for (const side of HEMIS) meshes[side].geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      stateRef.current = null;
    };
  }, [hemis]);

  // Camera presets.
  useEffect(() => {
    const s = stateRef.current;
    if (!s) return;
    layout(s.groups, hemis, view, s.camera.aspect);
    fitCamera(s.camera, s.controls, s.groups);
  }, [view, hemis]);

  // Recolour cortex for the current time and mode.
  useEffect(() => {
    const s = stateRef.current;
    if (!s) return;
    const colA: RGB = tokenRgb("--clip-a", "#2a78d6");
    const colB: RGB = tokenRgb("--clip-b", "#eb6834");
    const ready = (id: SlotId) => clips[id].summary && clips[id].activations;
    for (const id of ["A", "B"] as const) {
      const c = clips[id];
      if (c.summary && c.activations) sampleFrame(c.activations, c.summary, time, frames.current[id]);
    }
    const showDiff = mode === "diff" && ready("A") && ready("B");
    const single = mode === "diff" ? null : ready(mode) ? mode : null;
    const threshold = 0.15 * scale.single;
    const base: RGB = [0, 0, 0];

    for (const side of HEMIS) {
      const h = hemis[side];
      const out = s.colors[side];
      const offset = side === "left" ? 0 : N_LEFT;
      for (let v = 0; v < h.nVertices; v++) {
        const k = h.sulc[v] / 255; // 0 = deep sulcus, 1 = gyral crown
        base[0] = CORTEX_SULCUS[0] + (CORTEX_GYRUS[0] - CORTEX_SULCUS[0]) * k;
        base[1] = CORTEX_SULCUS[1] + (CORTEX_GYRUS[1] - CORTEX_SULCUS[1]) * k;
        base[2] = CORTEX_SULCUS[2] + (CORTEX_GYRUS[2] - CORTEX_SULCUS[2]) * k;
        const g = offset + v;
        if (showDiff) {
          const d = (frames.current.A[g] - frames.current.B[g]) / scale.diff;
          const n = Math.min(1, Math.abs(d));
          mixInto(out, v * 3, base, d >= 0 ? colA : colB, Math.pow(n, 0.8));
        } else if (single) {
          const value = frames.current[single][g];
          const n = Math.min(1, Math.max(0, (value - threshold) / (scale.single - threshold)));
          mixInto(out, v * 3, base, glow(single === "A" ? colA : colB, n), Math.min(1, n * 1.4));
        } else {
          out[v * 3] = base[0];
          out[v * 3 + 1] = base[1];
          out[v * 3 + 2] = base[2];
        }
      }
      (s.meshes[side].geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    }
  }, [clips, time, mode, scale, hemis]);

  // Hover: name the region under the pointer.
  useEffect(() => {
    const s = stateRef.current;
    const host = hostRef.current;
    if (!s || !host) return;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pending = 0;
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return setHover(null); // rotating
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        const rect = host.getBoundingClientRect();
        pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(pointer, s.camera);
        const hit = raycaster.intersectObjects([s.meshes.left, s.meshes.right], false)[0];
        if (!hit || !hit.face) return setHover(null);
        const side = hit.object.userData.side as "left" | "right";
        const geo = (hit.object as THREE.Mesh).geometry;
        const pos = geo.getAttribute("position");
        const local = hit.object.worldToLocal(hit.point.clone());
        let best = hit.face.a;
        let bestD = Infinity;
        for (const idx of [hit.face.a, hit.face.b, hit.face.c]) {
          const d = local.distanceToSquared(new THREE.Vector3().fromBufferAttribute(pos, idx));
          if (d < bestD) [best, bestD] = [idx, d];
        }
        const h = hemis[side];
        const areaIdx = h.areaIndex[best];
        const groupIdx = h.groupIndex[best];
        const g = (side === "left" ? 0 : N_LEFT) + best;
        const values: Partial<Record<SlotId, number>> = {};
        for (const id of ["A", "B"] as const) {
          if (clips[id].summary && clips[id].activations) values[id] = frames.current[id][g];
        }
        setHover({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          area: areaIdx === 255 ? "Medial wall" : `${side === "left" ? "Left" : "Right"} ${mesh.area_names[areaIdx]}`,
          group: groupIdx === 255 ? null : mesh.groups[groupIdx].label,
          values,
        });
      });
    };
    const onLeave = () => {
      cancelAnimationFrame(pending);
      setHover(null);
    };
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(pending);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
    };
  }, [hemis, mesh, clips]);

  return (
    <div className="brain-canvas" ref={hostRef}>
      {hover && (
        <div className="brain-tip" style={{ left: hover.x, top: hover.y }} role="status">
          <strong>{hover.area}</strong>
          <span>{hover.group ?? "Outside the tracked regions"}</span>
          {(["A", "B"] as const).map(
            (id) =>
              hover.values[id] !== undefined && (
                <span key={id} className="brain-tip-row">
                  <i className={`swatch swatch-${id.toLowerCase()}`} aria-hidden />
                  Clip {id} {formatValue(hover.values[id]!)}
                </span>
              ),
          )}
        </div>
      )}
    </div>
  );
}
