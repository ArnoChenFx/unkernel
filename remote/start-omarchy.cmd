@echo off
rem SPDX-License-Identifier: MIT
rem Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
rem Starts the Omarchy image in remote mode on its own data disk (start-omarchy.ps1).
setlocal
set "PSModulePath=%USERPROFILE%\Documents\WindowsPowerShell\Modules;%ProgramFiles%\WindowsPowerShell\Modules;%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-omarchy.ps1" %*
if errorlevel 1 pause
