@echo off
setlocal
title Sonic VPN - Russia server only (site)

where ssh >nul 2>&1 || (echo ERROR: ssh client not found on this Windows. & pause & exit /b 1)

echo ============================================================
echo   Sonic VPN - RUSSIA server only (site + admin)
echo ============================================================
echo.

if "%~1"=="" (
  set /p PUBKEY="Paste the Public Key (the line Public Key: from de-3xui.bat), then Enter: "
) else (
  set "PUBKEY=%~1"
)
if "%PUBKEY%"=="" (
  echo ERROR: Public Key is required. Run de-3xui.bat first.
  pause
  exit /b 1
)

ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 root@87.249.49.204 "curl -fsSL -o /root/app-setup.sh https://raw.githubusercontent.com/samagon90/vpnStar/arena/01a05219-vpnstar/deploy/app-setup.sh ^&^& bash /root/app-setup.sh 12345678 12345678 %PUBKEY%"

echo.
echo If you see the block at the end - open http://87.249.49.204/
pause
