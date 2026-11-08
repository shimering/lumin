@echo off
setlocal
cd /d "%~dp0"
echo =========================================================
echo   Building Lumin Server Station Standalone Executable
echo =========================================================
echo.

set "PY_EXE=..\storage-server\.venv\Scripts\python.exe"
if not exist "%PY_EXE%" (
    set "PY_EXE=python"
)

"%PY_EXE%" build_exe.py
pause
