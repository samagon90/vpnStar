@echo off
setlocal
title Sonic VPN - German server only (3x-ui)

where ssh >nul 2>&1 || (echo ERROR: ssh client not found on this Windows. & pause & exit /b 1)

echo ============================================================
echo   Sonic VPN - GERMANY server only (3x-ui)
echo
echo   At the end you will see a "Public Key:" line -
echo   copy it, it is needed for ru-site.bat (step 2).
echo ============================================================
echo.

ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 root@185.125.102.135 "curl -fsSL -o /root/xui-setup.sh https://raw.githubusercontent.com/samagon90/vpnStar/arena/01a05219-vpnstar/deploy/xui-setup.sh ^&^& bash /root/xui-setup.sh 12345678 12345678 87.249.49.204"

echo.
echo If you see "Public Key:" above - copy it and run ru-site.bat.
echo If you see "login failed" - wait 10 minutes and run this again.
pause
