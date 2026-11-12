"""Canvas operations for the Electron document schema.

The Electron canvas stores a small, UI-native model:

    { "nodes": [{id, kind, title, status, x, y, width, height, ...}],
      "wires": [{id, from, to}] }

This module is the pure reducer behind ``app_apply_ops`` and the convenience
tools. It deliberately mirrors the operations the live React canvas supports.
"""

from __future__ import annotations

import copy
import math
import secrets
import time
from typing import Any

NODE_SPECS: dict[str, dict[str, Any]] = {
    "image": {"width": 340.0, "height": 240.0, "title": "Image", "tone": "forest-b", "status": "完成"},
    "image-attempt": {"width": 380.0, "height": 380.0, "title": "生成", "tone": "forest-a", "status": "Draft"},
    "image-stack": {"width": 420.0, "height": 320.0, "title": "Image Stack", "tone": "forest-d", "status": "完成"},
    "assets": {"width": 360.0, "height": 320.0, "title": "Assets", "tone": "assets", "status": "0 files"},
    "smart-canvas": {"width": 420.0, "height": 300.0, "title": "Smart Canvas", "tone": "forest-e", "status": "Studio"},
    "svg": {"width": 420.0, "height": 320.0, "title": "SVG", "tone": "forest-c", "status": "完成"},
}

NODE_KINDS = tuple(NODE_SPECS)
NODE_FIELDS = frozenset({"title", "status", "x", "y", "width", "height", "prompt", "svg", "src", "count", "tone"})
VERSION_FIELDS = (
    "prompt",
    "why",
    "model",
    "outputFormat",
    "gifMode",
    "aspect",
    "quality",
    "complexity",
    "frames",
    "frameMs",
    "src",
    "originalSrcId",
    "originalWidth",
    "originalHeight",
    "referenceIds",
    "status",
    "generating",
    "error",
)


def now_id(prefix: str) -> str:
    return f"{prefix}-{int(time.time() * 1000)}-{secrets.token_hex(3)}"


