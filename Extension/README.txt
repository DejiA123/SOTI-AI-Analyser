SOTI AI Analyser
================

AI-powered log analysis, case management, and Salesforce integration for the
SOTI support team. Runs 100% locally via Ollama — no cloud, no API keys,
no data sent externally.


HOW TO INSTALL (Chrome Extension — recommended)
------------------------------------------------

1. Download or clone this repository.
2. Open Chrome or Edge and go to the Extensions page:
     Chrome: chrome://extensions
     Edge:   edge://extensions
3. Enable Developer Mode (toggle in the top-right).
4. Click "Load unpacked" and select the Extension folder.
5. Click the SOTI AI Analyser icon in the toolbar to open the side panel.

Works in Chrome, Edge, Brave, Opera, and Vivaldi.


STANDALONE OPTION (No installation required)
--------------------------------------------

If you prefer not to install the extension, you can use the tool as a plain
web page. Note: Tesseract OCR and local Ollama AI require the page to be served
over HTTP — opening the HTML file directly (file://) will block both.

1. Double-click serve_standalone.bat (requires Python or PowerShell — both
   are pre-installed on Windows).
2. Keep the terminal window open.
3. Open http://127.0.0.1:8765/SOTI_AI_Analyser.html in your browser.

Note: Salesforce sync (content.js) only works in the Chrome extension.


LOCAL AI SETUP (Ollama)
-----------------------

The extension uses a locally-running Ollama model for all AI responses.

First-time setup:
1. Open the extension, click the ⋮ menu → Settings.
2. Click "Download setup_local_ai.bat" and run it (double-click).
3. Wait for the setup to complete (~7.2 GB model download, one time only).
   Allow around 10 GB of free disk space for the model plus runtime overhead.
4. Back in Settings, click the refresh icon to detect models, then Save.


FILE INVENTORY
--------------

Core extension files (required):
  manifest.json           Extension configuration and permissions
  SOTI_AI_Analyser.html   Main UI (side panel)
  sidepanel.js            All application logic (~17,900 lines)
  power.js                Power & resource governor — caps this app's memory and
                          CPU use per machine (must load before sidepanel.js)
  styles.css              UI styling
  background.js           Service worker (opens side panel on click)
  content.js              Injected into Salesforce to sync case data

OCR support (lib/ folder — required):
  tesseract.v5.min.js             Tesseract.js OCR library
  worker.min.js                   Tesseract web worker
  tesseract-core.wasm(.js)        WASM OCR engine (standard)
  tesseract-core-simd.wasm(.js)   WASM OCR engine (SIMD optimised)
  tesseract-core-simd-lstm.wasm(.js) WASM OCR engine (SIMD + LSTM)
  eng.traineddata.gz              English language OCR model (~10 MB)

  Note: The worker.v5.min.js and tesseract-core.v5.* files are aliases of
  their non-v5 counterparts included for compatibility. The *.wasm files are
  the binary payloads loaded by their corresponding *.wasm.js loaders.

Knowledge base (knowledge/ folder — required):
  MobiControl.md          Product-specific AI context for MobiControl
  Connect.md              Product-specific AI context for SOTI Connect
  XSight.md               Product-specific AI context for SOTI XSight

Standalone server (optional — for non-extension users only):
  serve_standalone.bat    Starts a local HTTP server (Python or PowerShell)
  serve_standalone.ps1    PowerShell fallback server (used by the .bat)

Local AI installer (optional — for first-time Ollama setup):
  setup_local_ai.bat      Automated Ollama + model installer for Windows
  setup_local_ai.ps1      PowerShell implementation of the above installer

Tests:
  Removed from the repository. After editing sidepanel.js run "node --check sidepanel.js"
  and then load the panel — see PROJECT_OVERVIEW.md section 5.11.

Repo files:
  README.txt              This file
  SECURITY.md             Security & data-protection assessment
  UNINSTALL.md            Rollback/uninstall steps for the local AI setup
  .gitignore              Git ignore rules


RESOURCE USE (why the app doesn't slow your machine down)
---------------------------------------------------------

The app measures itself and works out how much memory it may use on YOUR machine
— roughly 1.8 GB on a 16 GB laptop, less on a smaller one. When it approaches that
limit it automatically shrinks its workload and hands back caches it can rebuild,
rather than letting the browser run out of memory.

The live pill in the top bar shows what it is currently using. Click it for:
  - what this app has budgeted for your machine, and why
  - live memory and responsiveness
  - how fast recent AI runs were (time to first token, tokens/sec)
  - "Free memory now" and "Copy report" (for bug reports)

IMPORTANT: this covers the browser panel only. The AI model itself runs inside
Ollama as a separate program holding its own 3-4 GB, which the panel cannot see or
control. If the whole machine is short of memory, lower Context Size in Settings
(or use a smaller model) — that is the setting that moves Ollama's usage.


FEATURES
--------

  Case Management     Multi-tab case workspace with persistent state across sessions
  AI Chat             Ask the AI anything about a case — powered by local Ollama
  Log Analysis        Upload MS, DS, Agent, DDR, HAR, and MSI logs for deep forensics
  Salesforce Sync     Auto-pull case number, account, platform, and email chain from SF
  OCR                 Extract text from screenshots using on-device Tesseract v5
  JIRA Reports        Generate formatted JIRA tickets from AI conversation + case data
  Power Monitor       The app measures itself and stays inside a memory budget it
                      works out for your machine, so it never freezes the laptop.
                      Click the live MB pill in the top bar for the full report.
  Privacy             All processing is local — no data leaves your machine
