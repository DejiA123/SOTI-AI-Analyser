# Rollback & Uninstall — Local AI Setup

Everything `setup_local_ai.bat` / `setup_local_ai.ps1` changes on a machine, and how to
reverse it. Written for support teams and for IT/Security review.

The installer runs entirely **in the user's own account** — it needs no Administrator
rights, writes nothing to `HKLM`, `C:\Program Files`, or the Windows directory, creates no
service, no scheduled task, and no firewall rule.

---

## 1. What the installer changes

| # | Change | Scope | Reversible |
|---|---|---|---|
| 1 | Installs Ollama | `%LOCALAPPDATA%\Programs\Ollama` (per-user) | Yes — §3.1 |
| 2 | Sets `OLLAMA_ORIGINS` | User environment variable | Yes — §3.2 |
| 3 | Sets `OLLAMA_NO_CLOUD=1` | User environment variable | Yes — §3.2 |
| 4 | Sets `OLLAMA_FLASH_ATTENTION=1` | User environment variable | Yes — §3.2 |
| 5 | Sets `OLLAMA_KV_CACHE_TYPE=q8_0` | User environment variable | Yes — §3.2 |
| 6 | Downloads model `gemma4:e2b` (~7.2 GB) | `%USERPROFILE%\.ollama\models` | Yes — §3.3 |
| 7 | Starts the Ollama tray app / backend | Running process, listens on `127.0.0.1:11434` | Yes — §3.4 |
| 8 | May leave an installer in TEMP | `%TEMP%\SOTI-AI-OllamaSetup` | Yes — §3.5 |

**Ollama's own installer** additionally adds a per-user Run entry so the tray app starts
with Windows, and puts `ollama.exe` on the user `PATH`. Both are removed by Ollama's
uninstaller (§3.1) — they are not created by this script.

### What it does *not* do

No Administrator elevation, no machine-wide (`Machine`-scope) environment variables, no
Windows Defender / antivirus exclusions, no firewall changes, no registry writes outside
Ollama's own per-user install, no accounts, no scheduled tasks, no telemetry.

---

## 2. Disk space

| Item | Size |
|---|---|
| Ollama runtime | ~2.8 GB (measured) |
| `gemma4:e2b` model | ~7.2 GB |
| Runtime overhead (KV cache etc.) | ~1 GB |
| **Recommended free space** | **~12 GB** |

---

## 3. Rollback steps

### 3.1 Remove Ollama

```
winget uninstall Ollama.Ollama
```

If it was installed by the official installer rather than winget, run the bundled
uninstaller instead:

```
& "$env:LOCALAPPDATA\Programs\Ollama\unins000.exe"
```

### 3.2 Remove the environment variables

Paste into PowerShell (no elevation needed):

```
foreach ($v in 'OLLAMA_ORIGINS','OLLAMA_NO_CLOUD','OLLAMA_FLASH_ATTENTION','OLLAMA_KV_CACHE_TYPE') {
    [Environment]::SetEnvironmentVariable($v, $null, 'User')
    Remove-Item "env:$v" -ErrorAction SilentlyContinue
}
```

Verify they are gone (each line should print blank):

```
'OLLAMA_ORIGINS','OLLAMA_NO_CLOUD','OLLAMA_FLASH_ATTENTION','OLLAMA_KV_CACHE_TYPE' | ForEach-Object { "$_ = " + [Environment]::GetEnvironmentVariable($_,'User') }
```

Already-open terminals keep the old values until they are restarted.

### 3.3 Remove the model

```
ollama rm gemma4:e2b
```

To remove **all** models and reclaim the full model store:

```
Remove-Item "$env:USERPROFILE\.ollama" -Recurse -Force
```

### 3.4 Stop the running service

```
Stop-Process -Name 'ollama app' -Force -ErrorAction SilentlyContinue
Stop-Process -Name 'ollama' -Force -ErrorAction SilentlyContinue
```

Confirm nothing is listening on the API port:

```
Test-NetConnection -ComputerName 127.0.0.1 -Port 11434 -WarningAction SilentlyContinue | Select-Object TcpTestSucceeded
```

### 3.5 Clear the TEMP installer

```
Remove-Item "$env:TEMP\SOTI-AI-OllamaSetup" -Recurse -Force -ErrorAction SilentlyContinue
```

### 3.6 Remove the extension and its data

Go to `chrome://extensions`, find **SOTI AI Analyser**, click **Remove**. This deletes all
case data, chat history, and learned insights held in `chrome.storage.local` — it is not
recoverable afterwards. Export anything still needed first (⋮ menu → Export session).

---

## 4. Partial rollback: keep Ollama, undo only the SOTI hardening

If Ollama is shared with other tools and only the SOTI-specific settings should go, run
§3.2 alone and restart Ollama. Ollama then reverts to its built-in defaults — note that
this **re-enables cloud features** and drops the origin restriction back to Ollama's
default allow-list.

---

## 5. Extension ID

`manifest.json` contains a `key` field that fixes the extension ID to:

```
odkmlcpmfgdfoikmcmhoongggbepbdna
```

`setup_local_ai.ps1` pins `OLLAMA_ORIGINS` to exactly that ID, so only this extension can
reach the local model from a browser. The two must stay in step:

- **If you change or remove the `key`**, the extension ID changes and the local AI stops
  working until the script is re-run with the matching `-ExtensionId`.
- **If you deploy from the Chrome Web Store or by enterprise policy**, that ID wins. Run
  the installer with it:

  ```
  powershell -ExecutionPolicy Bypass -File setup_local_ai.ps1 -ExtensionId <32-char-id>
  ```

- **Changing the ID resets storage.** Chrome keys `chrome.storage.local` by extension ID,
  so an ID change presents as a first run with no saved cases. Export before changing it.

The private half of the key lives at `soti-extension-signing-key.pem` in the repository
root and is **git-ignored**. It is needed only to publish a `.crx` under this same ID —
back it up somewhere secure. The extension does not need it to run.

---

## 6. Scope limits of the hardening

`OLLAMA_ORIGINS` is a **browser-boundary control**, and it is worth being precise about
what that does and does not buy:

- It blocks other websites and other Chrome extensions. *(Verified.)*
- It does **not** block local processes. Ollama accepts any request that carries no
  `Origin` header, which is every direct API call from a script or program on the machine.
- Ollama independently allows `localhost` / `127.0.0.1` on **any port**, plus `app://`,
  `tauri://` and `vscode-webview://` origins, and this default cannot be removed via
  `OLLAMA_ORIGINS`.

Treat the local Ollama API as reachable by anything already running on the machine. The
control that matters for confidentiality is `OLLAMA_NO_CLOUD=1` (§1 item 3), which keeps
inference on the device.
