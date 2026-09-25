@echo off
setlocal
cd /d "%~dp0"

echo Creating Desktop shortcut for LED Sign...

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([System.IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'LED Sign.lnk')); $s.TargetPath = '%~dp0start_led_sign.bat'; $s.WorkingDirectory = '%~dp0'; $s.Description = 'Start LED Sign Server and Open in Browser'; $s.Save()"

if %errorlevel% equ 0 (
    echo.
    echo [SUCCESS] 'LED Sign' shortcut has been created on your Desktop!
    echo Double-click that shortcut anytime to start the servers and open the app.
) else (
    echo.
    echo [ERROR] Failed to create shortcut automatically.
)
echo.
pause
