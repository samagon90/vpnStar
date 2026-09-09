@echo off
chcp 65001 >nul
setlocal
title Sonic VPN - диагностика обоих серверов

where ssh >nul 2>&1 || (echo ОШИБКА: на Windows не найден ssh. & pause & exit /b 1)

echo ============================================================
echo   Sonic VPN - диагностика (проверяем оба сервера)
echo   Результат откроется в Блокноте - пришлите мне его,
echo   если что-то работает не так.
echo ============================================================
echo.

set LOG=%TEMP%\sonic-doctor.log
del "%LOG%" 2>nul

echo === ДИАГНОСТИКА: %date% %time% ===>> "%LOG%"
echo.>> "%LOG%"
echo ---- НЕМЕЦКИЙ сервер (3x-ui) ---->> "%LOG%"
ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 root@185.125.102.135 "echo '-- settings --'; x-ui settings 2>/dev/null | head -20; echo; echo '-- firewall --'; ufw status 2>/dev/null | head -12" >> "%LOG%" 2>&1
echo.>> "%LOG%"
echo ---- РУССКИЙ сервер (сайт) ---->> "%LOG%"
ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 root@87.249.49.204 "echo '-- health --'; curl -s --max-time 5 http://127.0.0.1:3000/api/health; echo; echo '-- pm2 --'; pm2 list 2>/dev/null | head -8; echo; echo '-- последние логи --'; pm2 logs sonicvpn --nostream --lines 15 2>/dev/null" >> "%LOG%" 2>&1

echo.
echo Готово - результат открывается в Блокноте.
notepad "%LOG%"
pause
