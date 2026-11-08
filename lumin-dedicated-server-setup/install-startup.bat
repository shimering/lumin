@echo off
setlocal
title Install Lumin Storage Server on Windows Startup
cd /d "%~dp0"

echo ================================================================
echo    LUMIN STORAGE SERVER - WINDOWS AUTO-STARTUP INSTALLER
echo ================================================================
echo.

set "TARGET_VBS=%~dp0start-server-background.vbs"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\LuminStorageServer.lnk"

echo [*] Verifying Python environment...
call "%~dp0prepare-python.bat"
if errorlevel 1 (
    echo [ERROR] Python environment could not be prepared.
    pause
    exit /b 1
)

echo [*] Creating Windows Startup shortcut...
powershell -NoLogo -NoProfile -Command ^
    "$ws = New-Object -ComObject WScript.Shell; " ^
    "$s = $ws.CreateShortcut('%SHORTCUT_PATH%'); " ^
    "$s.TargetPath = '%TARGET_VBS%'; " ^
    "$s.WorkingDirectory = '%~dp0'; " ^
    "$s.Description = 'Lumin Dental Practice Local Storage Server'; " ^
    "$s.Save()"

if exist "%SHORTCUT_PATH%" (
    echo [OK] Storage Server shortcut installed in Windows Startup folder!
    echo      Path: "%SHORTCUT_PATH%"
) else (
    echo [ERROR] Failed to create shortcut in Startup folder.
    pause
    exit /b 1
)

echo.
echo [*] Checking Tailscale status...
where tailscale >nul 2>nul
if not errorlevel 1 (
    echo [OK] Tailscale is installed on this PC.
) else (
    echo [INFO] Tailscale is not yet installed on this PC.
    echo        You can install it by running:
    echo          winget install tailscale.tailscale
    echo        or download from: https://tailscale.com/download/windows
)

echo.
echo ================================================================
echo  INSTALLATION COMPLETE!
echo.
echo  The storage server will now start automatically in the
echo  background whenever Windows boots up (no black window).
echo.
echo  To start it right now without restarting your PC, double-click:
echo    "%TARGET_VBS%"
echo ================================================================
echo.
pause
