@echo off
setlocal

echo ========================================================
echo                 Stopping LED Sign
echo ========================================================

for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":8000 *LISTENING"') do (
    echo Stopping backend process (PID %%a)...
    taskkill /F /PID %%a >nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":5173 *LISTENING"') do (
    echo Stopping frontend process (PID %%a)...
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo All LED Sign services stopped.
timeout /t 2 >nul
