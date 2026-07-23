# SOTI AI Analyser - Local AI Auto-Setup
# Uses official https://ollama.com/install.ps1 then downloads gemma4:e2b.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Header ($text) {
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host " $text" -ForegroundColor Cyan
    Write-Host "==========================================" -ForegroundColor Cyan
}

function Write-Info ($text) { Write-Host "[*] $text" -ForegroundColor White }
function Write-Success ($text) { Write-Host "[+] $text" -ForegroundColor Green }
function Write-Err ($text) { Write-Host "[!] $text" -ForegroundColor Red }

function Refresh-PathEnv {
    $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

function Get-OllamaExePath {
    $defaultPath = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
    if (Test-Path $defaultPath) { return $defaultPath }
    Refresh-PathEnv
    $cmd = Get-Command ollama -ErrorAction SilentlyContinue
    if ($cmd -and (Test-Path $cmd.Source)) { return $cmd.Source }
    return $defaultPath
}

function Test-OllamaInstalled {
    $path = Get-OllamaExePath
    return Test-Path $path
}

function Install-OllamaOfficial {
    Write-Info "Running official installer: irm https://ollama.com/install.ps1 | iex"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $installScript = (Invoke-WebRequest -Uri "https://ollama.com/install.ps1" -UseBasicParsing -TimeoutSec 300).Content
        if ($installScript -is [byte[]]) {
            $installScript = [System.Text.Encoding]::UTF8.GetString($installScript)
        }
        Invoke-Expression $installScript
        Start-Sleep -Seconds 3
        Refresh-PathEnv
        return Test-OllamaInstalled
    } catch {
        Write-Err "Official install.ps1 failed: $($_.Exception.Message)"
        return $false
    }
}

function Install-OllamaViaWinget {
    Write-Info "Trying winget fallback (Ollama.Ollama)..."
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) { return $false }
    try {
        & winget install --id Ollama.Ollama -e --accept-package-agreements --accept-source-agreements --silent
        Start-Sleep -Seconds 3
        Refresh-PathEnv
        return Test-OllamaInstalled
    } catch {
        return $false
    }
}

function Install-OllamaViaSetupExe {
    Write-Info "Trying OllamaSetup.exe fallback..."
    $installerUrl = "https://ollama.com/download/OllamaSetup.exe"
    $setupDir = Join-Path $env:TEMP "SOTI-AI-OllamaSetup"
    $setupExe = Join-Path $setupDir "OllamaSetup.exe"
    New-Item -ItemType Directory -Force -Path $setupDir | Out-Null
    try {
        Invoke-WebRequest -Uri $installerUrl -OutFile $setupExe -UseBasicParsing -TimeoutSec 300
        if (-not (Test-Path $setupExe)) { return $false }
        $proc = Start-Process -FilePath $setupExe -ArgumentList "/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait -PassThru
        if ($proc.ExitCode -ne 0 -and -not (Test-OllamaInstalled)) {
            Start-Process -FilePath $setupExe -ArgumentList "/SILENT" -Wait | Out-Null
        }
        Refresh-PathEnv
        return Test-OllamaInstalled
    } catch {
        Write-Err "Setup.exe fallback failed: $($_.Exception.Message)"
        return $false
    }
}

function Test-OllamaApiReachable {
    # Bypass corporate proxy for local Ollama (common cause: browser works, PowerShell/extension fail)
    try {
        [System.Net.WebRequest]::DefaultWebProxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy()
    } catch {
        try { [System.Net.WebRequest]::DefaultWebProxy = $null } catch { continue }
    }

    $endpoints = @(
        "http://127.0.0.1:11434/api/tags",
        "http://localhost:11434/api/tags",
        "http://127.0.0.1:11434/",
        "http://localhost:11434/"
    )

    foreach ($uri in $endpoints) {
        try {
            $r = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) {
                Write-Info "API responded at $uri (HTTP $($r.StatusCode))"
                return $true
            }
        } catch {
            continue
        }
    }

    # Fallback: ollama CLI responds even when Invoke-WebRequest is blocked by proxy/AV
    $ollamaExe = Get-OllamaExePath
    if (Test-Path $ollamaExe) {
        try {
            $out = & $ollamaExe list 2>&1
            if ($LASTEXITCODE -eq 0 -and $out) {
                Write-Info 'Ollama CLI responded via ollama list - API is running.'
                return $true
            }
        } catch {
            # ignore CLI probe errors
        }
    }

    $tcp = Test-NetConnection -ComputerName 127.0.0.1 -Port 11434 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
    if ($tcp -and $tcp.TcpTestSucceeded) {
        Write-Info 'Port 11434 is open on 127.0.0.1 - TCP check passed.'
        return $true
    }

    return $false
}

