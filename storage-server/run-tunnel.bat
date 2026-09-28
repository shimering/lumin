@echo off
setlocal
cd /d "%~dp0"

call "%~dp0prepare-python.bat"
if errorlevel 1 goto :PYTHON_FAILED

"%~dp0.venv\Scripts\python.exe" -u "%~dp0tunnel_sync.py" --tunnel-only %*
set "TUNNEL_EXIT=%errorlevel%"
pause
exit /b %TUNNEL_EXIT%

:PYTHON_FAILED
echo [ERROR] Could not prepare Python to monitor the tunnel.
pause
exit /b 1
