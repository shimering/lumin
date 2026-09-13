@echo off
title Lumin Storage & Universal Access
cd /d "%~dp0"

echo ===================================================
echo     LUMIN DENTAL CLINIC - STORAGE & TUNNEL
echo ===================================================
echo.

if not exist ".venv\Scripts\python.exe" (
    echo [*] Setting up environment for the first time...
    python -m venv .venv
    .venv\Scripts\pip.exe install -r requirements.txt
)

.venv\Scripts\python.exe tunnel_sync.py

pause
