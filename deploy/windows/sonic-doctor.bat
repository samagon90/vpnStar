@echo off
setlocal
title Sonic VPN - diagnostic

where ssh >nul 2>&1 || (echo ERROR: ssh client not found on this Windows. & pause & exit /b 1)

echo ============================================================
echo   Sonic VPN - DIAGNOSTIC (checks both servers)
echo
echo   The result opens in Notepad.
echo   If something is broken, send me that Notepad text.
echo ============================================================
echo.

set LOG=%TEMP%\sonic-doctor.log
del "%LOG%" 2>nul

echo === DIAGNOSTIC: %date% %time% ===>> "%LOG%"
echo.>> "%LOG%"
echo ---- GERMANY server (3x-ui) ---->> "%LOG%"
ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 root@185.125.102.135 "echo '-- settings --'; x-ui settings 2>/dev/null | head -20; echo; echo '-- firewall --'; ufw status 2>/dev/null | head -12" >> "%LOG%" 2>&1
echo.>> "%LOG%"
echo ---- RUSSIA server (site) ---->> "%LOG%"
ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 root@87.249.49.204 "echo '-- health --'; curl -s --max-time 5 http://127.0.0.1:3000/api/health; echo; echo '-- pm2 --'; pm2 list 2>/dev/null | head -8; echo; echo '-- recent logs --'; pm2 logs sonicvpn --nostream --lines 15 2>/dev/null" >> "%LOG%" 2>&1

echo.
echo Done - the result opens in Notepad now.
notepad "%LOG%"
pause
