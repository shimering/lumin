@echo off
title Lumin Cloudflare Tunnel
cd /d "%~dp0"

echo ===================================================
echo     LUMIN DENTAL CLINIC - CLOUDFLARE TUNNEL
echo ===================================================
echo.

where cloudflared >nul 2>nul
if %errorlevel% equ 0 (
    set CLOUDFLARED_CMD=cloudflared
    goto :RUN_TUNNEL
)

if exist "cloudflared.exe" (
    set CLOUDFLARED_CMD=.\cloudflared.exe
    goto :RUN_TUNNEL
)

echo [*] cloudflared not found. Downloading official Cloudflare Tunnel binary...
echo [*] Downloading from https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe ...
powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', 'cloudflared.exe')"

if not exist "cloudflared.exe" (
    echo [!] Download failed. Please download cloudflared.exe manually and place it in this folder.
    pause
    exit /b 1
)
echo [OK] cloudflared downloaded successfully!
echo.
set CLOUDFLARED_CMD=.\cloudflared.exe

:RUN_TUNNEL
echo [*] Starting Cloudflare Tunnel connected to http://localhost:5000 ...
echo [*] Look for the line below containing: https://xxxx.trycloudflare.com
echo [*] Copy that URL and paste it into Lumin Admin -> Storage & X-Rays tab!
echo ==============================================================================
echo.

%CLOUDFLARED_CMD% tunnel --url http://localhost:5000

pause
