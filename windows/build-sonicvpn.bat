@echo off
setlocal EnableExtensions
title Sonic VPN for Windows - setup

set "BASE=%USERPROFILE%\SonicVPN"
set "PAGE=https://samagon90.github.io/vpnStar"
set "ELECTRON_URL=https://github.com/electron/electron/releases/download/v43.7.0/electron-v43.7.0-win32-x64.zip"
set "TMPZ=%TEMP%\sonicvpn-electron.zip"

echo ============================================================
echo   Sonic VPN for Windows
echo   App folder: %BASE%
echo ============================================================
echo.

if exist "%BASE%\SonicVPN.exe" (
  echo Old version found - reinstalling...
  rmdir /s /q "%BASE%" 2>nul
)

if not exist "%BASE%" mkdir "%BASE%"
if not exist "%BASE%\resources" mkdir "%BASE%\resources"

echo [1/5] Downloading app files (small)...
set "APPDIR=%BASE%\resources\app"
if not exist "%APPDIR%\renderer\js" mkdir "%APPDIR%\renderer\js"
call :fetch "%APPDIR%\package.json" "app/package.json"
call :fetch "%APPDIR%\main.js" "app/main.js"
call :fetch "%APPDIR%\preload.js" "app/preload.js"
call :fetch "%APPDIR%\diagnostics.js" "app/diagnostics.js"
call :fetch "%APPDIR%\xray-config.js" "app/xray-config.js"
call :fetch "%APPDIR%\renderer\index.html" "app/renderer/index.html"
call :fetch "%APPDIR%\renderer\style.css" "app/renderer/style.css"
call :fetch "%APPDIR%\renderer\ui.js" "app/renderer/ui.js"
call :fetch "%APPDIR%\renderer\js\jsQR.js" "app/renderer/js/jsQR.js"
if not exist "%APPDIR%\main.js" (
  echo.
  echo ERROR: could not download app files. Check internet.
  pause
  exit /b 1
)

if exist "%BASE%\electron.exe" goto :after-electron
echo [2/5] Downloading Electron (144 MB)...
echo       Can take 3-15 minutes. Progress below. Do not close window.
echo.
curl -fL --retry 2 -o "%TMPZ%" "%ELECTRON_URL%"
if errorlevel 1 (
  echo.
  echo curl failed - trying PowerShell downloader...
  powershell -NoProfile -Command "iwr '%ELECTRON_URL%' -OutFile '%TMPZ%' -UseBasicParsing"
)
if not exist "%TMPZ%" (
  echo.
  echo ERROR: could not download Electron. Check internet/VPN.
  pause
  exit /b 1
)
echo [3/5] Unpacking Electron...
tar -xf "%TMPZ%" -C "%BASE%"
if errorlevel 1 (
  echo tar failed - trying PowerShell...
  powershell -NoProfile -Command "Expand-Archive -LiteralPath '%TMPZ%' -DestinationPath '%BASE%' -Force"
)
if not exist "%BASE%\electron.exe" (
  echo.
  echo ERROR: electron.exe not found after unpack.
  pause
  exit /b 1
)
del "%TMPZ%" 2>nul
goto :check-app
:after-electron
echo [2/5]+[3/5] Electron already unpacked - skipping download.

:check-app
echo [4/5] Checking app files...
if not exist "%BASE%\resources\app\main.js" (
  echo.
  echo ERROR: resources\app\main.js not found.
  pause
  exit /b 1
)
if not exist "%BASE%\resources\app\renderer\js\jsQR.js" (
  echo.
  echo ERROR: app files are not complete.
  pause
  exit /b 1
)

echo [5/5] Creating desktop shortcut...
if exist "%BASE%\electron.exe" move /y "%BASE%\electron.exe" "%BASE%\SonicVPN.exe" >nul
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'SonicVPN.lnk')); $sc.TargetPath = '%BASE%\SonicVPN.exe'; $sc.WorkingDirectory = '%BASE%'; $sc.Description = 'Sonic VPN for Windows'; $sc.Save()"

echo.
echo ============================================================
echo   DONE!
echo   Shortcut "SonicVPN" is on your desktop. Double-click it.
echo   If Windows warns: More info - Run.
echo   First start downloads xray core (~40 MB) by itself.
echo ============================================================
pause
endlocal
exit /b 0

rem ---------- subroutine: download one file (curl, fallback iwr) ----------
:fetch
set "FDEST=%~1"
set "FURL=%PAGE%/windows/%~2"
curl -fL --retry 2 -sS -o "%FDEST%" "%FURL%" 2>nul
if errorlevel 1 (
  if exist "%FDEST%" del "%FDEST%" 2>nul
  powershell -NoProfile -Command "iwr '%FURL%' -OutFile '%FDEST%' -UseBasicParsing" 2>nul
)
if not exist "%FDEST%" echo   ! not downloaded: %~2
exit /b 0
