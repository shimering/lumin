@echo off
setlocal
title Lumin Storage ^& Universal Access
cd /d "%~dp0"

echo ===================================================
echo     LUMIN DENTAL CLINIC - STORAGE ^& TUNNEL
echo ===================================================
echo.

call "%~dp0prepare-python.bat"
if errorlevel 1 goto :PYTHON_FAILED

call "%~dp0start-tunnel.bat" --check-only
if errorlevel 1 goto :TUNNEL_FAILED
title Lumin Storage ^& Universal Access
if /i "%~1"=="--check-only" exit /b 0

"%~dp0.venv\Scripts\python.exe" "%~dp0tunnel_sync.py"
set "STORAGE_EXIT=%errorlevel%"

if not "%STORAGE_EXIT%"=="0" echo [!] Storage and tunnel process stopped with error code %STORAGE_EXIT%.
pause
exit /b %STORAGE_EXIT%

:PYTHON_FAILED
echo.
echo [ERROR] Storage and tunnel process could not prepare Python.
pause
exit /b 1

:TUNNEL_FAILED
echo.
echo [ERROR] Storage and tunnel process could not prepare Cloudflare Tunnel.
pause
exit /b 1
