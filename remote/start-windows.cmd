@echo off
rem SPDX-License-Identifier: MIT
rem Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
rem Starts the remote kernel backend (start-windows.ps1) with the options given,
rem for example: start-windows.cmd -Data E:\tmp\unkernel-data\img\vm1.img
setlocal
set "PSModulePath=%USERPROFILE%\Documents\WindowsPowerShell\Modules;%ProgramFiles%\WindowsPowerShell\Modules;%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows.ps1" %*
if errorlevel 1 pause
