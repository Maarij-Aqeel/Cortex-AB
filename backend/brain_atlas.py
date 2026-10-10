"""Brain-region definitions shared by the GPU worker and the API.

TRIBE v2 predicts activity on the fsaverage5 cortical mesh: 10242 vertices per
hemisphere, left hemisphere first (20484 total). Regions come from the HCP-MMP1
parcellation (Glasser et al. 2016), grouped into a few functional systems that
are easy to read in a demo.

fsaverage meshes are nested icosahedra, so the fsaverage5 vertices are the first
10242 vertices of the full-resolution fsaverage annotation. TRIBE relies on the
same property in ``tribev2.utils.get_hcp_labels``.
"""

from __future__ import annotations

import base64
import hashlib
import shutil
import urllib.request
from pathlib import Path

import numpy as np

N_PER_HEMI = 10242
N_VERTICES = 2 * N_PER_HEMI

# Same files and checksums MNE uses in mne.datasets.fetch_hcp_mmp_parcellation.
HCP_ANNOT = {
    "lh": ("https://ndownloader.figshare.com/files/5528816", "46a102b59b2fb1bb4bd62d51bf02e975"),
    "rh": ("https://ndownloader.figshare.com/files/5528819", "75e96b331940227bbcb07c1c791c2463"),
}

ROI_GROUPS: list[dict] = [
    {
        "key": "visual",
        "label": "Early visual",
        "hemi": "both",
        "areas": ["V1", "V2", "V3", "V4"],
        "blurb": "Raw visual input: edges, contrast, colour, cuts.",
    },
    {
        "key": "motion",
        "label": "Motion",
        "hemi": "both",
        "areas": ["MT", "MST", "FST", "V4t"],
        "blurb": "Movement and optic flow (MT+ complex).",
    },
    {
        "key": "faces",
        "label": "Faces & objects",
        "hemi": "both",
        "areas": ["FFC", "VVC", "PIT", "LO1", "LO2", "LO3", "V8"],
        "blurb": "Ventral visual stream: faces, bodies, objects.",
    },
    {
        "key": "auditory",
        "label": "Auditory",
        "hemi": "both",
        "areas": ["A1", "LBelt", "MBelt", "PBelt", "RI"],
        "blurb": "Early sound processing: music, voice, noise.",
    },
    {
        "key": "language",
        "label": "Language (left)",
        "hemi": "left",
        "areas": ["44", "45", "47l", "55b", "SFL", "PSL", "STSda", "STSdp",
                  "STSva", "STSvp", "STGa", "A4", "A5", "TA2"],
        "blurb": "Speech comprehension and meaning. Left-lateralised.",
    },
    {
        "key": "social",
        "label": "Social / TPJ",
        "hemi": "both",
        "areas": ["TPOJ1", "TPOJ2", "TPOJ3", "STV", "PGi", "PGs"],
        "blurb": "Temporo-parietal junction: people, intentions, stories.",
    },
    {
        "key": "attention",
        "label": "Attention",
        "hemi": "both",
        "areas": ["FEF", "PEF", "LIPv", "LIPd", "VIP", "MIP", "AIP", "IPS1",
                  "IP0", "IP1", "IP2", "7PC"],
        "blurb": "Dorsal attention network: where to look next.",
    },
    {
        "key": "salience",
        "label": "Salience / insula",
        "hemi": "both",
        "areas": ["AVI", "AAIC", "MI", "FOP4", "FOP5", "a24pr", "p32pr", "a32pr"],
        "blurb": "Anterior insula and cingulate: arousal and salience. "
                 "Tong et al. 2020 linked higher anterior-insula activity at "
                 "video onset to lower YouTube engagement.",
    },
    {
        "key": "valuation",
        "label": "Valuation (vmPFC/OFC)",
        "hemi": "both",
        "areas": ["OFC", "pOFC", "10r", "10v", "11l", "13l", "25", "s32"],
        "blurb": "Cortical value signals. fMRI signal is weak here, and the "
                 "main reward hub (nucleus accumbens) is subcortical and not "
                 "predicted. Read with caution.",
    },
]


def _md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def _download(url: str, md5: str, dest: Path) -> Path:
    if dest.exists() and _md5(dest) == md5:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "tribe-demo"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as f:
        shutil.copyfileobj(resp, f)
    if _md5(tmp) != md5:
        tmp.unlink()
        raise RuntimeError(f"Checksum mismatch for {url}")
    tmp.replace(dest)
    return dest


def _clean_area_name(name: str) -> str:
    # "L_V1_ROI" -> "V1"; "???" marks the medial wall.
    if name.startswith(("L_", "R_")):
        name = name[2:]
    name = name.removesuffix("_ROI")
    return "" if name == "???" else name


