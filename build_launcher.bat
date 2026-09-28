@echo off
setlocal
cd /d "%~dp0"

echo ========================================================
echo         LED Sign — Build .exe Launcher
echo ========================================================
echo.

:: Install dependencies
echo [1/3] Installing pystray and Pillow...
python -m pip install pystray Pillow pyinstaller --quiet
if %errorlevel% neq 0 (
    echo ERROR: pip install failed. Make sure Python is on PATH.
    pause & exit /b 1
)

:: Convert favicon.svg to .ico using Pillow
echo [2/3] Generating icon...
python -c ^
"from PIL import Image; import io, base64; ^
img = Image.new('RGBA',(64,64),(134,59,255,255)); ^
img.save('launcher_icon.ico', format='ICO', sizes=[(16,16),(32,32),(48,48),(64,64)])"
if %errorlevel% neq 0 (
    echo WARNING: Icon generation failed, using default icon.
    set ICON_ARG=
) else (
    set ICON_ARG=--icon=launcher_icon.ico
)

:: Build with PyInstaller
echo [3/3] Building LED_Sign.exe with PyInstaller...
pyinstaller ^
    --onefile ^
    --windowed ^
    --name "LED Sign" ^
    --add-data "server;server" ^
    --add-data "client;client" ^
    %ICON_ARG% ^
    launcher.py

if %errorlevel% neq 0 (
    echo.
    echo ERROR: PyInstaller build failed.
    pause & exit /b 1
)

echo.
echo ========================================================
echo  Done!  dist\LED Sign.exe  is ready to use.
echo
echo  NOTE: The .exe still needs Python + Node on PATH
echo  to launch the backend and frontend servers.
echo ========================================================
if exist launcher_icon.ico del launcher_icon.ico
pause
