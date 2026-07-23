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
3. Wait for the setup to complete (~2 GB model download, one time only).
4. Back in Settings, click the refresh icon to detect models, then Save.


FILE INVENTORY
--------------

Core extension files (required):
  manifest.json           Extension configuration and permissions
  SOTI_AI_Analyser.html   Main UI (side panel)
  sidepanel.js            All application logic (~5900 lines)
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

Repo files:
  README.txt              This file
  .gitignore              Git ignore rules


FEATURES
--------

  Case Management     Multi-tab case workspace with persistent state across sessions
  AI Chat             Ask the AI anything about a case — powered by local Ollama
  Log Analysis        Upload MS, DS, Agent, DDR, HAR, and MSI logs for deep forensics
  Salesforce Sync     Auto-pull case number, account, platform, and email chain from SF
  OCR                 Extract text from screenshots using on-device Tesseract v5
  JIRA Reports        Generate formatted JIRA tickets from AI conversation + case data
  Privacy             All processing is local — no data leaves your machine
