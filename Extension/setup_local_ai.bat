@echo off
title SOTI AI Analyser - Local AI Setup
echo ==========================================
echo SOTI AI Analyser - Automated Local AI Setup
echo ==========================================
echo.
echo Installs Ollama using the official ollama.com/install.ps1 script,
echo then downloads llama3.2 for the extension.
echo.
echo If Bitdefender asks, allow PowerShell and ollama.com (official installer).
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_local_ai.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [!] An error occurred during setup.
    pause
)
