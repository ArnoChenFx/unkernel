# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Starts unkernel's remote kernel backend on this computer and opens the page
# in the default browser (the README's remote section says how it is used).
# The web app is built first when its build is missing, or with -Rebuild.
# The settings are the backend's: these options, then the UNKERNEL_REMOTE_*
# variables, then remote\unkernel-remote.json (or -Config), then the defaults
# under %USERPROFILE%\.unkernel\remote. Relative paths are relative to the
# directory this runs from. Ctrl+C in this window stops the backend after it
# has saved the guest's disk.
#
#   remote\start-windows.ps1 -Data E:\tmp\unkernel-data\img\vm1.img -Work E:\tmp\unkernel-data\work -Cache E:\tmp\unkernel-cache

[CmdletBinding()]
param(
	[string]$Data,
	[string]$Work,
	[string]$Cache,
	[string]$Port,
	[string]$Config,
	[switch]$NoNet,
	[switch]$NoOpen,
	[switch]$Rebuild,
	[switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
	Write-Host "usage: remote\start-windows.ps1 [-Data FILE] [-Work DIR|none] [-Cache DIR] [-Port N] [-Config FILE] [-NoNet] [-NoOpen] [-Rebuild]"
	exit 0
}

function Stop-Start([string]$message) {
	Write-Host "unkernel remote: $message" -ForegroundColor Red
	exit 2
}

function Resolve-Path-Arg([string]$path) {
	if ([string]::IsNullOrEmpty($path)) { return $path }
	return [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $path))
}

function Find-Tool([string]$name, [string[]]$fallbacks) {
	$cmd = Get-Command $name -ErrorAction SilentlyContinue
	if ($cmd) { return $cmd.Source }
	foreach ($f in $fallbacks) {
		if (Test-Path -LiteralPath $f) { return $f }
	}
	return $null
}

$Data = Resolve-Path-Arg $Data
if ($Work -ne "none") { $Work = Resolve-Path-Arg $Work }
$Cache = Resolve-Path-Arg $Cache
$Config = Resolve-Path-Arg $Config

$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo

$bun = Find-Tool "bun" @((Join-Path $env:USERPROFILE ".bun\bin\bun.exe"))
if (-not $bun) { Stop-Start "Bun is not installed: get it from https://bun.sh (powershell -c `"irm bun.sh/install.ps1 | iex`"), then run this again." }

$webDir = Join-Path $repo "web\.output\public"
$template = Join-Path $repo "web\.output\server\_chunks\renderer-template.mjs"
$built = (Test-Path -LiteralPath $template) -and (Test-Path -LiteralPath (Join-Path $webDir "assets"))
if ($Rebuild -or -not $built) {
	$pnpm = Find-Tool "pnpm" @()
	if (-not $pnpm) { Stop-Start "pnpm is not installed (run corepack enable, or npm install -g pnpm), and the web app is not built." }
	if (-not (Test-Path -LiteralPath (Join-Path $repo "node_modules"))) {
		Write-Host "Installing the dependencies (pnpm install)..."
		& $pnpm install
		if ($LASTEXITCODE -ne 0) { Stop-Start "pnpm install failed." }
	}
	Write-Host "Building the web app (pnpm build:web)..."
	& $pnpm build:web
	if ($LASTEXITCODE -ne 0) { Stop-Start "pnpm build:web failed." }
}

$cli = @("--bun", "remote\cli.ts")
if ($Data) { $cli += @("--data", $Data) }
if ($Work) { $cli += @("--work", $Work) }
if ($Cache) { $cli += @("--cache", $Cache) }
if ($Port) { $cli += @("--port", $Port) }
if ($Config) { $cli += @("--config", $Config) }
if ($NoNet) { $cli += "--no-net" }
if (-not $NoOpen) { $cli += "--open" }

& $bun @cli
exit $LASTEXITCODE
