@echo off
echo === Master Duel Autoly Builder ===
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Install Python 3.10+ and add to PATH.
    pause
    exit /b 1
)

:: Install PyInstaller if missing
pip show pyinstaller >nul 2>&1
if errorlevel 1 (
    echo Installing PyInstaller...
    pip install pyinstaller
    if errorlevel 1 (
        echo ERROR: Failed to install PyInstaller.
        pause
        exit /b 1
    )
)

:: Run build
echo Building MasterDuelAutoly...
pyinstaller masterduel_autoly.spec --noconfirm --clean

if errorlevel 1 (
    echo.
    echo ERROR: Build failed. Check output above.
    pause
    exit /b 1
)

echo.
echo === Build complete! ===
echo Output: dist\MasterDuelAutoly\MasterDuelAutoly.exe
echo.
echo Don't forget to create a .env file next to the exe with:
echo   GEMINI_API_KEY=your_key_here
echo.
pause
