# SOTI AI Analyser - Local AI Auto-Setup Script
# This script downloads Ollama, installs it silently, starts it, and pulls the llama3.2 model.

$ErrorActionPreference = "Stop"

# Helper to output colored text
function Write-Header ($text) {
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host " $text" -ForegroundColor Cyan -Bold
    Write-Host "==========================================" -ForegroundColor Cyan
}

function Write-Info ($text) {
    Write-Host "[*] $text" -ForegroundColor White
}

function Write-Success ($text) {
    Write-Host "[+] $text" -ForegroundColor Green
}

function Write-Err ($text) {
    Write-Host "[!] $text" -ForegroundColor Red
}

Write-Header "SOTI AI Analyser - Local AI Setup"

# 1. Check if Ollama is already installed
$ollamaPath = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
$installed = Test-Path $ollamaPath

if ($installed) {
    Write-Success "Ollama is already installed at $ollamaPath"
} else {
    Write-Header "Step 1: Downloading Ollama"
    $tempDir = Join-Path $env:TEMP "OllamaSetup"
    if (-not (Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir | Out-Null }
    
    $installerPath = Join-Path $tempDir "OllamaSetup.exe"
    $downloadUrl = "https://ollama.com/download/OllamaSetup.exe"
    
    Write-Info "Downloading Ollama installer from $downloadUrl..."
    try {
        Start-BitsTransfer -Source $downloadUrl -Destination $installerPath -Priority Foreground -ErrorAction Stop
    } catch {
        Write-Info "BITS download failed/unavailable. Falling back to curl.exe..."
        & curl.exe -L -o $installerPath $downloadUrl
    }
    Write-Success "Download complete: $installerPath"
    
    Write-Header "Step 2: Installing Ollama (Silent Mode)"
    Write-Info "Running installer... This will take about a minute. Please wait."
    
    # Run the installer silently
    $process = Start-Process -FilePath $installerPath -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES" -PassThru -Wait
    
    if ($process.ExitCode -eq 0) {
        Write-Success "Ollama installed successfully!"
    } else {
        Write-Err "Ollama installation exited with code $($process.ExitCode). Trying to continue..."
    }
}

# 2. Start Ollama if it is not running
Write-Header "Step 3: Starting Ollama Service"
$processRunning = Get-Process ollama -ErrorAction SilentlyContinue

if ($processRunning) {
    Write-Info "Ollama process is already running."
} else {
    Write-Info "Starting Ollama application..."
    if (Test-Path $ollamaPath) {
        Start-Process -FilePath $ollamaPath
    } else {
        Write-Err "Could not find ollama.exe at expected location: $ollamaPath"
        Exit 1
    }
}

# 3. Wait for Ollama to become responsive
Write-Info "Waiting for Ollama API to respond..."
$retries = 20
$connected = $false
for ($i = 1; $i -le $retries; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:11434" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200 -or $response.Content -like "*Ollama is running*") {
            $connected = $true
            break
        }
    } catch {
        # ignore and retry
    }
    Start-Sleep -Seconds 1
}

if (-not $connected) {
    Write-Err "Ollama did not respond on http://localhost:11434 after 20 seconds."
    Write-Info "Please make sure Ollama is running from your system tray and try again."
    Exit 1
}

Write-Success "Ollama is active and responding!"

# 4. Pull the llama3.2 model
Write-Header "Step 4: Pulling llama3.2 Model"
Write-Info "Downloading llama3.2 model (approx 2GB). This may take a few minutes depending on your internet connection..."

# Run ollama pull in a way that shows progress
& $ollamaPath pull llama3.2

Write-Header "Setup Completed Successfully!"
Write-Success "Your local AI is ready for use!"
Write-Info "1. Load/Reload the SOTI AI Analyser extension in your browser."
Write-Info "2. Open the extension Settings (⚙) and click Save."
Write-Info "3. You are now running 100% private Local AI!"
Write-Host ""
pause
