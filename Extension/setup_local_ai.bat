@echo off
title SOTI AI Analyser - Local AI Setup Helper
echo ==========================================
echo Starting SOTI AI Analyser Local AI Setup
echo ==========================================
echo.
echo This helper script will configure your system for Local AI.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_local_ai.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [!] An error occurred during setup.
    pause
)
