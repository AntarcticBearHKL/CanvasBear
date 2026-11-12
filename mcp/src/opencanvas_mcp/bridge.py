"""HTTP client for the running OpenCanvas window.

The Electron main process hosts a loopback bridge on 127.0.0.1:3213. It
executes each request through the renderer's ``window.openCanvasAgent`` API,
so reads and writes hit the live React document and its localStorage mirror.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

DEFAULT_URL = "http://127.0.0.1:3213"
DEFAULT_TIMEOUT = 30.0
SCREENSHOT_TIMEOUT = 60.0


class BridgeError(RuntimeError):
    """The Electron app is unreachable or answered with an error."""


def base_url() -> str:
    return os.environ.get("OC_ELECTRON_BRIDGE_URL", DEFAULT_URL).rstrip("/")


def _timeout() -> float:
    try:
        return float(os.environ.get("OC_ELECTRON_BRIDGE_TIMEOUT", DEFAULT_TIMEOUT))
    except ValueError:
        return DEFAULT_TIMEOUT


def request(
    method: str,
    path: str,
    payload: Any | None = None,
    *,
    raw: bool = False,
    timeout: float | None = None,
) -> Any:
    url = f"{base_url()}{path}"
    data = None
    headers = {"Accept": "application/json, image/png"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    token = os.environ.get("OC_ELECTRON_BRIDGE_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout or _timeout()) as response:
            body = response.read()
            if raw:
                return body
            if not body:
                return {}
            return json.loads(body.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            detail = json.loads(body).get("error") or body
        except (ValueError, AttributeError):
            detail = body
        raise BridgeError(f"Electron bridge HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise BridgeError(
            "OpenCanvas 没有响应。请先启动 opencanvas"
            f"（代理桥默认 {base_url()}）；如果改过端口，设置 OC_ELECTRON_BRIDGE_URL。"
            f"原因：{exc.reason}"
        ) from exc
    except TimeoutError as exc:
        raise BridgeError(f"OpenCanvas 在 {timeout or _timeout():.0f}s 内没有响应") from exc


def health() -> dict:
    return request("GET", "/health")


def state() -> dict:
    return request("GET", "/state")


def library() -> dict:
    return request("GET", "/library")


def get_project(canvas_id: str) -> dict:
    return request("GET", f"/project/{canvas_id}")


def put_project(canvas_id: str, project: dict) -> dict:
    return request("PUT", f"/project/{canvas_id}", project)


def agent(method: str, *args: Any, timeout: float | None = None) -> Any:
    return request("POST", "/agent", {"method": method, "args": list(args)}, timeout=timeout)


def screenshot() -> bytes:
    return request("GET", "/screenshot", raw=True, timeout=SCREENSHOT_TIMEOUT)
