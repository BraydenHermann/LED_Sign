@echo off
setlocal

echo ========================================================
echo                 Stopping LED Sign
echo ========================================================

echo Disconnecting LED sign to prevent Bluetooth handle corruption...
curl --max-time 2 -s -X POST http://127.0.0.1:8000/disconnect >nul 2>&1
ping 127.0.0.1 -n 2 > nul

taskkill /F /IM "LED Sign.exe" >nul 2>&1
taskkill /F /IM "LED Sign*.exe" >nul 2>&1
taskkill /F /IM pythonw.exe >nul 2>&1
taskkill /F /IM python.exe >nul 2>&1
taskkill /F /IM python3.12.exe >nul 2>&1
taskkill /F /IM python3*.exe >nul 2>&1

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000" ^| findstr "LISTENING"') do (
    echo Stopping backend process ^(PID %%a^)...
    taskkill /F /T /PID %%a >nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5173" ^| findstr "LISTENING"') do (
    echo Stopping frontend process ^(PID %%a^)...
    taskkill /F /T /PID %%a >nul 2>&1
)

echo.
echo All LED Sign services stopped.
ping 127.0.0.1 -n 3 > nul
