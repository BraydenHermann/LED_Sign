@echo off
setlocal
cd /d "%~dp0"

echo ========================================================
echo                 LED Sign Launcher
echo ========================================================

:: Check if Python backend (port 8000) is running
netstat -ano | findstr /R /C:":8000 *LISTENING" >nul
if %errorlevel% neq 0 (
    echo [1/2] Starting Python backend server (port 8000)...
    start "LED Sign Backend" /d "%~dp0" cmd /k python -u server\main.py
) else (
    echo [1/2] Python backend server is already running.
)

:: Check if Vite frontend (port 5173) is running
netstat -ano | findstr /R /C:":5173 *LISTENING" >nul
if %errorlevel% neq 0 (
    echo [2/2] Starting Vite frontend server (port 5173)...
    start "LED Sign Frontend" /d "%~dp0client" cmd /k npm run dev
) else (
    echo [2/2] Vite frontend server is already running.
)

echo.
echo Waiting for servers to be ready...
timeout /t 5 /nobreak >nul

echo Opening http://localhost:5173/ in your default browser...
start http://localhost:5173/

echo.
echo ========================================================
echo LED Sign is now running!
echo To stop the servers later, run: stop_led_sign.bat
echo ========================================================
timeout /t 3 /nobreak >nul
