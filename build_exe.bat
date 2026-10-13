@echo off
setlocal
cd /d "%~dp0"

echo ==================================================
echo       LED Sign - Build App (.exe)
echo ==================================================
echo.

echo [1/3] Installing dependencies (pystray, Pillow, PyInstaller)...
py -3.12 -m pip install pystray Pillow pyinstaller --quiet
if %errorlevel% neq 0 (
    echo ERROR: pip install failed. Make sure Python is on PATH.
    if "%1" neq "--no-pause" pause
    exit /b 1
)

echo [2/3] Preparing LED Sign icon...
py -3.12 -c "from PIL import Image; im=Image.open('launcher_icon.png').convert('RGBA'); im.resize((256, 256), Image.Resampling.LANCZOS).save('launcher_icon.ico', format='ICO', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
if %errorlevel% neq 0 (
    echo ERROR: launcher_icon.png is required to build the app icon.
    if "%1" neq "--no-pause" pause
    exit /b 1
)
set ICON_ARG=--icon=launcher_icon.ico

taskkill /F /IM "LED Sign.exe" >nul 2>&1
if exist "build" rmdir /s /q "build"
if exist "dist\LED Sign.exe" del /f /q "dist\LED Sign.exe"
if exist "LED Sign.exe" del /f /q "LED Sign.exe"

echo [3/3] Building LED Sign.exe with PyInstaller...
py -3.12 -m PyInstaller ^
    --clean ^
    --noconfirm ^
    --onefile ^
    --windowed ^
    --name "LED Sign" ^
    %ICON_ARG% ^
    launcher.py

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Build failed.
    if exist _icon.ico del _icon.ico
    if "%1" neq "--no-pause" pause
    exit /b 1
)

taskkill /F /IM "LED Sign.exe" >nul 2>&1

if exist "dist\LED Sign.exe" (
    echo Copying updated LED Sign.exe to project root...
    copy /y "dist\LED Sign.exe" "LED Sign.exe" >nul 2>&1
)

echo.
echo ==================================================
echo  Done!
echo.
echo  App updated in root and dist:
echo    - .\LED Sign.exe
echo    - dist\LED Sign.exe
echo ==================================================
if "%1" neq "--no-pause" pause
