@echo off
setlocal

echo ========================================================
echo                 Stopping LED Sign
echo ========================================================

echo Disconnecting LED sign to prevent Bluetooth handle corruption...
curl --max-time 2 -s -X POST http://127.0.0.1:8000/disconnect >nul 2>&1
ping 127.0.0.1 -n 2 > nul

for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":8000 *LISTENING"') do (
    echo Stopping backend process ^(PID %%a^)...
    taskkill /F /PID %%a >nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":5173 *LISTENING"') do (
    echo Stopping frontend process ^(PID %%a^)...
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo All LED Sign services stopped.
ping 127.0.0.1 -n 3 > nul
