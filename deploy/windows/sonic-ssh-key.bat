@echo off
chcp 65001 >nul
setlocal
title Sonic VPN - ключ без паролей (один раз)

where ssh >nul 2>&1 || (echo ОШИБКА: на Windows не найден ssh. & pause & exit /b 1)

echo ============================================================
echo   Sonic VPN - ключи доступа (делается ОДИН раз)
echo
echo   После этого все скрипты будут работать БЕЗ паролей.
echo   Пароль попросят 2 раза (по одному на каждый сервер).
echo   Вводите пароль - ничего не светится, это нормально.
echo ============================================================
echo.

set KEYFILE=%USERPROFILE%\.ssh\id_ed25519
if exist "%KEYFILE%" (
  echo Ключ уже есть - использую его.
) else (
  if not exist "%USERPROFILE%\.ssh" mkdir "%USERPROFILE%\.ssh"
  ssh-keygen -t ed25519 -N "" -f "%KEYFILE%" -q
  echo Ключ создан.
)
echo.
echo Ставлю ключ на НЕМЕЦКИЙ сервер (введите пароль один раз):
type "%KEYFILE%.pub" | ssh -o StrictHostKeyChecking=accept-new root@185.125.102.135 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
echo.
echo Ставлю ключ на РУССКИЙ сервер (введите пароль один раз):
type "%KEYFILE%.pub" | ssh -o StrictHostKeyChecking=accept-new root@87.249.49.204 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
echo.
echo ============================================================
echo   ГОТОВО! Теперь sonic-launch.bat и sonic-doctor.bat
echo   работают без запроса паролей.
echo ============================================================
pause
