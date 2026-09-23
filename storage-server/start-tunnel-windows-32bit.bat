@echo off
setlocal
title Lumin Cloudflare Tunnel - 32-bit Windows
cd /d "%~dp0"

set "CLOUDFLARED_EXE=%~dp0cloudflared.exe"
set "CLOUDFLARED_DOWNLOAD=%~dp0cloudflared-windows-386.download.exe"
set "CLOUDFLARED_URL=https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-386.exe"

echo ==============================================================
echo     LUMIN CLOUDFLARE TUNNEL - 32-BIT WINDOWS
echo ==============================================================
echo.

if not exist "%CLOUDFLARED_EXE%" goto :DOWNLOAD

echo [*] Checking whether the installed cloudflared executable is 32-bit...
powershell -NoLogo -NoProfile -Command "$path = $env:CLOUDFLARED_EXE; try { $bytes = [IO.File]::ReadAllBytes($path); $pe = [BitConverter]::ToInt32($bytes, 0x3c); $machine = [BitConverter]::ToUInt16($bytes, $pe + 4); if ($machine -eq 0x014c) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 goto :REPLACE_WRONG_ARCHITECTURE

"%CLOUDFLARED_EXE%" --version >nul 2>nul
if not errorlevel 1 goto :RUN_TUNNEL

echo [!] The existing 32-bit cloudflared executable cannot run.
echo [*] Downloading a fresh official copy...
goto :DOWNLOAD

:REPLACE_WRONG_ARCHITECTURE
echo [!] The existing cloudflared executable is not the 32-bit version.
echo [*] Downloading the correct 32-bit version without launching the incompatible file...
goto :DOWNLOAD

:DOWNLOAD
echo [*] Downloading the official Cloudflare 32-bit Windows binary...
powershell -NoLogo -NoProfile -Command "$ErrorActionPreference = 'Stop'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile($env:CLOUDFLARED_URL, $env:CLOUDFLARED_DOWNLOAD)"
if errorlevel 1 goto :DOWNLOAD_FAILED
if not exist "%CLOUDFLARED_DOWNLOAD%" goto :DOWNLOAD_FAILED

"%CLOUDFLARED_DOWNLOAD%" --version >nul 2>nul
if errorlevel 1 goto :INCOMPATIBLE

move /y "%CLOUDFLARED_DOWNLOAD%" "%CLOUDFLARED_EXE%" >nul
if errorlevel 1 goto :DOWNLOAD_FAILED
echo [OK] 32-bit cloudflared downloaded and verified.
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
echo [ERROR] The downloaded 32-bit executable cannot run on this PC.
echo Check that this computer is running Windows 10 or Windows 11.
pause
exit /b 1
