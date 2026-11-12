"""MCP tool surface for the live OpenCanvas canvas.

The Electron app is the source of truth. Every tool reads or writes the live
React document through ``window.openCanvasAgent``; changes are mirrored into
IndexedDB by the renderer, so reopening a canvas sees the same document.

The public tool surface is intentionally grouped:

    app_*                    discovery, batch ops, screenshots
    canvas_list_projects     library/project discovery
    canvas_manage_project    create / rename / delete canvases
    canvas_manage_library    create / rename / delete groups
    canvas_get_*             inspect project or one node
    canvas_create_node       create any node type, or duplicate a node
    canvas_update_nodes      patch one or many nodes
    canvas_delete_nodes      delete nodes
    canvas_arrange_nodes     move / resize / align / distribute / duplicate
    canvas_manage_generation references, versions, extract image
    canvas_set_view          selection, deselect, viewport
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

from mcp import types
from mcp.server.mcpserver import MCPServer

from . import bridge, canvas_ops

_INSTRUCTIONS = Path(__file__).with_name("instructions.md").read_text(encoding="utf-8")
SERVER_VERSION = "0.3.0"

server = MCPServer(
    "opencanvas",
    version=SERVER_VERSION,
    instructions=_INSTRUCTIONS,
)

OP_DESCRIPTIONS: dict[str, str] = {
    "add_node": "创建节点；nodeType 为 image/image-attempt/image-stack/assets/smart-canvas/svg，x/y 为左上角坐标。",
    "update_node": "更新节点字段；patch 支持 title/status/x/y/width/height/prompt/svg/src/count/tone。",
    "move_node": "按 dx/dy 移动一个节点。",
    "move_nodes": "按 dx/dy 批量移动节点。",
    "resize_node": "设置节点宽高与可选位置。",
    "delete_node": "删除节点及相关连线。",
    "delete_connections": "删除连线；支持 ids、id 或 all。",
    "connect_nodes": "把 image 节点连接到生成节点左侧输入：写入 referenceIds，必要时自动创建新的草稿版本。",
    "disconnect_nodes": "断开 image 节点与生成节点的参考关系。",
    "create_version": "在最新版本已锁定时创建新的草稿版本。",
    "update_version": "更新生成节点某个版本的字段；省略 versionId 时更新最新版本。",
    "extract_image": "把生成节点的当前图片提取为右侧 image 节点（Add as Image）。",
    "select_nodes": "设置当前画布选中节点。",
    "deselect_all": "清空选中。",
    "duplicate_node": "复制节点（默认右下偏移 24）。",
    "align_nodes": "对齐/分布：left/right/center-x/top/bottom/center-y/distribute-x/distribute-y。",
    "rename_nodes": "批量重命名节点。",
    "set_node_title": "设置节点标题。",
    "set_node_prompt": "写入 Image Attempt 的提示词。",
    "apply_node_metadata": "把 metadata 中的 UI 字段合并到节点。",
    "set_viewport": "设置画布视口 {x,y,k}，k 限制在 0.05..5。",
    "set_zoom": "只调整视口缩放。",
}

AVAILABLE_ACTIONS = [
    {
        "ns": "canvas",
        "title": "画布",
        "description": "OpenCanvas 画布的节点、参考图、版本、选中与视口操作。",
        "ops": [{"type": name, "description": description} for name, description in OP_DESCRIPTIONS.items()],
    }
]


def _state() -> dict[str, Any]:
    return bridge.state()


def _project(project_id: str) -> dict[str, Any]:
    return canvas_ops.sanitize_project(bridge.get_project(project_id))


def _target(project_id: str | None) -> str:
    if project_id:
        return project_id
    state = _state()
    target = state.get("openCanvasId")
    if not target:
        raise ValueError("没有打开的画布；请提供 projectId")
    return str(target)


def _commit(project_id: str, project: dict[str, Any], result: dict[str, Any]) -> None:
    bridge.put_project(project_id, canvas_ops.sanitize_project(project))
    if result.get("selected") is not None:
        bridge.agent("selectNodes", list(result["selected"]))
    if result.get("viewport") is not None:
        bridge.agent("setViewport", result["viewport"])


def _apply(project_id: str, ops: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    project = _project(project_id)
    state = _state()
    result = canvas_ops.apply_ops(
        project,
        ops,
        viewport=state.get("viewport") if isinstance(state.get("viewport"), dict) else None,
        stage=state.get("stageSize") if isinstance(state.get("stageSize"), dict) else None,
    )
    _commit(project_id, project, result)
    return project, result


def _node(project: dict[str, Any], node_id: str) -> dict[str, Any]:
    return canvas_ops.find_node(project, node_id)


def _groups() -> list[dict[str, Any]]:
    return list(bridge.library().get("groups") or [])


def _ensure_group(library_id: str | None) -> str:
    if library_id:
        if not any(str(group.get("id")) == library_id for group in _groups()):
            raise ValueError(f"库分组不存在：{library_id}")
        return library_id
    groups = _groups()
    if groups:
        return str(groups[0]["id"])
    group = bridge.agent("createGroup", "Project 1")
    return str(group["id"])


def _ids(id: str | None, ids: list[str] | None) -> list[str]:
    result = [str(item) for item in (ids or [])]
    if id and str(id) not in result:
        result.insert(0, str(id))
    if not result:
        raise ValueError("需要 id 或 ids")
    return result


def _page_size(page: float | None, page_size: float | None) -> tuple[int, int]:
    return max(1, int(page or 1)), max(1, min(500, int(page_size or 50)))


def _content_meta(data: dict[str, Any]) -> types.TextContent:
    meta = {key: value for key, value in data.items() if key not in {"src"}}
    return types.TextContent(type="text", text=json.dumps(meta, ensure_ascii=False))


def _public_node(node: dict[str, Any], include_images: bool = False) -> dict[str, Any]:
    """Keep tool output below the MCP transport limit by hiding base64 payloads."""
    result = dict(node)
    if include_images:
        return result
    src = result.get("src")
    if isinstance(src, str) and src.startswith("data:image/"):
        result["src"] = f"[base64 image: {len(src)} chars]"
    versions = result.get("versions")
    if isinstance(versions, list):
        cleaned = []
        for version in versions:
            if isinstance(version, dict) and isinstance(version.get("src"), str) and version["src"].startswith("data:image/"):
                cleaned.append({**version, "src": f"[base64 image: {len(version['src'])} chars]"})
            else:
                cleaned.append(version)
        result["versions"] = cleaned
    return result


def _public_project(project: dict[str, Any], include_images: bool = False) -> dict[str, Any]:
    clean = canvas_ops.sanitize_project(project)
    return {
        **clean,
        "nodes": [_public_node(node, include_images) for node in clean.get("nodes") or []],
        "wires": clean.get("wires") or [],
    }


# --------------------------------------------------------------- app
@server.tool()
def app_get_state() -> dict:
    """读取 Electron 当前状态：页面（library/canvas/studio）、打开的画布、选中节点、节点/连线数量与可用操作命名空间。"""
    state = _state()
    return {
        "ok": True,
        "page": state.get("page"),
        "title": state.get("title"),
        "state": state,
        "availableActions": AVAILABLE_ACTIONS,
    }


@server.tool()
def app_describe_actions(ns: str | None = None) -> dict:
    """读取 canvas 操作命名空间；app_apply_ops 的 ops 字段以此为准。"""
    actions = [action for action in AVAILABLE_ACTIONS if ns is None or action["ns"] == ns]
    return {"ok": True, "namespaces": actions}


@server.tool()
def app_apply_ops(projectId: str | None = None, ops: list[dict[str, Any]] | None = None) -> dict:
    """向 Electron 画布提交一批扁平操作（每项含 type，可带 ns="canvas"）。projectId 省略时使用当前打开的画布。"""
    if not ops:
        raise ValueError("ops 不能为空")
    target = _target(projectId)
    project, result = _apply(target, ops)
    return {
        "ok": True,
        "projectId": target,
        "applied": len(ops),
        "createdNodeIds": result.get("createdIds") or [],
        "selectedNodeIds": result.get("selected") or [],
        "warnings": result.get("warnings") or [],
    }


@server.tool()
def app_screenshot(nodeId: str | None = None, projectId: str | None = None) -> list[types.ContentBlock]:
    """截取 OpenCanvas 窗口；传 nodeId 时只截该节点的图片输出（SVG 会栅格化成 PNG）。

    nodeId 模式只读取节点内容，不需要把画布切到前台；projectId 省略时使用当前打开的画布。
    """
    if nodeId:
        target = _target(projectId)
        result = bridge.agent("captureNode", target, str(nodeId), timeout=120)
        data_url = str(result.get("dataUrl") or "")
        if not data_url.startswith("data:image/png;base64,"):
            raise ValueError("节点截图失败：没有图片输出")
        data = data_url.split(",", 1)[1]
        meta = {
            "nodeId": result.get("nodeId") or nodeId,
            "projectId": target,
            "kind": result.get("kind"),
            "title": result.get("title"),
            "width": result.get("width"),
            "height": result.get("height"),
        }
        return [
            types.ImageContent(type="image", data=data, mimeType="image/png"),
            types.TextContent(type="text", text=json.dumps(meta, ensure_ascii=False)),
        ]
    png = bridge.screenshot()
    return [
        types.ImageContent(
            type="image",
            data=base64.b64encode(png).decode("ascii"),
            mimeType="image/png",
        ),
        types.TextContent(type="text", text=f"OpenCanvas window screenshot ({len(png)} bytes)"),
    ]


# --------------------------------------------------------------- library
@server.tool()
def canvas_list_projects(
    keyword: str | None = None,
    page: float | None = None,
    pageSize: float | None = None,
) -> dict:
    """列出 Electron 全部画布（canvas 项目），含所属分组、节点数、连线数；返回的 id 用作 projectId。"""
    groups = _groups()
    rows: list[dict[str, Any]] = []
    for group in groups:
        for canvas in group.get("canvases") or []:
            rows.append(
                {
                    "id": canvas.get("id"),
                    "title": canvas.get("name"),
                    "groupId": group.get("id"),
                    "libraryId": group.get("id"),
                    "groupName": group.get("name"),
                    "updatedAt": canvas.get("updatedAt"),
                }
            )
    if keyword:
        needle = keyword.strip().lower()
        rows = [row for row in rows if needle in str(row.get("title") or "").lower() or needle in str(row.get("groupName") or "").lower()]
    page_number, size = _page_size(page, pageSize)
    start = (page_number - 1) * size
    state = _state()
    items = []
    for row in rows[start : start + size]:
        project = bridge.get_project(str(row["id"]))
        items.append(
            {
                **row,
                "nodeCount": len(project.get("nodes") or []),
                "connectionCount": len(project.get("wires") or []),
                "open": row["id"] == state.get("openCanvasId"),
            }
        )
    return {"total": len(rows), "page": page_number, "pageSize": size, "items": items}


@server.tool()
def canvas_manage_project(
    action: str,
    id: str | None = None,
    title: str | None = None,
    libraryId: str | None = None,
    ids: list[str] | None = None,
) -> dict:
    """管理画布项目。action：create / open / rename / delete。

    create 可指定 title、libraryId；open 用于让 AI 工具操作指定画布；
    delete 支持 id 或 ids。
    """
    if action == "create":
        group_id = _ensure_group(libraryId)
        canvas = bridge.agent("createCanvas", group_id, title)
        groups = {str(group.get("id")): str(group.get("name") or "") for group in _groups()}
        return {
            "ok": True,
            "action": action,
            "id": canvas["id"],
            "title": canvas.get("name"),
            "libraryId": group_id,
            "libraryName": groups.get(group_id),
            "projectId": canvas["id"],
        }
    if action == "open":
        if not id:
            raise ValueError("open 需要 id")
        canvas = bridge.agent("openCanvas", id)
        return {"ok": True, "action": action, "id": id, "canvas": canvas}
    if action == "rename":
        if not id or not title:
            raise ValueError("rename 需要 id 和 title")
        bridge.agent("renameCanvas", id, title)
        return {"ok": True, "action": action, "id": id, "title": title}
    if action == "delete":
        targets = _ids(id, ids)
        for project_id in targets:
            bridge.agent("deleteCanvas", project_id)
        return {"ok": True, "action": action, "deleted": targets}
    raise ValueError("action 必须是 create / open / rename / delete")


@server.tool()
def canvas_manage_library(action: str, id: str | None = None, name: str | None = None) -> dict:
    """管理库分组。action：create / rename / delete。delete 不会自动删除画布数据。"""
    if action == "create":
        group = bridge.agent("createGroup", name)
        return {"ok": True, "action": action, "id": group["id"], "name": group.get("name"), "libraryId": group["id"]}
    if action == "rename":
        if not id or not name:
            raise ValueError("rename 需要 id 和 name")
        bridge.agent("renameGroup", id, name)
        return {"ok": True, "action": action, "id": id, "name": name}
    if action == "delete":
        if not id:
            raise ValueError("delete 需要 id")
        bridge.agent("deleteGroup", id)
        return {"ok": True, "action": action, "id": id, "deleted": True}
    raise ValueError("action 必须是 create / rename / delete")


# --------------------------------------------------------------- inspect
@server.tool()
def canvas_get_project(projectId: str, includeImages: bool = False) -> dict:
    """读取一个 Electron 画布的 JSON（nodes/wires）。默认把 base64 图片替换为长度标记，避免 MCP 传输过大。"""
    project = _project(projectId)
    return {
        "ok": True,
        "projectId": projectId,
        "project": _public_project(project, includeImages),
        "nodeCount": len(project.get("nodes") or []),
        "connectionCount": len(project.get("wires") or []),
    }


@server.tool()
def canvas_get_node_content(projectId: str, nodeId: str) -> list[types.ContentBlock]:
    """读取 Electron 节点内容：image 返回图片，svg 返回 SVG 源码，其他节点返回节点 JSON。"""
    node = _node(_project(projectId), nodeId)
    if str(node.get("kind")) == "svg":
        markup = str(node.get("svg") or "")
        text = markup or json.dumps(node, ensure_ascii=False)
        return [types.TextContent(type="text", text=text), _content_meta(node)]
    src = str(node.get("src") or "")
    if src.startswith("data:image/") and ";base64," in src:
        header, data = src.split(",", 1)
        mime = header[5:].split(";", 1)[0] or "image/png"
        return [
            types.ImageContent(type="image", data=data, mimeType=mime),
            _content_meta(node),
        ]
    text = node.get("prompt") or json.dumps(node, ensure_ascii=False)
    return [types.TextContent(type="text", text=str(text)), _content_meta(node)]


# --------------------------------------------------------------- nodes
@server.tool()
def canvas_create_node(
    projectId: str,
    nodeType: str | None = None,
    title: str | None = None,
    x: float | None = None,
    y: float | None = None,
    width: float | None = None,
    height: float | None = None,
    svg: str | None = None,
    copyFromId: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict:
    """创建节点。nodeType：image / image-attempt / image-stack / assets / smart-canvas / svg。

    svg 节点传 svg（完整 SVG 源码）；传 copyFromId 时复制已有节点，可再覆盖 title/x/y/width/height/svg。
    """
    if copyFromId:
        project, result = _apply(projectId, [{"type": "duplicate_node", "id": copyFromId}])
        node_id = (result.get("createdIds") or [None])[0]
        if not node_id:
            raise ValueError("节点复制失败")
        patch = {
            key: value
            for key, value in {
                "title": title,
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "svg": svg,
            }.items()
            if value is not None
        }
        if metadata:
            patch.update(metadata)
        if patch:
            project, _ = _apply(projectId, [{"type": "update_node", "id": node_id, "patch": patch}])
        return {
            "ok": True,
            "projectId": projectId,
            "id": node_id,
            "node": _public_node(_node(project, node_id)),
            "warnings": result.get("warnings") or [],
        }
    if not nodeType:
        raise ValueError("创建节点需要 nodeType，或传 copyFromId 复制节点")
    op: dict[str, Any] = {
        "type": "add_node",
        "nodeType": nodeType,
        "title": title,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "svg": svg,
        "metadata": metadata,
    }
    project, result = _apply(projectId, [op])
    node_id = (result.get("createdIds") or [None])[0]
    if not node_id:
        raise ValueError("节点创建失败")
    return {
        "ok": True,
        "projectId": projectId,
        "id": node_id,
        "node": _public_node(_node(project, node_id)),
        "warnings": result.get("warnings") or [],
    }


@server.tool()
def canvas_update_nodes(projectId: str, ids: list[str], patch: dict[str, Any]) -> dict:
    """批量更新节点字段。patch 支持 title/status/x/y/width/height/prompt/svg/src/count/tone。"""
    if not ids:
        raise ValueError("ids 不能为空")
    if not patch:
        raise ValueError("patch 不能为空")
    ops = [{"type": "update_node", "id": node_id, "patch": patch} for node_id in ids]
    project, _ = _apply(projectId, ops)
    return {
        "ok": True,
        "projectId": projectId,
        "nodes": [_public_node(_node(project, node_id)) for node_id in ids],
    }


@server.tool()
def canvas_delete_nodes(projectId: str, ids: list[str]) -> dict:
    """删除 Electron 节点及相关连线。"""
    if not ids:
        raise ValueError("ids 不能为空")
    _apply(projectId, [{"type": "delete_node", "ids": ids}])
    return {"ok": True, "projectId": projectId, "deleted": ids}


@server.tool()
def canvas_arrange_nodes(
    projectId: str,
    ids: list[str],
    action: str,
    dx: float = 0,
    dy: float = 0,
    mode: str = "left",
    width: float | None = None,
    height: float | None = None,
    x: float | None = None,
    y: float | None = None,
) -> dict:
    """批量调整节点。action：move（dx/dy）、resize（width/height/x/y）、align（mode）、distribute（mode）、duplicate。"""
    if not ids:
        raise ValueError("ids 不能为空")
    if action == "move":
        project, _ = _apply(projectId, [{"type": "move_nodes", "ids": ids, "dx": dx, "dy": dy}])
        return {"ok": True, "projectId": projectId, "nodes": [_public_node(_node(project, node_id)) for node_id in ids]}
    if action == "resize":
        ops = [
            {"type": "resize_node", "id": node_id, "width": width, "height": height, "x": x, "y": y}
            for node_id in ids
        ]
        project, _ = _apply(projectId, ops)
        return {"ok": True, "projectId": projectId, "nodes": [_public_node(_node(project, node_id)) for node_id in ids]}
    if action in {"align", "distribute"}:
        align_mode = mode if action == "align" or mode.startswith("distribute-") else f"distribute-{mode}"
        project, _ = _apply(projectId, [{"type": "align_nodes", "ids": ids, "mode": align_mode}])
        return {"ok": True, "projectId": projectId, "nodes": [_public_node(_node(project, node_id)) for node_id in ids]}
    if action == "duplicate":
        project, result = _apply(projectId, [{"type": "duplicate_node", "id": node_id} for node_id in ids])
        created = result.get("createdIds") or []
        return {"ok": True, "projectId": projectId, "ids": created, "nodes": [_public_node(_node(project, node_id)) for node_id in created]}
    raise ValueError("action 必须是 move / resize / align / distribute / duplicate")


# --------------------------------------------------------------- generation
@server.tool()
def canvas_manage_generation(
    projectId: str,
    action: str,
    nodeId: str | None = None,
    fromNodeId: str | None = None,
    toNodeId: str | None = None,
    versionId: str | None = None,
    patch: dict[str, Any] | None = None,
    title: str | None = None,
    x: float | None = None,
    y: float | None = None,
) -> dict:
    """管理生成节点。action：connect / disconnect / list_versions / create_version / update_version / extract_image。

    connect/disconnect 使用 fromNodeId（image 或 svg）和 toNodeId（image-attempt）。SVG 参考图在生成时自动栅格化成 PNG。
    list_versions/create_version/update_version/extract_image 使用 nodeId。
    update_version 可传 versionId；省略时更新最新版本。
    """
    if action in {"connect", "disconnect"}:
        if not fromNodeId or not toNodeId:
            raise ValueError(f"{action} 需要 fromNodeId 和 toNodeId")
        project, result = _apply(
            projectId,
            [{"type": f"{action}_nodes", "fromNodeId": fromNodeId, "toNodeId": toNodeId}],
        )
        return {
            "ok": True,
            "action": action,
            "projectId": projectId,
            "fromNodeId": fromNodeId,
            "toNodeId": toNodeId,
            "node": _public_node(_node(project, toNodeId)),
            "warnings": result.get("warnings") or [],
        }
    if not nodeId:
        raise ValueError(f"{action} 需要 nodeId")
    if action == "list_versions":
        node = _node(_project(projectId), nodeId)
        versions = node.get("versions") or []
        return {
            "ok": True,
            "action": action,
            "projectId": projectId,
            "nodeId": nodeId,
            "activeVersion": node.get("activeVersion", 0),
            "versions": [_public_node(version) for version in versions],
        }
    if action == "create_version":
        project, _ = _apply(projectId, [{"type": "create_version", "id": nodeId}])
        return {"ok": True, "action": action, "projectId": projectId, "node": _public_node(_node(project, nodeId))}
    if action == "update_version":
        project, _ = _apply(
            projectId,
            [{"type": "update_version", "id": nodeId, "versionId": versionId, "patch": patch or {}}],
        )
        return {"ok": True, "action": action, "projectId": projectId, "node": _public_node(_node(project, nodeId))}
    if action == "extract_image":
        project, result = _apply(projectId, [{"type": "extract_image", "id": nodeId, "title": title, "x": x, "y": y}])
        image_id = (result.get("createdIds") or [None])[0]
        return {
            "ok": True,
            "action": action,
            "projectId": projectId,
            "id": image_id,
            "node": _public_node(_node(project, image_id)) if image_id else None,
        }
    raise ValueError("action 必须是 connect / disconnect / list_versions / create_version / update_version / extract_image")


# --------------------------------------------------------------- AI
@server.tool()
def canvas_ai(
    projectId: str,
    action: str,
    nodeId: str | None = None,
    prompt: str | None = None,
    model: str | None = None,
    quality: str | None = None,
    aspect: str | None = None,
    outputFormat: str | None = None,
    complexity: str | None = None,
    maxTokens: int | None = None,
    scale: float | None = None,
    targetLongEdge: int | None = None,
    method: str | None = None,
    yaw: float | None = None,
    pitch: float | None = None,
    zoom: float | None = None,
    normalConvention: str | None = None,
    tileable: bool | None = None,
    resolution: int | None = None,
    resolutionDepth: int | None = None,
    parts: list[str] | None = None,
    title: str | None = None,
    x: float | None = None,
    y: float | None = None,
) -> dict:
    """调用 AI 功能。action：cutout / pbr / segment / upscale / angle / generate。

    - cutout / pbr / segment / upscale / angle 调用本地 AI 服务；nodeId 省略时使用当前选中的 image，否则使用第一个 image。
    - generate 传 nodeId（生成节点）时写入该节点当前版本，使用它的 prompt 和 referenceIds；
      SVG 参考自动栅格化。不传 nodeId 时用 prompt 新建 image 节点。
    - AI 工具操作当前打开的画布；先 app_get_state，必要时 canvas_manage_project(action="open", id=...)。
    """
    state = _state()
    if str(state.get("openCanvasId") or "") != projectId:
        raise ValueError("AI 工具只操作当前打开的画布；请先 canvas_manage_project(action='open', id=...)")
    options = {
        key: value
        for key, value in {
            "nodeId": nodeId,
            "prompt": prompt,
            "model": model,
            "quality": quality,
            "aspect": aspect,
            "outputFormat": outputFormat,
            "complexity": complexity,
            "maxTokens": maxTokens,
            "scale": scale,
            "targetLongEdge": targetLongEdge,
            "method": method,
            "yaw": yaw,
            "pitch": pitch,
            "zoom": zoom,
            "normalConvention": normalConvention,
            "tileable": tileable,
            "resolution": resolution,
            "resolutionDepth": resolutionDepth,
            "parts": parts,
            "title": title,
            "x": x,
            "y": y,
        }.items()
        if value is not None
    }
    result = bridge.agent("runAiTool", action, options)
    if not isinstance(result, dict):
        result = {"result": result}
    return {"ok": True, "projectId": projectId, **result}


# --------------------------------------------------------------- view
@server.tool()
def canvas_set_view(
    projectId: str,
    action: str,
    ids: list[str] | None = None,
    x: float = 0,
    y: float = 0,
    k: float = 1,
) -> dict:
    """设置画布视图状态。action：select（ids）、deselect、viewport（x/y/k）。"""
    if action == "select":
        if not ids:
            raise ValueError("select 需要 ids")
        _apply(projectId, [{"type": "select_nodes", "ids": ids}])
        return {"ok": True, "action": action, "projectId": projectId, "selected": ids}
    if action == "deselect":
        _apply(projectId, [{"type": "deselect_all"}])
        return {"ok": True, "action": action, "projectId": projectId, "selected": []}
    if action == "viewport":
        _apply(projectId, [{"type": "set_viewport", "x": x, "y": y, "k": k}])
        return {"ok": True, "action": action, "projectId": projectId, "viewport": {"x": x, "y": y, "k": k}}
    raise ValueError("action 必须是 select / deselect / viewport")


# --------------------------------------------------------------- prompts
CHARACTER_DESIGN_PROMPT = """你现在在 OpenCanvas 里做「人物设定」。按下面流程执行，不要跳步，也不要在一条回复里把后面几步全做完。

