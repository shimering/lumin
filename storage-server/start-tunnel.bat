@echo off
setlocal
title Lumin Cloudflare Tunnel - Automatic Windows Detection
cd /d "%~dp0"

echo ==============================================================
echo     LUMIN DENTAL CLINIC - CLOUDFLARE TUNNEL
echo ==============================================================
echo [*] Detecting whether Windows is 32-bit or 64-bit...

powershell -NoLogo -NoProfile -Command "if ([Environment]::Is64BitOperatingSystem) { exit 0 } else { exit 1 }"
if errorlevel 1 goto :WINDOWS_32BIT

echo [OK] 64-bit Windows detected.
call "%~dp0start-tunnel-windows-64bit.bat" %*
exit /b %errorlevel%

:WINDOWS_32BIT
echo [OK] 32-bit Windows detected.
call "%~dp0start-tunnel-windows-32bit.bat" %*
exit /b %errorlevel%
