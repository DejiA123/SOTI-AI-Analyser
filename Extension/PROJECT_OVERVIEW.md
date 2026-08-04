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

Sitting across all of it:
  • Power governor (power.js)   → caps how much memory/CPU the above may use on THIS
                                  machine, and shrinks the work when it gets tight (§9)
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
A self-governing resource budget (`power.js`)	The app profiles the machine it is running on and caps its own memory and CPU use accordingly	A browser tab has no OS-level memory limit — it takes what it can until Chrome kills it. Every engineer's laptop is different, so a single hard-coded cap would be wrong everywhere. Deriving the cap per machine, and adapting live, is the only version that behaves on both a 4 GB netbook and a 32 GB workstation. Section 9. The trade-off: on a weak machine some prompts are smaller and some caches are rebuilt more often — slower, but never frozen.
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
`power.js`	~830 lines	The Power & Resource Governor. Profiles the machine, derives a memory budget for it, measures heap and main-thread lag, hands out throttle settings, reclaims memory under pressure, and keeps the internal AI performance log. Loaded **before** `sidepanel.js`. Section 9.
`tests/`	—	`power.test.js` (51 unit tests, `node tests/power.test.js`), `run.js` (112 case-answer and multilingual checks, `node tests/run.js`, loading the real `sidepanel.js` through `harness.js`; fixtures in `tests/fixtures/`) and `browser.e2e.js` (55 checks driving the real panel in Chromium). No test framework — plain Node, no `npm install` for the unit tests. Sections 5.11 and 9.
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
Loading (`loadState`) also enforces a 30-day retention policy — a case (and its
stored logs) is auto-deleted after 30 days of inactivity. The clock is keyed on last
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
**Log text is stored separately, and loaded lazily.** The main `cases` key holds only log
*metadata* (name, size, source ZIP); the text itself lives under a per-case `caseLogs:<id>`
key, written only when that case's logs actually change. On startup only the case being
opened has its text read into memory — the others stay as metadata until you open them, and
can be released again under memory pressure. This is what keeps a five-case session from
costing ~100 MB before you have done anything; see section 9.6 for the mechanism and the one
place it is deliberately switched off (standalone mode).
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
Key concepts (see the Glossary, section 10, if these are new):
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
5.10 Multilingual signal detection — the same facts in any language
SOTI Support is global, and roughly half of a chain routinely arrives in the customer's own
language. Every deterministic signal therefore exists twice: the original English pattern, and
a multilingual twin ending `_ML_RE` covering Russian, German, French, Spanish, Portuguese,
Italian, Dutch, Polish, Turkish, Japanese, Chinese and Korean. They are tried together by
`matchEarliest` (returns the earliest hit, so the quote lands where the signal really occurs)
or `testAny` (boolean tests that need no quote).
> **Why two regexes instead of one union?** The twins need the `u` flag for `\p{L}` and
> Unicode-aware boundaries. Splicing a `\p{L}` source into a non-`u` regex makes it match a
> literal `p` instead — a failure that is completely silent. Keeping them separate also means
> the English behaviour, which the suite pins down, cannot shift because a Turkish cue was added.
Two traps the cue tables exist to avoid, both of which had silently disabled whole languages:
`\b` is ASCII-only, so `\bвстреча` never matches at any position; and `\w` is ASCII-only even
under `u`, so a stem written `срочн\w*` fails its closing boundary the moment a Cyrillic letter
follows. Every cue uses `\p{L}` and the lookaround boundaries in `mlCue` instead.
The layer covers the decisive signals (`SIG_*`), what SOTI asked for and what the customer
delivered (`SUPPORT_REQUEST`, `REQUEST_FULFILLED`), the three states of a live session
(`MEETING_PROPOSED` → `MEETING_BOOKED` → `MEETING_HELD` — booked is a state of its own, so a
plan can never open by arranging a meeting that is already in the diary), the customer's
contrast with an earlier case (`ISSUE_CONTRAST`), and the lifecycle scan that decides open vs
closing (`REOPEN_SIGNAL`, `CUSTOMER_CONSENT`, `SUPPORT_CLOSING`) — that last one matters most,
because the case state governs what "Next steps:" is even allowed to contain.
`detectChainSignals(entries, lc, issueText)` also reads the **issue summary**, not just the
chain. On a case opened through the portal that is the only place the customer states the
problem in full, and it is where a recurrence and the "unlike the previous case…" contrast
normally live. An issue-summary recurrence is flagged `fromIssueSummary` and rendered with
weaker wording than a chain one, because "I hit this again" in an opening report usually means
the customer has met the fault before — not that a fix on *this* case regressed.
---
5.11 The test suite — `node tests/run.js`
`tests/harness.js` evaluates the real `sidepanel.js` inside a Node `vm` context with the
browser surface stubbed by a self-returning Proxy, then exposes the top level (including
`const` bindings, read back through `vm.runInContext`). Nothing is copied out of the source:
the checks run the shipping code, so a red test means the extension is wrong.
112 checks in four groups — chain parsing, multilingual signals, case C01720260 end to end, and
English regressions. Two are structural rather than behavioural and guard the trap above: no
`_ML_RE` may contain `\w`, and every one must carry the `u` flag. Note that a regex built inside
the vm has the vm's `RegExp` as its prototype, so `instanceof RegExp` is false in the suite —
duck-type with `typeof re.test === 'function'` instead.
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
Memory cap	Derived per machine	One hard-coded number	A cap that suits a 16 GB laptop starves a 4 GB one and wastes a 32 GB one
Machine sizing	RAM class **and** core count	`deviceMemory` alone	The spec caps `deviceMemory` at 8, so an 8 GB and a 32 GB machine look identical without it
Pressure sensing	Heap **and** event-loop lag	Heap alone	Memory can look fine while the main thread is blocked — lag is what the user actually feels
Log text in memory	Per case, on demand	All cases at startup	Only one case is ever on screen; the rest was ~100 MB held for nothing
Throttle values	Read live at each decision	Computed once at startup	A cached throttle meant the app ran idle settings through an analysis that had gone critical
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
Memory and CPU *pressure* — as distinct from raw model speed — are handled separately by
the Power & Resource Governor in section 9.
---
9. The Power & Resource Governor (`power.js`)
This is the app's answer to a real complaint: **on some machines the panel used all the
memory and CPU it could reach, and the whole laptop stuttered.** Everything in this
section exists to make the app a well-behaved guest on whatever machine it lands on.
9.1 Why it was needed
The analyser does genuinely heavy work inside a browser tab. It holds whole log bundles
in memory as strings, splits each into a per-line array (a full second copy of the text),
builds per-line classification caches on top of that, indexes a 24 MB knowledge corpus,
spawns Tesseract WASM workers for OCR, and streams from a local LLM. On a developer
machine that is fine. On a support engineer's laptop — already running Chrome itself,
Salesforce, Teams, and **Ollama holding a 3-4 GB model resident** — the same work pushed
the machine into swap, and "the app froze" was the result.
Three specific things were doing most of the damage:
Startup read **every** stored case's log text at once and held it for the whole session,
though only one case is ever on screen. Five cases meant ~100 MB resident before the user
had done anything.
Log scanning ran in fixed 2,000-line chunks with a fixed 20 ms yield. On a 150,000-line
bundle that is one long synchronous block — the panel simply stopped painting.
OCR spawned **one Tesseract worker per image, simultaneously**. Each is a fresh WASM
instance carrying ~80-150 MB with the English data loaded, so six pasted screenshots meant
roughly a gigabyte appearing in a couple of seconds. A worker whose `recognize()` threw was
never terminated, so its memory stayed stranded for the life of the panel.
9.2 How your machine's memory budget is worked out
The governor profiles the machine at startup and derives **one number**: the megabytes this
app may occupy here. Everything else is downstream of it.
The obvious approach — "read the RAM, take a percentage" — does not work on its own,
because `navigator.deviceMemory` is **capped at 8 by the web spec** for fingerprinting
reasons. An 8 GB netbook and a 32 GB workstation both report `8`. The logical core count
(`navigator.hardwareConcurrency`) is the only other cheap signal that separates them, and
in practice it correlates well: a 16-thread mobile workstation is not an 8 GB netbook. So
the core count earns a real multiplier rather than a cosmetic one.
```js
budget = deviceMemoryGB × 1024 × 0.17 × coreFactor(cores)
budget = min(budget, jsHeapSizeLimit × 0.75)     // never plan past what V8 will grant
budget = clamp(budget, 256 MB, 3072 MB)

coreFactor:  >=16 → 1.30   >=12 → 1.20   >=8 → 1.05
             >=6  → 0.85   >=4  → 0.70   else 0.55
```
Worked examples (these are pinned as tests, so a tuning change shows up as a failing test
rather than as silent drift):
Machine	Reports	Budget	Tier
AMD Ryzen AI 7 PRO 350, 16 GB (8 cores / 16 threads)	deviceMemory 8, cores 16	**1810 MB**	`high`
8 GB laptop, 4 cores	deviceMemory 8, cores 4	975 MB	`low`
4 GB laptop, 4 cores	deviceMemory 4, cores 4	487 MB	`minimal`
2 GB netbook, 2 cores	deviceMemory 2, cores 2	256 MB (floor)	`minimal`
32 GB workstation, Chrome granting only a 2172 MB heap	heap-limited	1629 MB	`high`
Firefox / Safari (no `deviceMemory`, no `performance.memory`)	nothing	487 MB (assumed 4 GB / 4 cores)	`minimal`
The `0.17` share is deliberately conservative. We are **one tenant** on this machine, not
the only one — and the largest other tenant is usually Ollama, which the browser cannot see
at all (see 9.10).
The **tier** (`minimal` / `low` / `balanced` / `high`) gears long-lived *behaviour*: how many
OCR workers may run, how many cases stay loaded, whether the knowledge index is pre-built.
The **level** (below) gears moment-to-moment *intensity*. Both are needed — a capable machine
under a brief spike should back off without being permanently demoted to netbook settings.
9.3 What it measures
Two sensors, sampled every 2 s while working and every 6 s when idle:
**Memory** — `performance.memory.usedJSHeapSize` against the budget above.
**Responsiveness** — main-thread **event-loop lag**, measured as the overshoot of a
self-scheduling timer. If we asked to be woken in 6,000 ms and were woken in 6,420 ms, then
420 ms of work ran without yielding. *This is the sensor that matches what a user feels.*
Memory can be perfectly healthy while the panel is frozen solid, and lag is what catches it.
Each folds into a level, and the reported level is the **worse of the two**:
Level	Memory (share of budget)	Lag	What it means
`ok`	< 70%	< 50 ms	Normal. Everything at full size.
`warm`	70-85%	50-150 ms	Tighten the throttles. Nothing is thrown away yet.
`high`	85-95%	150-400 ms	Visible stutter. Start reclaiming.
`critical`	>= 95%	>= 400 ms	What a user calls "frozen". Reclaim everything needed.
9.4 What it does about it — the throttle knobs
Subsystems ask the governor what size to work at, immediately before doing the work:
```js
const knobs = Power.knobs;   // ALWAYS read fresh — see the warning below
```
Knob	What it controls	Range
`yieldEveryMs`	How often a hot loop hands the main thread back	8-32 ms
`chunkLines`	Lines scanned between yields	200-4,000
`promptScale`	Multiplier on the prompt character budget	0.33-1.0
`answerScale`	Multiplier on `num_predict`	0.60-1.0
`maxOcrWorkers`	Concurrent Tesseract WASM instances	1-3
`maxResidentLogBytes`	Total log text held across all cases	share of budget
`maxHydratedCases`	Cases whose logs stay in memory	1-3
`prewarmKb`	Whether to pre-build the 24 MB index at startup	true/false
`promptScale` is the strongest lever available, because on a CPU-bound model **prefill cost
scales with prompt tokens** — the same maths as section 8. `answerScale` is deliberately
gentler: a slow answer is a nuisance, but an answer cut off mid-sentence is a wasted run the
engineer has to fire again, which costs more than it saved.
> **The one trap to avoid: never cache `Power.knobs`.** It is a live computation of the
> current level. An earlier revision read it once at construction, so the app ran an *idle*
> throttle through an entire analysis that had long since gone critical — the governor could
> see the pressure and did nothing about it. There is a regression test for exactly this.
9.5 Reclaim — what gets sacrificed, and in what order
Subsystems register a reclaimer with a **priority**, which is really an *order of sacrifice*:
lower number = given up first, because it is cheapest to rebuild.
Priority	What is dropped	Cost to rebuild	Runs at
10	Per-line intel caches on background cases	Seconds — pure derived data	`high`
20	The same caches on the *active* case (only when no analysis is running)	Seconds	`critical`
30	Log text of background cases	A storage read	`high`
40	The last question's research buffers	Regenerated next search	`critical`
60	The 24 MB knowledge index	A full re-parse — expensive	`critical`
Two rules keep this honest:
**Nothing here can lose your work.** Every item is either pure derived data or text that is
durable in `chrome.storage` and re-readable. The case you are looking at is never touched,
and neither is any log text that has not yet been flushed to storage.
**The heap is re-read between reclaimers**, so if dropping the cheap caches already brought
the app home, the expensive knowledge index survives.
There are **two modes**, and the distinction matters more than it looks:
*Automatic* (the sampler responding to pressure) stops the moment the app is back under the
warm threshold. Dropping more than necessary just means rebuilding it — turning a memory
problem into a CPU problem.
*Forced* (`reclaim(level, { force: true })` — you pressed **Free memory now**, or an upload
needs room) runs the **whole** sweep. Without this, an explicit request did nothing whenever
the app happened to be comfortable at that moment, which is exactly when someone asks for
room before attaching a big bundle.
9.6 On-demand log hydration (the single biggest saving)
Log text is now loaded **per case, when that case is opened**, rather than all at once at
startup. What is always in memory is *metadata* — name, size, source ZIP — which is enough
to render the Logs panel and the file manifest. The text arrives when you open the case, and
can be handed back under pressure because it is safe on disk.
```
Startup:   read case metadata for all cases        (kilobytes)
           hydrate ONLY the case being opened      (its logs)
Open tab:  hydrate that case, release the oldest one over budget
Pressure:  release background cases, keep the active one
```
The invariant everything else depends on: **the active case is always hydrated.** Both
`switchCase()` and `send()` await `ensureCaseHydrated()`, so no analysis path can ever
observe a half-loaded case — the rest of the pipeline is unchanged and does not know this
happens.
> **Standalone mode is deliberately excluded.** Lazy loading is only safe where the text can
> be read back. Standalone has no per-case storage key — the text lives inline in
> `localStorage` — so stubbing it out there would *delete it*. Standalone keeps the old eager
> behaviour, and `dehydrateCaseLogs()` refuses to run without `chrome.storage`. This is
> checked explicitly in the browser tests, because getting it wrong loses a user's logs.
9.7 The internal performance log
Every AI run is timed and recorded, so "why was that slow?" is answerable after the fact
instead of guessable. A run records:
The **mode** (`analysis` / `chat` / `quick-action` / `jira`, plus `-continuation`), because a
forensic analysis and a one-line reply differ by an order of magnitude — pooling them makes
both the median and the worst case meaningless.
Model, `num_ctx`, `num_predict`, prompt characters, and the prompt scale in force.
**Time to first token** (wall clock — the part you actually sit through) and, from Ollama's
own terminal stream frame, its authoritative `prompt_eval_count` / `eval_count` and prefill
and generation durations. Real counts, not a chars-per-token estimate.
Tokens/sec computed over **generation only**, excluding prefill — including it flatters a
slow prefill into looking like fast generation.
Peak heap during the run, fed by the sampler, plus the pressure level at both ends.
Log ingest, OCR, index builds, hydration and reclaim sweeps are recorded alongside them, in a
250-entry ring buffer. Summaries use the **median**, not the mean, so one cold-start run does
not make every subsequent run look slow.
9.8 The Power Monitor UI
A live pill in the topbar shows the current megabytes and colours by level. Clicking it opens
a panel that explains the number:
**This machine** — memory class, cores, the browser's heap ceiling, the tier, the derived
budget, and *why* it landed there ("derived from this machine's memory class and 16 logical
cores", or "capped by what this browser will grant a single tab").
**Right now** — memory against budget, and responsiveness in plain language
("instant" / "slight delay" / "sluggish" / "stalling") next to the raw lag.
**Active limits** — the throttles currently in force, as percentages.
**AI performance** — median duration, time to first token and tokens/sec, broken out by
request type.
**Recent activity** — a rolling log of everything above.
Two buttons make it actionable rather than merely informative: **Free memory now** (a forced
sweep) and **Copy report** (the whole thing as plain text, for pasting into a bug report).
9.9 If `power.js` is missing
Every call site in `sidepanel.js` goes through a guarded bridge (`const Power = ...`) rather
than touching `window.SotiPower` directly. If `power.js` is absent, blocked, or fails to
construct, the bridge returns **static knobs that are exactly the constants the app used
before the governor existed** — 20 ms yields, 2,000-line chunks, full prompt budget. The pill
is hidden, because a control that reports nothing is worse than no control. A missing
`power.js` costs adaptivity, not correctness. The browser tests boot the app with the file
blocked and check all of this.
9.10 What it does *not* measure (read this before trusting the number)
**Ollama is not counted, and it is usually the bigger consumer.** The budget governs *this
browser tab*. `gemma4:e2b` runs in a separate process holding its own 3-4 GB — memory the
browser cannot see and this app cannot reclaim. On a 16 GB laptop with Context Size on Auto,
Ollama is the larger tenant by a wide margin. The panel says so explicitly rather than
implying its number is the whole story. If the *machine* is short of memory, the lever that
matters is Context Size in Settings, not this governor.
**Readings are the JavaScript heap only.** Detached DOM nodes, Tesseract's WASM linear
memory and image bitmaps live outside it, so the real tab footprint is somewhat higher.
That is part of why the budget only claims 75% of the heap ceiling — the difference is
headroom, not an oversight.
**Firefox and Safari expose no `performance.memory`,** so there the governor senses
responsiveness only and uses the conservative `minimal` profile. It degrades rather than
disabling itself.
9.11 Verifying and tuning it
```bash
node tests/power.test.js      # 51 unit tests — budget maths, pressure, knobs, reclaim, perf log
node tests/browser.e2e.js     # 55 checks driving the real panel in a real Chromium
```
The unit tests drive the real module through an injected synthetic machine and clock, so the
budget for each hardware class above is pinned. The browser suite loads the actual panel with
a realistic session (4 cases, 12 files, 48 MB of log text) and measures the result:
```
Idle heap after boot:   119.2 MB  ->  8.5 MB     (92.9% lower)
Forced reclaim:         123.6 MB  ->  12.4 MB
After a full workout:   12.4 MB of a 975 MB budget
```
To tune: the constants live in one block at the top of `power.js` (`RAM_FRACTION`,
`CORE_FACTOR_STEPS`, `HEAP_LIMIT_SHARE`, the tier and threshold tables). They are re-exported
for the tests, so changing one produces a **visible failing test naming the machine class you
changed** rather than silent drift. Run `node tests/power.test.js` after any edit.
---
10. Glossary (plain definitions)
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
JS heap — the memory the browser gives this tab's JavaScript. `performance.memory` reports
it; it does NOT include WASM memory (Tesseract), image bitmaps, or anything Ollama uses.
Event-loop lag — how much later than scheduled a timer actually fires. It measures how long
the main thread was busy without yielding, which is what a user experiences as freezing.
Memory budget — the megabytes this app allows itself on your specific machine, derived at
startup by `power.js` (section 9.2). Not an OS limit; a self-imposed one.
Tier — the machine's long-lived capability class (`minimal`/`low`/`balanced`/`high`), fixed
at startup. Level — the moment-to-moment pressure state (`ok`/`warm`/`high`/`critical`).
Reclaim — dropping rebuildable caches to give memory back. Never loses your work: only
derived data, or text that is safe on disk and can be re-read.
Hydration — loading a case's log text into memory. A case that is not hydrated still shows
its file names and sizes; only the text is absent until you open it.
---
11. How to change things safely
Edit the AI's personality → the `TIER3_IDENTITY` constant and the `get*Prompt()`
functions. Comments-and-strings only; low risk.
Add product log knowledge → edit `knowledge/MobiControl.md` / `Connect.md` /
`XSight.md`. No code change needed.
Change default speed/size → `getSessionCtx()` (context size) and the `numPredict`
values in `OllamaAI.completions.create` (answer length).
Change what counts as "analyse" vs a question → `wantsLogAnalysis()`.
Change how much memory the app allows itself → the constants block at the top of `power.js`
(`RAM_FRACTION`, `CORE_FACTOR_STEPS`, `HEAP_LIMIT_SHARE`, the tier and threshold tables).
They are re-exported for the tests, so run `node tests/power.test.js` afterwards — a change
that moves any machine class shows up as a named failing test rather than silent drift.
Change what gets sacrificed under pressure → the `Power.registerReclaimer({...})` blocks
near the bottom of `sidepanel.js`. Lower `priority` = given up first. Never register
anything whose loss would destroy the user's work.
Add a language, or a phrase in one already covered → the `_ML_RE` cue tables in
`sidepanel.js` (section 5.10), then `node tests/run.js`. Use `\p{L}`, never `\w`, and never a
leading `\b` before non-Latin text — both are ASCII-only and fail silently.
Golden rule: after any edit to `sidepanel.js`, run a syntax check and the suites before
reloading: `node --check sidepanel.js`, then `node tests/run.js` and `node tests/power.test.js`.
The syntax check catches typos that would otherwise break the whole panel; the suites catch the
ones it cannot see, because a regex assembled at runtime (`new RegExp(...)`) parses fine and
throws on load — an unbalanced bracket in one multilingual cue takes the whole side panel down,
and only loading the file finds it.
Reload the extension at `chrome://extensions` → Reload, then open the side panel and press
F12 (choose the side-panel document) to see the console — the `[Ollama Request]` line
shows the exact `num_ctx` / sizes for each call.
---
12. Known limitations (be honest with users)
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
The Power Monitor does not measure Ollama, and Ollama is usually the bigger consumer. The
budget covers this browser tab only; the model runs in a separate process holding its own
3-4 GB that the browser cannot see or reclaim. If the whole machine is short of memory, the
lever that matters is Context Size in Settings — not this app's budget. Section 9.10.
Memory readings are the JavaScript heap only. Tesseract's WASM memory and image bitmaps sit
outside it, so the real tab footprint is somewhat higher than the pill shows. The budget
claims only 75% of the browser's heap ceiling precisely to leave room for that difference.
On a weak machine the governor trades quality for stability. Smaller prompts mean less raw
log text reaches the model (the pre-analysis keeps the high-signal evidence, but there is
less context around it), and dropped caches are rebuilt when next needed. That is the
intended trade — slower and slightly leaner answers beat a frozen laptop — but it is a real
trade, not a free win.
---
This document describes the code as a guide. The authoritative source is always the code
itself — the major functions in `sidepanel.js` carry inline comments that mirror this
overview.
