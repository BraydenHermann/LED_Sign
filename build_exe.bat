@echo off
setlocal
cd /d "%~dp0"

echo ==================================================
echo       LED Sign - Build App (.exe)
echo ==================================================
echo.

echo [1/3] Installing dependencies (pystray, Pillow, PyInstaller)...
python -m pip install pystray Pillow pyinstaller --quiet
if %errorlevel% neq 0 (
    echo ERROR: pip install failed. Make sure Python is on PATH.
    pause & exit /b 1
)

echo [2/3] Preparing LED Sign icon...
python -c "from PIL import Image; im=Image.open('launcher_icon.png').convert('RGBA'); im.save('launcher_icon.ico',format='ICO',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
if %errorlevel% neq 0 (
    echo ERROR: launcher_icon.png is required to build the app icon.
    pause & exit /b 1
)
set ICON_ARG=--icon=launcher_icon.ico

echo [3/3] Building LED Sign.exe with PyInstaller...
python -m PyInstaller ^
    --onefile ^
    --windowed ^
    --name "LED Sign" ^
    %ICON_ARG% ^
    launcher.py

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Build failed.
    if exist _icon.ico del _icon.ico
    pause & exit /b 1
)

if exist "LED Sign.spec" del "LED Sign.spec"

echo.
echo ==================================================
echo  Done!
echo.
echo  Run the app:  dist\LED Sign.exe
echo.
echo  IMPORTANT: Keep LED Sign.exe next to the project
echo  folder (it finds server\ and client\ automatically)
echo ==================================================
pause
