@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Sonic VPN for Windows - сборка

set "BASE=%USERPROFILE%\SonicVPN"
set "PAGE=https://samagon90.github.io/vpnStar"
set "ELECTRON_URL=https://github.com/electron/electron/releases/download/v43.7.0/electron-v43.7.0-win32-x64.zip"
set "TMPZ=%TEMP%\sonicvpn-electron.zip"

echo ============================================================
echo   Sonic VPN for Windows
echo   Папка приложения: %BASE%
echo ============================================================
echo.

if exist "%BASE%\SonicVPN.exe" (
  echo Обнаружена старая версия - переустанавливаем...
  rmdir /s /q "%BASE%" 2>nul
)

if not exist "%BASE%" mkdir "%BASE%"
if not exist "%BASE%\resources" mkdir "%BASE%\resources"

rem ---- [1/5] файлы приложения (9 файлов, ~350 КБ) ----
echo [1/5] Скачиваем файлы приложения (мало)...
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
  echo ОШИБКА: не удалось скачать файлы приложения. Проверь интернет.
  pause
  exit /b 1
)

rem ---- [2/5] Electron 144 МБ ----
echo [2/5] Скачиваем Electron (144 МБ)...
echo       Может быть 3-15 минут. Прогресс показан ниже. Не закрывай окно.
echo.
curl -fL --retry 2 -o "%TMPZ%" "%ELECTRON_URL%"
if errorlevel 1 (
  echo.
  echo curl не справился - пробуем стандартным PowerShell-скачивателем...
  powershell -NoProfile -Command "iwr '%ELECTRON_URL%' -OutFile '%TMPZ%' -UseBasicParsing"
)
if not exist "%TMPZ%" (
  echo.
  echo ОШИБКА: не удалось скачать Electron. Проверь интернет/VPN.
  pause
  exit /b 1
)

rem ---- [3/5] распаковка Electron ----
echo [3/5] Распаковываем Electron...
tar -xf "%TMPZ%" -C "%BASE%"
if errorlevel 1 (
  echo tar не справился - пробуем PowerShell...
  powershell -NoProfile -Command "Expand-Archive -LiteralPath '%TMPZ%' -DestinationPath '%BASE%' -Force"
)
if not exist "%BASE%\electron.exe" (
  echo.
  echo ОШИБКА: electron.exe не найден после распаковки.
  pause
  exit /b 1
)
del "%TMPZ%" 2>nul

rem ---- [4/5] проверка файлов приложения ----
echo [4/5] Проверяем файлы приложения...
if not exist "%BASE%\resources\app\main.js" (
  echo.
  echo ОШИБКА: resources\app\main.js не найден.
  pause
  exit /b 1
)
if not exist "%BASE%\resources\app\renderer\js\jsQR.js" (
  echo.
  echo ОШИБКА: не все файлы приложения на месте.
  pause
  exit /b 1
)

rem ---- [5/5] переименование + ярлык ----
echo [5/5] Создаю ярлык на рабочем столе...
if exist "%BASE%\electron.exe" move /y "%BASE%\electron.exe" "%BASE%\SonicVPN.exe" >nul
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'SonicVPN.lnk')); $sc.TargetPath = '%BASE%\SonicVPN.exe'; $sc.WorkingDirectory = '%BASE%'; $sc.Description = 'Sonic VPN for Windows'; $sc.Save()"

echo.
echo ============================================================
echo   ГОТОВО!
echo   Ярлык "SonicVPN" на рабочем столе. Двойной клик - и всё.
echo   Если Windows покажет предупреждение: "Подробнее" - "Запуск".
echo   При первом запуске приложение само скачает ядро xray (~40 МБ).
echo ============================================================
pause
endlocal
exit /b 0

rem ---------- subroutine: скачать один файл (curl, фолбэк iwr) ----------
:fetch
set "FDEST=%~1"
set "FURL=%PAGE%/windows/%~2"
curl -fL --retry 2 -sS -o "%FDEST%" "%FURL%" 2>nul
if errorlevel 1 (
  if exist "%FDEST%" del "%FDEST%" 2>nul
  powershell -NoProfile -Command "iwr '%FURL%' -OutFile '%FDEST%' -UseBasicParsing" 2>nul
)
if not exist "%FDEST%" echo   ! не скачалось: %~2
exit /b 0
