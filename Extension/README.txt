SOTI AI Analyser
================

A Chrome side-panel tool for SOTI support engineers. It reads a Salesforce case —
fields, email chain, internal notes and their replies — takes your log files, and
answers questions about them.

The AI comes from Microsoft 365 Copilot — the enterprise Copilot the company
already runs. There is no API key and no endpoint to configure: the tool relays
each question through the Copilot session you are already signed in to, and reads
the answer back. That relay is what "the bridge" means throughout these docs.


WHAT YOU NEED
-------------

  * Chrome or Edge.
  * A Microsoft 365 account with Copilot, signed in in the same browser.
  * Access to your Salesforce org.

Nothing to install beyond the extension itself. No model download, no server.


INSTALL (5 minutes, once)
-------------------------

1. Download or clone this repository.

2. Open your browser's Extensions page:
       Chrome: chrome://extensions
       Edge:   edge://extensions

3. Turn on "Developer mode" (top-right).

4. Click "Load unpacked" and choose the Extension folder.

5. Click the SOTI AI Analyser icon in the toolbar. The side panel opens.

6. Sign in to Microsoft 365 Copilot in a normal browser tab if you are not
   already: https://m365.cloud.microsoft

7. In the panel, open Settings (the ⋮ menu) and click "Grant access to
   https://m365.cloud.microsoft". Chrome will ask you to allow it — this is what
   lets the tool read Copilot's answer back. Then press "Test Copilot Bridge
   Connection". You should get a reply within a few seconds.

That is the whole setup.

Works in Chrome, Edge, Brave, Opera and Vivaldi.


DAY-TO-DAY USE
--------------

Working one case:

  1. Open the case in Salesforce.
  2. In the panel, open the Case Info Panel.
  3. Click "Sync from Salesforce".

The sync opens the case's Feed tab for you, scrolls the whole email chain into
view, and pulls in the case fields, the emails, the internal notes and the
replies to those notes. Then ask it anything, or use a Quick Option
(Case Summary, Draft Email, JIRA, Problem & Resolution).

Working your queue:

  1. Open your case list in Salesforce (e.g. Cases → My Open Cases).
  2. In the panel, click the "Open Cases" tab, then "Sync from Salesforce".

You get one line per case — number, subject, severity, age — grouped by
entitlement tier. From there you can:

  * Search by case number, subject or account.
  * Filter to one tier (Enterprise / Premium / Standard).
  * Sort by age, by severity, or by whose move it is.
  * Expand a case (the ▸) to read the customer's description.
  * Click a case to open it in Salesforce and sync it in one go.

Cases marked in RED are "Waiting on SOTI response" — those are the ones sitting
on you.

Log analysis:

  1. Attach files with the 📄 button beside the chat box — LOG, TXT, XML, JSON,
     HAR, CSV, or a ZIP bundle.
  2. Click "Analyse Now".

A ZIP is unpacked for you and findings are cited back to the file they came
from. Screenshots are read with on-device OCR.


WHERE YOUR DATA GOES
--------------------

Worth understanding before you use it on a customer case.

  * Case content and log text are sent to Microsoft 365 Copilot to be analysed.
    They leave your machine.
  * They go to the SAME enterprise Copilot the company already licenses and
    approves — your own signed-in session, inside the company tenant. This tool
    does not introduce a new AI service or a new supplier; it connects to the one
    that is already there. In effect it does automatically what you are already
    allowed to do by hand: put case material into Copilot and read the answer.
  * There is no API key and no endpoint. The extension holds no credential for
    Microsoft and never calls Microsoft directly — it types into the Copilot page
    and reads the reply, and the page's own session carries the traffic.
  * Each relayed chat is titled with the case number, so the Copilot history
    reads as a record you can navigate. Nothing is deleted by default.
  * Network captures (.har) are redacted for tokens, cookies and auth headers
    before anything is sent.
  * Cases, logs and chat history are stored on your device in the browser's
    extension storage, and auto-deleted after 30 days of inactivity.
    Settings → "Clear all cases & logs now" wipes them immediately.

Case material is NOT redacted before it is sent — customer names, email chains
and log text go as written. See SECURITY.md for the full assessment.


IF SOMETHING DOES NOT WORK
--------------------------

"Chrome access is needed for ..." or the relay cannot read the answer
    Settings → "Grant access to https://m365.cloud.microsoft", then accept
    Chrome's prompt. This is per-host and only a click can ask for it.

The sync says it could not find the case, or the panel looks empty
    Make sure the Salesforce case is in the ACTIVE tab, then sync again.
    Content-script changes need the Salesforce tab reloaded.

The relay opens a window and nothing happens
    Check you are still signed in to Copilot. Settings → "Test Copilot Bridge
    Connection" tells you which stage failed.

Answers stop mid-way, or a case comes back trimmed
    A very large case is sent as several messages. The panel says so when it
    has to trim, and never trims silently.

For anything else, open the side panel's console and run SOTI_DIAG() — it
prints what the panel thinks is configured and where it is failing.


WHAT IS IN THE FOLDER
---------------------

Core (required):
  manifest.json            Extension configuration and permissions
  SOTI_AI_Analyser.html    The side-panel UI
  sidepanel.js             Application logic — UI, prompts, analysis, storage
  ai-provider.js           Provider layer; translates to and from the bridge
  copilot-bridge.js        Drives the Copilot tab and reads the answer back
  content.js               Injected into Salesforce to read case data
  power.js                 Memory/CPU governor (must load before sidepanel.js)
  background.js            Service worker; opens the side panel
  styles.css               UI styling

OCR (lib/ — required):
  tesseract.v5.min.js, worker.min.js, tesseract-core*.wasm(.js),
  eng.traineddata.gz       On-device screenshot OCR (Tesseract v5)

Knowledge base (knowledge/ — required):
  MobiControl.md, Connect.md, XSight.md, and their *_Knowledge.md companions
                           Product context sent alongside a case, so a hosted
                           model knows what a Deployment Server is
  PulseKnowledge.md        Offline copy of SOTI Pulse, used by the search index

Docs:
  README.txt               This file
  SECURITY.md              Security & data-protection assessment
  PROJECT_OVERVIEW.md      How it works internally, and why
  UNINSTALL.md             Removal steps

Tests are not in this repository. After editing sidepanel.js run
"node --check sidepanel.js" and load the panel — see PROJECT_OVERVIEW.md §5.11.


RESOURCE USE
------------

The tool measures itself and works out how much memory it may use on YOUR
machine — roughly 1.8 GB on a 16 GB laptop, less on a smaller one. When it gets
close it shrinks its workload and hands back caches it can rebuild, rather than
letting the browser run out of memory.

There is no local model, so nothing else is holding several gigabytes on your
behalf. Run SOTI_POWER() in the side panel's console for the full report:
the budget it has set for your machine, live memory, and how fast recent runs
were.
