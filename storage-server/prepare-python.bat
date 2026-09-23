@echo off
setlocal
cd /d "%~dp0"

set "VENV_PYTHON=%~dp0.venv\Scripts\python.exe"
set "SYSTEM_PYTHON="
set "PYTHON_RESULT=%TEMP%\lumin-python-%RANDOM%-%RANDOM%.txt"

if /i "%~1"=="--find-only" goto :FIND_PYTHON
if not exist "%VENV_PYTHON%" goto :FIND_PYTHON

"%VENV_PYTHON%" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
if errorlevel 1 goto :BROKEN_VENV

echo [OK] Existing Python virtual environment is working.
goto :ENSURE_PACKAGES

:BROKEN_VENV
echo [!] The existing virtual environment belongs to another Python installation.
echo [*] It will be rebuilt using Python installed on this computer.

:FIND_PYTHON
echo [*] Searching for Python 3 on this computer...

py -3 -c "import sys; print(sys.executable)" >"%PYTHON_RESULT%" 2>nul
if errorlevel 1 goto :TRY_PYTHON_COMMAND
set /p "SYSTEM_PYTHON="<"%PYTHON_RESULT%"
call :VALIDATE_PYTHON
if defined SYSTEM_PYTHON goto :PYTHON_FOUND

:TRY_PYTHON_COMMAND
python -c "import sys; print(sys.executable)" >"%PYTHON_RESULT%" 2>nul
if errorlevel 1 goto :TRY_PYTHON3_COMMAND
set /p "SYSTEM_PYTHON="<"%PYTHON_RESULT%"
call :VALIDATE_PYTHON
if defined SYSTEM_PYTHON goto :PYTHON_FOUND

:TRY_PYTHON3_COMMAND
python3 -c "import sys; print(sys.executable)" >"%PYTHON_RESULT%" 2>nul
if errorlevel 1 goto :SEARCH_COMMON_FOLDERS
set /p "SYSTEM_PYTHON="<"%PYTHON_RESULT%"
call :VALIDATE_PYTHON
if defined SYSTEM_PYTHON goto :PYTHON_FOUND

:SEARCH_COMMON_FOLDERS
for %%P in ("%LocalAppData%\Programs\Python\Python*\python.exe") do if not defined SYSTEM_PYTHON set "SYSTEM_PYTHON=%%~fP"
call :VALIDATE_PYTHON
if defined SYSTEM_PYTHON goto :PYTHON_FOUND

for %%P in ("%LocalAppData%\Python\pythoncore-*\python.exe") do if not defined SYSTEM_PYTHON set "SYSTEM_PYTHON=%%~fP"
call :VALIDATE_PYTHON
if defined SYSTEM_PYTHON goto :PYTHON_FOUND

for %%P in ("%ProgramFiles%\Python*\python.exe") do if not defined SYSTEM_PYTHON set "SYSTEM_PYTHON=%%~fP"
call :VALIDATE_PYTHON
if defined SYSTEM_PYTHON goto :PYTHON_FOUND

for %%P in ("%ProgramFiles(x86)%\Python*\python.exe") do if not defined SYSTEM_PYTHON set "SYSTEM_PYTHON=%%~fP"
call :VALIDATE_PYTHON
if defined SYSTEM_PYTHON goto :PYTHON_FOUND

for %%P in ("%SystemDrive%\Python*\python.exe") do if not defined SYSTEM_PYTHON set "SYSTEM_PYTHON=%%~fP"
call :VALIDATE_PYTHON
if defined SYSTEM_PYTHON goto :PYTHON_FOUND

del /q "%PYTHON_RESULT%" >nul 2>nul
echo.
echo [ERROR] A working Python 3.9 or newer installation could not be found.
echo Install Python and enable the option "Add Python to PATH", then try again.
echo Download: https://www.python.org/downloads/windows/
exit /b 1

:VALIDATE_PYTHON
if not defined SYSTEM_PYTHON exit /b 0
if not exist "%SYSTEM_PYTHON%" set "SYSTEM_PYTHON="
if not defined SYSTEM_PYTHON exit /b 0
"%SYSTEM_PYTHON%" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
if errorlevel 1 set "SYSTEM_PYTHON="
exit /b 0

:PYTHON_FOUND
del /q "%PYTHON_RESULT%" >nul 2>nul
echo [OK] Found Python:
"%SYSTEM_PYTHON%" --version
echo     %SYSTEM_PYTHON%
if /i "%~1"=="--find-only" exit /b 0
echo [*] Creating a local virtual environment...
"%SYSTEM_PYTHON%" -m venv --clear "%~dp0.venv"
if errorlevel 1 goto :VENV_FAILED

if not exist "%VENV_PYTHON%" goto :VENV_FAILED
"%VENV_PYTHON%" -c "import sys; print('[OK] Virtual environment uses ' + sys.version.split()[0])"
if errorlevel 1 goto :VENV_FAILED

:ENSURE_PACKAGES
"%VENV_PYTHON%" -c "import flask, flask_cors, PIL" >nul 2>nul
if not errorlevel 1 exit /b 0

echo [*] Installing required Python packages...
"%VENV_PYTHON%" -m pip install --disable-pip-version-check -r "%~dp0requirements.txt"
if errorlevel 1 goto :PACKAGES_FAILED

"%VENV_PYTHON%" -c "import flask, flask_cors, PIL" >nul 2>nul
if errorlevel 1 goto :PACKAGES_FAILED
echo [OK] Required Python packages are installed.
exit /b 0

:VENV_FAILED
echo.
echo [ERROR] Python was found, but the local virtual environment could not be created.
echo Confirm that the Python venv component is installed and try again.
exit /b 1

:PACKAGES_FAILED
echo.
echo [ERROR] Required Python packages could not be installed.
echo Check the internet connection and run this file again.
exit /b 1