每一步先用一句话说明你要做什么，再调用工具；完成后用节点截图验证，不要只看“操作成功”。

## 0. 先确认画布

- `app_get_state`
- 有打开的画布就直接用；没有就 `canvas_manage_project(action="create", title="人物设定 · <角色名>")`，再 `open`。
- 记下 `projectId`，后面所有调用都带上。

## 1. 接住粗描述

- 如果用户还没给描述，先只问一句：“先给我一个大概的人物描述（风格、性别、气质、服装方向）”，不要自己编人设。
- 用户会给一个大概的人物描述（风格、性别、气质、服装方向等）。
- 先用 3-5 条复述你理解的外形要点，让用户确认或补充。
- 只问最多 2 个真正影响画面、但描述里没有的关键问题（例如写实/二次元、时代、主色）。
- 不要一次抛出长问卷；用户说“你定”就自己选合理默认值。

## 2. SVG 草图（多轮）

- 创建 SVG 节点：
  `canvas_create_node(projectId, nodeType="svg", title="人物草图", svg="<svg ...>...</svg>")`
- 规格：竖版 `viewBox="0 0 480 720"`；白底或透明底；全身正面站姿；先抓轮廓、比例、大块服装，不要一开始抠细节。
- SVG 必须自包含：不要外链图片或字体；文字尽量少，用形状表达。
- 每轮只改 1-3 个点（比例、发型、服装轮廓、配色），用：
  `canvas_update_nodes(projectId, ids=[svgId], patch={svg: "<svg ...>新的源码</svg>"})`
