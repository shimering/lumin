@echo off
setlocal
cd /d "%~dp0"
title Lumin - Repair Tailscale Public Access

if exist "%~dp0.venv\Scripts\python.exe" (
    "%~dp0.venv\Scripts\python.exe" "%~dp0tailscale_access.py" --repair
) else (
    py -3 "%~dp0tailscale_access.py" --repair
)
set "ACCESS_RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %ACCESS_RESULT%
