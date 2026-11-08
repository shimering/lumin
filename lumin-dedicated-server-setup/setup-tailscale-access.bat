@echo off
setlocal
cd /d "%~dp0"
title Lumin - Verify Tailscale Public Access

if exist "%~dp0.venv\Scripts\python.exe" (
    "%~dp0.venv\Scripts\python.exe" "%~dp0tailscale_access.py" --setup --repair
) else (
    py -3 "%~dp0tailscale_access.py" --setup --repair
)
set "ACCESS_RESULT=%ERRORLEVEL%"
echo.
if not "%ACCESS_RESULT%"=="0" echo [!] Setup did not pass. Follow the error above before saving the URL in Lumin.
pause
exit /b %ACCESS_RESULT%