def hcp_vertex_labels(cache_dir: str | Path) -> np.ndarray:
    """HCP area name for every fsaverage5 vertex (left then right), '' if unlabelled."""
    import nibabel as nib

    out = []
    for hemi in ("lh", "rh"):
        url, md5 = HCP_ANNOT[hemi]
        path = _download(url, md5, Path(cache_dir) / f"{hemi}.HCPMMP1.annot")
        labels, _ctab, names = nib.freesurfer.read_annot(str(path))
        names = [_clean_area_name(n.decode() if isinstance(n, bytes) else n) for n in names]
        idx = labels[:N_PER_HEMI]
        out.append(np.array([names[i] if i >= 0 else "" for i in idx], dtype=object))
    return np.concatenate(out)


def roi_indices(vertex_labels: np.ndarray) -> dict[str, np.ndarray]:
    """Vertex indices for each ROI group."""
    known = set(vertex_labels.tolist())
    hemi_mask = {
        "both": np.ones(N_VERTICES, dtype=bool),
        "left": np.arange(N_VERTICES) < N_PER_HEMI,
        "right": np.arange(N_VERTICES) >= N_PER_HEMI,
    }
    out = {}
    for group in ROI_GROUPS:
        missing = [a for a in group["areas"] if a not in known]
        if missing:
            raise ValueError(f"HCP areas not found for {group['key']}: {missing}")
        mask = np.isin(vertex_labels, group["areas"]) & hemi_mask[group["hemi"]]
        out[group["key"]] = np.flatnonzero(mask)
    return out


def summarize(preds: np.ndarray, rois: dict[str, np.ndarray]) -> dict[str, list[float]]:
    """Mean predicted activity per ROI group per timestep, plus whole cortex."""
    series = {key: preds[:, idx].mean(axis=1) for key, idx in rois.items()}
    series["overall"] = preds.mean(axis=1)
    return {key: np.round(values, 4).tolist() for key, values in series.items()}


def quantize(preds: np.ndarray) -> tuple[bytes, float, float]:
    """uint8-encode predictions on a robust range; decode as lo + q / 255 * (hi - lo)."""
    lo, hi = np.percentile(preds, [0.1, 99.9])
    if hi <= lo:
        hi = lo + 1e-6
    q = np.round((np.clip(preds, lo, hi) - lo) / (hi - lo) * 255).astype(np.uint8)
    return q.tobytes(), float(lo), float(hi)


def _b64(array: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(array).tobytes()).decode()


def build_mesh_payload(cache_dir: str | Path) -> dict:
    """Inflated fsaverage5 mesh + per-vertex region info for the 3D viewer.

    Coordinates are RAS millimetres, each hemisphere centred on its own
    centroid; ``offset`` restores the anatomical position for a top view.
    """
    from nilearn import datasets, surface

    fsaverage = datasets.fetch_surf_fsaverage("fsaverage5")
    labels = hcp_vertex_labels(cache_dir)
    rois = roi_indices(labels)

    area_names = sorted({a for a in labels.tolist() if a})
    area_lookup = {name: i for i, name in enumerate(area_names)}
    area_index = np.array([area_lookup.get(a, 255) for a in labels], dtype=np.uint8)

    group_index = np.full(N_VERTICES, 255, dtype=np.uint8)
    for gi, group in enumerate(ROI_GROUPS):
        group_index[rois[group["key"]]] = gi

    hemis = {}
    gap = 6.0
    for hemi, sl in (("left", slice(0, N_PER_HEMI)), ("right", slice(N_PER_HEMI, None))):
        mesh = surface.load_surf_mesh(fsaverage[f"infl_{hemi}"])
        coords = np.asarray(mesh.coordinates, dtype=np.float32)
        faces = np.asarray(mesh.faces, dtype=np.uint16)
        sulc = np.asarray(surface.load_surf_data(fsaverage[f"sulc_{hemi}"]), dtype=np.float32)
        centroid = coords.mean(axis=0)
        centred = coords - centroid
        half_width = np.abs(centred[:, 0]).max()
        offset_x = -(half_width + gap) if hemi == "left" else half_width + gap
        sulc_q = np.round((np.clip(sulc, -2, 2) + 2) / 4 * 255).astype(np.uint8)
        hemis[hemi] = {
            "positions": _b64(centred),
            "faces": _b64(faces),
            "sulc": _b64(sulc_q),
            "area_index": _b64(area_index[sl]),
            "group_index": _b64(group_index[sl]),
            "offset": [float(offset_x), 0.0, 0.0],
            "n_vertices": int(coords.shape[0]),
            "n_faces": int(faces.shape[0]),
        }

    return {
        "mesh": "fsaverage5",
        "n_vertices": N_VERTICES,
        "hemis": hemis,
        "area_names": area_names,
        "groups": [{k: g[k] for k in ("key", "label", "hemi", "areas", "blurb")} for g in ROI_GROUPS],
    }
