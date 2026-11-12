"""Local AI service for OpenCanvas Image Studio.

Runs entirely on this machine. The Electron main process starts this process
and talks to it over loopback. No cloud APIs are used.

Endpoints:
  GET  /health
  POST /v1/cutout   { image: dataURL } -> { foreground, mask }
  POST /v1/pbr      { image: dataURL, normalConvention, tileable } -> maps
  POST /v1/spine    { image: dataURL, resolution } -> parts
"""

from __future__ import annotations

import base64
import gc
import hashlib
import io
import json
import math
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image

ROOT = Path(__file__).resolve().parent
VENDOR = ROOT / "vendor" / "see-through"
WORKSPACE = ROOT / "workspace"
WORKSPACE.mkdir(exist_ok=True)

# All model weights live under the app root (or OC_MODEL_DIR for development).
MODEL_ROOT = Path(os.environ.get("OC_MODEL_DIR") or (ROOT.parent / "model")).resolve()
HF_HOME = MODEL_ROOT / "huggingface"
HF_HUB_CACHE = HF_HOME / "hub"
TORCH_HOME = MODEL_ROOT / "torch"
for _path in (MODEL_ROOT, HF_HOME, HF_HUB_CACHE, TORCH_HOME):
    _path.mkdir(parents=True, exist_ok=True)
os.environ["HF_HOME"] = str(HF_HOME)
os.environ["HF_HUB_CACHE"] = str(HF_HUB_CACHE)
os.environ["TRANSFORMERS_CACHE"] = str(HF_HUB_CACHE)
os.environ["TORCH_HOME"] = str(TORCH_HOME)

app = FastAPI(title="OpenCanvas Local AI", version="0.2.0")

_birefnet = None
_depth_pipe = None
_model_lock = threading.Lock()
_downloads: dict[str, dict[str, Any]] = {}
_remote_sizes: dict[str, int] = {}

MODEL_SPECS: dict[str, dict[str, Any]] = {
    "birefnet": {
        "name": "BiRefNet",
        "purpose": "Cutout 去背景",
        "repo": "ZhengPeng7/BiRefNet",
        "loadable": True,
    },
    "depth-anything-v2-small": {
        "name": "Depth Anything V2 Small",
        "purpose": "PBR 材质通道",
        "repo": "depth-anything/Depth-Anything-V2-Small-hf",
        "loadable": True,
    },
    "seethrough-layerdiff3d": {
        "name": "See-through LayerDiff3D",
        "purpose": "Segment 拆件（主体）",
        "repo": "layerdifforg/seethroughv0.0.2_layerdiff3d",
        "loadable": False,
    },
    "seethrough-marigold": {
        "name": "See-through Marigold Depth",
        "purpose": "Segment 拆件（深度）",
        "repo": "24yearsold/seethroughv0.0.1_marigold",
        "loadable": False,
    },
}


def _model_env() -> dict[str, str]:
    return {
        **os.environ,
        "HF_HOME": str(HF_HOME),
        "HF_HUB_CACHE": str(HF_HUB_CACHE),
        "TRANSFORMERS_CACHE": str(HF_HUB_CACHE),
        "TORCH_HOME": str(TORCH_HOME),
    }


def _repo_dir(repo: str) -> Path:
    return HF_HUB_CACHE / f"models--{repo.replace('/', '--')}"