def number(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else fallback
    except (TypeError, ValueError):
        return fallback


def node_spec(kind: str) -> dict[str, Any]:
    return copy.deepcopy(NODE_SPECS.get(kind, NODE_SPECS["image"]))


def find_node(project: dict[str, Any], node_id: str) -> dict[str, Any]:
    for node in project.get("nodes") or []:
        if str(node.get("id")) == node_id:
            return node
    raise ValueError(f"节点不存在：{node_id}")


def find_wire(project: dict[str, Any], wire_id: str) -> dict[str, Any]:
    for wire in project.get("wires") or []:
        if str(wire.get("id")) == wire_id:
            return wire
    raise ValueError(f"连线不存在：{wire_id}")


def _next_x(nodes: list[dict[str, Any]]) -> float:
    if not nodes:
        return 120.0
    return max(number(node.get("x")) + number(node.get("width")) for node in nodes) + 80.0


def _node_from_op(
    op: dict[str, Any],
    nodes: list[dict[str, Any]],
    viewport: dict[str, Any] | None = None,
    stage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    kind = str(op.get("nodeType") or op.get("kind") or "image")
    if kind not in NODE_SPECS:
        raise ValueError(f"不支持的节点类型：{kind}；可用：{', '.join(NODE_KINDS)}")
    spec = node_spec(kind)
    node_id = str(op.get("id") or now_id(kind))
    title = str(op.get("title") or spec["title"])
    position = op.get("position") if isinstance(op.get("position"), dict) else {}
    raw_x = op.get("x", position.get("x"))
    raw_y = op.get("y", position.get("y"))
    width = number(op.get("width"), spec["width"])
    height = number(op.get("height"), spec["height"])
    if raw_x is None or raw_y is None:
        if viewport and stage and number(stage.get("width")) > 0 and number(stage.get("height")) > 0:
            k = max(0.05, number(viewport.get("k"), 1.0))
            center_x = (number(stage.get("width")) / 2 - number(viewport.get("x"))) / k
            center_y = (number(stage.get("height")) / 2 - number(viewport.get("y"))) / k
            cascade = (len(nodes) % 5) * 12
            x = center_x - width / 2 + cascade if raw_x is None else number(raw_x)
            y = center_y - height / 2 + cascade if raw_y is None else number(raw_y)
        else:
            x = _next_x(nodes) if raw_x is None else number(raw_x)
            y = 0.0 if raw_y is None else number(raw_y)
    else:
        x = number(raw_x)
        y = number(raw_y)
    metadata = op.get("metadata") if isinstance(op.get("metadata"), dict) else {}
    node: dict[str, Any] = {
        "id": node_id,
        "kind": kind,
        "title": title,
        "status": str(op.get("status") or metadata.get("status") or spec["status"]),
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "tone": str(op.get("tone") or metadata.get("tone") or spec["tone"]),
    }
    for key in ("prompt", "svg", "src", "count"):
        value = op.get(key, metadata.get(key))
        if value is not None:
            node[key] = value
    _reject_vector_image(node)
    return node


def _reject_vector_image(node: dict[str, Any]) -> None:
    if str(node.get("kind")) == "image" and str(node.get("src") or "").startswith("data:image/svg"):
        raise ValueError("image 节点只接受位图；SVG 请使用 svg 节点")


def _apply_patch(node: dict[str, Any], patch: dict[str, Any]) -> None:
    for key in NODE_FIELDS:
        if key in patch:
            node[key] = copy.deepcopy(patch[key])
    metadata = patch.get("metadata")
    if isinstance(metadata, dict):
        for key in NODE_FIELDS:
            if key in metadata:
                node[key] = copy.deepcopy(metadata[key])
    _reject_vector_image(node)


def sanitize_project(project: dict[str, Any]) -> dict[str, Any]:
    """Drop text nodes and their wires.

    Text nodes were removed from the canvas model; only image generation nodes
    carry prompt content now. Older documents still contain them in storage,
    so every read and write goes through this cleanup.
    """
    nodes = project.get("nodes")
    nodes = nodes if isinstance(nodes, list) else []
    text_ids = {
        str(node.get("id"))
        for node in nodes
        if isinstance(node, dict) and str(node.get("kind")) == "text"
    }
    clean_nodes: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict) or str(node.get("kind")) == "text":
            continue
        node.pop("text", None)
        clean_nodes.append(node)
    wires = project.get("wires")
    project["nodes"] = clean_nodes
    project["wires"] = [
        wire
        for wire in (wires if isinstance(wires, list) else [])
        if isinstance(wire, dict)
        and str(wire.get("from")) not in text_ids
        and str(wire.get("to")) not in text_ids
    ]
    return project


def _delete_nodes(project: dict[str, Any], ids: set[str]) -> None:
    project["nodes"] = [node for node in project.get("nodes") or [] if str(node.get("id")) not in ids]
    project["wires"] = [
        wire for wire in project.get("wires") or []
        if str(wire.get("from")) not in ids and str(wire.get("to")) not in ids
    ]


def _align(nodes: list[dict[str, Any]], ids: set[str], mode: str) -> None:
    selected = [node for node in nodes if str(node.get("id")) in ids]
    if len(selected) < 2:
        return
    left = min(number(node.get("x")) for node in selected)
    right = max(number(node.get("x")) + number(node.get("width")) for node in selected)
    top = min(number(node.get("y")) for node in selected)
    bottom = max(number(node.get("y")) + number(node.get("height")) for node in selected)
    cx = (left + right) / 2
    cy = (top + bottom) / 2
    if mode == "distribute-x":
        ordered = sorted(selected, key=lambda node: number(node.get("x")))
        total = sum(number(node.get("width")) for node in ordered)
        gap = ((right - left) - total) / max(1, len(ordered) - 1)
        cursor = left
        for node in ordered:
            node["x"] = cursor
            cursor += number(node.get("width")) + gap
        return
    if mode == "distribute-y":
        ordered = sorted(selected, key=lambda node: number(node.get("y")))
        total = sum(number(node.get("height")) for node in ordered)
        gap = ((bottom - top) - total) / max(1, len(ordered) - 1)
        cursor = top
        for node in ordered:
            node["y"] = cursor
            cursor += number(node.get("height")) + gap
        return
    for node in selected:
        if mode == "left":
            node["x"] = left
        elif mode == "right":
            node["x"] = right - number(node.get("width"))
        elif mode == "center-x":
            node["x"] = cx - number(node.get("width")) / 2
        elif mode == "top":
            node["y"] = top
        elif mode == "bottom":
            node["y"] = bottom - number(node.get("height"))
        elif mode == "center-y":
            node["y"] = cy - number(node.get("height")) / 2


def _node_versions(node: dict[str, Any]) -> list[dict[str, Any]]:
    versions = node.get("versions")
    if isinstance(versions, list) and versions:
        return versions
    version = {
        "id": f"v1-{node.get('id')}",
        "number": 1,
        "prompt": node.get("prompt") or "",
        "why": node.get("why") or "",
        "model": node.get("model") or "openai/gpt-image-2.6-sunburst",
        "outputFormat": node.get("outputFormat") or "png",
        "gifMode": bool(node.get("gifMode")),
        "aspect": node.get("aspect") or "1:1",
        "quality": node.get("quality") or "medium",
        "complexity": node.get("complexity") or "medium",
        "frames": node.get("frames") or 9,
        "frameMs": node.get("frameMs") or 200,
        "src": node.get("src"),
        "originalSrcId": node.get("originalSrcId"),
        "originalWidth": node.get("originalWidth"),
        "originalHeight": node.get("originalHeight"),
        "referenceIds": list(node.get("referenceIds") or []),
        "status": node.get("status") or "Draft",
        "generating": bool(node.get("generating")),
        "error": node.get("error"),
    }
    node["versions"] = [version]
    node["activeVersion"] = 0
    return [version]


def _sync_node_from_version(node: dict[str, Any], version: dict[str, Any]) -> None:
    for key in VERSION_FIELDS:
        if key in version:
            node[key] = copy.deepcopy(version[key])
    node["version"] = version.get("number")


def _is_locked(version: dict[str, Any]) -> bool:
    return bool(version.get("src")) or str(version.get("status") or "") == "完成"


def _is_gif(src: Any) -> bool:
    value = str(src or "")
    return value.startswith("data:image/gif") or ".gif" in value.lower()


def _connect_reference(project: dict[str, Any], from_id: str, to_id: str) -> str | None:
    source = find_node(project, from_id)
    target = find_node(project, to_id)
    if str(target.get("kind")) != "image-attempt":
        raise ValueError("连线目标必须是生成节点")
    kind = str(source.get("kind"))
    if kind == "image":
        src = source.get("src")
        if not src or _is_gif(src):
            raise ValueError("GIF 或没有图片的节点不能作为参考图")
    elif kind == "svg":
        if not str(source.get("svg") or "").strip():
            raise ValueError("SVG 节点还没有源码，不能作为参考图")
    else:
        raise ValueError("只有 image 或 svg 节点可以作为参考图输出端")
    versions = _node_versions(target)
    latest = versions[-1]
    references = list(latest.get("referenceIds") or [])
    if from_id in references:
        return "该图片已经连接到此生成节点"
    if _is_locked(latest):
        version_number = max((int(version.get("number") or 0) for version in versions), default=0) + 1
        draft = {
            "id": f"v{version_number}-{int(time.time() * 1000)}",
            "number": version_number,
            "prompt": latest.get("prompt") or "",
            "why": latest.get("why") or "",
            "model": latest.get("model") or "openai/gpt-image-2.6-sunburst",
            "outputFormat": latest.get("outputFormat") or "png",
            "gifMode": bool(latest.get("gifMode")),
            "aspect": latest.get("aspect") or "1:1",
            "quality": latest.get("quality") or "medium",
            "complexity": latest.get("complexity") or "medium",
            "frames": latest.get("frames") or 9,
            "frameMs": latest.get("frameMs") or 200,
            "src": None,
            "referenceIds": [*references, from_id],
            "status": "Draft",
            "generating": False,
            "error": None,
        }
        versions.append(draft)
        target["activeVersion"] = len(versions) - 1
        _sync_node_from_version(target, draft)
        return "目标最新版本已完成，已自动创建新的草稿版本并加入参考图"
    latest["referenceIds"] = [*references, from_id]
    target["activeVersion"] = len(versions) - 1
    _sync_node_from_version(target, latest)
    return None


def _disconnect_reference(project: dict[str, Any], from_id: str, to_id: str) -> None:
    target = find_node(project, to_id)
    versions = _node_versions(target)
    changed = False
    for version in versions:
        references = list(version.get("referenceIds") or [])
        filtered = [item for item in references if str(item) != from_id]
        if len(filtered) != len(references):
            version["referenceIds"] = filtered
            prompt = str(version.get("prompt") or "")
            version["prompt"] = prompt.replace(f"[[image:{from_id}]]", "")
            changed = True
    if changed:
        index = min(max(0, int(target.get("activeVersion") or 0)), len(versions) - 1)
        _sync_node_from_version(target, versions[index])


def _extract_image(project: dict[str, Any], node_id: str, title: str | None = None, x: float | None = None, y: float | None = None) -> str:
    source = find_node(project, node_id)
    if str(source.get("kind")) != "image-attempt":
        raise ValueError("只有生成节点可以提取图片")
    versions = _node_versions(source)
    active = min(max(0, int(source.get("activeVersion") or 0)), len(versions) - 1)
    version = next((versions[index] for index in range(active, -1, -1) if versions[index].get("src")), None)
    if not version:
        raise ValueError("生成节点还没有可用图片")
    image_id = now_id("image")
    width = number(source.get("width"), 340)
    height = number(source.get("height"), 240)
    image = {
        "id": image_id,
        "kind": "image",
        "title": title or f"{source.get('title') or '生成'} · Image",
        "status": "完成",
        "x": number(x, number(source.get("x")) + width + 48),
        "y": number(y, number(source.get("y"))),
        "width": width,
        "height": height,
        "tone": source.get("tone") or "forest-b",
        "src": version.get("src"),
    }
    for key in ("originalSrcId", "originalWidth", "originalHeight"):
        if version.get(key) is not None:
            image[key] = version[key]
    project.setdefault("nodes", []).append(image)
    return image_id


def apply_ops(
    project: dict[str, Any],
    ops: list[dict[str, Any]],
    viewport: dict[str, Any] | None = None,
    stage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    sanitize_project(project)
    nodes = project.setdefault("nodes", [])
    wires = project.setdefault("wires", [])
    created: list[str] = []
    selected: list[str] | None = None
    viewport_result: dict[str, Any] | None = None
    warnings: list[str] = []

    for raw in ops:
        if not isinstance(raw, dict):
            warnings.append("忽略非对象 op")
            continue
        op = dict(raw)
        kind = str(op.get("type") or "")
        if kind == "add_node":
            node = _node_from_op(op, nodes, viewport, stage)
            if any(str(item.get("id")) == node["id"] for item in nodes):
                raise ValueError(f"节点 id 已存在：{node['id']}")
            nodes.append(node)
            created.append(node["id"])
        elif kind in {"update_node", "set_node_title", "set_node_prompt", "apply_node_metadata"}:
            node = find_node(project, str(op.get("id") or ""))
            patch = op.get("patch") if isinstance(op.get("patch"), dict) else {}
            if kind == "set_node_title":
                patch = {**patch, "title": op.get("title")}
            if kind == "set_node_prompt":
                patch = {**patch, "prompt": op.get("prompt")}
            if kind == "apply_node_metadata" and isinstance(op.get("metadata"), dict):
                patch = {**patch, "metadata": op["metadata"]}
            _apply_patch(node, patch)
        elif kind in {"move_node", "move_nodes"}:
            ids = [str(item) for item in op.get("ids") or ([op["id"]] if op.get("id") else [])]
            dx = number(op.get("dx"))
            dy = number(op.get("dy"))
            for node in nodes:
                if str(node.get("id")) in ids:
                    node["x"] = number(node.get("x")) + dx
                    node["y"] = number(node.get("y")) + dy
        elif kind == "resize_node":
            node = find_node(project, str(op.get("id") or ""))
            for key in ("x", "y"):
                if op.get(key) is not None:
                    node[key] = number(op.get(key))
            for key in ("width", "height"):
                if op.get(key) is not None:
                    node[key] = max(1.0, number(op.get(key)))
        elif kind == "delete_node":
            ids = {str(item) for item in op.get("ids") or ([op["id"]] if op.get("id") else [])}
            _delete_nodes(project, ids)
        elif kind == "delete_connections":
            ids = {str(item) for item in op.get("ids") or ([op["id"]] if op.get("id") else [])}
            if op.get("all"):
                wires.clear()
            else:
                project["wires"] = [wire for wire in wires if str(wire.get("id")) not in ids]
        elif kind == "connect_nodes":
            warning = _connect_reference(
                project,
                str(op.get("fromNodeId") or op.get("from") or ""),
                str(op.get("toNodeId") or op.get("to") or ""),
            )
            if warning:
                warnings.append(warning)
        elif kind == "disconnect_nodes":
            _disconnect_reference(
                project,
                str(op.get("fromNodeId") or op.get("from") or ""),
                str(op.get("toNodeId") or op.get("to") or ""),
            )
        elif kind == "create_version":
            node = find_node(project, str(op.get("id") or ""))
            versions = _node_versions(node)
            latest = versions[-1]
            if not _is_locked(latest):
                raise ValueError("最新版本还没有锁定，不能新建版本")
            version_number = max((int(version.get("number") or 0) for version in versions), default=0) + 1
            draft = {
                "id": f"v{version_number}-{int(time.time() * 1000)}",
                "number": version_number,
                "prompt": latest.get("prompt") or "",
                "why": latest.get("why") or "",
                "model": latest.get("model") or "openai/gpt-image-2.6-sunburst",
                "outputFormat": latest.get("outputFormat") or "png",
                "gifMode": bool(latest.get("gifMode")),
                "aspect": latest.get("aspect") or "1:1",
                "quality": latest.get("quality") or "medium",
                "complexity": latest.get("complexity") or "medium",
                "frames": latest.get("frames") or 9,
                "frameMs": latest.get("frameMs") or 200,
                "src": None,
                "referenceIds": list(latest.get("referenceIds") or []),
                "status": "Draft",
                "generating": False,
                "error": None,
            }
            versions.append(draft)
            node["activeVersion"] = len(versions) - 1
            _sync_node_from_version(node, draft)
        elif kind == "update_version":
            node = find_node(project, str(op.get("id") or ""))
            versions = _node_versions(node)
            version_id = str(op.get("versionId") or "")
            index = next((i for i, version in enumerate(versions) if str(version.get("id")) == version_id), len(versions) - 1)
            version = versions[index]
            patch = op.get("patch") if isinstance(op.get("patch"), dict) else {}
            for key in VERSION_FIELDS:
                if key in patch:
                    version[key] = copy.deepcopy(patch[key])
            node["activeVersion"] = index
            _sync_node_from_version(node, version)
        elif kind == "extract_image":
            image_id = _extract_image(project, str(op.get("id") or ""), op.get("title"), op.get("x"), op.get("y"))
            created.append(image_id)
        elif kind == "select_nodes":
            selected = [str(item) for item in op.get("ids") or [] if any(str(node.get("id")) == str(item) for node in nodes)]
        elif kind == "deselect_all":
            selected = []
        elif kind == "duplicate_node":
            source = find_node(project, str(op.get("id") or ""))
            clone = copy.deepcopy(source)
            clone["id"] = now_id(str(source.get("kind") or "image"))
            clone["x"] = number(source.get("x")) + 24
            clone["y"] = number(source.get("y")) + 24
            clone["title"] = f"{source.get('title') or 'Node'} copy"
            nodes.append(clone)
            created.append(clone["id"])
        elif kind == "align_nodes":
            ids = {str(item) for item in op.get("ids") or ([op["id"]] if op.get("id") else [])}
            _align(nodes, ids, str(op.get("mode") or "left"))
        elif kind == "rename_nodes":
            ids = [str(item) for item in op.get("ids") or []]
            base = str(op.get("title") or op.get("name") or "Node")
            for index, node in enumerate([item for item in nodes if str(item.get("id")) in ids], start=1):
                node["title"] = f"{base} {index}" if len(ids) > 1 else base
        elif kind in {"set_viewport", "set_zoom"}:
            viewport_result = {
                "x": number(op.get("x")),
                "y": number(op.get("y")),
                "k": max(0.05, min(5.0, number(op.get("k"), 1.0))),
            }
        else:
            warnings.append(f"当前 Electron 画布不支持 op：{kind}")
    return {
        "createdIds": created,
        "selected": selected,
        "viewport": viewport_result,
        "warnings": warnings,
    }
