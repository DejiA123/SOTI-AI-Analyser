@echo off
title SOTI AI Analyser - Local AI Setup
echo ==========================================
echo SOTI AI Analyser - Automated Local AI Setup
echo ==========================================
echo.
echo Installs Ollama silently (winget or direct download).
echo No browser or manual ollama.com steps required.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_local_ai.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [!] An error occurred during setup.
    pause
)