def _dir_size(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    for item in path.rglob("*"):
        try:
            if item.is_file():
                total += item.stat().st_size
        except OSError:
            continue
    return total


def _is_downloading(model_id: str) -> bool:
    with _model_lock:
        return _downloads.get(model_id, {}).get("status") == "downloading"


def _installed(model_id: str) -> bool:
    spec = MODEL_SPECS.get(model_id)
    if not spec:
        return False
    repo_dir = _repo_dir(spec["repo"])
    snapshots = repo_dir / "snapshots"
    return (
        repo_dir.exists()
        and snapshots.exists()
        and any(snapshots.iterdir())
        and not _is_downloading(model_id)
    )


def _remote_size(model_id: str) -> int:
    spec = MODEL_SPECS[model_id]
    if model_id in _remote_sizes:
        return _remote_sizes[model_id]
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(spec["repo"], files_metadata=True)
        size = sum(int(getattr(sibling, "size", 0) or 0) for sibling in (info.siblings or []))
        _remote_sizes[model_id] = size
        return size
    except Exception:
        _remote_sizes[model_id] = 0
        return 0


def _model_payload(model_id: str) -> dict[str, Any]:
    spec = MODEL_SPECS[model_id]
    installed = _installed(model_id)
    size = _dir_size(_repo_dir(spec["repo"])) if installed else _remote_size(model_id)
    loaded = False
    if model_id == "birefnet":
        loaded = _birefnet is not None
    elif model_id == "depth-anything-v2-small":
        loaded = _depth_pipe is not None
    with _model_lock:
        download = dict(_downloads.get(model_id) or {})
    return {
        "id": model_id,
        "name": spec["name"],
        "purpose": spec["purpose"],
        "repo": spec["repo"],
        "loadable": bool(spec["loadable"]),
        "installed": installed,
        "loaded": loaded,
        "sizeBytes": size,
        "download": download or None,
    }


def _require_installed(model_ids: list[str]) -> None:
    missing = [model_id for model_id in model_ids if not _installed(model_id)]
    if missing:
        names = "、".join(MODEL_SPECS[model_id]["name"] for model_id in missing)
        raise HTTPException(
            status_code=409,
            detail=f"模型未下载：{names}。请到 Settings → Local Models 下载。",
        )


def data_url_to_image(value: str) -> Image.Image:
    if "," in value:
        value = value.split(",", 1)[1]
    raw = base64.b64decode(value)
    return Image.open(io.BytesIO(raw)).convert("RGBA")


def image_to_data_url(image: Image.Image, fmt: str = "PNG") -> str:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def png_data_url(array: np.ndarray) -> str:
    ok, encoded = cv2.imencode(".png", array)
    if not ok:
        raise RuntimeError("PNG encode failed")
    return "data:image/png;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")


def png_data_url_rgb(array: np.ndarray) -> str:
    """Encode an RGB/RGBA array; cv2 expects BGR/BGRA channel order."""
    if array.ndim == 3 and array.shape[2] == 4:
        array = cv2.cvtColor(array, cv2.COLOR_RGBA2BGRA)
    elif array.ndim == 3 and array.shape[2] == 3:
        array = cv2.cvtColor(array, cv2.COLOR_RGB2BGR)
    return png_data_url(array)


def get_birefnet():
    global _birefnet
    if _birefnet is None:
        import torch
        from transformers import AutoModelForImageSegmentation

        model = AutoModelForImageSegmentation.from_pretrained(
            "ZhengPeng7/BiRefNet", trust_remote_code=True
        )
        model.eval()
        if torch.cuda.is_available():
            model = model.half().cuda()
        _birefnet = model
    return _birefnet


def get_depth_pipe():
    global _depth_pipe
    if _depth_pipe is None:
        from transformers import pipeline
        import torch

        device = 0 if torch.cuda.is_available() else -1
        _depth_pipe = pipeline(
            "depth-estimation",
            model="depth-anything/Depth-Anything-V2-Small-hf",
            device=device,
        )
    return _depth_pipe


class ImageRequest(BaseModel):
    image: str


class PBRRequest(ImageRequest):
    normalConvention: str = "opengl"
    tileable: bool = False


class SpineRequest(ImageRequest):
    resolution: int = 1024
    resolutionDepth: int = 720


class UpscaleRequest(ImageRequest):
    scale: int = 2
    targetLongEdge: int = 0
    method: str = "lanczos"


class AngleRequest(ImageRequest):
    yaw: float = 0
    pitch: float = 0
    zoom: float = 1


@app.get("/health")
def health() -> dict[str, Any]:
    import torch

    return {
        "ok": True,
        "gpu": torch.cuda.is_available(),
        "gpuName": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "",
        "birefnetLoaded": _birefnet is not None,
        "depthLoaded": _depth_pipe is not None,
        "seeThrough": (VENDOR / "inference" / "scripts" / "inference_psd_blockswap.py").exists(),
        "modelsRoot": str(MODEL_ROOT),
        "hfCache": str(HF_HUB_CACHE),
    }


@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    return {
        "ok": True,
        "modelsRoot": str(MODEL_ROOT),
        "hfCache": str(HF_HUB_CACHE),
        "models": [_model_payload(model_id) for model_id in MODEL_SPECS],
    }


