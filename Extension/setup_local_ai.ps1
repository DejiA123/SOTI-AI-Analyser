# SOTI AI Analyser - Local AI Auto-Setup (silent, no browser redirect)
# Installs Ollama via winget or direct download, starts the service, pulls llama3.2.

$ErrorActionPreference = "Stop"

function Write-Header ($text) {
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host " $text" -ForegroundColor Cyan
    Write-Host "==========================================" -ForegroundColor Cyan
}

function Write-Info ($text) { Write-Host "[*] $text" -ForegroundColor White }
function Write-Success ($text) { Write-Host "[+] $text" -ForegroundColor Green }
function Write-Err ($text) { Write-Host "[!] $text" -ForegroundColor Red }

Write-Header "SOTI AI Analyser - Local AI Setup"

$ollamaPath = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
$installerUrl = "https://ollama.com/download/OllamaSetup.exe"
$setupDir = Join-Path $env:TEMP "SOTI-AI-OllamaSetup"
$setupExe = Join-Path $setupDir "OllamaSetup.exe"

function Test-OllamaInstalled {
    return Test-Path $ollamaPath
}

function Install-OllamaViaWinget {
    Write-Info "Trying winget (recommended - often allowed by corporate AV)..."
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) { return $false }
    try {
        & winget install --id Ollama.Ollama -e --accept-package-agreements --accept-source-agreements --silent
        if ($LASTEXITCODE -eq 0 -or (Test-OllamaInstalled)) { return $true }
    } catch { }
    return $false
}

function Install-OllamaViaDownload {
    Write-Info "Downloading Ollama installer from ollama.com..."
    New-Item -ItemType Directory -Force -Path $setupDir | Out-Null
    try {
        Invoke-WebRequest -Uri $installerUrl -OutFile $setupExe -UseBasicParsing -TimeoutSec 300
    } catch {
        Write-Err "Download failed: $($_.Exception.Message)"
        return $false
    }
    if (-not (Test-Path $setupExe)) { return $false }

    Write-Info "Running silent install (no browser, no click-through)..."
    Write-Info "If Bitdefender blocks this, add an exclusion for: $setupExe and $ollamaPath"
    $proc = Start-Process -FilePath $setupExe -ArgumentList "/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait -PassThru
    if ($proc.ExitCode -ne 0 -and -not (Test-OllamaInstalled)) {
        Write-Info "Silent flags returned $($proc.ExitCode); retrying with /SILENT..."
        Start-Process -FilePath $setupExe -ArgumentList "/SILENT" -Wait | Out-Null
    }
    return Test-OllamaInstalled
}

# --- Step 1: Install ---
if (Test-OllamaInstalled) {
    Write-Success "Ollama already installed at $ollamaPath"
} else {
    Write-Header "Step 1: Install Ollama"
    $ok = Install-OllamaViaWinget
    if (-not $ok) { $ok = Install-OllamaViaDownload }
    if (-not $ok) {
        Write-Err "Automatic install did not complete."
        Write-Info "Manual fallback: run this file again as Administrator, or ask IT to allow Ollama.Ollama via winget."
        Write-Info "Installer URL (official): $installerUrl"
        exit 1
    }
    Write-Success "Ollama installed successfully."
}

# --- Step 2: Start service ---
Write-Header "Step 2: Start Ollama"
if (-not (Get-Process ollama -ErrorAction SilentlyContinue)) {
    Write-Info "Starting Ollama..."
    Start-Process -FilePath $ollamaPath -WindowStyle Hidden
    Start-Sleep -Seconds 2
}

Write-Info "Waiting for API on http://localhost:11434 ..."
$connected = $false
for ($i = 1; $i -le 30; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:11434" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $connected = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
}
if (-not $connected) {
    Write-Err "Ollama API not responding. Check the system tray icon or restart Ollama."
    exit 1
}
Write-Success "Ollama API is running."

# --- Step 3: Pull model ---
Write-Header "Step 3: Download llama3.2 model (~2GB)"
Write-Info "This runs once; later use is offline."
& $ollamaPath pull llama3.2
if ($LASTEXITCODE -ne 0) {
    Write-Err "Model pull failed. Run manually: ollama pull llama3.2"
    exit 1
}

Write-Header "Setup complete"
Write-Success "Local AI is ready."
Write-Info "1. Reload the SOTI AI Analyser extension in Chrome."
Write-Info "2. Open Settings - refresh models - Save."
Write-Info "3. Optional AV exclusion path: $env:LOCALAPPDATA\Programs\Ollama"
Write-Host ""
pause
