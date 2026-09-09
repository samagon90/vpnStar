@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title Sonic VPN - запуск всех серверов одной кнопкой

where ssh >nul 2>&1 || (echo ОШИБКА: на Windows не найден ssh. & pause & exit /b 1)

echo ============================================================
echo   Sonic VPN - ЗАПУСК ОДНОЙ КНОПКОЙ
echo
echo   Пароль попросят 2 раза: немецкий и русский серверы.
echo   Вводите пароль - НИЧЕГО НЕ СВЕТИТСЯ, это нормально,
echo   просто печатайте и жмите Enter.
echo ============================================================
echo.
echo [1/2] Немецкий сервер: настраиваем 3x-ui ...
ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 root@185.125.102.135 "curl -fsSL -o /root/xui-setup.sh https://raw.githubusercontent.com/samagon90/vpnStar/arena/01a05219-vpnstar/deploy/xui-setup.sh ^&^& bash /root/xui-setup.sh 12345678 12345678 87.249.49.204" > "%TEMP%\sonic-de.log" 2>&1
findstr /c:"__SONIC_XUI_OK__" "%TEMP%\sonic-de.log" >nul
if errorlevel 1 (
  echo.
  echo X Немецкий сервер: не завершился.
  echo   Подробности открыты в Блокноте - пришлите мне последние 15 строк.
  notepad "%TEMP%\sonic-de.log"
  pause
  exit /b 1
)
for /f "usebackq tokens=1,* delims=:" %%a in (`findstr /c:"Public Key" "%TEMP%\sonic-de.log"`) do set "PUBKEY=%%b"
for /f "tokens=*" %%i in ("!PUBKEY!") do set "PUBKEY=%%i"
if not defined PUBKEY (
  echo.
  echo X В выводе немецкого сервера не нашёлся Public Key.
  notepad "%TEMP%\sonic-de.log"
  pause
  exit /b 1
)
echo   Готово. Public Key получен, передаём на русский сервер.
echo.
echo [2/2] Русский сервер: ставим сайт, базу и админку ...
ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 root@87.249.49.204 "curl -fsSL -o /root/app-setup.sh https://raw.githubusercontent.com/samagon90/vpnStar/arena/01a05219-vpnstar/deploy/app-setup.sh ^&^& bash /root/app-setup.sh 12345678 12345678 !PUBKEY!" > "%TEMP%\sonic-ru.log" 2>&1
findstr /c:"__SONIC_SITE_OK__" "%TEMP%\sonic-ru.log" >nul
if errorlevel 1 (
  echo.
  echo X Русский сервер: не завершился.
  echo   Подробности открыты в Блокноте - пришлите мне последние 15 строк.
  notepad "%TEMP%\sonic-ru.log"
  pause
  exit /b 1
)
type "%TEMP%\sonic-ru.log"
echo.
echo ============================================================
echo   ВСЁ ГОТОВО! Откройте в браузере:
echo
echo     http://87.249.49.204/
echo
echo   (Токен админки - в Блокноте sonic-ru.log выше)
echo ============================================================
pause
