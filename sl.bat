@echo off
setlocal
title Sonic VPN
if not exist "%~dp0sl.ps1" (echo sl.ps1 not found next to this bat & pause & exit /b 1)powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sl.ps1"
pause