- 每轮修改后看节点效果：
  `app_screenshot(nodeId=svgId, projectId=projectId)`
- 用户要源码时用 `canvas_get_node_content(projectId, svgId)` 返回完整 `<svg>`。
- 每次回复告诉用户“这一轮改了什么”，等用户确认或提出修改；不要连续改很多轮不让人看。

## 3. 人物设定图（纯白背景）

- 用户确认 SVG 后，创建生成节点：
  `canvas_create_node(projectId, nodeType="image-attempt", title="人物设定图")`
- 把 SVG 连过去：
  `canvas_manage_generation(projectId, action="connect", fromNodeId=svgId, toNodeId=genId)`
- 设置这一版的固定提示词：
  `canvas_manage_generation(projectId, action="update_version", nodeId=genId, patch={prompt: "..."})`
- 提示词模板（把方括号替换成角色信息）：
  ```
  character design sheet, full body, front view, neutral standing pose,
  clean line art, flat colors, pure white background (#ffffff),
  no background scenery, no text, no watermark, no logo,
  [角色描述], [服装细节], [配色]
  ```
- 生成：
  `canvas_ai(projectId, action="generate", nodeId=genId)`
- 检查：
  `app_screenshot(nodeId=genId, projectId=projectId)`
- 检查点：背景是否纯白、全身是否完整、服装和 SVG 是否一致、有没有多余文字。
- 不满足就改 prompt 再生成，同一版最多重试 2 次；不要用同一提示词反复抽卡。

