@echo off
chcp 65001 >nul
setlocal
title Sonic VPN - только русский сервер (сайт)

where ssh >nul 2>&1 || (echo ОШИБКА: на Windows не найден ssh. & pause & exit /b 1)

echo ============================================================
echo   Sonic VPN - установка сайта на РУССКИЙ сервер
echo ============================================================
echo.

if "%~1"=="" (
  set /p PUBKEY="Вставьте Public Key (строка "Public Key:" из de-3xui.bat) и Enter: "
) else (
  set "PUBKEY=%~1"
)
if "%PUBKEY%"=="" (
  echo ОШИБКА: нужен Public Key. Запустите сначала de-3xui.bat.
  pause
  exit /b 1
)

ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 root@87.249.49.204 "curl -fsSL -o /root/app-setup.sh https://raw.githubusercontent.com/samagon90/vpnStar/arena/01a05219-vpnstar/deploy/app-setup.sh ^&^& bash /root/app-setup.sh 12345678 12345678 %PUBKEY%"

echo.
echo Если выше "САЙТ ЖИВ" - откройте в браузере http://87.249.49.204/
pause
