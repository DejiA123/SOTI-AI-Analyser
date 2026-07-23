@echo off
title SOTI AI Analyser - Local AI Setup
echo ==========================================
echo SOTI AI Analyser - Automated Local AI Setup
echo ==========================================
echo.
echo Installs Ollama (via winget where available, otherwise the official
echo ollama.com installer), then downloads gemma4:e2b for the extension.
echo.
echo The model download is approximately 7.2 GB and runs once.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_local_ai.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [!] An error occurred during setup.
    pause
)