## 4. 四向图（人物确认后）

- 只有用户明确说“人物可以了”才进入这一步。
- 创建 4 个生成节点，横向排开，标题分别为：正面 / 四分之三 / 侧面 / 背面。
- 每个节点都连接同一个 SVG：
  `canvas_manage_generation(projectId, action="connect", fromNodeId=svgId, toNodeId=eachGenId)`
- 四个提示词共用同一段后缀，只改视角句：
  1. 正面：`full body, front view, neutral standing pose, ...`
  2. 四分之三：`full body, three-quarter view (45 degrees), ...`
  3. 侧面：`full body, side profile view (90 degrees), ...`
  4. 背面：`full body, back view (180 degrees), ...`
- 共用后缀：
  ```
  character design sheet, clean line art, flat colors, pure white background (#ffffff),
  no background scenery, no text, no watermark, no logo,
  consistent costume, proportions and colors with the reference SVG,
  [角色描述], [服装细节], [配色]
  ```
- 每个节点用同一套 model / quality / aspect（建议 1:1 或竖版），只改视角句，不要改其他形容词。
- 逐个生成并截图检查；如果某一向不一致，只改该节点的视角提示词或重新生成，不要动 SVG。

## 5. 交付

- 汇总：SVG 节点 id、人物设定图节点 id、四个视角节点 id。
- 用 `app_screenshot(nodeId=...)` 展示最终结果。
- 如果用户还要改，回到对应阶段；不要从头重做。

## 硬性规则

- image 节点只存位图，SVG 只放 svg 节点。
- 每个生成节点只用一个 SVG 参考。
- 所有人物设定图和四向图必须是纯白背景。
- 不要给人物加文字标签、边框、阴影背景或装饰背景。
- 参考关系必须通过 `canvas_manage_generation(action="connect")` 建立，不要直接把 SVG 塞进 prompt。
- 不要跳过用户确认直接做四向图。
"""


@server.prompt(
    name="character design",
    title="Character Design",
    description="从人物粗描述开始，迭代 SVG，生成白底人物设定图，最后生成四向图。",
)
def character_design(brief: str = "") -> str:
    """Return the OpenCanvas character design workflow prompt."""
    text = CHARACTER_DESIGN_PROMPT
    if brief.strip():
        text += f"\n\n---\n\n用户这次给出的人物描述：\n{brief.strip()}"
    return text
