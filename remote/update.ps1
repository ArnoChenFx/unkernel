# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Installs and updates the remote kernel backend from a release of the fork,
# then starts it (remote/README.md). Nothing to build: the release's manifest
# lists every file of the install with its sha256; a file already installed
# with that hash is reused, an archive is downloaded only when one of its files
# changed, and every download is checked before anything is installed.
#
# Under -Dir (default %USERPROFILE%\.unkernel\app):
#   versions\<tag>\        one complete install, at the paths of the repository
#                          (remote\, web\.output\...), with its manifest.json
#   current.txt            the tag that runs; replaced by a rename
#   update.ps1, update.cmd the launchers (update.ps1 hands over to versions\<tag>\remote\)
#   downloads\             the verified archives of the update in progress
# The install is assembled in partial-<tag>\ and renamed into versions\, so a
# failed update leaves the running version alone. The data directory
# (%USERPROFILE%\.unkernel\remote) is never touched.
#
# Windows PowerShell 5.1 and PowerShell 7. remote/test/update.test.ts runs it
# with PowerShell 7 against a local fixture server.

[CmdletBinding()]
param(
	[string]$Dir = '',
	[string]$Repo = 'ArnoChenFx/unkernel',
	[string]$Tag = '',
	[string]$ApiBase = 'https://api.github.com',
	[string]$DownloadBase = 'https://github.com',
	[switch]$Check,
	[switch]$NoUpdate,
	[switch]$NoStart,
	[switch]$Force,
	[string]$Data = '',
	[string]$Work = '',
	[string]$Cache = '',
	[string]$Port = '',
	[string]$Config = '',
	[switch]$NoNet,
	[switch]$NoOpen
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$UserAgent = 'unkernel-remote-update'
$userHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$unkernelHome = Join-Path $userHome '.unkernel'
if (-not $Dir) { $Dir = if ($env:UNKERNEL_APP) { $env:UNKERNEL_APP } else { Join-Path $unkernelHome 'app' } }
$app = if ([IO.Path]::IsPathRooted($Dir)) { [IO.Path]::GetFullPath($Dir) } else { [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Dir)) }
$dataDir = [IO.Path]::GetFullPath((Join-Path $unkernelHome 'remote'))
if ($app -eq $dataDir -or $app.StartsWith($dataDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
	throw "-Dir ($app) must not be the data directory ($dataDir)"
}

function Say([string]$message) { Write-Host "[update] $message" }

function Format-Size([long]$bytes) {
	if ($bytes -ge 1MB) { return ('{0:N1} MiB' -f ($bytes / 1MB)) }
	return ('{0:N0} KiB' -f ($bytes / 1KB))
}

function ToLocal([string]$relative) { return $relative.Replace('/', [IO.Path]::DirectorySeparatorChar) }

function Test-SafeRelative([string]$path) {
	if (-not $path -or $path.StartsWith('/') -or $path.Contains('\') -or $path -match '^[A-Za-z]:') { return $false }
	foreach ($part in $path.Split('/')) {
		if ($part -eq '' -or $part -eq '.' -or $part -eq '..') { return $false }
	}
	return $true
}

function Test-LocalFile([string]$path, [long]$size, [string]$sha256) {
	if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
	if ((Get-Item -LiteralPath $path).Length -ne $size) { return $false }
	return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $sha256.ToLowerInvariant()
}

function Write-Text([string]$path, [string]$text) {
	[IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
}

function Remove-Tree([string]$path) {
	if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
}

function Get-Installed {
	$file = Join-Path $app 'current.txt'
	if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return '' }
	$name = [IO.File]::ReadAllText($file).Trim()
	if ($name -notmatch '^[A-Za-z0-9._-]+$') { return '' }
	if (Test-Path -LiteralPath (Join-Path (Join-Path $app 'versions') $name) -PathType Container) { return $name }
	return ''
}

function Enter-Lock {
	$script:lockFile = Join-Path $app 'update.lock'
	for ($attempt = 0; $attempt -lt 2; $attempt++) {
		try {
			$stream = [IO.File]::Open($script:lockFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
			$writer = New-Object IO.StreamWriter($stream)
			$writer.Write([string]$PID)
			$writer.Dispose()
			return
		} catch [IO.IOException] {
			$holder = [IO.File]::ReadAllText($script:lockFile).Trim()
			$pid0 = 0
			$alive = [int]::TryParse($holder, [ref]$pid0) -and ($null -ne (Get-Process -Id $pid0 -ErrorAction SilentlyContinue))
			if ($alive) { throw "another update is running (process $holder)" }
			Remove-Item -LiteralPath $script:lockFile -Force -ErrorAction SilentlyContinue
		}
	}
	throw "cannot take $($script:lockFile)"
}

function Exit-Lock {
	if ($script:lockFile) { Remove-Item -LiteralPath $script:lockFile -Force -ErrorAction SilentlyContinue }
}

function Test-Flag($release, [string]$name) {
	$property = $release.PSObject.Properties[$name]
	return ($null -ne $property -and [bool]$property.Value)
}

function Get-LatestTag {
	$list = Invoke-RestMethod -Uri "$ApiBase/repos/$Repo/releases?per_page=30" -UserAgent $UserAgent -Headers @{ Accept = 'application/vnd.github+json' }
	# The API's order is not the publication order (a release made from an older commit can be listed first): the newest is by publication time.
	$pick = @($list | Where-Object { ([string]$_.tag_name) -like 'remote-v*' -and -not (Test-Flag $_ 'draft') -and -not (Test-Flag $_ 'prerelease') } |
		Sort-Object -Descending -Property @{ Expression = { $t = if ($_.PSObject.Properties['published_at'] -and $_.published_at) { $_.published_at } else { $_.created_at }; [DateTimeOffset]::Parse([string]$t, [Globalization.CultureInfo]::InvariantCulture).UtcTicks } })
	if ($pick.Count -eq 0) { throw "no remote-v* release in $Repo" }
	return [string]$pick[0].tag_name
}

function Download([string]$url, [string]$path) {
	Invoke-WebRequest -UseBasicParsing -UserAgent $UserAgent -Uri $url -OutFile $path
}

function Get-Asset($asset) {
	$cached = Join-Path (Join-Path $app 'downloads') ([string]$asset.name)
	if (Test-LocalFile $cached ([long]$asset.size) ([string]$asset.sha256)) { return $cached }
	$partialFile = "$cached.partial"
	Say "downloading $($asset.name) ($(Format-Size ([long]$asset.size)))"
	Download ([string]$asset.url) $partialFile
	if (-not (Test-LocalFile $partialFile ([long]$asset.size) ([string]$asset.sha256))) {
		Remove-Item -LiteralPath $partialFile -Force -ErrorAction SilentlyContinue
		throw "$($asset.name) does not match its size or sha256 in the manifest"
	}
	Move-Item -LiteralPath $partialFile -Destination $cached -Force
	return $cached
}

function Copy-Installed([string]$source, [string]$target) {
	New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
	try {
		New-Item -ItemType HardLink -Path $target -Value $source -ErrorAction Stop | Out-Null
	} catch {
		Copy-Item -LiteralPath $source -Destination $target -Force
	}
}

function Expand-Files([string]$zipPath, $wanted, [string]$root) {
	Add-Type -AssemblyName System.IO.Compression.FileSystem
	$zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
	try {
		foreach ($file in $wanted) {
			$entry = $zip.GetEntry([string]$file.path)
			if (-not $entry) { throw "$($file.path) is not in $(Split-Path -Leaf $zipPath)" }
			$target = Join-Path $root (ToLocal ([string]$file.path))
			New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
			[IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
		}
	} finally {
		$zip.Dispose()
	}
}

function Update-Launchers([string]$versionDir) {
	foreach ($name in 'update.ps1', 'update.cmd') {
		$target = Join-Path $app $name
		if (Test-Path -LiteralPath $target -PathType Leaf) { continue }
		$source = Join-Path (Join-Path $versionDir 'remote') $name
		if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination $target -Force }
	}
	# The Omarchy launchers follow each release: replaced every update (they find the version's image themselves).
	foreach ($name in 'start-omarchy.ps1', 'start-omarchy.cmd') {
		$source = Join-Path (Join-Path $versionDir 'remote') $name
		if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination (Join-Path $app $name) -Force }
	}
}

function Remove-Downloads {
	$dir = Join-Path $app 'downloads'
	if (Test-Path -LiteralPath $dir) { Get-ChildItem -LiteralPath $dir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
}

function Remove-OldVersions([string]$keepA, [string]$keepB) {
	$versions = Join-Path $app 'versions'
	if (-not (Test-Path -LiteralPath $versions)) { return }
	foreach ($dir in Get-ChildItem -LiteralPath $versions -Directory) {
		if ($dir.Name -eq $keepA -or $dir.Name -eq $keepB) { continue }
		Remove-Tree $dir.FullName
	}
}

# Installs the release named by -Tag (or the newest remote-v* release) and returns the version to run;
# '' when only checking, or when the installed version is already the newest.
function Update-Install([string]$current) {
	if ($NoUpdate) {
		if (-not $current) { throw 'nothing is installed yet (run without -NoUpdate)' }
		return $current
	}
	$tag = if ($Tag) { $Tag } else { Get-LatestTag }
	$safe = $tag -replace '[^A-Za-z0-9._-]', '_'
	$downloads = Join-Path $app 'downloads'
	New-Item -ItemType Directory -Force -Path $downloads | Out-Null
	$manifestFile = Join-Path $downloads ("manifest-$safe.json")
	Download "$DownloadBase/$Repo/releases/download/$([uri]::EscapeDataString($tag))/manifest.json" $manifestFile
	$manifestText = [IO.File]::ReadAllText($manifestFile, [Text.Encoding]::UTF8)
	$manifest = $manifestText | ConvertFrom-Json
	if ($manifest.format -ne 1 -or $manifest.product -ne 'unkernel-remote') { throw "the manifest of $tag is not an unkernel-remote manifest of format 1" }
	if ([string]$manifest.tag -ne $tag) { throw "the manifest says $($manifest.tag), not $tag" }
	$assets = @{}
	foreach ($asset in @($manifest.assets)) { $assets[[string]$asset.name] = $asset }
	$files = @($manifest.files)
	foreach ($file in $files) {
		if (-not (Test-SafeRelative ([string]$file.path))) { throw "the manifest names an unsafe path: $($file.path)" }
		if (-not $assets.ContainsKey([string]$file.asset)) { throw "$($file.path) names no asset in the manifest" }
	}

	$currentDir = if ($current) { Join-Path (Join-Path $app 'versions') $current } else { '' }
	$keep = New-Object System.Collections.ArrayList
	$stale = New-Object System.Collections.ArrayList
	foreach ($file in $files) {
		$local = if ($currentDir) { Join-Path $currentDir (ToLocal ([string]$file.path)) } else { '' }
		if ($local -and (Test-LocalFile $local ([long]$file.size) ([string]$file.sha256))) { [void]$keep.Add($file) } else { [void]$stale.Add($file) }
	}
	$needed = @($stale | ForEach-Object { [string]$_.asset } | Sort-Object -Unique)
	$bytes = [long]0
	foreach ($name in $needed) { $bytes += [long]$assets[$name].size }

	if ($current -eq $safe -and $stale.Count -eq 0 -and -not $Force) {
		Say "up to date: $tag"
		if ($Check) { return '' }
		return $safe
	}
	if ($Check) {
		$from = if ($current) { $current } else { 'nothing installed' }
		Say "update available: $from -> $tag, $($needed.Count) download(s), $(Format-Size $bytes)"
		return ''
	}

	Say "installing $tag ($($needed.Count) download(s), $(Format-Size $bytes))"
	Get-ChildItem -LiteralPath $app -Directory -Filter 'partial-*' -ErrorAction SilentlyContinue | ForEach-Object { Remove-Tree $_.FullName }
	$partial = Join-Path $app ("partial-$safe")
	New-Item -ItemType Directory -Force -Path $partial | Out-Null
	try {
		foreach ($file in $keep) {
			Copy-Installed (Join-Path $currentDir (ToLocal ([string]$file.path))) (Join-Path $partial (ToLocal ([string]$file.path)))
		}
		foreach ($name in $needed) {
			$asset = $assets[$name]
			$archive = Get-Asset $asset
			$wanted = @($stale | Where-Object { [string]$_.asset -eq $name })
			if ([string]$asset.kind -eq 'distro') {
				foreach ($file in $wanted) { Copy-Installed $archive (Join-Path $partial (ToLocal ([string]$file.path))) }
			} else {
				Expand-Files $archive $wanted $partial
			}
		}
		foreach ($file in $files) {
			if (-not (Test-LocalFile (Join-Path $partial (ToLocal ([string]$file.path))) ([long]$file.size) ([string]$file.sha256))) {
				throw "$($file.path) does not match the manifest after the install"
			}
		}
		Write-Text (Join-Path $partial 'manifest.json') $manifestText
	} catch {
		Remove-Tree $partial
		throw
	}

	$target = Join-Path (Join-Path $app 'versions') $safe
	$old = ''
	if (Test-Path -LiteralPath $target) {
		$old = "$target.old-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
		Move-Item -LiteralPath $target -Destination $old
	}
	Move-Item -LiteralPath $partial -Destination $target
	$pointer = Join-Path $app 'current.txt'
	Write-Text "$pointer.tmp" $safe
	Move-Item -LiteralPath "$pointer.tmp" -Destination $pointer -Force
	if ($old) { Remove-Tree $old }
	Remove-Item -LiteralPath $manifestFile -Force -ErrorAction SilentlyContinue
	Update-Launchers $target
	Remove-Downloads
	Remove-OldVersions $safe $current
	Say "installed $tag"
	return $safe
}

function Start-Backend([string]$version) {
	$script = Join-Path (Join-Path (Join-Path (Join-Path $app 'versions') $version) 'remote') 'start-windows.ps1'
	if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "$script is missing" }
	$forward = @{}
	if ($Data) { $forward['Data'] = $Data }
	if ($Work) { $forward['Work'] = $Work }
	if ($Cache) { $forward['Cache'] = $Cache }
	if ($Port) { $forward['Port'] = $Port }
	if ($NoNet) { $forward['NoNet'] = $true }
	if ($NoOpen) { $forward['NoOpen'] = $true }
	if ($Config) {
		$forward['Config'] = $Config
	} else {
		$appConfig = Join-Path $app 'unkernel-remote.json'
		if (Test-Path -LiteralPath $appConfig -PathType Leaf) { $forward['Config'] = $appConfig }
	}
	& $script @forward
}

# update.ps1 in the install root only hands over to the updater of the installed version, so that
# the newest updater (which the release installs) does the work and the launcher never rewrites itself.
$self = [IO.Path]::GetFullPath($PSCommandPath)
if ($self -eq [IO.Path]::GetFullPath((Join-Path $app 'update.ps1'))) {
	$handover = Get-Installed
	if ($handover) {
		$other = Join-Path (Join-Path (Join-Path (Join-Path $app 'versions') $handover) 'remote') 'update.ps1'
		if ((Test-Path -LiteralPath $other -PathType Leaf) -and ([IO.Path]::GetFullPath($other) -ne $self)) {
			& $other @PSBoundParameters
			exit $LASTEXITCODE
		}
	}
}

New-Item -ItemType Directory -Force -Path $app | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $app 'versions') | Out-Null
$current = Get-Installed
$toStart = ''
$failure = ''
Enter-Lock
try {
	$toStart = Update-Install $current
} catch {
	$failure = $_.Exception.Message
} finally {
	Exit-Lock
}
if ($failure) {
	if ($Check -or -not $current) {
		Write-Host "[update] $failure" -ForegroundColor Red
		exit 1
	}
	Write-Host "[update] the update failed: $failure" -ForegroundColor Yellow
	Say "starting the installed version $current"
	$toStart = $current
}
if ($Check -or $NoStart -or -not $toStart) { exit 0 }
Start-Backend $toStart
exit $LASTEXITCODE
