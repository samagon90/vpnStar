@echo off
setlocal EnableDelayedExpansion
title Sonic VPN - one-click launch

where ssh >nul 2>&1 || (echo ERROR: ssh client not found on this Windows. & pause & exit /b 1)

echo ============================================================
echo   Sonic VPN - ONE-CLICK LAUNCH (both servers)
echo
echo   The password will be asked 2 times
echo   (German server, then Russian server).
echo   When you type the password NOTHING is shown -
echo   that is normal. Just type it and press Enter.
echo
echo   Text from the servers may look broken here -
echo   it is OK. The Notepad logs at the end are correct.
echo ============================================================
echo.
echo [1/2] German server: setting up 3x-ui ...
ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 root@185.125.102.135 "curl -fsSL -o /root/xui-setup.sh https://raw.githubusercontent.com/samagon90/vpnStar/arena/01a05219-vpnstar/deploy/xui-setup.sh ^&^& bash /root/xui-setup.sh 12345678 12345678 87.249.49.204" > "%TEMP%\sonic-de.log" 2>&1
findstr /c:"__SONIC_XUI_OK__" "%TEMP%\sonic-de.log" >nul
if errorlevel 1 (
  echo.
  echo X German server: NOT finished.
  echo   Log opened in Notepad - send me the last 15 lines.
  notepad "%TEMP%\sonic-de.log"
  pause
  exit /b 1
)
for /f "usebackq tokens=1,* delims=:" %%a in (`findstr /c:"Public Key" "%TEMP%\sonic-de.log"`) do set "PUBKEY=%%b"
for /f "tokens=*" %%i in ("!PUBKEY!") do set "PUBKEY=%%i"
if not defined PUBKEY (
  echo.
  echo X Public Key not found in the German server log.
  notepad "%TEMP%\sonic-de.log"
  pause
  exit /b 1
)
echo   OK: Public Key captured. Starting the Russian server ...
echo.
echo [2/2] Russian server: installing the site (code, database, admin) ...
ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 root@87.249.49.204 "curl -fsSL -o /root/app-setup.sh https://raw.githubusercontent.com/samagon90/vpnStar/arena/01a05219-vpnstar/deploy/app-setup.sh ^&^& bash /root/app-setup.sh 12345678 12345678 !PUBKEY!" > "%TEMP%\sonic-ru.log" 2>&1
findstr /c:"__SONIC_SITE_OK__" "%TEMP%\sonic-ru.log" >nul
if errorlevel 1 (
  echo.
  echo X Russian server: NOT finished.
  echo   Log opened in Notepad - send me the last 15 lines.
  notepad "%TEMP%\sonic-ru.log"
  pause
  exit /b 1
)
echo.
echo ============================================================
echo   DONE! Your site is live. Open in your browser:
echo
echo     http://87.249.49.204/
echo
echo   The admin panel token is in the log (Notepad).
echo ============================================================
notepad "%TEMP%\sonic-ru.log"
pause