function Wait-OllamaApi {
    Write-Info "Waiting for Ollama API (trying 127.0.0.1 and localhost:11434) ..."
    for ($i = 1; $i -le 60; $i++) {
        if (Test-OllamaApiReachable) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Install-AIModel {
    param([string]$OllamaExe)
    Write-Header "Step 3: Install gemma4:e2b model"
    Write-Info 'Running: ollama pull gemma4:e2b - downloads the model for the extension...'
    & $OllamaExe pull gemma4:e2b
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Model download failed. Try manually: ollama pull gemma4:e2b"
        return $false
    }
    Write-Success "gemma4:e2b is installed and ready for ollama run gemma4:e2b"
    return $true
}

Write-Header "SOTI AI Analyser - Local AI Setup"
Refresh-PathEnv

# --- Step 1: Install Ollama ---
if (Test-OllamaInstalled) {
    Write-Success "Ollama is already installed."
} else {
    Write-Header "Step 1: Install Ollama"
    # SECURITY: prefer winget first - it installs a signed, hash-verified package from the
    # Windows Package Manager repo, so the common case does NOT fetch a remote script and pipe
    # it into Invoke-Expression. Fall back to Ollama's official installer / setup.exe only if
    # winget is unavailable (older Windows).
    $ok = Install-OllamaViaWinget
    if (-not $ok) { $ok = Install-OllamaOfficial }
    if (-not $ok) { $ok = Install-OllamaViaSetupExe }
    if (-not $ok) {
        Write-Err "Automatic install did not complete."
        Write-Info "Manual install: open PowerShell and run: irm https://ollama.com/install.ps1 | iex"
        exit 1
    }
    Write-Success "Ollama installed successfully."
}

$ollamaExe = Get-OllamaExePath
if (-not (Test-Path $ollamaExe)) {
    Write-Err "Ollama executable not found after install."
    exit 1
}

# --- Step 2: Start / verify service ---
Write-Header "Step 2: Start Ollama"

# SECURITY: scope OLLAMA_ORIGINS to the SOTI extension + the standalone page ONLY - never "*".
# "*" lets ANY website the analyst visits reach the local model API from the browser (a
# drive-by localhost-service risk the security team flagged). This scoped list blocks arbitrary
# web origins while still allowing the extension and the standalone page. For a managed rollout,
# replace chrome-extension://* with the pinned extension ID (chrome-extension://<your-id>).
$sotiOrigins = "chrome-extension://*,http://localhost:8765,http://127.0.0.1:8765"
Write-Info "Configuring OLLAMA_ORIGINS to the SOTI extension + standalone page only (not '*')..."
[System.Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", $sotiOrigins, "User")
$env:OLLAMA_ORIGINS = $sotiOrigins

# Speed: flash attention + quantized KV cache. On CPU-only / low-RAM laptops this lowers
# memory bandwidth and can speed up inference. It does NOT change answer quality.
Write-Info "Configuring OLLAMA_FLASH_ATTENTION=1 and OLLAMA_KV_CACHE_TYPE=q8_0 for faster inference..."
[System.Environment]::SetEnvironmentVariable("OLLAMA_FLASH_ATTENTION", "1", "User")
[System.Environment]::SetEnvironmentVariable("OLLAMA_KV_CACHE_TYPE", "q8_0", "User")
$env:OLLAMA_FLASH_ATTENTION = "1"
$env:OLLAMA_KV_CACHE_TYPE = "q8_0"

$runningOllama = Get-Process ollama -ErrorAction SilentlyContinue
$runningOllamaApp = Get-Process "ollama app" -ErrorAction SilentlyContinue

if ($runningOllama -or $runningOllamaApp) {
    Write-Info "Restarting Ollama to apply CORS + speed settings (flash attention, KV cache)..."
    if ($runningOllamaApp) { Stop-Process -Name "ollama app" -Force -ErrorAction SilentlyContinue }
    if ($runningOllama) { Stop-Process -Name "ollama" -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
}

$appExe = "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"
if (Test-Path $appExe) {
    Write-Info "Starting Ollama tray app..."
    Start-Process -FilePath $appExe
} else {
    Write-Info "Starting Ollama backend..."
    Start-Process -FilePath $ollamaExe -WindowStyle Hidden
}
Start-Sleep -Seconds 3
if (-not (Wait-OllamaApi)) {
    Write-Err "Ollama API not responding to setup checks."
    Write-Info "If http://127.0.0.1:11434 works in your browser, continue manually:"
    Write-Info "  1. In extension Settings set URL to: http://127.0.0.1:11434"
    Write-Info "  2. Run in PowerShell: ollama pull gemma4:e2b"
    Write-Info 'Corporate proxy/AV often blocks PowerShell HTTP to localhost - use 127.0.0.1 in extension Settings.'
    exit 1
}
Write-Success "Ollama API is running."

# --- Step 3: Model ---
if (-not (Install-AIModel -OllamaExe $ollamaExe)) {
    exit 1
}

Write-Header "Setup complete"
Write-Success "Local AI is ready."
Write-Info "1. Reload the SOTI AI Analyser extension in Chrome."
Write-Info "2. Open Settings - set URL to http://127.0.0.1:11434 - refresh models - Save."
Write-Host ""
pause
