@echo off
setlocal
title Lumin Local Storage Server
cd /d "%~dp0"

echo ===================================================
echo     LUMIN DENTAL CLINIC - LOCAL STORAGE SERVER
echo ===================================================
echo.

call "%~dp0prepare-python.bat"
if errorlevel 1 goto :PYTHON_FAILED
if /i "%~1"=="--check-only" exit /b 0

echo [*] Starting Storage Server...
echo [*] Accessible locally on: http://localhost:5000
echo [*] Press Ctrl+C anytime to stop.
echo.
"%~dp0.venv\Scripts\python.exe" "%~dp0server.py"
set "SERVER_EXIT=%errorlevel%"

if not "%SERVER_EXIT%"=="0" echo [!] Storage Server stopped with error code %SERVER_EXIT%.
pause
exit /b %SERVER_EXIT%

:PYTHON_FAILED
echo.
echo [ERROR] Storage Server could not prepare Python.
pause
exit /b 1
