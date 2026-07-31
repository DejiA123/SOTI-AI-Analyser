# SOTI AI Analyser - Local AI Auto-Setup
# Installs Ollama (winget first, official installer / signed setup.exe as fallbacks),
# hardens it for local-only use, then downloads gemma4:e2b (~7.2 GB).
#
# Managed rollout: pass -ExtensionId <id> when the extension is deployed from the Chrome
# Web Store or by enterprise policy under an ID other than the one the bundled manifest
# "key" produces. The default below matches Extension/manifest.json.

param(
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId = "odkmlcpmfgdfoikmcmhoongggbepbdna"
)

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

function Test-InstallerSignature {
    # SECURITY: the downloaded installer runs with full user privileges outside the browser
    # sandbox, so verify its Authenticode signature before executing it. This closes the
    # "fetch an .exe over HTTPS and simply trust it" gap - a tampered, unsigned, or
    # wrong-publisher binary (TLS-intercepting proxy, cache poisoning, hijacked URL) is
    # rejected here instead of being installed silently.
    param([string]$Path)

    try {
        $sig = Get-AuthenticodeSignature -FilePath $Path -ErrorAction Stop
    } catch {
        Write-Err "Could not read the installer signature: $($_.Exception.Message)"
        return $false
    }

    if ($sig.Status -ne "Valid") {
        Write-Err "Installer signature is NOT valid (status: $($sig.Status)). Refusing to run it."
        if ($sig.StatusMessage) { Write-Err "  $($sig.StatusMessage)" }
        return $false
    }

    $subject = "$($sig.SignerCertificate.Subject)"
    if ($subject -notmatch 'CN=Ollama Inc\.') {
        Write-Err "Installer is signed by an UNEXPECTED publisher. Refusing to run it."
        Write-Err "  Expected: CN=Ollama Inc."
        Write-Err "  Found:    $subject"
        return $false
    }

    Write-Success "Installer signature verified (CN=Ollama Inc., issuer: $(($sig.SignerCertificate.Issuer -split ',')[0]))."
    return $true
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
        if (-not (Test-InstallerSignature -Path $setupExe)) {
            Remove-Item $setupExe -Force -ErrorAction SilentlyContinue
            return $false
        }
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
    # SECURITY: the install paths are ordered MOST-VERIFIED FIRST, so the unverified one is only
    # ever reached when every verified path above it is unavailable:
    #   1. winget          - signed, hash-verified package from the Windows Package Manager repo.
    #                        No remote script is fetched or evaluated at all.
    #   2. OllamaSetup.exe - downloaded, then Authenticode status AND publisher (CN=Ollama Inc.)
    #                        are verified by Test-InstallerSignature before it is allowed to run;
    #                        a tampered/unsigned/wrong-publisher binary is deleted, not executed.
    #   3. install.ps1     - LAST RESORT. Pipes remote script text into Invoke-Expression with no
    #                        integrity check, so it must stay behind both verified paths: it is
    #                        reached only on a machine with no winget AND no usable signed
    #                        installer (older Windows where winget is absent and the .exe
    #                        download itself failed).
    $ok = Install-OllamaViaWinget
    if (-not $ok) { $ok = Install-OllamaViaSetupExe }
    if (-not $ok) { $ok = Install-OllamaOfficial }
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

# SECURITY: scope OLLAMA_ORIGINS to THIS extension by its exact ID + the standalone page.
# Never "*" (that lets any website the analyst visits reach the local model) and no longer
# "chrome-extension://*" (that let EVERY installed Chrome extension reach it). The ID below
# is fixed by the "key" field in manifest.json, so it is identical on every machine.
# Note this is a browser-boundary control: it stops other web origins and other extensions,
# but requests carrying no Origin header (any local process) are always allowed by Ollama,
# and Ollama additionally permits localhost/127.0.0.1 on any port by default.
$sotiOrigins = "chrome-extension://$ExtensionId,http://localhost:8765,http://127.0.0.1:8765"
Write-Info "Configuring OLLAMA_ORIGINS to this extension ID + standalone page only..."
Write-Info "  Pinned extension: chrome-extension://$ExtensionId"
[System.Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", $sotiOrigins, "User")
$env:OLLAMA_ORIGINS = $sotiOrigins

# SECURITY: enforce local-only inference. Ollama can route work to its cloud (remote models
# and web search). Customer case content must never leave the machine, so disable those
# features at the server instead of relying on the extension only ever asking for a local
# model. Must be set before the server starts - the restart below applies it.
Write-Info "Configuring OLLAMA_NO_CLOUD=1 (disables Ollama cloud inference + web search)..."
[System.Environment]::SetEnvironmentVariable("OLLAMA_NO_CLOUD", "1", "User")
$env:OLLAMA_NO_CLOUD = "1"

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
    # "serve" is required: bare `ollama` launches an interactive menu, not the API server,
    # so with -WindowStyle Hidden it would sit invisible forever and the API check below
    # would time out.
    Write-Info "Starting Ollama backend..."
    Start-Process -FilePath $ollamaExe -ArgumentList "serve" -WindowStyle Hidden
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
