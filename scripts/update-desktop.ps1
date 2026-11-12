$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "release-install\win-unpacked\resources"
$install = Join-Path $env:LOCALAPPDATA "Programs\opencanvas"
$target = Join-Path $install "resources"

if (-not (Test-Path (Join-Path $source "app.asar"))) {
  throw "Build output not found: $source\app.asar"
}
if (-not (Test-Path (Join-Path $install "OpenCanvas.exe"))) {
  throw "Installed app not found: $install\OpenCanvas.exe"
}

Get-Process -Name OpenCanvas -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

Copy-Item -LiteralPath (Join-Path $source "app.asar") -Destination (Join-Path $target "app.asar") -Force
$sourceUnpacked = Join-Path $source "app.asar.unpacked"
$targetUnpacked = Join-Path $target "app.asar.unpacked"
if (Test-Path $sourceUnpacked) {
  if (Test-Path $targetUnpacked) { Remove-Item -LiteralPath $targetUnpacked -Recurse -Force }
  Copy-Item -LiteralPath $sourceUnpacked -Destination $targetUnpacked -Recurse -Force
}

$shortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "OpenCanvas.lnk"
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = Join-Path $install "OpenCanvas.exe"
$link.WorkingDirectory = $install
$link.IconLocation = (Join-Path $install "OpenCanvas.exe") + ",0"
$link.Save()

Start-Process -FilePath (Join-Path $install "OpenCanvas.exe")
Write-Output "Updated desktop app: $install"
