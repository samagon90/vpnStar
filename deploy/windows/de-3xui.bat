@echo off
chcp 65001 >nul
setlocal
title Sonic VPN - только немецкий сервер (3x-ui)

where ssh >nul 2>&1 || (echo ОШИБКА: на Windows не найден ssh. & pause & exit /b 1)

echo ============================================================
echo   Sonic VPN - настройка НЕМЕЦКОГО сервера (3x-ui)
echo   В конце будет блок "ГОТОВО" с Public Key -
echo   он нужен для ru-site.bat (следующий шаг).
echo ============================================================
echo.

ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 root@185.125.102.135 "curl -fsSL -o /root/xui-setup.sh https://raw.githubusercontent.com/samagon90/vpnStar/arena/01a05219-vpnstar/deploy/xui-setup.sh ^&^& bash /root/xui-setup.sh 12345678 12345678 87.249.49.204"

echo.
echo Если выше "ГОТОВО" - скопируйте Public Key и запустите ru-site.bat.
echo Если "Вход не удался" - подождите 10 минут и запустите этот файл ещё раз.
pause
