@echo off
setlocal
title Remove Lumin Storage Server from Windows Startup
cd /d "%~dp0"

echo ================================================================
echo    REMOVE LUMIN STORAGE SERVER FROM WINDOWS STARTUP
echo ================================================================
echo.

set "SHORTCUT_PATH=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\LuminStorageServer.lnk"

if exist "%SHORTCUT_PATH%" (
    del /f /q "%SHORTCUT_PATH%"
    echo [OK] Removed Lumin Storage Server from Windows Startup.
) else (
    echo [INFO] Startup shortcut was not found.
)

echo.
pause
