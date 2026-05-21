# SOTI AI Analyser - Local AI Auto-Setup
# Uses official https://ollama.com/install.ps1 then downloads llama3.2.

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
    Write-Info "If Bitdefender prompts, choose Allow - this is the official Ollama script from ollama.com."
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

function Install-Llama32Model {
    param([string]$OllamaExe)
    Write-Header "Step 3: Install llama3.2 model (~2GB)"
    Write-Info 'Running: ollama pull llama3.2 - downloads the model for the extension...'
    & $OllamaExe pull llama3.2
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Model download failed. Try manually: ollama pull llama3.2"
        return $false
    }
    Write-Success "llama3.2 is installed and ready for ollama run llama3.2"
    return $true
}

Write-Header "SOTI AI Analyser - Local AI Setup"
Refresh-PathEnv

# --- Step 1: Install Ollama ---
if (Test-OllamaInstalled) {
    Write-Success "Ollama is already installed."
} else {
    Write-Header "Step 1: Install Ollama"
    $ok = Install-OllamaOfficial
    if (-not $ok) { $ok = Install-OllamaViaWinget }
    if (-not $ok) { $ok = Install-OllamaViaSetupExe }
    if (-not $ok) {
        Write-Err "Automatic install did not complete."
        Write-Info "If Bitdefender blocked the script, allow PowerShell and https://ollama.com for your user."
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
if (-not (Get-Process ollama -ErrorAction SilentlyContinue)) {
    Write-Info "Starting Ollama..."
    Start-Process -FilePath $ollamaExe -WindowStyle Hidden
    Start-Sleep -Seconds 2
}
if (-not (Wait-OllamaApi)) {
    Write-Err "Ollama API not responding to setup checks."
    Write-Info "If http://127.0.0.1:11434 works in your browser, continue manually:"
    Write-Info "  1. In extension Settings set URL to: http://127.0.0.1:11434"
    Write-Info "  2. Run in PowerShell: ollama pull llama3.2"
    Write-Info 'Corporate proxy/AV often blocks PowerShell HTTP to localhost - use 127.0.0.1 in extension Settings.'
    exit 1
}
Write-Success "Ollama API is running."

# --- Step 3: Model ---
if (-not (Install-Llama32Model -OllamaExe $ollamaExe)) {
    exit 1
}

Write-Header "Setup complete"
Write-Success "Local AI is ready."
Write-Info "1. Reload the SOTI AI Analyser extension in Chrome."
Write-Info "2. Open Settings - set URL to http://127.0.0.1:11434 - refresh models - Save."
Write-Info "3. Optional Bitdefender exclusion: $env:LOCALAPPDATA\Programs\Ollama"
Write-Host ""
pause
