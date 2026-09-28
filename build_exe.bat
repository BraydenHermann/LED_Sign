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

echo [2/3] Generating icon...
python -c "from PIL import Image, ImageDraw; img = Image.new('RGBA',(64,64),(0,0,0,0)); d = ImageDraw.Draw(img); d.rounded_rectangle([4,14,60,50],radius=6,fill=(28,28,36),outline=(134,59,255),width=2); colors=[(0,230,80),(0,180,255),(230,60,255),(255,180,0),(0,230,80)]; [d.ellipse([10+i*10,23,16+i*10,29],fill=c) for i,c in enumerate(colors)]; img.save('_icon.ico',format='ICO',sizes=[(16,16),(32,32),(48,48),(64,64)])"
if %errorlevel% neq 0 (
    echo WARNING: Icon generation failed, using default.
    set ICON_ARG=
) else (
    set ICON_ARG=--icon=_icon.ico
)

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

if exist _icon.ico del _icon.ico
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
