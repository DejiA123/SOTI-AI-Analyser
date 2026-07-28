SOTI AI Analyser — Complete Project Overview
> A plain-English, developer-friendly guide to how this extension works, what the
> important code does, and **why** it was built this way (including the alternatives
> that were considered and rejected). Read top-to-bottom the first time; after that
> use it as a reference.
---
1. What this project is (in one paragraph)
The SOTI AI Analyser is a Google Chrome side-panel extension that helps SOTI
support engineers analyse log files from SOTI products (MobiControl, SOTI Connect,
SOTI XSight, SOTI Identity). You attach log files, optionally fill in case details, and a
local AI model (running on your own machine through Ollama) reads the logs and
tells you the likely root cause and fix. It also answers general SOTI questions using an
offline copy of SOTI's official help documentation, can pull case details from Salesforce,
and learns from your feedback over time. Nothing leaves your machine — the AI runs
locally, which is the whole point for handling customer logs.
---
2. The big picture — how a single analysis flows
```
┌─────────────┐   attach    ┌──────────────────┐   build prompt   ┌─────────────┐
│  You (UI)   │ ─────────►  │  sidepanel.js    │ ───────────────► │   Ollama    │
│ side panel  │  + ask      │ (the whole brain)│   (local HTTP)   │ gemma4:2b   │
└─────────────┘             └──────────────────┘ ◄─────────────── └─────────────┘
       ▲                            │   streamed answer (tokens)
       │  rendered answer           │
       └────────────────────────────┘

Supporting inputs the brain pulls in while building the prompt:
  • Log Intelligence pipeline  → finds errors/exceptions/timestamps in your logs
  • PulseKB (offline RAG)       → relevant excerpts from SOTI's official docs
  • Learned insights            → root causes you previously confirmed with 👍
  • Salesforce (content.js)     → case number, product, version, email chain
```
Everything important happens in `sidepanel.js`. The other files are small and play
supporting roles. The single most important function is `send()` — it assembles the
prompt and talks to the AI. Section 7 walks through it line by line.
---
3. The technology stack — and why these choices
Choice	What it is	Why this, and not the alternative
Chrome Extension (Manifest V3)	The app is a browser extension, not a website or desktop app	Engineers already live in Chrome with Salesforce open. A side panel sits next to their work. MV3 is the only version Chrome accepts for new extensions today.
Vanilla JavaScript (no React/Vue)	Plain JS + direct DOM calls (`document.createElement`, `$('id')`)	No build step, no `npm install`, no framework to learn or update. One `.js` file you can edit and reload. For a single-developer internal tool, a framework would add complexity without payback. The trade-off: `sidepanel.js` is large (~7,800 lines) and you manage the DOM by hand.
Local AI via Ollama	Ollama runs an open model (gemma4) on your CPU and exposes an HTTP API at `127.0.0.1:11434`	Customer logs can contain sensitive data. A cloud AI (ChatGPT/Claude API) would send that data off-machine — unacceptable. Local = private, free, offline-capable. The trade-off: it's slower (your CPU, not a datacentre GPU).
Streaming HTTP (`fetch` + `ReadableStream`)	The answer arrives token-by-token, not all at once	The user sees words appear immediately instead of staring at a blank screen for a minute. Critical UX on a slow CPU.
`chrome.storage.local`	Where cases/settings are saved	Survives browser restarts (unlike `sessionStorage`), has a large quota with the `unlimitedStorage` permission, and is the standard for extensions. `localStorage` is used only as a fallback when running outside the extension.
Tesseract.js (in `lib/`)	OCR — reads text out of screenshot images	Engineers often paste screenshots of error dialogs. Tesseract extracts the text so the AI can read it. Runs locally in the browser (WASM), no upload.
---
4. File-by-file tour
File	Size	What it does
`sidepanel.js`	~7,800 lines	The entire application brain. UI events, state, the log-analysis pipeline, the AI engine, prompts, RAG, self-learning. Everything below is in here.
`SOTI_AI_Analyser.html`	~417 lines	The side-panel UI markup: the chat area, the case-info panel, the logs panel, the settings modal.
`styles.css`	~1,000 lines	All styling (dark theme, layout, chat bubbles, the 👍/👎 feedback row, etc.).
`background.js`	29 lines	The service worker. Tells Chrome to open the side panel when the toolbar icon is clicked, and clears stale network rules. Tiny by design.
`content.js`	~324 lines	The Salesforce scraper. Injected into Salesforce pages; reads case fields off the page (handling Salesforce's nested "Shadow DOM") and sends them to the panel.
`manifest.json`	~60 lines	The extension's "ID card": its name, permissions, which URLs it may talk to, and which files load when.
`knowledge/*.md`	—	Product knowledge in two layers. (1) Small "log signature" cheat-sheets injected during analysis: `MobiControl.md`, `Connect.md`, `XSight.md`. (2) The RAG corpus searched by `PulseKB`: `PulseKnowledge.md` (a 24 MB MobiControl scrape, ~10,000 articles) plus the curated, source-referenced `Connect_Knowledge.md` and `XSight_Knowledge.md`. Extend a product by appending `# Title` / `Source:` / body articles to its corpus file, or add a file to `PulseKB.KB_FILES`.
`setup_local_ai.ps1` / `.bat`	—	One-click installer: installs Ollama, pulls the model, and sets Ollama's environment variables (CORS + speed). The `.bat` just launches the `.ps1`.
`lib/`	—	Tesseract.js OCR engine and its WASM/model data.
---
5. The core subsystems (deep dives)
5.1 Cases & state persistence
A case is one investigation: a name, chat messages, attached logs, attached images,
and the case-info fields. The app can hold several cases as tabs.
```js
// getDefaultCase() — the shape of a case object
{
  id, name,
  msgs: [],   // chat history: [{role:'user'|'assistant', content, hidden}]
  logs: [],   // attached log files: [{name, content, lines, uploadedAt, panelIntel}]
  imgs: [],   // attached images (with OCR text)
  ci: {},     // case info from the form / Salesforce
  createdAt
}
```
Saving (`saveState`): writes the whole `cases` array to `chrome.storage.local`. Two
clever details and why:
Throttled/debounced saves (`scheduleSaveState`, 450 ms): typing in the case panel
fires many change events. Without debouncing it would write to storage on every
keystroke. Debouncing means "wait until they stop typing, then save once."
A `sessionStorage` quick-cache: a tiny snapshot is written synchronously so that
when you re-open the panel it paints instantly from the cache, while the full data
loads from `chrome.storage` (which is asynchronous) a moment later. This removes the
"blank panel for half a second" feeling.
Loading (`loadState`) also enforces a 7-day retention policy — a case (and its
stored logs) is auto-deleted after 7 days of inactivity. The clock is keyed on last
activity (`updatedAt`, stamped on every save), not creation time, so a case you keep
working on survives and only genuinely idle cases are cleared. Settings → Data & Privacy
also has a "Clear all cases & logs now" button (`btnClearAllData`) that wipes all cases,
logs, and learned insights from the device immediately. Why: log data is sensitive, so it
shouldn't sit on disk longer than needed.
> **Security note — how is this data protected?** It's stored *unencrypted* in
> `chrome.storage.local` (a LevelDB database inside your Chrome profile). It is **sandboxed**
> (no website or other extension can read it) and **never uploaded** (we use `storage.local`,
> not `storage.sync`). It is **not** reachable by a remote attacker — the extension exposes
> no inbound network surface. The realistic risk is *local* access (malware running as you,
> an unlocked laptop, or a stolen drive with no disk encryption) — the same exposure as the
> raw log files already in Downloads. The strong mitigation is OS-level: **BitLocker disk
> encryption + a locked screen**. Meaningful in-extension encryption isn't practical (there's
> nowhere safe to keep the key), which is why we rely on the OS + short retention + the
> clear-now button instead.
> **Design note — why `chrome.storage.local` and not a database?** A database (IndexedDB,
> SQLite-WASM) would be overkill for "a few dozen cases." `chrome.storage.local` is
> simple, built-in, and survives restarts. The cost is that we serialize the whole
> `cases` array each save — fine at this scale.
5.2 Log ingestion & the "Log Intelligence" pipeline
This is the largest part of the file and the cleverest. When you attach a log, the app
does not just dump raw text at the AI. A weak local model would drown. Instead it
pre-analyses the log with plain code first, then feeds the AI a focused summary plus
the most relevant raw lines.
The flow when you attach a file (`handleFiles`):
Read the file (handles `.log`, `.txt`, `.xml`, `.json`, `.har`, and `.zip` archives).
`normalizeLogText` — clean up encoding (`decodeLogBytes` handles UTF-8/UTF-16/BOM).
`getLogPanelIntel` — scan the log and cache an "intel" summary on the log object:
line count, first/last timestamp, top error category, top exception, detected product,
a verdict, and ranked "root-cause candidate" lines.
The scanning helpers each do one job (this is deliberate — small, named, testable):
`classifyLogLine` — looks at one line and decides: is this an error? an exception?
SQL? a certificate problem? MSI installer noise to ignore? It returns categories +
keyword hits.
`scoreRootCauseCandidate` — gives each suspicious line a score so the worst
offenders bubble to the top. A `SqlException` outscores a generic `WARN`.
`FAST_FORENSIC_PREFILTER` (a regex) — a cheap first pass so we only run the
expensive classifier on lines that might matter, not all 50,000 lines.
> **Why pre-process at all instead of "just send the log to the AI"?** Two reasons.
> (1) **Context limits** — a 50,000-line log is millions of characters; it doesn't fit in
> the model's memory window. (2) **Small-model accuracy** — gemma4:2b can't reliably find
> one error in a haystack. By extracting and ranking the evidence in code first, we hand
> the model a short, high-signal brief it *can* reason about. The code is the detective's
> magnifying glass; the AI writes the report.
When it's time to analyse, several builders turn the intel into prompt text:
`buildFileManifest` — one line per file (name, line count, product, top signals). This
guarantees the AI always knows every file exists, even if a file's detailed snippet
had to be trimmed.
`buildLogPatternProfile` / `buildCrossLogIncidentIndex` — cross-file summaries of what
went wrong and when.
`getSmartLogSnippet` — picks the most relevant raw lines (head + tail + windows around
incidents) up to a character budget, instead of a blind "first N characters."
5.3 The AI engine (`OllamaAI.completions.create`)
This is the function that actually talks to Ollama. It receives the assembled messages and
returns a stream of tokens. The hard part is fitting the prompt into the model's memory
window without overflowing it, because overflow = the model silently drops your logs.
Key concepts (see the Glossary, section 9, if these are new):
`num_ctx` — the size of the model's working memory (the "context window"), measured
in tokens. Everything (your prompt + the model's answer) must fit inside it.
`num_predict` — the maximum number of tokens the model may generate as its answer.
```js
// We probe each model for its REAL context window once, then cache it.
async function getModelContextLength(model) { /* POST /api/show, read *.context_length */ }
```
> **Why probe instead of hard-coding?** Different models have different windows
> (gemma4 supports 131,072 tokens; older models far less). Asking Ollama via `/api/show`
> means the code adapts to whatever model you select, instead of guessing.
Sizing strategy (the important bit):
```js
// One FIXED context size per model for the whole session.
async function getSessionCtx(model) {
  const { hardMax } = await getHardCtxMax(model);          // model max ∩ your setting
  const small = /(2b|3b|...|e2b|e4b)/i.test(model);
  if (LOCAL_AI_CTX_MAX !== 'auto') return hardMax;          // honour your manual setting
  return small ? Math.min(8192, hardMax) : Math.min(32768, hardMax);
}
```
> **Why a FIXED size and not "grow to fit each request"?** Ollama re-allocates the model
> (effectively a full reload — many seconds on a CPU) **whenever `num_ctx` changes between
> requests**. An earlier version recalculated `num_ctx` per message, so the model reloaded
> almost every turn. Fixing it means the model loads **once** and stays warm. This was one
> of the biggest speed wins.
>
> **Why 8,192 for small models and not the full 131,072?** On a CPU, every extra 1,000
> tokens of context adds real seconds of "prefill" time (the model reading your prompt).
> A 131K window would be technically possible but unusably slow. 8K is the sweet spot:
> enough for the manifest + key log evidence + case summary, small enough to stay fast.
> You can raise it in Settings → Context Size if you have a faster machine.
Budgeting & trimming. Before sending, the code checks the prompt fits:
```js
const CHARS_PER_TOKEN = 2.5;  // measured: gemma turns ~2.5 chars of log text into 1 token
const maxAllowedChars = (ctxCeiling - numPredict - 600) * CHARS_PER_TOKEN;
```
> **Why 2.5 and not the usual ~4?** Log files (timestamps, GUIDs, stack traces) tokenize
> *denser* than English prose. Measuring real logs gave ~2.55 chars/token. Using a
> conservative 2.5 means we slightly **over**-estimate token count, so `num_ctx` is never
> set too small — the prompt never overflows.
If the prompt is still too big, trimming happens in priority order: drop oldest chat
history first, then trim the case/research data from the end — the log section and
the file manifest are placed early in the prompt and are never cut. (See 5.4 for why
order matters.)
Robustness — the request itself:
```js
let res = await doOllamaFetch(numCtx);
if (!res.ok) {
  if (/memory|oom|allocate/i.test(err) && numCtx > 8192) {  // GPU/RAM exhausted
    numCtx = Math.max(8192, numCtx / 2);                     // retry once, smaller
    res = await doOllamaFetch(numCtx);
  }
}
```
> **Why retry on out-of-memory?** On a low-RAM machine a big context can fail to allocate.
> Rather than show an error, we halve the window and try again — degraded but working.
Other request settings and why:
`temperature: 0.0` — deterministic output. For forensic analysis you want the same
logs to give the same answer, not creative variation.
`keep_alive: -1` — keep the model in memory indefinitely between requests (no reload).
`think: false` (for gemma/reasoning models) — skip the model's internal "thinking" phase
so the answer goes straight to the visible output and isn't wasted as hidden reasoning.
5.4 Prompts & personas
A system prompt is the instruction text that tells the AI who it is and how to behave.
This project has several, picked depending on the situation:
Function	Used when	Personality / job
`getLogForensicsSystemPrompt`	"analyse the logs" / "root cause"	Short, strict MSI/installer forensic report
`getLeanLogPrompt`	Log analysis on a large model	Full ~13 KB structured forensic report format
`getCompactLogPrompt`	Log analysis on a small/CPU model	Trimmed (~1.5 KB) — same rules, fast prefill
`getConversationalPrompt`	Logs attached but you asked a normal question	Answers directly, no rigid report
`getLeanQAPrompt`	No logs — general SOTI Q&A	Uses live/offline docs to answer
All of them share one identity constant:
```js
const TIER3_IDENTITY = `You are the SOTI Tier-3 AI Analyser — a senior escalation
engineer for the SOTI ONE Suite ...`;
```
> **Why a shared constant?** So the persona ("Tier-3 escalation engineer, never guesses")
> is identical everywhere and you change it in **one place**. Copy-pasting it into five
> prompts would drift over time.
>
> **Why a separate tiny prompt for small models?** The full forensic prompt is ~3,700
> tokens. On your CPU at ~22 tokens/sec of prefill, that's ~165 seconds of waiting before
> a single word appears — which reads as a "frozen/blank" app. The compact prompt keeps
> the non-negotiable rules and drops the verbosity, so the model starts answering quickly.
5.5 Intent routing — "analyse" vs "just answer"
The problem this solves: once logs are attached, every message used to be treated as a
log analysis — so "what's the case number?" got a forensic report saying "insufficient
evidence." Not intelligent.
```js
function wantsLogAnalysis(text, silent) {
  if (silent && text.trim().toLowerCase() === 'analyse') return true;   // the Analyse button
  if (/\bcase\s*(number|info|summary|...)\b/.test(t)) return false;     // a case question
  return /\b(analy[sz]e|root\s*cause|why\s+(is|did)|the\s+(error|...))\b/.test(t);
}
```
`send()` then chooses:
Analysis mode → forensic/compact prompt + full log evidence.
Conversational mode (logs attached, normal question) → conversational prompt + just
the file manifest (fast) + full case info.
Q&A mode (no logs, or a version/release-notes question) → Q&A prompt + research.
> **Why route on the message instead of a mode toggle?** Less friction. The user just
> types naturally; the app figures out whether they want a report or an answer. The
> conversational path is also much faster because it sends the manifest, not full snippets.
5.6 Offline knowledge base — `PulseKB` (RAG)
RAG = "Retrieval-Augmented Generation": instead of hoping the model memorised SOTI's
docs, we search a local copy of the docs and paste the relevant bits into the prompt.
`PulseKnowledge.md` is 24 MB (~10,000 articles). `PulseKB` handles it:
```js
const PulseKB = {
  chunks: null,
  async ensureIndex() {            // run ONCE per session
    const raw = await fetch('knowledge/PulseKnowledge.md');
    const parts = raw.split('\n# ');         // split into articles on the "# Title" lines
    this.chunks = parts.map(text => ({ text, lower: text.toLowerCase(), ... }));
  },
  search(query, kws, opts) { /* score every chunk by keyword overlap, return top few */ }
};
```
> **Why index once and cache?** The old code re-read and re-lowercased all 24 MB on **every
> message** — slow and wasteful. `ensureIndex()` does it a single time (warmed 3 seconds
> after the panel opens), then every search is fast.
>
> **Why `split('\n# ')` instead of a fancy parser?** The file is structured as Markdown
> articles, each starting with `# Title`. A plain string split on that marker is ~1000×
> faster than regex on a 24 MB string, and it's all we need.
>
> **Why keyword scoring and not "vector embeddings" (the modern RAG approach)?** Embeddings
> would need an embedding model + a vector store — more moving parts, more startup cost, and
> another model loaded on an already-busy CPU. Keyword scoring (with bonuses for title
> matches, product names, and log error signatures) is simple, instant, and good enough for
> looking up known SOTI terms. It's the right tool for *this* machine.
When logs are attached, KB results are injected as a clearly-labelled `[SUPPORTING REFERENCE — background only]` block, and the prompt explicitly tells the model not to
summarise the articles as the answer — so it stays focused on your logs. (On small
models this lookup is skipped entirely to save time.)
5.7 Self-learning (the 👍/👎 loop)
True fine-tuning of the model isn't possible from inside a browser. So "learning" here is
retrieval-based: confirmed answers are saved and re-injected into similar future cases.
```
You 👍 an analysis  →  saveLearnedInsight()  →  chrome.storage.local.learnedInsights
                                                  { product, keywords, signatures,
                                                    rootCause, resolution, verdict }
Later, similar logs  →  matchLearnedInsights()  →  [LEARNED FROM PAST CONFIRMED CASES]
                                                    injected into the new prompt
```
`attachFeedbackUI` adds the 👍/👎 row under substantial answers.
👎 lets you type the real cause; it's stored as a correction and later shown to the
model as "previously the AI wrongly concluded X; the confirmed cause was Y."
`matchLearnedInsights` only injects an insight when it shares ≥2 keywords/signatures with
the current case — so irrelevant past cases don't leak in.
> **Why not real fine-tuning?** It needs the base model weights, a GPU, and a training
> pipeline — none of which exist in a Chrome extension. Retrieval-based learning gives the
> practical benefit (the tool gets better on cases you've seen) without the impossible
> infrastructure. Be honest about this: it's "memory," not "retraining."
5.8 Salesforce integration (`content.js`)
A content script runs inside a web page (here, Salesforce). `content.js` reads case
fields off the open Salesforce case and sends them to the panel, so you don't retype them.
The hard part is that Salesforce hides fields inside Shadow DOM (isolated DOM
sub-trees) and off-screen background tabs. Hence helpers like `findInShadows` (walks into
shadow roots) and `isVisible` (ignores hidden/off-screen elements). `cleanFieldValue`
strips Salesforce's button-text noise (e.g. `"Acme CorpOpen Preview Edit"` → `"Acme Corp"`).
> **Why scrape the page instead of using the Salesforce API?** The API needs OAuth setup,
> admin permissions, and credentials. Scraping the already-open page needs none of that —
> it just reads what the engineer is already looking at. The trade-off: if Salesforce
> changes its HTML, the selectors may need updating.
Alongside case number, account, subject, versions and the feed, the scraper reads MC
Hosted (Cloud vs On-Prem). That one field decides who can collect the server logs, so it
drives the whole evidence half of every answer — see 5.9. License Type remains only as a
fallback for layouts that don't expose MC Hosted.
---
5.9 Case-answer guards — the deterministic checks around the model
The quick actions (Case Summary + Next Steps, Draft an email, Work out a
resolution, 30/60/90) produce text that goes to a customer or into the Salesforce
record, so three classes of error are checked in JavaScript rather than trusted to the
model. Each has a prompt side (tell the model) and an output side (verify the answer),
because an instruction is not a guarantee on a small local model.
1. MCMR citations must be right, or absent. An MCMR code promises the customer that
their exact defect is fixed in a named build, so a near-miss is worse than silence.
Matching (`releaseNoteLineMatchesSymptom`): a release-notes line reaches the prompt only
if it matches the case symptom on a contiguous phrase ("internal server error") or on
3 word hits including 2 distinctive ones. Bag-of-words alone is not enough — a case
written in generic vocabulary ("error", "server", "upgrade") matches almost every resolved
issue ever shipped, which is how an unrelated fix once got cited.
Scoping: a troubleshooting turn never receives a wholesale resolved-issues dump. With a
customer version it runs the upgrade scan (newer versions only); without one it runs
the symptom scan (matching lines across all versions). An explicit "show me the release
notes" question is the only case that gets the full listing (`MCMR_CITATION_MODE = 'open'`).
Enforcement (`enforceMcmrCitations`): every `MCMR-xxxxx` in the finished answer is checked
against the allow-list (symptom-verified entries + codes already on the case + codes in the
logs). Anything else has its sentence deleted and a visible note appended — removing a
factual claim must be visible, never silent.
2. Next steps must be executable. `stripVagueNextSteps` deletes a forward-looking step
only when it is both generic-verification phrasing (`VAGUE_STEP_RE`) and carries no
concrete anchor at all (`CONCRETE_ANCHOR_RE` — a named file, service, port, console path,
error string, quoted text, timestamp). Requiring both keeps real steps safe; a bare version
number is deliberately not an anchor, because "verify the configuration against known
stable states for 2026.1.1" is still unactionable. Sections that record the past
("Troubleshoots done") are never edited. `buildSymptomPlaybook` supplies the vocabulary that
makes specificity possible: real service names, log files, ports and error signatures from
`knowledge/MobiControl*.md`, selected by matching the case symptom against a table.
3. Evidence must be collected from the right side. `buildLogAccessDirective` turns the
MC Hosted field into a fact directive:
MC Hosted	Who collects	What the answer must say
Cloud	The support agent, from the backend	Name the artefact and time window the agent pulls; asking the customer for server logs is forbidden; only device-side evidence is requested
On-Prem	The customer	Name each log, server role, log level and time window; include arranging a screen-share to reproduce and capture together with exact timestamps
(blank)	Unknown	Confirm the hosting first; never write an unconditional "ask the customer for the logs"
`flagLogAccessMismatch` then checks the answer and appends a correction if it collected from
the wrong side. This one flags rather than edits: "request further details, including any
log files or reproduction details" is half wrong on a Cloud case and half right, and no regex
can safely split that sentence.
---
6. Key design decisions & trade-offs (the "why X not Y" summary)
Decision	Chosen	Rejected alternative	Why
AI location	Local (Ollama)	Cloud API	Privacy of customer logs; cost; offline use
Default model	gemma4:2b (small)	A big 70B model	Must run on a 2-core laptop CPU; big models are unusably slow
`num_ctx`	Fixed per session	Grow-to-fit per request	Avoids costly model reloads between turns
Context size (small)	8,192 tokens	The full 131,072	CPU prefill time; 8K fits the essentials and stays fast
Logs → AI	Pre-analysed brief + key lines	Raw log dump	Fits the window; small models can't search raw logs
Prompt ordering	Rules → logs → case/research	Case/research first	So trimming sacrifices secondary data, never the logs
Chat history	Clean text only	Store the log dump too	Old dumps in history pushed new logs out of context
RAG	Keyword search	Vector embeddings	Simpler, instant, no extra model on a busy CPU
Learning	Retrieval (insights)	Fine-tuning	Fine-tuning is impossible in a browser
UI	Vanilla JS	React/Vue	No build step; single editable file for an internal tool
Output randomness	`temperature 0`	Higher temperature	Deterministic, repeatable forensic conclusions
---
7. Guided walkthrough of `send()` (the heart of the app)
`send(overrideText, silent)` runs every time you submit a message or click Analyse Now.
Here is its shape, annotated:
```js
async function send(overrideText = null, silent = false) {
  const c = cases.find(x => x.id === activeCaseId);   // the current case

  // (a) Wait for uploads/OCR still in progress, so we never analyse before files finish.
  if (pendingLogUploads.get(c.id) > 0) { /* poll up to 30s */ }

  // (b) Classify the request.
  const isGreeting   = /^(hi|hello|...)/.test(txt);
  const hasLogs      = c.logs.length > 0;
  const forensicRun  = hasLogs && isLogForensicsRequest(txt);     // "analyse the logs"
  const analysisRun  = hasLogs && (forensicRun || wantsLogAnalysis(txt, silent));
  const needsDeepPulse = /version|release notes|mobicontrol|.../.test(txt);

  // (c) Research (only when it makes sense — see intent routing).
  //     Q&A → full online+offline research. Logs+question → small KB reference (big models).

  // (d) Pick the persona prompt.
  let corePrompt = analysisRun ? (forensic ? forensicPrompt : compact/leanLogPrompt)
                 : (hasLogs && !needsDeepPulse) ? conversationalPrompt
                 : qaPrompt;

  // (e) Inject product-specific knowledge (.md) when analysing.
  // (f) Build the live-data section: [ISSUE SUMMARY], [CASE] (capped on small models),
  //     versions, research results, learned insights, and a [CRITICAL INSTRUCTION].

  // (g) Build the log context, BUDGETED against everything else so it always fits:
  let logContext = analysisRun ? (full manifest + profile + incident + budgeted snippets)
                 : hasLogs ? (manifest only — lightweight, fast)
                 : "";

  // (h) Assemble the system prompt. Order depends on mode:
  //     analysis → rules + LOGS + images + case   (logs protected from trimming)
  //     otherwise → case/research + rules + manifest  (answer source first)

  // (i) Store ONLY the clean user text in history (never the log dump).
  // (j) Stream the answer from Ollama and render tokens as they arrive.
  // (k) Safety net: if the model returns empty, recover or show a helpful message.
  // (l) Verify the finished answer: unsupported MCMR codes out, contentless next steps out,
  //     wrong-side log collection flagged (postValidateCaseAnswer — section 5.9).
  // (m) Attach the 👍/👎 feedback row; remember lastSentAt (for "new files" detection).
}
```
The four things to understand about `send()`:
It decides intent first (analyse vs converse) — section 5.5.
It budgets the logs against the rest of the prompt so they always fit — section 5.3.
It never lets the bubble go blank — there's a recovery + fallback at the end.
It checks the answer rather than trusting it — the citation, specificity and
log-access guards in section 5.9 run on the finished text.
---
8. Performance on a CPU (why it is the speed it is)
Local AI speed is set by your hardware. On a typical support laptop (2-core CPU, no
GPU), gemma4:e2b runs at roughly 6 tokens/sec generating and ~22 tokens/sec
reading the prompt. That maths is the whole story:
A big prompt takes minutes just to read before answering → feels frozen.
The fixes in this app all attack that: small fixed context, compact prompts,
manifest-only for conversational questions, a warmed/pinned model, and Ollama speed flags
(`OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, set by the setup script).
To go faster without losing quality: use a smaller model (gemma4:2b, qwen2.5:3b, or
llama3.2:3b), keep Context Size on Auto, close other heavy apps, and — the only real
step-change — run it on a machine with a GPU.
---
9. Glossary (plain definitions)
Token — a chunk of text the model works in (~¾ of a word for English; ~2.5
characters for dense log text). Models think in tokens, not characters.
Context window / `num_ctx` — the model's working memory, in tokens. Prompt + answer
must fit inside it. Overflow = the start or end of your prompt gets silently dropped.
`num_predict` — the cap on how many tokens the answer may be.
Prefill — the model reading your prompt before it writes anything. On a CPU this is
the slow, "nothing's happening yet" phase.
KV cache — memory the model uses to remember the prompt while generating. Bigger
`num_ctx` = bigger KV cache. `q8_0` shrinks it (faster, lower memory, same answers).
Streaming — sending the answer token-by-token so it appears live.
RAG (Retrieval-Augmented Generation) — search a knowledge source and paste relevant
bits into the prompt so the model answers from facts, not memory.
System prompt — the hidden instructions that define the AI's role and rules.
Temperature — randomness. `0` = always the most likely next token (deterministic).
Shadow DOM — isolated DOM sub-trees a page can create; Salesforce uses them, which is
why scraping needs special `findInShadows` traversal.
Service worker (`background.js`) — a small background script Chrome runs for the
extension; it has no UI and may be stopped/restarted by Chrome at any time.
Manifest V3 — the current required format/rulebook for Chrome extensions.
---
10. How to change things safely
Edit the AI's personality → the `TIER3_IDENTITY` constant and the `get*Prompt()`
functions. Comments-and-strings only; low risk.
Add product log knowledge → edit `knowledge/MobiControl.md` / `Connect.md` /
`XSight.md`. No code change needed.
Change default speed/size → `getSessionCtx()` (context size) and the `numPredict`
values in `OllamaAI.completions.create` (answer length).
Change what counts as "analyse" vs a question → `wantsLogAnalysis()`.
Golden rule: after any edit to `sidepanel.js`, run a syntax check before reloading:
`node --check sidepanel.js`. It catches typos that would otherwise break the whole panel.
Reload the extension at `chrome://extensions` → Reload, then open the side panel and press
F12 (choose the side-panel document) to see the console — the `[Ollama Request]` line
shows the exact `num_ctx` / sizes for each call.
---
11. Known limitations (be honest with users)
Speed is hardware-bound. A full multi-log analysis on a 2-core, no-GPU laptop takes
tens of seconds to a couple of minutes. That's physics, not a bug.
Small models can still be wrong. The pipeline maximises accuracy, but gemma4:2b is
not infallible — the 👍/👎 loop exists precisely to catch and remember corrections.
Salesforce scraping is HTML-dependent. If Salesforce changes its markup, `content.js`
selectors may need updating.
"Self-learning" is memory, not retraining. The base model never changes; confirmed
insights are re-injected as context.
Online research needs connectivity. The "Failed to fetch" message just means the live
SOTI Pulse lookup couldn't reach the network; analysis still runs from logs + offline KB.
---
This document describes the code as a guide. The authoritative source is always the code
itself — the major functions in `sidepanel.js` carry inline comments that mirror this
overview.
