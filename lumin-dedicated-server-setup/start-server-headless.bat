@echo off
setlocal
cd /d "%~dp0"
call "%~dp0prepare-python.bat" >nul 2>&1
"%~dp0.venv\Scripts\python.exe" -u "%~dp0server.py" >> "%~dp0server.log" 2>&1
