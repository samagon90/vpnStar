@echo off
setlocal
title Sonic VPN - ssh keys (one time)

where ssh >nul 2>&1 || (echo ERROR: ssh client not found on this Windows. & pause & exit /b 1)

echo ============================================================
echo   Sonic VPN - SSH KEYS (do this ONE time)
echo
echo   After this, all launch scripts work WITHOUT passwords.
echo   The password is asked 2 times
echo   (German server, then Russian server).
echo   Typing the password shows nothing - that is normal.
echo ============================================================
echo.

set KEYFILE=%USERPROFILE%\.ssh\id_ed25519
if exist "%KEYFILE%" (
  echo Key already exists - using it.
) else (
  if not exist "%USERPROFILE%\.ssh" mkdir "%USERPROFILE%\.ssh"
  ssh-keygen -t ed25519 -N "" -f "%KEYFILE%" -q
  echo Key created.
)
echo.
echo Installing the key on the GERMANY server (password 1 time):
type "%KEYFILE%.pub" | ssh -o StrictHostKeyChecking=accept-new root@185.125.102.135 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
echo.
echo Installing the key on the RUSSIA server (password 1 time):
type "%KEYFILE%.pub" | ssh -o StrictHostKeyChecking=accept-new root@87.249.49.204 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
echo.
echo ============================================================
echo   DONE! Now sonic-launch.bat and sonic-doctor.bat
echo   work without asking passwords.
echo ============================================================
pause
