@echo off
title SOTI AI Analyser - Standalone Server
cd /d "%~dp0"
echo.
echo ==========================================
echo  SOTI AI Analyser - Standalone mode
echo ==========================================
echo.
echo Keep this window open while using the app.
echo.
echo Open in your browser:
echo   http://127.0.0.1:8765/SOTI_AI_Analyser.html
echo.

:: Check if Python is ACTUALLY installed and functional
py -V >nul 2>&1
if %errorlevel% equ 0 (
    echo [✓] Starting via Python Launcher...
    py -m http.server 8765 --bind 127.0.0.1
    goto :done
)

python -V >nul 2>&1
if %errorlevel% equ 0 (
    echo [✓] Starting via Python...
    python -m http.server 8765 --bind 127.0.0.1
    goto :done
)

:: Fallback using PowerShell
echo [!] Python not found or not functional.
echo [✓] Starting zero-dependency pre-installed Windows PowerShell HTTP server...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve_standalone.ps1"

:done
pause
