# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Starts the Omarchy image (niri desktop) in remote mode, on its OWN data disk, work
# directory and port, so it never touches the default instance's disk. Run from the
# install directory (update.ps1 puts it there) or from versions\<tag>\remote. The image
# is the installed version's own (web\.output\public\distros\omarchy-*.erofs), so this
# follows every update. Beside the install directory (the one holding versions\):
#   data\img\omarchy.img     the data disk, created on the first start
#   data\work-omarchy        /work in the guest
# Ctrl+C in this window stops the backend after it has saved the disk. In the guest,
# run `omarchy desktop` (remote mode has no virgl: niri renders in software, slowly).
#
#   start-omarchy.cmd [-Port 8791] [-NoOpen]

[CmdletBinding()]
param([string]$Port = '8791', [switch]$NoOpen)

$ErrorActionPreference = "Stop"
# PowerShell 7 hands Windows PowerShell 5.1 a PSModulePath that hides its own modules (Get-FileHash...).
if ($PSVersionTable.PSEdition -ne 'Core') {
	$env:PSModulePath = "$env:USERPROFILE\Documents\WindowsPowerShell\Modules;$env:ProgramFiles\WindowsPowerShell\Modules;$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
}

$here = $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $here 'current.txt')) {
	$app = $here
	$ver = (Get-Content -LiteralPath (Join-Path $here 'current.txt') -Raw).Trim()
	if ($ver -notmatch '^[A-Za-z0-9._-]+$') { Write-Host "unkernel remote: current.txt does not name a version: run update.cmd" -ForegroundColor Red; exit 2 }
	$versionDir = Join-Path (Join-Path $app 'versions') $ver
} else {
	$versionDir = Split-Path -Parent $here
	$app = Split-Path -Parent (Split-Path -Parent $versionDir)
}
$root = Split-Path -Parent $app
$distros = Join-Path $versionDir 'web\.output\public\distros'
$image = if (Test-Path -LiteralPath $distros) { Get-ChildItem -LiteralPath $distros -Filter 'omarchy-*.erofs' | Select-Object -First 1 }
if (-not $image) { Write-Host "unkernel remote: this version has no Omarchy image ($distros): run update.cmd for a release that has it" -ForegroundColor Red; exit 2 }

$data = Join-Path $root 'data\img\omarchy.img'
$work = Join-Path $root 'data\work-omarchy'
New-Item -ItemType Directory -Force (Split-Path -Parent $data), $work | Out-Null

$url = "http://127.0.0.1:$Port/?remote=1&distro=omarchy"
if (-not $NoOpen) {
	Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', "for(`$i=0;`$i -lt 90;`$i++){ try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:$Port/' -TimeoutSec 2 | Out-Null; Start-Process '$url'; break } catch { Start-Sleep 1 } }"
}
Write-Host "Omarchy ($($image.Name)): $url"
Write-Host "data disk $data (created on first start), /work $work"

$launch = @{ Data = $data; Work = $work; Port = $Port; NoOpen = $true }
if (Test-Path -LiteralPath (Join-Path $root 'cache')) { $launch.Cache = Join-Path $root 'cache' }
& (Join-Path $versionDir 'remote\start-windows.ps1') @launch
exit $LASTEXITCODE
