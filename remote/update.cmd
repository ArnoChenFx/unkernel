@echo off
rem SPDX-License-Identifier: GPL-2.0-or-later
rem Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
rem Updates the remote kernel backend from the fork's newest release, then starts it (update.ps1),
rem for example: update.cmd -Check    or    update.cmd -NoStart
setlocal
set "PSModulePath=%USERPROFILE%\Documents\WindowsPowerShell\Modules;%ProgramFiles%\WindowsPowerShell\Modules;%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %*
if errorlevel 1 pause
