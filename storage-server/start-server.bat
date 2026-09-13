@echo off
title Lumin Local Storage Server
cd /d "%~dp0"

echo ===================================================
echo     LUMIN DENTAL CLINIC - LOCAL STORAGE SERVER
echo ===================================================
echo.

if not exist ".venv\Scripts\python.exe" (
    echo [*] Setting up virtual environment for the first time...
    python -m venv .venv
    if errorlevel 1 (
        echo [!] Failed to create virtual environment. Please ensure Python is installed.
        pause
        exit /b 1
    )
    echo [*] Installing required packages...
    .venv\Scripts\pip.exe install -r requirements.txt
    if errorlevel 1 (
        echo [!] Failed to install dependencies.
        pause
        exit /b 1
    )
)

echo [*] Starting Storage Server...
echo [*] Accessible locally on: http://localhost:5000
echo [*] Press Ctrl+C anytime to stop.
echo.
.venv\Scripts\python.exe server.py

pause
