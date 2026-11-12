$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "AI service venv missing: $python" }
& $python -m uvicorn app:app --host 127.0.0.1 --port 3214