@app.get("/v1/system")
def system_status() -> dict[str, Any]:
    import psutil
    import torch

    memory = psutil.virtual_memory()
    process = psutil.Process()
    gpu: dict[str, Any] = {"available": False}
    if torch.cuda.is_available():
        try:
            free, total = torch.cuda.mem_get_info()
            gpu = {
                "available": True,
                "name": torch.cuda.get_device_name(0),
                "totalBytes": int(total),
                "usedBytes": int(total - free),
                "allocatedBytes": int(torch.cuda.memory_allocated()),
                "reservedBytes": int(torch.cuda.memory_reserved()),
            }
        except Exception as error:
            gpu = {"available": False, "error": str(error)}
    return {
        "ok": True,
        "gpu": gpu,
        "ram": {
            "totalBytes": int(memory.total),
            "usedBytes": int(memory.total - memory.available),
            "availableBytes": int(memory.available),
            "percent": float(memory.percent),
        },
        "process": {
            "rssBytes": int(process.memory_info().rss),
            "pid": int(process.pid),
        },
        "modelsRoot": str(MODEL_ROOT),
        "hfCache": str(HF_HUB_CACHE),
    }


@app.post("/v1/models/{model_id}/download")
def download_model(model_id: str) -> dict[str, Any]:
    spec = MODEL_SPECS.get(model_id)
    if not spec:
        raise HTTPException(status_code=404, detail="未知模型")
    with _model_lock:
        if _downloads.get(model_id, {}).get("status") == "downloading":
            return {"ok": True, "model": _model_payload(model_id)}
        _downloads[model_id] = {"status": "downloading", "downloaded": 0, "total": _remote_size(model_id), "error": None}

    def worker() -> None:
        repo = str(spec["repo"])
        repo_dir = _repo_dir(repo)
        stop = threading.Event()

        def monitor() -> None:
            while not stop.wait(1.0):
                with _model_lock:
                    state = _downloads.get(model_id)
                    if state and state.get("status") == "downloading":
                        state["downloaded"] = _dir_size(repo_dir)

        monitor_thread = threading.Thread(target=monitor, daemon=True)
        monitor_thread.start()
        try:
            from huggingface_hub import snapshot_download

            snapshot_download(repo_id=repo, cache_dir=str(HF_HUB_CACHE), resume_download=True)
            with _model_lock:
                _downloads[model_id] = {
                    "status": "done",
                    "downloaded": _dir_size(repo_dir),
                    "total": _dir_size(repo_dir),
                    "error": None,
                }
        except Exception as error:
            with _model_lock:
                _downloads[model_id] = {
                    "status": "error",
                    "downloaded": _dir_size(repo_dir),
                    "total": _remote_size(model_id),
                    "error": str(error),
                }
        finally:
            stop.set()

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True, "model": _model_payload(model_id)}


@app.post("/v1/models/{model_id}/load")
def load_model(model_id: str) -> dict[str, Any]:
    if model_id not in MODEL_SPECS:
        raise HTTPException(status_code=404, detail="未知模型")
    if not _installed(model_id):
        _require_installed([model_id])
    if model_id == "birefnet":
        get_birefnet()
    elif model_id == "depth-anything-v2-small":
        get_depth_pipe()
    else:
        return {
            "ok": True,
            "model": _model_payload(model_id),
            "note": "See-through 在每次拆件时启动子进程，不常驻显存。",
        }
    return {"ok": True, "model": _model_payload(model_id)}


@app.post("/v1/models/{model_id}/unload")
def unload_model(model_id: str) -> dict[str, Any]:
    global _birefnet, _depth_pipe
    if model_id not in MODEL_SPECS:
        raise HTTPException(status_code=404, detail="未知模型")
    if model_id == "birefnet":
        _birefnet = None
    elif model_id == "depth-anything-v2-small":
        _depth_pipe = None
    else:
        return {
            "ok": True,
            "model": _model_payload(model_id),
            "note": "See-through 不常驻显存。",
        }
    gc.collect()
    import torch

    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return {"ok": True, "model": _model_payload(model_id)}


