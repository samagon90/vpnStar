@echo off
setlocal
title Sonic VPN - one-click launch
if not exist "%~dp0sonic-launch.ps1" (
  echo The file sonic-launch.ps1 must be next to this .bat on the Desktop.
  echo Run the PowerShell one-liner from the instructions again.
  pause
  exit /b 1
)
if not exist "%~dp0sonic-creds.txt" (
  echo The file sonic-creds.txt must be next to this .bat on the Desktop.
  echo Run the PowerShell one-liner from the instructions again (it creates it).
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sonic-launch.ps1"
echo.
pause
