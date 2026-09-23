@echo off
setlocal
title Lumin Cloudflare Tunnel - 64-bit Windows
cd /d "%~dp0"

set "CLOUDFLARED_EXE=%~dp0cloudflared.exe"
set "CLOUDFLARED_DOWNLOAD=%~dp0cloudflared-windows-amd64.download.exe"
set "CLOUDFLARED_URL=https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

echo ==============================================================
echo     LUMIN CLOUDFLARE TUNNEL - 64-BIT WINDOWS
echo ==============================================================
echo.

powershell -NoLogo -NoProfile -Command "if ([Environment]::Is64BitOperatingSystem) { exit 0 } else { exit 1 }"
if errorlevel 1 goto :WRONG_ARCHITECTURE

if not exist "%CLOUDFLARED_EXE%" goto :DOWNLOAD

echo [*] Checking the installed 64-bit cloudflared executable...
"%CLOUDFLARED_EXE%" --version >nul 2>nul
if not errorlevel 1 goto :RUN_TUNNEL

echo [!] The existing 64-bit cloudflared executable cannot run.
echo [*] Downloading a fresh official copy...
goto :DOWNLOAD

:DOWNLOAD
echo [*] Downloading the official Cloudflare 64-bit Windows binary...
powershell -NoLogo -NoProfile -Command "$ErrorActionPreference = 'Stop'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile($env:CLOUDFLARED_URL, $env:CLOUDFLARED_DOWNLOAD)"
if errorlevel 1 goto :DOWNLOAD_FAILED
if not exist "%CLOUDFLARED_DOWNLOAD%" goto :DOWNLOAD_FAILED

"%CLOUDFLARED_DOWNLOAD%" --version >nul 2>nul
if errorlevel 1 goto :INCOMPATIBLE

move /y "%CLOUDFLARED_DOWNLOAD%" "%CLOUDFLARED_EXE%" >nul
if errorlevel 1 goto :DOWNLOAD_FAILED
echo [OK] 64-bit cloudflared downloaded and verified.
echo.

:RUN_TUNNEL
"%CLOUDFLARED_EXE%" --version
if /i "%~1"=="--check-only" exit /b 0

echo.
echo [*] Starting Cloudflare Tunnel connected to http://localhost:5000 ...
echo [*] Look for the line containing: https://xxxx.trycloudflare.com
echo [*] Copy that URL into Lumin Admin -^> Storage ^& X-Rays.
echo ==============================================================
echo.

"%CLOUDFLARED_EXE%" tunnel --url http://localhost:5000
set "TUNNEL_EXIT=%errorlevel%"
echo.
if not "%TUNNEL_EXIT%"=="0" echo [!] Cloudflare Tunnel stopped with error code %TUNNEL_EXIT%.
pause
exit /b %TUNNEL_EXIT%

:WRONG_ARCHITECTURE
echo [ERROR] This computer is running 32-bit Windows.
echo Run start-tunnel-windows-32bit.bat instead.
pause
exit /b 1

:DOWNLOAD_FAILED
echo.
echo [ERROR] cloudflared could not be downloaded.
echo Check the internet connection, then run this file again.
echo Manual download:
echo %CLOUDFLARED_URL%
pause
exit /b 1

:INCOMPATIBLE
echo.
echo [ERROR] The downloaded 64-bit executable cannot run on this PC.
echo Run start-tunnel-windows-32bit.bat if Windows itself is 32-bit.
pause
exit /b 1