@app.delete("/v1/models/{model_id}")
def delete_model(model_id: str) -> dict[str, Any]:
    spec = MODEL_SPECS.get(model_id)
    if not spec:
        raise HTTPException(status_code=404, detail="未知模型")
    unload_model(model_id)
    repo_dir = _repo_dir(str(spec["repo"]))
    if repo_dir.exists():
        shutil.rmtree(repo_dir, ignore_errors=True)
    with _model_lock:
        _downloads.pop(model_id, None)
    _remote_sizes.pop(model_id, None)
    return {"ok": True, "deleted": model_id, "model": _model_payload(model_id)}


@app.post("/v1/cutout")
def cutout(request: ImageRequest) -> dict[str, Any]:
    _require_installed(["birefnet"])
    try:
        import torch
        from torchvision import transforms

        image = data_url_to_image(request.image)
        # BiRefNet expects RGB; flatten transparency onto white instead of black.
        flattened = Image.new("RGB", image.size, (255, 255, 255))
        flattened.paste(image, mask=image.split()[3])
        model = get_birefnet()
        transform = transforms.Compose(
            [
                transforms.Resize((1024, 1024)),
                transforms.ToTensor(),
                transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
            ]
        )
        tensor = transform(flattened).unsqueeze(0)
        if torch.cuda.is_available():
            tensor = tensor.half().cuda()
        with torch.no_grad():
            prediction = model(tensor)[-1].sigmoid().cpu()[0].squeeze()
        mask = transforms.ToPILImage()(prediction).resize(image.size, Image.Resampling.BILINEAR)
        mask_arr = np.array(mask)
        mask_arr = np.clip(mask_arr, 0, 255).astype(np.uint8)
        rgba = np.array(image.convert("RGBA"))
        rgba[..., 3] = mask_arr
        foreground = Image.fromarray(rgba)
        return {
            "ok": True,
            "foreground": image_to_data_url(foreground),
            "mask": png_data_url(cv2.cvtColor(mask_arr, cv2.COLOR_GRAY2BGRA)),
        }
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Cutout failed: {exc}") from exc


def _normalize_depth(depth: Image.Image, size: tuple[int, int]) -> np.ndarray:
    arr = np.array(depth.resize(size, Image.Resampling.BICUBIC), dtype=np.float32)
    arr = arr - arr.min()
    arr = arr / max(1e-6, arr.max())
    return arr


