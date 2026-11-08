@echo off
setlocal
cd /d "%~dp0"

if exist "LuminServerStation.exe" (
    start "" "LuminServerStation.exe"
    exit /b 0
)

if exist "LuminServerStation\LuminServerStation.exe" (
    start "" "LuminServerStation\LuminServerStation.exe"
    exit /b 0
)

set "PY_EXE=..\storage-server\.venv\Scripts\python.exe"
if exist "%PY_EXE%" (
    start "" "%PY_EXE%" manager_app.py
    exit /b 0
)

set "PY_EXE=pythonw.exe"
start "" "%PY_EXE%" manager_app.py
exit /b 0
