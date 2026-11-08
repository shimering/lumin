@echo off
setlocal enabledelayedexpansion
title Setup Tailscale Funnel for Lumin Storage
cd /d "%~dp0"

echo ================================================================
echo       LUMIN STORAGE SERVER - TAILSCALE FUNNEL SETUP
echo ================================================================
echo.

where tailscale >nul 2>nul
if errorlevel 1 (
    echo [!] Tailscale CLI was not found on this computer.
    echo.
    echo Would you like to install Tailscale now via Windows Package Manager?
    set /p "INSTALL_CHOICE=Install Tailscale now? (Y/N): "
    if /i "!INSTALL_CHOICE!"=="Y" (
        echo [*] Installing Tailscale...
        winget install tailscale.tailscale
        echo.
        echo [OK] Installation command finished.
        echo Please sign in to the Tailscale app from your system tray,
        echo then run this script again.
        pause
        exit /b 0
    ) else (
        echo Please download and install Tailscale from:
        echo https://tailscale.com/download/windows
        pause
        exit /b 1
    )
)

echo [*] Reading port from config.json...
set "PORT=5000"
for /f "tokens=2 delims=:, " %%a in ('findstr /i "\"port\"" config.json 2^>nul') do (
    set "PORT=%%~a"
)

echo [*] Target local port: %PORT%
echo.
echo [*] Enabling persistent Tailscale Funnel for port %PORT%...
echo     (This runs in the background and stays active across reboots)
echo.

tailscale funnel --bg %PORT%

echo.
echo ================================================================
echo [*] Current Tailscale Funnel Status:
echo ================================================================
tailscale funnel status
echo.
echo Look for the public address above (e.g. https://your-pc.tailnet.ts.net)
echo.
echo In Lumin App:
echo 1. Open Admin -^> Storage ^& X-Rays.
echo 2. Enter your Tailscale Funnel HTTPS URL.
echo 3. Enter your Clinic Secret Key (from config.json).
echo 4. Click Test Connection -^> Save Settings.
echo ================================================================
echo.
pause