def _sobel_normal(height: np.ndarray, strength: float = 2.0, convention: str = "opengl") -> np.ndarray:
    h = height.astype(np.float32)
    dx = cv2.Sobel(h, cv2.CV_32F, 1, 0, ksize=3) * strength
    dy = cv2.Sobel(h, cv2.CV_32F, 0, 1, ksize=3) * strength
    nx = -dx
    ny = -dy
    nz = np.ones_like(h)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    nx /= length
    ny /= length
    nz /= length
    if convention == "directx":
        ny = -ny
    normal = np.stack([(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255], axis=-1)
    return np.clip(normal, 0, 255).astype(np.uint8)


def _seamless_blend(image: np.ndarray, band: int = 24) -> np.ndarray:
    """Small edge-wrap blend so the result is less obviously cut at the border."""
    h, w = image.shape[:2]
    band = max(1, min(band, h // 2, w // 2))
    out = image.copy()
    left = image[:, :band].astype(np.float32)
    right = image[:, w - band :].astype(np.float32)
    for i in range(band):
        t = i / max(1, band - 1)
        out[:, i] = (left[:, i] * (1 - t) + right[:, band - 1 - i] * t).astype(np.uint8)
    top = image[:band, :].astype(np.float32)
    bottom = image[h - band :, :].astype(np.float32)
    for i in range(band):
        t = i / max(1, band - 1)
        out[i, :] = (top[i, :] * (1 - t) + bottom[band - 1 - i, :] * t).astype(np.uint8)
    return out


def _fit_part_to_source(arr: np.ndarray, src_w: int, src_h: int) -> np.ndarray:
    """See-through pads its square output; map the content back to the source aspect."""
    out_h, out_w = arr.shape[:2]
    src_ratio = src_w / max(1, src_h)
    out_ratio = out_w / max(1, out_h)
    if out_ratio > src_ratio:
        content_h = out_h
        content_w = int(round(out_h * src_ratio))
        x0 = (out_w - content_w) // 2
        y0 = 0
    else:
        content_w = out_w
        content_h = int(round(out_w / src_ratio))
        x0 = 0
        y0 = (out_h - content_h) // 2
    cropped = arr[y0 : y0 + content_h, x0 : x0 + content_w]
    return cv2.resize(cropped, (src_w, src_h), interpolation=cv2.INTER_LANCZOS4)


def _part_bounds(arr: np.ndarray) -> dict[str, int] | None:
    alpha = arr[..., 3]
    ys, xs = np.where(alpha > 8)
    if len(xs) == 0:
        return None
    return {
        "x": int(xs.min()),
        "y": int(ys.min()),
        "width": int(xs.max() - xs.min() + 1),
        "height": int(ys.max() - ys.min() + 1),
    }


@app.post("/v1/pbr")
def pbr(request: PBRRequest) -> dict[str, Any]:
    _require_installed(["depth-anything-v2-small"])
    try:
        source = data_url_to_image(request.image)
        full = np.array(source)
        h, w = full.shape[:2]
        alpha = full[..., 3]
        ys, xs = np.where(alpha > 8)
        if len(xs):
            x0, x1 = int(xs.min()), int(xs.max()) + 1
            y0, y1 = int(ys.min()), int(ys.max()) + 1
        else:
            x0, y0, x1, y1 = 0, 0, w, h
        crop = full[y0:y1, x0:x1]
        crop_alpha = crop[..., 3]
        rgb = np.ascontiguousarray(crop[..., :3])
        ch, cw = rgb.shape[:2]
        crop_image = Image.fromarray(rgb, mode="RGB")

        # Delighting: remove large-scale illumination from the albedo estimate.
        float_rgb = rgb.astype(np.float32) / 255.0
        illumination = cv2.GaussianBlur(float_rgb, (0, 0), sigmaX=max(8, min(ch, cw) / 18))
        illumination = np.maximum(illumination, 0.6)
        albedo = np.clip(float_rgb / illumination, 0, 1)
        albedo_u8 = (albedo * 255).astype(np.uint8)

        # Height: monocular depth with a luminance-detail fallback.
        try:
            depth_result = get_depth_pipe()(crop_image)
            height = _normalize_depth(depth_result["depth"], (cw, ch))
        except Exception:
            lum = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
            height = cv2.GaussianBlur(lum, (0, 0), 1.2)
        height_u8 = (np.clip(height, 0, 1) * 255).astype(np.uint8)

        normal = _sobel_normal(height, 2.2, request.normalConvention)

        # AO from local height valleys; roughness from local contrast.
        height_blur = cv2.GaussianBlur(height, (0, 0), max(1.5, min(ch, cw) / 180))
        ao = np.clip(0.55 + (height - height_blur) * 2.4, 0.25, 1.0)
        ao_u8 = (ao * 255).astype(np.uint8)
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
        local_var = cv2.GaussianBlur((gray - cv2.GaussianBlur(gray, (0, 0), 3)) ** 2, (0, 0), 5)
        roughness = np.clip(0.28 + np.sqrt(np.maximum(local_var, 0)) * 2.2, 0.12, 0.95)
        rough_u8 = (roughness * 255).astype(np.uint8)
        hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
        metallic = np.clip((hsv[..., 1] < 40) * (hsv[..., 2] > 150) * 0.65, 0, 1)
        metal_u8 = (metallic * 255).astype(np.uint8)

        if request.tileable:
            albedo_u8 = _seamless_blend(albedo_u8)
            height_u8 = _seamless_blend(height_u8)
            normal = _seamless_blend(normal)
            ao_u8 = _seamless_blend(ao_u8)
            rough_u8 = _seamless_blend(rough_u8)
            metal_u8 = _seamless_blend(metal_u8)

        def place_rgb(map_u8: np.ndarray) -> np.ndarray:
            out = np.zeros((h, w, 4), dtype=np.uint8)
            out[y0:y1, x0:x1, :3] = map_u8
            out[y0:y1, x0:x1, 3] = crop_alpha
            return out

        def place_gray(map_u8: np.ndarray) -> np.ndarray:
            out = np.zeros((h, w, 4), dtype=np.uint8)
            out[y0:y1, x0:x1, 0] = map_u8
            out[y0:y1, x0:x1, 1] = map_u8
            out[y0:y1, x0:x1, 2] = map_u8
            out[y0:y1, x0:x1, 3] = crop_alpha
            return out

        return {
            "ok": True,
            "maps": {
                "baseColor": png_data_url_rgb(place_rgb(albedo_u8)),
                "height": png_data_url_rgb(place_gray(height_u8)),
                "normal": png_data_url_rgb(place_rgb(normal)),
                "roughness": png_data_url_rgb(place_gray(rough_u8)),
                "metallic": png_data_url_rgb(place_gray(metal_u8)),
                "ao": png_data_url_rgb(place_gray(ao_u8)),
            },
            "normalConvention": request.normalConvention,
            "tileable": request.tileable,
            "size": {"width": w, "height": h},
        }
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"PBR failed: {exc}") from exc


@app.post("/v1/upscale")
def upscale(request: UpscaleRequest) -> dict[str, Any]:
    try:
        from PIL import ImageFilter

        image = data_url_to_image(request.image).convert("RGBA")
        width, height = image.size
        method = (request.method or "lanczos").lower()
        if method not in {"lanczos", "bicubic", "bilinear", "nearest"}:
            method = "lanczos"
        if request.targetLongEdge and request.targetLongEdge > 0:
            scale = float(request.targetLongEdge) / max(1, max(width, height))
        else:
            scale = float(max(1, min(8, int(request.scale))))
        max_dim = 8192
        scale = min(scale, max_dim / max(1, max(width, height)))
        scale = max(0.05, scale)
        out_width = max(1, round(width * scale))
        out_height = max(1, round(height * scale))
        resampling = {
            "lanczos": Image.Resampling.LANCZOS,
            "bicubic": Image.Resampling.BICUBIC,
            "bilinear": Image.Resampling.BILINEAR,
            "nearest": Image.Resampling.NEAREST,
        }[method]
        result = image.resize((out_width, out_height), resampling)
        if method in {"lanczos", "bicubic"}:
            result = result.filter(ImageFilter.UnsharpMask(radius=1.2, percent=70, threshold=2))
        return {
            "ok": True,
            "image": image_to_data_url(result),
            "width": result.width,
            "height": result.height,
            "scale": round(scale, 4),
            "method": method,
        }
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Upscale failed: {exc}") from exc


@app.post("/v1/angle")
def angle(request: AngleRequest) -> dict[str, Any]:
    try:
        image = data_url_to_image(request.image).convert("RGBA")
        width, height = image.size
        rgba = np.array(image)
        bgra = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA)
        yaw = math.tan(math.radians(max(-60.0, min(60.0, request.yaw)))) * 0.35
        pitch = math.tan(math.radians(max(-45.0, min(45.0, request.pitch)))) * 0.35
        zoom = max(0.5, min(2.0, request.zoom))
        dst = np.float32([
            [width * (0.0 + pitch * 0.15), height * (0.0 + yaw * 0.15)],
            [width * (1.0 - pitch * 0.15), height * (0.0 - yaw * 0.15)],
            [width * (1.0 + pitch * 0.15), height * (1.0 - yaw * 0.15)],
            [width * (0.0 - pitch * 0.15), height * (1.0 + yaw * 0.15)],
        ])
        center = np.float32([width / 2, height / 2])
        dst = (dst - center) / zoom + center
        src = np.float32([[0, 0], [width, 0], [width, height], [0, height]])
        matrix = cv2.getPerspectiveTransform(src, dst)
        warped = cv2.warpPerspective(
            bgra,
            matrix,
            (width, height),
            flags=cv2.INTER_LANCZOS4,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(0, 0, 0, 0),
        )
        return {
            "ok": True,
            "image": png_data_url(warped),
            "width": width,
            "height": height,
        }
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Angle failed: {exc}") from exc


@app.post("/v1/spine")
def spine(request: SpineRequest) -> dict[str, Any]:
    _require_installed(["seethrough-layerdiff3d", "seethrough-marigold"])
    try:
        if not (VENDOR / "inference" / "scripts" / "inference_psd_blockswap.py").exists():
            raise RuntimeError("See-through vendor files are missing")
        image = data_url_to_image(request.image).convert("RGBA")
        resolution = max(512, min(1536, request.resolution))
        resolution_depth = max(512, min(1024, request.resolutionDepth))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        raw = buffer.getvalue()
        cache_key = hashlib.sha256(
            raw + f"|{resolution}|{resolution_depth}|blockswap".encode("ascii")
        ).hexdigest()[:24]
        cache_dir = WORKSPACE / "spine-cache" / cache_key
        result_file = cache_dir / "result.json"
        if result_file.exists():
            cached = json.loads(result_file.read_text(encoding="utf-8"))
            if cached.get("version") != 2:
                for part in cached.get("parts", []):
                    try:
                        raw_part = base64.b64decode(part["png"].split(",", 1)[1])
                        arr = cv2.imdecode(np.frombuffer(raw_part, np.uint8), cv2.IMREAD_UNCHANGED)
                        if arr is None or arr.shape[2] < 4:
                            continue
                        arr = _fit_part_to_source(arr, image.width, image.height)
                        bounds = _part_bounds(arr)
                        if bounds is None:
                            continue
                        part["png"] = png_data_url(arr)
                        part["bounds"] = bounds
                    except Exception:
                        continue
                cached["version"] = 2
                cache_dir.mkdir(parents=True, exist_ok=True)
                result_file.write_text(json.dumps(cached, ensure_ascii=False), encoding="utf-8")
            cached["cached"] = True
            cached["elapsed"] = 0.0
            return cached
        job_id = uuid.uuid4().hex[:12]
        job_dir = WORKSPACE / "spine" / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        source = job_dir / "input.png"
        source.write_bytes(raw)
        output_dir = job_dir / "out"
        output_dir.mkdir(exist_ok=True)
        command = [
            str(ROOT / ".venv" / "Scripts" / "python.exe"),
            "inference/scripts/inference_psd_blockswap.py",
            "--srcp",
            str(source),
            "--save_to_psd",
            "--resolution",
            str(resolution),
            "--resolution_depth",
            str(resolution_depth),
            "--save_dir",
            str(output_dir),
        ]
        started = time.time()
        process = subprocess.run(
            command,
            cwd=str(VENDOR),
            capture_output=True,
            text=True,
            timeout=1800,
            env=_model_env(),
        )
        if process.returncode != 0:
            detail = (process.stderr or process.stdout or "See-through failed").strip()
            lines = [line for line in detail.splitlines() if line.strip()]
            raise RuntimeError("\n".join(lines[-4:])[-1200:])
        part_dir = output_dir / "input"
        if not part_dir.exists():
            candidates = [path for path in output_dir.iterdir() if path.is_dir()]
            if not candidates:
                raise RuntimeError("See-through produced no part directory")
            part_dir = candidates[0]
        parts = []
        part_files = {
            path.stem: path
            for path in sorted(part_dir.glob("*.png"))
            if not path.stem.endswith("_depth")
            and not path.stem.startswith("src_")
            and path.stem != "reconstruction"
        }
        order: list[str] = []
        psd_path = part_dir.parent / f"{source.stem}.psd"
        if psd_path.exists():
            try:
                from psd_tools import PSDImage

                psd = PSDImage.open(psd_path)
                order = [layer.name for layer in psd]
                order.reverse()
            except Exception:
                order = []
        if not order:
            info_path = part_dir / "info.json"
            if info_path.exists():
                try:
                    info = json.loads(info_path.read_text(encoding="utf-8"))
                    order = list(info.get("parts", {}).keys())
                except Exception:
                    order = []
        ordered_names = [name for name in order if name in part_files]
        ordered_names += [name for name in part_files if name not in ordered_names]
        for name in ordered_names:
            path = part_files[name]
            arr = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
            if arr is None or arr.shape[2] < 4:
                continue
            arr = _fit_part_to_source(arr, image.width, image.height)
            bounds = _part_bounds(arr)
            if bounds is None:
                continue
            parts.append({
                "name": name,
                "png": png_data_url(arr),
                "bounds": bounds,
            })
        payload = {
            "ok": True,
            "version": 2,
            "parts": parts,
            "partCount": len(parts),
            "elapsed": round(time.time() - started, 1),
            "cached": False,
        }
        cache_dir.mkdir(parents=True, exist_ok=True)
        result_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return payload
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="See-through timed out") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Spine split failed: {exc}") from exc
