SOTI AI Analyser — Complete Project Overview
> A plain-English, developer-friendly guide to how this extension works, what the
> important code does, and **why** it was built this way (including the alternatives
> that were considered and rejected). Read top-to-bottom the first time; after that
> use it as a reference.
---
1. What this project is (in one paragraph)
The SOTI AI Analyser is a Google Chrome side-panel extension that helps SOTI
support engineers analyse log files from SOTI products (MobiControl, SOTI Connect,
SOTI XSight, SOTI Identity). You attach log files, optionally fill in case details, and an
AI reads the logs and tells you the likely root cause and fix. It also answers general SOTI
questions using an offline copy of SOTI's official help documentation, pulls case details
from Salesforce — fields, email chain, internal notes and the replies to them — and learns
from your feedback over time.

The AI is **Microsoft 365 Copilot** — specifically the enterprise Copilot the business already
licenses and has approved. The tool does not introduce an AI service; it **links onto the one
that is already there**. That link is what "the bridge" means throughout this document: there
is no API key and no endpoint, because the panel relays each prompt through a Copilot chat the
engineer is **already signed in to**, typing it into the composer and reading the answer back
out of the page. Their existing session does the authenticating. See §5.12 — it is the piece
of this codebase most worth understanding before changing anything.

The consequence, stated plainly because it used to be the opposite: **case content leaves the
machine.** Earlier builds ran a local model precisely so it would not, and every claim of the
form "nothing leaves your machine" belongs to that architecture, not this one. It goes to the
company's own tenant rather than to a new supplier — in effect the tool automates what an
engineer is already permitted to do by hand — but it goes, and it goes unredacted.
`SECURITY.md` has the assessment.
---
2. The big picture — how a single analysis flows
```
┌─────────────┐  attach   ┌──────────────────┐  build prompt  ┌───────────────────┐
│  You (UI)   │ ────────► │  sidepanel.js    │ ─────────────► │  ai-provider.js   │
│ side panel  │  + ask    │ (the whole brain)│  (one request  │  (the seam)       │
└─────────────┘           └──────────────────┘   request)     └─────────┬─────────┘
       ▲                          │  streamed answer                    │
       │  rendered answer         │  (NDJSON frames)                    │ types it in
       └──────────────────────────┘ ◄───────────────────────────┐       ▼
                                                                │  ┌───────────────────┐
   Everything above the seam speaks ONE request and response     │  │ copilot-bridge.js │
   response shape. ai-provider.js translates in both directions, │  │  runs INSIDE the  │
   so the panel does not know which backend answered.            │  │   Copilot page    │
                                                                │  └─────────┬─────────┘
                                                                │            │ reads the
                                                                └────────────┤ answer back
                                                                             ▼
                                                       ┌──────────────────────────────┐
                                                       │ Microsoft 365 Copilot, in a   │
                                                       │ minimized window, on YOUR     │
                                                       │ already-signed-in session     │
                                                       └──────────────────────────────┘

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
AI via the Microsoft 365 Copilot **browser bridge**	The panel drives a Copilot chat in a minimized window: types the prompt into the composer, waits for the answer to stop changing, reads it back	**The alternatives all needed a key.** A hosted API (OpenAI, Claude, Azure) means procuring a key, storing it in `chrome.storage.local` where anyone who can unpack the extension can read it, and engaging a new data processor. M365 Copilot has no completions endpoint to call, and a Copilot *agent* runs the wrong way round — it lets Copilot call your tool, not your tool call Copilot. The bridge is the only keyless path that exists: the engineer is already signed in, so their session authenticates. The trade-offs are real and are the subject of §5.12 — it drives someone else's web UI, so it breaks when that UI changes (the selectors are settings, not constants, so the fix is not a release), a chat box caps how much you can send at once, and **the case leaves the device**. Earlier builds ran a local model to avoid that last one; see `SECURITY.md` for what changed and what it costs.
Streaming, as NDJSON frames	The answer arrives progressively rather than all at once	The user sees words appear instead of staring at a blank screen. The panel consumes one frame shape whatever answered; `ai-provider.js` translates every backend into it, which is why nothing above the seam had to change when the backend did. The bridge streams forward-only — it prefers a little duplication to a truncated answer when the site re-renders its markdown mid-stream.
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
`content.js`	~5,300 lines	The Salesforce reader and the only writer. Injected into Salesforce and JIRA pages; reads case fields, the feed, list views and Knowledge articles off the page (handling Salesforce's nested "Shadow DOM"), and reads the account team off an Account record (§5.8.1). It also drives the case's own publisher for the three actions that write: a call note, a feed post, and filling in the email composer. Nothing in it presses Send.
`manifest.json`	~60 lines	The extension's "ID card": its name, permissions, which URLs it may talk to, and which files load when.
`knowledge/*.md`	—	Product knowledge in two layers. (1) Small "log signature" cheat-sheets injected during analysis: `MobiControl.md`, `Connect.md`, `XSight.md`. (2) The RAG corpus searched by `PulseKB`: `PulseKnowledge.md` (a 24 MB MobiControl scrape, ~10,000 articles) plus the curated, source-referenced `Connect_Knowledge.md` and `XSight_Knowledge.md`. Extend a product by appending `# Title` / `Source:` / body articles to its corpus file, or add a file to `PulseKB.KB_FILES`.
`ai-provider.js`	~1,600 lines	The provider seam. `SotiAI.chat(payload)` takes the exact request body the panel already builds and returns something that quacks like the `fetch` Response it already consumes, whatever the backend is — the keyless browser relay (what this build ships with), Azure OpenAI/OpenAI-compatible, or the Anthropic API. Adding a backend means writing one adapter here and changing nothing above it. Section 5.12.
`copilot-bridge.js`	~1,150 lines	The browser bridge's relay. Injected on demand into a chat tab the engineer is already signed in to; types the prompt in, watches the answer render, and streams it back. Never declared in the manifest, so it does not run in anyone's Copilot tab unless the bridge is selected and the host granted. Section 5.12.
`power.js`	~830 lines	The Power & Resource Governor. Profiles the machine, derives a memory budget for it, measures heap and main-thread lag, hands out throttle settings, reclaims memory under pressure, and keeps the internal AI performance log. Loaded **before** `sidepanel.js`. Section 9.
`tests/`	—	The suites that survive: `ai-provider.test.js`, `copilot-bridge.test.js`, `sidepanel-render.test.js`, `content-feedtab.test.js`, `account-email.test.js` (real Chromium against fixtures under `tests/fixtures`) and `panel-features.test.js` (real Chromium against the panel itself — the split Sync button, the bookings links, the meeting draft, and the usage report's leak check), run with `node tests/<file>`. They pin down the provider translation, the bridge's answer extraction and prompt splitting, the rules that turn an answer into what the engineer sees, and which Salesforce tab the sync is allowed to click — the parts that fail SILENTLY, where a wrong answer looks exactly like a right one. Section 5.11.
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

**When the case is UPLOADED, none of the above is what the model reads.** Everything in this
section is a reducer, and the sizes it reduces to (240 characters per digest row, 15,000 per
file, 24,000 for the whole failure index) are what a chat composer holds — not what a file
upload holds. So `buildConcentratedSnippets` branches: if `logsUploadAsFile()` is true (the
browser bridge with `attachData` on), the digest becomes a short INDEX and
`buildVerbatimLogSection` puts the log files themselves in behind the same
`=== FILE: <path> ===` markers, complete and unedited.

A file too big for the upload ceiling is not head-cut. `buildVerbatimLogBody` keeps contiguous
windows around every error/warning/exception line — each grown forward over the exception block
that follows it, so a stack trace is never severed from the exception that threw it — plus the
file's head (the preamble: build, OS, install path) and its tail (where a failed run actually
died). Every gap between windows is declared inline with its real line numbers and whether
anything in it carried a signal, and the per-file header says COMPLETE or PARTIAL.

Network captures are the exception: a `.har` never goes up raw, because it holds the
Authorization headers, cookies and id_tokens of the session it recorded. It goes as the same
redacted transaction evidence the inline path builds.

**The JIRA ticket's "Log Analysis" block is built from the same raw log, by a different rule.**
`buildJiraLogEvidence` fills it deterministically — the model is never trusted with it — and the
unit it works in is the log ENTRY, not the line. Anchors (the forensic report's own root-cause
text located in the raw log, then the line numbers it cites, then issue terms, then error
density) fold onto the entry that contains them; a window is seeded by the strongest entry left
and grows only into neighbours at least half as strong; and a second window is admitted only at
60% of the primary's strength.

Every one of those rules is there because its absence produced a specific wrong ticket. Scoring
a window by SUMMING its anchors let two hundred one-line DEBUG heartbeats outscore the entry
holding the exception. Chaining entries within eight lines of each other let a run of weak ones
absorb a strong one. And a 15-line-back / 40-line-forward expansion guard opened the block
inside a 122-line stack trace. `jiraHasEntryStructure` decides whether a file has entries at all
(an XML dump or a CSV has none) so both ends of a window are found the same way.
5.3 The AI engine (`AIEngine.completions.create`)
This is the function every path goes through to reach the AI. It receives the assembled
messages and returns a stream of tokens.

> **It builds ONE request shape and consumes ONE stream shape**, whatever is actually
> answering. That shape is a historical accident — it is what the app was first written
> against — and keeping it is what let the backend change without touching anything above
> this line. `ai-provider.js` sits underneath it and
> translates, in both directions, to whatever the active provider is (in this build: the
> Copilot bridge). Renaming it would touch every call site and the payload shape would be
> unchanged, so the name stayed and this note exists instead. §5.12 is the backend.

The hard part is fitting the prompt into the window without overflowing it, because
overflow = the model silently drops your logs. That problem did not go away when the backend
changed — it changed shape. A local model had a token window; a chat box has a character
limit per message and a conversation window across messages. §5.12 covers how the budget is
worked out now.
Key concepts (see the Glossary, section 10, if these are new):
`num_ctx` — the size of the model's working memory (the "context window"), measured
in tokens. Everything (your prompt + the model's answer) must fit inside it.
`num_predict` — the maximum number of tokens the model may generate as its answer.

> **Read this block as background, not as the live path.** Everything from here to the end of
> §5.3 describes sizing a **local model's** context window, and this build has no local model.
> It is kept because the *problem* is unchanged — put in more than the backend will hold and
> it silently drops the end of your case — and because the code is still there and still runs
> for a local backend if one is ever configured. **For the bridge, the budget is worked out
> from a chat composer's character limit and the number of messages a conversation may carry;
> that is §5.12, and it is the one that applies today.**

```js
// The provider layer is the only thing that knows the window; ask it, never guess.
async function getModelContextLength(model) { /* SotiAI.getContextWindow(model) */ }
```
> **Why ask instead of hard-coding?** Different backends have wildly different windows — a
> hosted frontier model holds 200,000 tokens, and the relay holds whatever a chat composer
> will swallow multiplied by how many messages the case may arrive in. The adapter is the
> only thing that can answer for itself, so it does.
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
> **Why a FIXED size and not "grow to fit each request"?** Because one budget for the whole
> session is the only way what fits in a prompt stops depending on which turn of a
> conversation it happens to be. A recalculated-per-message size also made a real backend
> re-allocate its cache on every turn, which was one of the biggest speed losses this app
> ever had.
>
> **Why not the full 131,072?** Two different numbers do two different jobs, and conflating
> them was a bug in its own right. `num_ctx` (`getSessionCtx`) is the KV-cache window: on Auto
> it is the model's own window capped at 32,768, held CONSTANT for the session. The PROMPT BUDGET (`getPromptCharBudget`) is how much text we actually
> put in, and that is what costs time — prefill scales with prompt tokens, not with `num_ctx`.
> On Auto a small model budgets against 16,384 tokens (≈36,900 chars).
> Measured on gemma4:e2b, CPU, a 61,213-char chain — Case Summary + Next Steps:
> Auto ≈ 620 s, 14/14 on the scorecard. Context Size 8K ≈ 300 s, 13/14 — everything decisive
> survives (the plan, the JIRA, the fix version, the recurrence), but "Troubleshooting done" loses
> the record of what was actually tried, because the case history is the block the smaller budget
> cannot hold. **Auto is the right default**; 8K is the setting to choose when an answer is wanted
> in five minutes and the plan matters more than the history.
> To be exact about 8K: the quick-action prompt does NOT fit there and is not meant to. The
> mandatory half — the task spec, the CASE STATE verdict and the DECISIVE CASE SIGNALS — is about
> 10K on its own, and those are the blocks that decide whether the answer is TRUE, so they are
> never traded for size. The per-request trimmer therefore still cuts, and what it reaches first
> is the case history at the tail of the user message. That is a deliberate, measured degradation,
> not an accident: at Auto (28,901 of 36,900 chars for the case above, 31,787 for a case carrying
> a 15K Description and a 5.6K JIRA thread) nothing is cut at all.
> Auto got faster on the way to that figure: the chain-condensation pass (`buildCaseHistoryLines`)
> used to run on any chain of 8+ messages, which on a twelve-message case meant six model calls
> — about six minutes — spent rewriting messages into 90-character lines that the scaffold then
> rendered at a 260-character cap. It now runs only when the budget actually forces a cap at or
> below what the model would produce, so a long chain still gets it and a normal one does not.
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
let res = await doEngineFetch(numCtx);
if (!res.ok) {
  if (/memory|oom|allocate/i.test(err) && numCtx > 8192) {  // GPU/RAM exhausted
    numCtx = Math.max(8192, numCtx / 2);                     // retry once, smaller
    res = await doEngineFetch(numCtx);
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

**The sync opens the Feed sub-tab itself** (`activateFeedTab`). A Lightning case record is
split into Feed / Details / Related and Salesforce renders only the active one, so syncing a
case that was sitting on Details found no feed in the DOM at all and imported an empty email
chain — recoverable, because the panel said so, but it cost the engineer a manual click on
every case. Three rules keep an automatic click from becoming its own problem:

- **It only clicks when no feed is on screen.** A case already showing its Feed is not touched.
- **It runs after the fields have been read.** Leaving a sub-tab unmounts it, so opening the
  Feed any earlier would trade an empty chain for empty case fields.
- **It matches the tab by its LABEL, never by `data-tab-value`.** Those values
  (`flexipage_tab3`) are assigned per layout — the number differs between orgs and changes
  when somebody edits the page. The label is matched on the WORD, so a "Feedback" tab is never
  mistaken for the feed, and only VISIBLE tabs are eligible, because a background console tab
  keeps its whole tab bar in the DOM and clicking that one would switch a case nobody is
  looking at.

What it did is reported back on `feedTab` and decides the wording when a chain still comes
back empty: "the Feed tab was opened but no posts rendered" and "the case Feed has no posts to
read" are different problems, and neither is "open the Feed tab and sync again" — an
instruction to do a thing that has just been done for you is how someone learns to stop
reading the messages.
---
5.8.1 Account Email — the reply, with the account team copied in
"Draft an email to the customer" writes the reply and stops. The engineer then
copies it into Salesforce by hand and, on an account with a TAM, remembers to go and
find who else should see it. That last part is the part that gets missed, and it is
also the most expensive part to miss: the TAM hears about their own account's case
from the customer.

`draftAccountEmail()` does the whole errand instead. It reads the case's account,
reads that account's team off the Account record, drafts the email, shows it with
the Cc list beside it, and fills in the case's own Email composer.

**It is an optional action, under + Add actions, not a permanent button.** It moved
there on 2026-09-04. It WRITES into Salesforce's own composer, which puts it in the
same class as Log a Call and Write a Post rather than with the actions whose worst
outcome is a wrong paragraph on screen — and most cases have no account team to copy
in, so a permanent button for the ones that do made the column longer for everybody.
An engineer who works TAM'd accounts ticks it once and it stays. See
`QA_EXTRA_ACTIONS`; `renderQuickActionExtras` wires it through the same
`wireQuickAction` every permanent action uses, so a ticked-on extra behaves
identically to one that was always there.

**Reply All comes first, before anything is written.** Pressing "Email" on the publisher
opens a BLANK compose form, and that is not what an engineer answering a case does: they
press Reply All on the customer's last message, which puts the customer and everyone
already on the thread into To, sets the subject to "RE: <their subject>" so it threads in
their mail client, and quotes the message being answered underneath. Skipping it produced
a draft that looked complete in the composer and would have arrived as a brand-new message
— breaking the thread and dropping anybody on the original who is not the case contact.

`findReplyAllAction` matches the `utility:reply_all` icon first, because that is what the
action IS and it survives the label being translated; the exact name is the fallback, and
it is exact because "Reply" is a prefix of "Reply All" and sits next to it in the same row.
It is pressed ONCE and only when `composerIsAlreadyReply` says the form is not already one
— on most layouts pressing it again re-opens the form and takes the recipients and the
typed body with it, which is the one action in this sequence that can destroy work. It is
best effort: a case raised by phone has no email to reply to, so a missing action is
reported in `replyAll` and the write carries on, because everything after that step still
works.

**Which means the body write has to keep the quoted thread.** Selecting the whole body and
writing over it — what this did before — deletes the message being answered, and on a case
running for weeks that is most of the context the customer has. So the draft replaces only
what is ABOVE the quote (`topLevelQuotedNode`), which also keeps a re-press correct: the
previous draft is exactly what sits above it.

With a quote present the draft is placed **by DOM, deliberately not by execCommand**. A
range that ends before the quote node does not stop the browser SPLITTING it: inserting
against it took the quote's own "From: …" line out of `#divRplyFwdMsg` and left it above the
boundary as a bare `<div>`, tearing the header in half so its first line counted as part of
the draft. No arrangement of the selection prevents that reliably. Removing what is above
the quote and inserting before it cannot split anything, and the input/change events fired
afterwards are the same ones the innerHTML path has always relied on. `chars` is measured
over the draft region only — with a thread on the form the body is never empty, so measuring
all of it would report a comfortable few thousand characters for a write that put nothing in.

**A publisher the engineer has scrolled past is still found.** `isVisible` rejects anything
more than 500px above the viewport — right for the inactive console tabs Salesforce parks
off-screen, wrong for the publisher, which sits at the top of the feed and goes above the
fold as soon as you read any history (measured at y = -878 with one quoted thread on the
form). `findPublisherTab` now falls back to `isRenderedIgnoringScroll` — the same test minus
the position — scoped to the record's own root so the off-screen console tabs stay out of
reach, and scrolls the tab into view before clicking it.

**It never presses Send.** Everything else this panel writes lands somewhere
internal — a call note, a Chatter post — and can be corrected afterwards by
whoever reads it. An email cannot: it is gone the moment Send is pressed, to the
customer and to the whole account team the action exists to copy in. So the
composer is left filled in and open, and the last click is the engineer's. There is
deliberately no code in `writeEmailDraft` that finds the Send button.

**The email is byte-for-byte the customer draft.** Both actions call
`buildCustomerEmailPrompt(c)`, which is the whole former body of
`draftCustomerEmail`, extracted rather than copied. Copying the account team onto
the header changes who receives the message, not a word of what it says — an email
that read differently because a colleague was on the Cc line would be the wrong
email, since the customer is still the person being written to. The same split gave
`caseHasEmailMaterial(c)` its own function, so the two actions cannot drift apart
about when there is enough on the case to draft from.

**The account is read in the background window, not by clicking the account link.**
The by-hand sequence is Details tab → click the account → read six fields → back to
the case, and clicking that link NAVIGATES the tab the case is open in. The write
that follows needs the case's own publisher, so the panel would then have to
navigate back and wait for the record to mount a second time. The href is the useful
part of that click: `GET_SALESFORCE_CASE_ACCOUNT` returns it, and
`readAccountRecordTeam` loads the Account in the same hidden `ocReader` window the
queue sync uses (§5.1's two-phase poll, the paint escalation, the guaranteed tab
close). The engineer's tab is left where they left it. A team read is cached for
fifteen minutes per account id — reassignments happen weeks apart, not minutes.

**The read finishes when it stops growing, not when it first answers.** This is
the fix for "only the account owner and the TAM get Cc'd", and the bug was here
rather than in the scraping. `pollUntil` used to return the first read reporting
`fieldsSeen > 0`, which on a real record is the FIRST PAINT and not the finished
one: Lightning mounts an Account layout in pieces, and the two fields that carry
`data-target-selection-name` (Account Owner, `Support_Owner__c`) come up with the
first section while the aligned-engineer fields land a beat later. The panel took
that first answer, closed the reader tab, and reported a two-person account team
for an account with five people on it — as a SUCCESS, so nothing ever said the
read had been cut off half way. Now every read is kept, the best wins, and the
poll returns when the whole layout is accounted for (`fieldsSeen >= fieldsTotal`,
the fast path), or when two consecutive reads have found nothing more, or at the
deadline. A read that hit the deadline still growing is `settled: false`: it is
still USED — three of five people beats none, and the review box lists exactly who
is on it — but it is **not cached**, because a partial team cached for fifteen
minutes is a partial team on every case on that account for fifteen minutes. It
also now earns the paint escalation, which previously only an empty read got.

**And "quiet" no longer means finished** — the first version of this fix still lost
the engineers. It returned as soon as two consecutive reads found nothing more, about
1.6 seconds, which on a record whose first paint carries Account Owner and TAM is
exactly long enough to conclude that a five-person team is a two-person one. Worse,
it returned `settled: true`, so the paint escalation never ran: the reader tab is a
minimized background window, Chrome renders almost nothing in one, and painting it is
the single most effective thing available for getting the rest of a layout to mount.
The read gave up before trying the one thing that works. Now only
`fieldsSeen >= fieldsTotal` ends a pass successfully; going quiet short of that ends
it EARLY and unsuccessfully, which is the point — it reaches the paint in a second and
a half instead of sitting out the whole budget first. The second pass, painted, uses a
longer quiet window (six reads) because it is the last look and waiting has become
productive. `reason` is one of complete / quiet / deadline, and only `deadline` is
unsafe to cache.

The read also logs one line to the panel's console — people found, fields seen of
fields total, how many the sweep added, and how the read ended — because when a team
comes back short the question is always "was the field missing, empty, or not mounted
yet", and none of that is visible from the review box.

**The Details tab is usually not clicked at all.** `findCaseAccountLink` does not
require the field to be VISIBLE. A Details tab opened once stays in the DOM, merely
hidden behind whichever sub-tab is showing, and the account link in it is still this
case's account — so it is read where it lies. Only a panel Lightning has never
mounted has nothing to find, and that is the one case `activateDetailsTab` exists
for. `detailFieldsShowing` tests for `[data-target-selection-name^="sfdc:RecordField."]`
rather than for field labels, because a case shows its highlights strip (Priority,
Status, Case Number) whatever sub-tab is selected — "there are labels" is true on the
Feed tab too, and would have reported the Details tab as already open when it was not.

**The seven person fields are matched by API name first, label second.**
`ACCOUNT_TEAM_FIELDS` carries `Support_Owner__c` (labelled "TAM"), `Backup_TAM__c`,
`Aligned_Support_Engineer_1__c`, `Aligned_Support_Engineer_2__c`,
`Aligned_Backup_Engineer_1__c` — labelled **"Aligned Support Engineer 3"** — and
`Aligned_Backup_Engineer_2__c`, labelled "Aligned Support Engineer 4". Those last two
are why the API name leads: matching them by label alone looks right and reads the
wrong fields the day somebody puts the labels back. The label list is the fallback
for a layout with no `data-target-selection-name` on it. `personFromFieldBox` reads
the **user link**, not the box's text — an empty lookup still renders a
`<span class="not-navigable">`, and on some layouts the inline-edit affordance beside
it is the only text in the box. "Support Comments / Aligned Engineers" is deliberately
not on the list: it is free text about the account, not a person field.

**And then everything else that is obviously an aligned engineer.** The seven named
fields are a CLOSED list; an account team is not. An org can add a fifth aligned
engineer, renumber the ones it has, rename `Aligned_Backup_Engineer_1__c` again, or
— as the reporting org's layout actually does — **label two different fields
identically**, so that two separate engineers both sit under "Aligned Support
Engineer 1". Every one of those loses a person silently: the field is on the page,
plainly labelled, with a User link in it, and nothing asks for it. Matching by label
alone makes the duplicate case worse rather than better, because the same box is
handed to the "1" spec and to the "2" spec and the second engineer is never read at
all.

Two things fix it. `accountFieldBox` now takes a **claimed** list and skips boxes
already taken, so duplicated labels resolve positionally — first match to the first
field that asks, second to the next. And after the seven, `alignedEngineerBoxes`
**sweeps** for any field whose label matches `/^aligned (support|backup) engineer
\d*$/` and was not claimed, reporting each with the label the page actually printed.
The sweep is deliberately generous, because the two failure modes are not
symmetrical: a field it reads by mistake appears as a named person in the review box
with an × beside it, while one it misses appears as nothing at all. It is bounded at
both ends all the same — an empty lookup is still nobody, and "Support Comments /
Aligned Engineers" is still not a person.

Claims compare by CONTAINMENT, not identity (`sameFieldBox`): the selection-name path
returns the flexipage's outer `div.slds-grid` and the label path the
`.slds-form-element` inside it, so identity alone would let one field be claimed
twice and the sweep would report the same engineer as a second person.

**The Cc lookup is driven by name, because a name is all there is.** The team fields
are user lookups: they render "Vlastimil Turzik" and a link to a User record, and
nowhere on that page is there an email address. Salesforce's own recipient lookup
resolves a name to the right address — the same search the engineer would use — so
the name is typed and the org's own answer is taken. Nothing composes an address out
of a name: a guessed `firstname.lastname@` that happens to be wrong is an email about
a customer's case sent to whoever does own that mailbox, reported as a success.
`matchRecipientOption` requires **every word** of the full name in the option text, so
the surname-only retry widens what is OFFERED and never what is ACCEPTED — "Mitulski"
alone would otherwise take whichever Mitulski Salesforce listed first. A person is
counted as added when their **pill** appears and not before, and a name the lookup
could not resolve is cleared out of the box and named in the report. Half a Cc list
the panel is quiet about is worse than a Cc list it says is half done.

**Recipients first, body last**, and the order is load-bearing: opening the Cc row
and dropping pills into it re-lays out everything below the header, and on some
layouts that re-render replaces the body's iframe outright. A body written first
would be written into an editor that is about to be thrown away.

**The body is a TinyMCE document inside an iframe**, so the editable node is not in
the page's document at all and no selector run against `document` will ever find it.
The frame has no `src` of its own and therefore inherits the page's origin, which is
what makes `contentDocument` reachable; a cross-origin frame throws on the property
access and is skipped. It is written with `execCommand('insertHTML')` **in the
editor's own document** — TinyMCE keeps its own model, and content written into the
DOM behind its back can be re-rendered away, which would file an email the engineer
watched appear on screen. That needs the document focused, which is why
`accountEmailToSalesforce` brings the tab to the front first (the same reason
`postToSalesforceFeed` does). The HTML is `emailBodyAsHtml(bodyText)` — the identical
string the **email** Copy button puts on the clipboard, signature and all, so a draft
that goes in through this path and one pasted by hand arrive looking the same. (Copy
under any other kind of answer is unsigned — see 5.8.8.)

**Two things are read and never written.** The **To** field: Salesforce fills it in
from the case contact, and overwriting it would be this panel deciding who the email
is addressed to on the strength of a field it read one record away. It is reported
instead, because an empty To on a composer full of Cc'd colleagues is worth saying
before Send is pressed. And the **Subject**, when Salesforce already has one: a reply
carries "RE: <the customer's subject>", which is the thread their mail client
recognises, and replacing it with the model's wording breaks the threading for no
gain. The drafted subject goes in only when the field is empty.

**A failed team read does not stop the draft.** The read happens in
`runQuickAIAction`'s preparation pass, which is also what gets `opts.sfEmail` onto the
message in time for `send()` to persist it. Throwing there would report the failure
and leave the engineer with nothing, when the email is worth having on its own with
the Cc list put in by hand — which is exactly what they did before the button
existed. The reason is carried forward and said in the review box instead.

**The write can be retried without regenerating.** `msg.sfEmail` is persisted with the
answer (same mechanism as `msg.sfWrite`, and `copyRowKey` is why the row is rebuilt
when it is set a moment after the bubble was first drawn), so the button under the
draft reopens the review box with the same Cc list. The write is six steps in somebody
else's UI and the commonest reasons it stops are momentary — a stale tab, a composer
caught mid-render, a case that was not open yet — so the expensive half must not have
to be repeated to have another go at the cheap one.

**It is a permanent Quick Options button, not one of the optional extras.** The two
that write (Log a Call Note, Write a Post) are opt-in because they put text on the
customer's record under the engineer's name and the panel cannot take it back. This
one fills a composer in and sends nothing, and it is the same errand as the button
directly above it — the two read as a pair: draft it, or draft it and copy in the
people who own the account.
---
5.8.2 Sync from Salesforce — it finds the list, and refreshes it
Two things used to be true of this button that should not have been.

**It only worked from one place.** It read the ACTIVE TAB and nothing else, so
standing on Jira, on Outlook, or on a case record and pressing it read whatever was
in front of it, found no case rows, and told the engineer to go and open a list view
they had open five minutes ago. The panel knew perfectly well where the queue had
come from; it had simply never written it down.

It does now. Every list sync that returns rows records the view it read
(`ocLastList` → `OC_LAST_LIST_KEY`), and `resolveCaseListTab()` picks a tab in this
order: the active tab if it is a case list view; the remembered list if it is open
in a tab (focus it); any open case list view; the active tab if it is a Salesforce
page **and nothing is remembered yet** — the old behaviour, kept as the path that
LEARNS an org's odd list URL; and finally re-opening the remembered list in a new
tab, waiting for the grid with the same `syncListWhenTabIsReady` a saved link uses.
It never assembles a URL out of an org's hostname: the list it goes back to is one
the engineer stood on and synced from.

Note the fourth step's condition. Once a list is remembered, pressing Sync on a case
RECORD goes to the list rather than failing on the record — which is the whole
complaint. And a named tab that has gone (`opts.tabId` that will not fetch, because
the engineer closed it while the grid loaded) **stops and says so** rather than
resolving again: the opener calls back into the sync with the new tab's id, so
falling through there is an unbounded loop that opens Salesforce tabs until somebody
notices. The end-to-end driver opened nine before it was stopped.

**It did not refresh.** A Lightning list view is a SNAPSHOT of the moment it loaded;
it does not re-query because time has passed. So syncing a tab open all day read this
morning's queue — cases closed since then still in it, cases opened since then
missing, every age and status cell stale, and nothing about the result looking wrong.
That was a ↻ welded onto the end of the button, on the reasoning that the refresh
costs a round trip and a fresh queue does not need one. **That reasoning does not
survive the question it asks**: "is the list in that tab stale?" is exactly what you
cannot know without refreshing it, so the choice between the two halves was one
nobody could make correctly. Refreshing is now part of every sync, the ↻ is gone
(`refreshThenSyncCaseList`, `.sf-split`, `.sf-refresh` with it), and
`refreshSalesforceListView` is on the main path instead of a side one. It remains
best-effort and cannot fail a sync — no Refresh button, no reply, a refresh that
never resolves, each falls through to reading what is on screen, which is precisely
what the old plain sync did. `refresh: false` exists for the one caller that has
already pressed it.

`USAGE_SYNC_LABELS.listRefresh` is kept and marked retired: nothing writes it any
more, but a profile that pressed the ↻ before 7.5.0 still has the count, and the
report only prints a row when there is one.
---
5.8.3 Bookings links, and asking for a meeting on purpose
The bookings setting was one URL, which is right until it isn't: an engineer routinely
has a 30-minute triage page and a 60-minute deep-dive page, or their own and their
team's, and which is appropriate is a property of the case. One field meant editing
Settings between drafts.

**The name is the feature, not a label on it.** Three Microsoft Bookings URLs are
indistinguishable from one another — all `outlook.office.com/bookwithme/user/<guid>` —
so a picker showing URLs would be a picker nobody could use. `bookingsLinkLabel` falls
back to the host rather than leaving a row nameless, because a nameless row cannot be
chosen; the picker shows the URL underneath as the tiebreaker for two pages somebody
named "mine" and "new one".

**One list, not a list plus a default.** The first entry IS the default, and that is the
whole rule: `getBookingsUrl()` — which every automatic path already called — returns
it, so an engineer with one link sees no change at all and
`buildMeetingInviteDirective` never learns the list exists. `normaliseBookingsLinks`
validates on the way IN as well as out (these reach a customer's inbox), de-duplicates
by URL, caps the list, and takes the legacy single `bookingsUrl` as its upgrade path —
read only when there is no list, so a value the engineer has moved on from cannot
reappear beside it. Both shapes are still written on save, so a profile rolled back to
an older build keeps a working link.

**“📅 Draft with a meeting request” is a sub-button of the plain draft — and still an
action, not a toggle.** It sits under "Draft an email to the customer" the way the
length chips sit under Case Summary, because that is the relationship: it is not a
separate errand, it is the button above it with one more thing asked for. As a
full-width sibling it read as an unrelated action that happened to be next in the
column.

The first attempt at making it look subordinate indented it, shrank it and greyed it
out, and the result read as a DISABLED control rather than a nested one — dim 11px
text under a bright button looks like something you cannot press. So the shape carries
the relationship and the contrast no longer has to: `.qa-sub::before` draws an elbow
from the bottom-left of the parent across to this one, the same connector a tree view
uses, and text is back to a readable weight. The label was also a fragment that only
parsed if you had just read the button above it ("With a meeting request"); it is a
whole instruction now. What it must never become is a *sticky* chip like Standard/Concise: those
are a remembered setting, this runs when pressed and is never left switched on.
What an email asks for is not a formatting option, and a toggle that silently
changes whether a customer is asked to book a call is one somebody leaves on and
then sends an invitation they did not mean to. Sub-button, not sub-chip.
It keeps `qa-drop-item` alongside `qa-sub-item` so the three email actions remain
one group in document order.

**The behaviour behind it is unchanged, and deliberately ungated.**
`buildMeetingInviteDirective` DECIDES whether a session is warranted from the case's
signals, and it is right to — most replies should not propose a call, and a panel that
offered one every time would be as wrong as one that never did. That stays. This is the
other case: the engineer already knows the answer, and a heuristic re-litigating it by
reading the chain is not a feature at that point, it is the button not working. So
`buildRequestedMeetingDirective` has no gate — no `meetingNeededForEmail`, no lifecycle
check, no "offer" tier.

The two are mutually exclusive by construction rather than by a flag inside one
directive: `buildCustomerEmailPrompt(c, { meetingLink })` swaps one block for the other.
An email carrying both would tell the model to offer a session in one paragraph and to
require one in the next, with the same agenda candidates printed twice.

What the mandatory directive still reads from the signals is what the email must not get
WRONG: a session already booked is confirmed and prepared for, one already offered is
chased rather than re-offered, one already held is named as a FURTHER session. And the
fix still goes in — an email that withholds a known answer to book a call about it is a
worse email, said explicitly because the layout directive is strong enough to make the
session read as the message.

**No dialog for one link, and none for none.** A modal with a single option exists only
to be dismissed, and it would sit between the button and the draft on every use for the
majority of engineers, who have one page — so the one link is taken and a toast says
which. With none configured the action refuses before a token is generated and opens
Settings at the list: the link is the whole point, and drafting an email with nothing to
book on is the button not working.
---
5.8.4 Usage & Feedback — what the panel is actually used for
The panel has about twenty distinct actions and nobody knew which of them anybody
pressed. That is not a curiosity: it decides what gets built next and, more usefully,
what gets REMOVED — twenty shortcuts where five are used is a panel where the five are
hard to find.

`recordUsage(kind, key, n)` is the only entry point and it swallows every error it can
raise, because a counter that can break a Quick Option is a counter that should not
exist. It is called from six places:

- **`wireQuickAction`** — the one place every Quick Option is wired, permanent and
  optional alike, so an action added tomorrow is counted without anybody adding a line.
- **The sync buttons**, each counted separately — the queue, one case, JIRA, the
  Knowledge base. `listRefresh` was a fifth, belonging to the ↻ that is now gone
  (§5.8.2); its label is kept so an older profile's count still reads as words, and
  nothing writes it any more.
- **`send()`**, on `overrideText === null` only. That is not a heuristic: every quick
  action passes its prompt in, and the only caller that passes nothing is `#btnSend` and
  the Enter key — so "questions typed" and "buttons pressed" stay separate numbers,
  which is the interesting split.
- **The 👍/👎 row**, on the state that was actually saved. A 👎 whose correction was
  never submitted is not a vote.
- **The three Salesforce writes**, on SUCCESS only. A write the org refused is a report
  about the feature, not a use of it, and counting attempts would make a flaky org look
  like an enthusiastic one.
- **`openCaseFromList` and `closeCase`** — the case clock. `getDefaultCase` stamps
  `startedAt` separately from `createdAt` even though they are the same number, because
  they mean different things: `createdAt` is the retention clock and must never move.

**"Time to resolve" is named as what it is.** It is the span between opening a case in
the panel and pressing *Close case* on it — not Salesforce's case age, and not a
resolution time. It tracks the real thing closely on a case worked through the tool and
not at all on one opened, glanced at and left, which is why the median leads and the
mean is shown beside it: the gap between the two is the long tail. Spans that are
negative or longer than a year are dropped rather than skewing it.

**The catalogue travels with the report.** Absence is the answer the whole exercise is
for — a zero across every engineer is the case for deleting something — and a dashboard
holding its own copy of the action list would be wrong about it the day one is added or
renamed. `usageCatalogue()` reads the buttons that exist plus `QA_EXTRA_ACTIONS`, so it
cannot drift.

**What is not in the report.** No case number, account, customer, contact, subject,
description, log text, prompt or answer. There is no free-text field at all except the
engineer's name and the panel version — so nothing about a case can reach it even by
accident, which is a property of the shape rather than of a filter that has to be right.
The report is printed in Settings and "Copy report" puts the exact bytes on the
clipboard, because the one thing that would make this unacceptable is an engineer not
being able to see what left their machine.

**WHY IT OPENS A TAB RATHER THAN POSTING.** The extension cannot post anywhere. Its
`connect-src` allows `'self'` and SOTI's and Salesforce's own hosts and nothing else,
deliberately (SECURITY.md §5), and there is no SOTI endpoint that collects this.
Widening the CSP to a new host is a decision for whoever owns that assessment, not
something a feature does on its way past. So the panel does not send: it opens the
dashboard in a background tab with the report in the URL **fragment**, and the page —
running as the engineer, on its own origin — writes it into the shared database itself.
A fragment is never part of a request, the extension holds no credential, no host
permission is added and the CSP is untouched. It is one click, or once a day if the
engineer ticks it; off until they do.

**IT IS NOT IN SETTINGS ANY MORE — it is an administrator's screen.** Everything in that
box answers an administrator's question, not an engineer's: which shortcuts get pressed,
where the report goes, and Clear counters. Folding it away (the previous answer) hid the
LENGTH of the section, not the section, and the two mistakes that actually happened were an
engineer clearing their own counters and an engineer pointing the dashboard address at a
board that was not the team's. It ships `hidden` on the wrapper now and
`revealUsageSectionForAdmins()` brings it back when `soti_usage_admin` is set in
`chrome.storage.local` — read once at start-up rather than on the settings-open path,
because `chrome.storage` is async and a section that appears a frame after the dialog does
grows the dialog under a cursor already moving towards Save.

**How an admin turns it on: the corner of the dialog.** `#adminSpot` is a 22px square in
the bottom-left of AI Settings — invisible at rest, a faint dot under the cursor, the
default arrow rather than a pointer because `cursor: pointer` is how a browser advertises
a control and advertising it is the one thing this must not do. The flag used to be
settable only from DevTools, which made the honest answer to "how does an admin turn this
on" an answer nobody should have to give.

*Why a corner and not a labelled checkbox.* A tick marked "Admin mode" is a labelled
invitation: the engineers the section was hidden FROM would find it first and tick it to
see what it does, and the section would be back on everyone's screen — the whole thing
being fixed. A control nobody stumbles over is the point.

*A toggle, not a switch-on.* `setUsageAdmin()` writes both stores and `applyUsageAdmin()`
paints the section and the dot from one place, so the control and the thing it controls
cannot disagree. Clicking the corner again turns it off, because whatever turns a thing on
has to turn it off from the same place or the only way back is the console this replaces —
and a click in an empty corner is exactly what happens by accident. A toast names the new
state and names the corner as the way back, said once, at the moment it is true. In flow
(first child of a `flex-end` row, `margin-right:auto`) rather than absolutely positioned,
so it can never drift over Cancel or Save on a narrow panel; `tabindex="-1"` and
`aria-hidden`, because an unnamed square in the tab order of a dialog every engineer opens
is worse for a keyboard user than not being there — the storage key stays the second route.

That flag is **not a security control and must not be read as one.** The panel has no
account and no directory to ask, so there is nothing here to authenticate against, and
anything that can set the key can read the counters straight out of the same store. It
decides what the dialog OFFERS, which is the real problem. **Counting is unaffected either
way** — every counter is written by the actions themselves, and hiding a readout does not
stop the thing it reads. `<div hidden>` also needed a stylesheet rule to work at all here:
`hidden` is only a `display:none` in the browser's own stylesheet and `.fld` is
`display:flex`, which outranks it, so the section rendered in full while every property
said it was hidden. `[hidden] { display: none !important }` at the top of styles.css.

**The board** is an Artifact with the `db` capability, at
https://claude.ai/code/artifact/f34ef254-178b-4774-b11b-b2cf47a7a51e — one document per install
at `usage/<installId>`, overwritten each time, because an artifact database holds 5,000
documents and an event stream would spend them in a week. It subscribes to the
collection, so a report arriving anywhere appears on every open copy. Declaring `db`
makes it organisation-internal: everyone signed in to the owner's org can read it and it
cannot be shared publicly, which is the right boundary for this and is stated on the
page.
---
5.8.5 Server sizing on a deployment SOTI hosts
"Server Sizing & System Requirements" reads the requirements for the case's MobiControl
version off SOTI Pulse and sizes the estate against them. Its last section is the one
that needed a branch: on a **Cloud (SOTI-hosted)** deployment the customer has no console
access to the management server, no SQL instance to read a version off, and no say in how
either is sized — SOTI operates all of it. So "Questions to ask the customer: obtain the
Management Server CPU and RAM allocation" is not merely unhelpful, it is an instruction to
go and ask somebody a question they are structurally unable to answer, on a case where the
person who CAN answer it is the engineer's own hosting team.

This used to be a line in the prompt asking the model to bear it in mind, and a line in a
prompt is a request rather than a guarantee — the report that prompted this change still
came back with five infrastructure questions addressed to the customer. It is a branch on
`$('dsCfg')` now. When hosting reads Cloud the final section is RENAMED to "What to obtain
internally (SOTI-hosted)", its audience is the engineer, each bullet names the internal team
to obtain the fact from, and asking the customer for server, database or infrastructure
configuration is forbidden outright rather than discouraged. What is unknown about the
hosted estate is reported as "not stated — SOTI-hosted, obtain internally" rather than as
something the customer failed to provide. The customer may still be asked about what is
genuinely theirs — device count, platforms, what they observe, when it started — and where
one of those is asked, the answer says so. `progressSections` follows the rename, or the
progress meter would wait for a heading the model was told not to write.
---
5.8.6 When the panel and the screen are on different cases
This panel does not follow the browser, and that is a design rather than an
oversight — see `salesforceTabForActiveCase`, and the run pinning that keeps an
answer with the case that asked for it. A summary started on case A must finish on
case A even if the engineer walks off to case B while it thinks, or the answer
belongs to nobody.

The cost of that is a quiet failure. The panel is a column of facts — case number,
product, versions, the email chain, every answer in the chat — and none of it
changes when the tab behind it changes. So an engineer reading case B in Salesforce
with case A still selected here is reading two customers at once with nothing
saying so, and the sentence they paste, the version they quote or the note they log
is about the wrong one. Everything on screen is correct; it is correct about
somebody else's customer.

`checkCaseMismatch` compares the panel's own case record id against the record id
of the tab in front, and when they disagree it puts a **3px red outline around the
whole panel** and a strip naming both case numbers. The outline is on the body
rather than under the header because the mistake is made with the eyes somewhere
else — it has to be catchable in peripheral vision from the far side of the window.
It is an `outline`, not a `border`, and inset: a border would add to the panel's box
and shove the layout inwards the moment it appeared, re-wrapping the case tabs on a
400px side panel. It pulses four times and then stops — it has to move to be noticed
and stop moving to be worked next to, and `prefers-reduced-motion` removes the
animation entirely.

**The exclusions matter as much as the rule**, because a warning that cries wolf is
one people learn to read past. It fires only when the tab in front is a Salesforce
CASE RECORD page (a list view, Jira, Outlook or a KB article is a Tuesday, not a
contradiction); only when this panel actually knows its own case (a case typed in by
hand has no record link to compare, and inventing a disagreement out of a missing
value would fire forever on every unsynced case); never against the background
reader's tab, which holds records open during a sync; and not while the Open Cases
queue is up, because that screen IS the act of choosing what to work on next.

**It states, it does not act.** It offers the two ways out — bring this panel's case
to the front, or move the panel to the case in front — and both are the engineer's
to press. "Switch panel to it" appears only for a case this panel already holds, since
a record id alone cannot be made into a working tab. Switching either one
automatically would be this panel deciding which customer is being worked on, which
is the whole mistake it exists to point at.
---
5.8.7 Stats — the engineer's own Power BI report, in the panel
A third screen beside Cases, shown the same way: instead of `.layout`, never inside it.
The panel's three screens answer three different questions — `.layout` is about ONE case,
the Cases queue is about what to work on next, and this is about the person — and the tab
row is where the panel already answers "which of them am I looking at". `showStats()` /
`hideStats()` mirror `showOpenCases()` / `hideOpenCases()`, and `viewMode` gained a third
value that `navSnapshot`, `goBack` and `rememberViewMode` all carry, so Back works across
it and a rebuilt document comes back to it.

**`hideOpenCases()` now leaves EITHER screen.** Its dozen callers — a row clicked in the
queue, a field being pointed at, an answer about to be streamed — all mean one thing, "the
case view is what should be in front now", and not one of them knows or should know which
screen is currently covering the chat. Handling Stats at each call site instead is how you
get a Quick Option that streams its answer behind a Power BI report.

**TWO ADDRESSES FOR ONE REPORT, and they are not interchangeable.** `STATS_REPORT_URL` is
the address a person visits, with the workspace and report section in the path; that is
what "Open in Power BI" opens, in a real top-level tab. `STATS_EMBED_URL` is
`/reportEmbed`, the secure-embed address, which is the one Power BI supports being framed —
the visiting address is a full app shell and is not meant to render inside anything.

**`autoAuth=true`, AND THE SIGN-IN HOSTS ARE FRAMEABLE — the fix for a screen that showed
"This content is blocked".** As shipped, 7.7.0's Stats tab rendered Chrome's grey blocked
page over the whole report, and the cause was in this extension rather than in Power BI:
the panel's own `<meta>` CSP said `frame-src 'none'` while the manifest allowed
`app.powerbi.com`, and **a browser enforces the intersection of the two**, so the allowance
was `'none'` and the very first load was refused. Both policies now carry the identical
list. And it would have been refused again one redirect later: `/reportEmbed` answers a
browser with no Power BI *embed* session — which is a different thing from being signed in
to Microsoft, and is why "but I am logged in" and a blank report are not a contradiction —
by sending the frame to `login.microsoftonline.com`, and `frame-src` governs navigations
*inside* a frame, not only its first address. So the sign-in hosts are on the list too, and
`autoAuth=true` — the parameter Power BI's own *Embed report → Website or portal* dialog
generates — is what makes that exchange happen silently for a browser that already has a
Microsoft session. Without it the embed page waits to be driven by the powerbi-client SDK
and an embed token, which is the *other* embedding model: it needs a service principal and a
secret, and this panel deliberately holds neither. `STATS_TENANT_ID` is the optional `ctid`,
blank by default, and only matters to somebody signed in to more than one tenant.

**AND A REFUSAL NOW REPORTS ITSELF — BUT ONLY A REFUSAL.** `#statsNote` used to carry a
permanent line of troubleshooting advice ("Signed in to Microsoft in this browser? … press
Open in Power BI"), written for a build whose frame was blocked and therefore always blank.
With the frame working, that sentence sat on top of a loaded report on every single visit and
pushed it down the screen to answer a question nobody had asked. Standing advice on a screen
that works is noise, and noise on a screen you open every morning is how a real warning gets
skipped when it finally appears. **The strip now ships empty and hidden**, and speaks only for
the two states the panel can actually establish. It cannot see inside the frame, but it can
see its own CSP refuse one: `securitypolicyviolation` fires on the panel document and names
the address that was blocked, and `statsFrameSetState` turns that into a sentence naming the
host and both files that have to agree. The other state is a guess and is worded as one — a
frame that has not fired `load` in twelve seconds says it is taking a while. A frame that HAS
fired `load` says nothing, because a rendered report, a sign-in wall and Chrome's own error
page all fire it. **Open in Power BI** is a permanent button above the strip either way, which
is the way out the sentence existed to point at.

**The frame is loaded on the first visit and then left alone.** `#statsFrame` ships with no
`src`, so a panel that boots straight into a case never fetches Power BI at all — and Chrome
rebuilds this document often enough that "on every boot" would be several loads a day of a
report nobody opened. Re-assigning the same `src` on each visit would reload the report and
throw away whatever page or filter the engineer had moved to, which is the one thing a
report you keep returning to must not do. Reload is a button for exactly that.

**WHAT THE PANEL CANNOT SEE, and what follows from it.** The frame is `app.powerbi.com`'s
document. Same-origin means a sign-in wall, a "you do not have access" page and a fully
rendered report are indistinguishable from out here, and a browser not signed in to
Microsoft gets a blank rectangle with nothing able to say why. So the frame is never the
only route: the note above it is always on, in words, naming the button that fixes it, and
**Open in Power BI** opens the report where sign-in can actually complete. `createEngineerTab`
rather than `chrome.tabs.create`, for the reason the usage board uses it — with a background
reader window alive, "the current window" is a minimized one the engineer cannot see.

No credential is involved anywhere in this: the report renders for whoever the browser
already is, the same posture the Copilot bridge takes. The embed URL is a fixed workspace
and report id built from constants — no case, account, name or counter goes into it. See
SECURITY.md §2 and §5 for the `frame-src` change this needed, and what it does not grant.
---
5.8.8 The row under an answer — what Copy copies, and what files it
Every assistant answer gets a `.copy-row` built by `attachCopyUI`. What is on it is decided
by `msg.copyKind` (what a quick action named its output) and by three flags the action can
set — `sfWrite`, `sfEmail`, `sfInternalNote` — all of which are persisted with the message,
because the row has to still be there after a tab switch. `copyRowKey` names what the row
was built for, and is why a row drawn before a quick action finished naming its answer is
REBUILT rather than left saying "Copy" over an email.

**THE SIGNATURE BELONGS TO AN EMAIL AND TO NOTHING ELSE — and that is a statement about the
TEXT, not about which button produced it.** `writeEmailToClipboard` used to append the SOTI
signature block — ", Technical Support, SOTI | Call Us | …" and the legal notice —
unconditionally, so it landed on every Copy button in the panel: cleaned meeting notes, a
case summary, a log analysis, the answer to a question asked in the chat. None of those is an
email, none of them is signed, and the block was being pasted into Salesforce's internal note
field and deleted by hand. It is now gated on the copy kind, and an answer is an email when
**either** of two things is true:

- a quick action said so — `copyKind: 'email'`, set by **📧 Draft an email to the customer**,
  **📅 Draft with a meeting request** and **👥 Account Email**; or
- **it is one by its shape.** "Draft an email to the customer" *typed into the chat* produces
  exactly the same artefact — subject line, greeting, body, sign-off — and no `copyKind`,
  because no quick action ran. It used to copy unsigned with the subject line pasted into the
  body. `looksLikeEmailDraft` reads the shape instead, and the whole email treatment follows:
  the label becomes **📧 Copy email body**, the subject stays out of the body, the draft is
  signed, and **📧 Put in the Salesforce email** appears under it.

**The detector takes two independent signals, never one**, because the cost of a false
positive is the original complaint coming back — a signature glued to something that is not
an email. A **sign-off** in the last few real lines is mandatory (`EMAIL_SIGNOFF_RE`, or a
trailing "Ayodeji Augustine / Technical Support / SOTI" via the existing `isSignOffTail`),
and then either a **subject line** at the top — which settles it, since "Subject:" above a
sign-off is an email and nothing else — or a **greeting** at the top, which is the weak pair
and additionally requires five real lines and 200 characters, so a conversational "Hi Deji, …
Thanks" in the chat is not a draft of anything. `EMAIL_SIGNOFF_RE` and `EMAIL_GREETING_RE`
are the lists `restoreEmailParagraphs` already uses in eleven languages; a second pair would
have come apart the first time somebody added a language to one of them.

The two kinds of sign-off are **not weighed the same**. A bare closer ("Kind regards,", "Thanks")
is a word anybody might end a message with, and paired with a greeting it still needs five lines
and 200 characters behind it. A **signed identity block** — a name, a role, a company, in the
shape `isSignOffTail` recognises — is how a message is *signed* and nothing else ends that way, so
a greeting plus one of those is enough at any length. A three-line reply that is unmistakably a
draft was being refused by a length floor written for conversational chatter.

**AND THE MODEL'S OWN SIGN-OFF COMES OFF BEFORE THE BLOCK GOES ON.** `stripTrailingSignerName`
exists so the customer is not told who sent the message twice, and it used to recognise only the
three exact forms the quick-action prompt dictates — the name, `Technical Support`,
`Technical Support, SOTI`, `SOTI`. A typed prompt dictates nothing, so a draft closing

```
Kind regards,
Ayodeji Augustine
Technical Support Engineer        ← not "Technical Support"
SOTI Support                      ← not "SOTI"
```

matched on none of them; and because the walk-up stops at the first line it does not recognise
and the first line it meets is the bottom one, **nothing at all came off** and the whole block
was sent above the org's. `isSignOffTail` now matches by WORDS rather than by exact strings: a
line belongs to the block when every word in it is the signer's own name, a STRONG word (`soti`,
`support`, `engineer`, `consultant`, `specialist`, …) or a WEAK one (`technical`, `senior`,
`team`, `ltd`, …), and at least one strong word or the whole name is present. The closer is not
made of those words, so it survives — which is the point: the signature goes *under*
"Kind regards,", exactly as the quick actions already produced.

Three guards keep it off the body. It reads from the **bottom up and stops at the first line it
does not recognise**, so it can never reach into the message. A line of five words or more ending
in a full stop is **prose, not a signature** ("Please contact the support team." is built entirely
from listed words and is not a sign-off). And a **bare contact line — an address, a phone number,
a link — never extends the cut on its own**; it comes off only when an identity line is found
above it, so an invented direct line goes with the block it belongs to while an email that ends
with the article link it was written to send keeps the link. If the cut would consume every real
line, nothing is cut at all: an empty body is the one outcome nobody spots before pressing Send.

**A quick action's name wins outright.** `copyKindOf` returns `msg.copyKind` before it looks
at anything else, which is what keeps cleaned meeting notes and a case summary out of this:
they are named at the source, and no amount of shape-matching gets a vote on them. The
detection is memoised in a `WeakMap` keyed on the message object *and its content*, because
`attachCopyUI` runs for every bubble on every render and a still-streaming answer must be
re-read when it finishes rather than judged on its first paragraph.

Three things deliberately did NOT change with it. The **font** is not part of the gate:
Calibri 16 is a property of pasting into Salesforce rather than of being an email, and every
Copy button still writes both a rich and a plain flavour with the face named — that was
fixed for its own reasons and taking it away here would be a silent regression nobody sees
until they paste. The **two flavours still agree**: whatever the caller decides about the
signature applies to both, which was the original reason for signing unconditionally and is
not worth losing. And the **Salesforce composer write** still signs — `emailBodyAsHtml`
defaults to on, and that path is the actual email to the customer.

**PROFESSIONALISE FILES ITS OWN NOTES.** `sfWrite` puts **📞 Log a Call** and **💬 Write a
Post** beside the Copy button, going through the same `logCallNoteToSalesforce` /
`writePostToSalesforce` the Quick Options entries use with the text already in the box — the
dialog still opens, the engineer still reads it and still presses Save, and nothing reaches
the customer's record unread. It was set on the Case Summary and on nothing else, so cleaned
meeting notes — the output that most obviously wants to go onto the case — offered Copy and
left the engineer to find the case in Salesforce, open Feed → Log a Call and paste. It is
now set by `cleanUpMeetingNotes` too. The tooltips read "these notes" under notes and "this
summary" under a summary; everything else about the two buttons is identical, and an answer
that did not ask for them still does not get them.
---
5.9 Case-answer guards — the deterministic checks around the model
The quick actions (Case Summary + Next Steps, Draft an email, With a meeting request,
Account Email, Work out a resolution, 30/60/90, Problem & Resolution) produce text that goes to a customer or into the
Salesforce record, so five classes of error are checked in JavaScript rather than trusted to the
model. Each has a prompt side (tell the model) and an output side (verify the answer),
because an instruction is not a guarantee on a small local model — every one of these was added
after watching the instruction alone fail.
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
notes" question is the only case that gets the full listing (`MCMR_CITATION_MODE = 'open'`),
and "explicit" means *the agent typed it*. A quick action's research query is built by the app
from the case's own symptom text, so `searchPulseAndDocs(..., { caseDerived: true })` refuses to
infer the question from it: a case whose Issue Summary reads "MCMR-30202 is raised with
Development" — which is exactly what a well-filled case says — used to trip the `mcmr-\d+`
trigger and switch the allow-list off. The guard was being disabled by the case being well
documented.
A log analysis runs the scan too (`buildLogFixScanQuery`, notes-only and time-boxed). Research
used to be skipped on that path entirely, which meant no MCMR was ever verified, which meant
`buildMcmrCitationRule` emitted its "you are FORBIDDEN from writing any 'fixed in version X'
claim" paragraph — so an engineer analysing a log from a two-year-old build was *guaranteed*
never to be told the defect in front of them ships fixed.
4. A fix that has already shipped is stated, not implied. When a ticket the case already
carries (`jiraNum`, the synced ticket, or a code the correspondence names) appears in the
Resolved Issues of a build NEWER than `sotiVer`, `caseTicketsFixedInNewerVersion` treats that as
settled fact and `noteShippedFixForCaseTicket` appends the build and the gap if the answer never
says it. Deliberately narrow: a symptom-matched code the case does *not* carry is a suggestion,
and suggestions stay with the model and its allow-list. The note reads the answer before it
speaks — "upgrading belongs in the next steps" is right on a case summary and wrong on an
internal record or a forensic report, neither of which has a plan.
5. An interim mitigation is not left out of the internal record. `flagMissingMitigation` fires
only when the case data itself uses the word (workaround / interim mitigation / stop-gap) and the
finished "Solution:" line uses none, and it FLAGS rather than fills in — which of a case's
recorded actions *is* the mitigation is a judgement, and a wrong one written into a permanent
record is worse than a missing one. The reason it exists is that instructions were not enough:
the fact reaches the prompt verbatim from the notes, the template demands it and the record
directive demands it, and a small model still wrote a two-sentence Solution without the
240-second keep-alive that was the only thing keeping 2,060 devices online.
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
("Troubleshooting done") are never edited. `buildSymptomPlaybook` supplies the vocabulary that
makes specificity possible: real service names, log files, ports and error signatures from
`knowledge/MobiControl*.md`, selected by matching the case symptom against a table.
3. Evidence must be collected from the right side. `buildLogAccessDirective` turns the
MC Hosted field into a fact directive:
MC Hosted	Who collects	What the answer must say
Cloud	The support agent, from the backend	Name the artefact and time window the agent pulls; asking the customer for server logs is forbidden; only device-side evidence is requested
On-Prem	The customer	Name each log, server role, log level and time window; include arranging a screen-share to reproduce and capture together with exact timestamps — unless a session has already been HELD (`{ sessionHeld }`), in which case arranging one is not a next step at all
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
delivered (`SUPPORT_REQUEST`, `REQUEST_FULFILLED`), the four states of a live session
(`MEETING_PROPOSED` → `MEETING_BOOKED` → `MEETING_HELD`, plus "none of these") — booked is a
state of its own so a plan can never open by arranging a meeting already in the diary, and HELD
is now recorded rather than merely used to cancel the other two, because a case whose session is
behind it carried no session signal at all and the On-Prem log-access rule then told the plan to
arrange one), the customer's
contrast with an earlier case (`ISSUE_CONTRAST`), and the lifecycle scan that decides open vs
closing (`REOPEN_SIGNAL`, `CUSTOMER_CONSENT`, `SUPPORT_CLOSING`) — that last one matters most,
because the case state governs what "Next steps:" is even allowed to contain.
**What the newest message says happens next** (`latestIntent`) sits above all of them, because
"Next steps" is a question about the future and the last thing anyone wrote is the most recent
statement about it. When SOTI's own newest email says "I will be in contact with the developers
on MCMR-30202 first thing tomorrow", that IS the next step — it opens the plan, and the drafted
email reports back on it. When the CUSTOMER's newest message says what *they* will do, the case
is waiting on them and the step is to follow that up, never to re-request it under a new name.
Two filters keep the claim honest: a conditional undertaking is not one ("if it is not released
yet, tell me and I will plan around it" was being reported as the outstanding action), and
neither is a gesture with no substance — a commitment worth opening a plan with names a ticket,
a build, a case, a file, or is at least a full clause.
An internal note or call log is written to a fixed template, and BOTH of its halves are read.
"Next steps" supplies the commitments (the newest note's plan is the plan, so the loop stops at
the first one it finds); "Troubleshooting done" supplies the record of what was actually carried
out, collected across every note because those are historical facts that do not supersede one
another. That second half used to be ignored entirely — which is where the interim mitigation
lives, and on case C01751884 the internal Problem & Resolution record therefore came back without
"Keep-alive set to 240s on the Warrington test group": the next engineer to touch the case would
not have known that a hand-set timer was the only thing keeping the estate online, which is
exactly the thing they would undo. When items come from more than one note the "recorded by X in
a note (date)" label is dropped rather than attributing all of them to whichever note came first.
`detectChainSignals(entries, lc, issueText)` also reads the **issue summary**, not just the
chain. On a case opened through the portal that is the only place the customer states the
problem in full, and it is where a recurrence and the "unlike the previous case…" contrast
normally live. An issue-summary recurrence is flagged `fromIssueSummary` and rendered with
weaker wording than a chain one, because "I hit this again" in an opening report usually means
the customer has met the fault before — not that a fix on *this* case regressed.
---
5.11 Verifying a change
`sidepanel.js` has no full suite in the tree, so most changes to it are verified by hand —
its RENDERING rules are the exception, and now have one. The provider layer and the bridge
DO have one — see below.

1. `node --check sidepanel.js` — this is not optional. A regex assembled at runtime
   (`new RegExp(...)`) parses fine and throws on LOAD, so an unbalanced bracket in one
   multilingual cue takes the whole side panel down with no warning until you open it.
2. `node tests/ai-provider.test.js` and `node tests/copilot-bridge.test.js` after any
   change to `ai-provider.js` or `copilot-bridge.js`. Both fail silently in production if
   they are wrong — a dropped system message does not throw, it just answers without the
   SOTI rules — which is exactly why these two are the files that kept a suite.
3. `node tests/sidepanel-render.test.js` after any change to `md()` or to the answer
   sanitiser. Those are a stack of about twenty regexes rewriting the same string in
   sequence, so each one can break the next, and the damage is invisible in a diff and
   obvious on screen: a rule that swallowed the line break after "Troubleshooting done:"
   left the first bullet of every section rendering as a literal "-" mid-sentence. The
   harness lifts `md()` and the relay-artefact repairs out of the shipping file by name,
   so it tests the real source rather than a copy — if it reports that sidepanel.js "no
   longer contains" something, a function was renamed and the harness needs the new name.
4. `node tests/content-feedtab.test.js` after any change to the Salesforce scraper's tab
   handling. Reading a page is safe; CLICKING one is not, and the failure mode is silent in
   the worst way — the wrong tab is opened on somebody's live case and the sync imports
   whatever was behind it.
5. `node tests/panel-features.test.js` after any change to the split Sync button, the
   bookings links, the meeting-request draft or the usage counters (§5.8.2 to §5.8.4).
   Half of what those claim is a claim about layout and the DOM — that the two halves of
   the split button render level and welded, that swapping the label keeps the icon, that
   the settings rows read back what was typed — which needs a browser. The other half is
   the LEAK CHECK: it fills a case with a case number, an account, a customer address, a
   symptom and an answer, then walks every string in the usage report and asserts none of
   them carries any of it. If a field is ever added to that report which could hold free
   text, that is the check that fails.

6. `node tests/account-email.test.js` after any change to the account-team read or to the
   email composer write (§5.8.1). It drives real Chromium against fixtures shaped like a SOTI
   Account record and a Lightning case publisher, because every claim that feature makes is a
   claim about how Chrome behaves on somebody else's page — a hidden panel still being
   readable, an element inside `display:none` reporting a zero rect, an `srcdoc` iframe
   inheriting its parent's origin, `execCommand` landing in the iframe's own document. Writing
   into a customer's email composer is the one path in this codebase with no undo, so it is
   also the one worth a browser. It needs Playwright; with it missing the run SKIPS and says
   so rather than passing quietly.

7. Reload the extension and exercise the path you touched with a real case.

The two structural traps the removed suite used to guard still apply and now have nothing
watching them: no `_ML_RE` may contain `\w` (ASCII-only — it silently fails on Cyrillic, and
that exact mistake has already been made once), and every one must carry the `u` flag.

The suite is recoverable from git history if it is ever wanted back:
`git checkout 68e9f63 -- Extension/tests` restores it with all 254 checks.
---
5.12 The browser bridge — and why a chat box's limit is not the model's limit
`ai-provider.js` makes the model a setting. The `bridge` provider is the one with no API key
at all: Microsoft 365 Copilot has no completions endpoint, so instead of POSTing a prompt,
the extension injects `copilot-bridge.js` into a Copilot tab the engineer is **already signed
in to**, types the prompt into the composer, watches the answer render, and streams the text
back. The existing SSO session does the authenticating, so there is no key to configure and
none to leak.

**The constraint that shaped everything.** A web composer has a length limit, and it TRUNCATES
silently rather than erroring. Reporting that limit to the panel's prompt budgeter as if it
were a context window is what starved the bridge: at the 12,000 characters this shipped with,
the budgeter derived 4,800 tokens, and after reserving room for the answer a log analysis was
left with roughly **5,400 characters for the entire case** — less than the rules block, never
mind the evidence. Case summaries and JIRA fills, which
build ~40,000-character prompts, arrived with most of the case removed. The answers looked
fine, which is the worst property a failure can have.

**The fix is that the limit is per MESSAGE, and a conversation has no such limit.** Remembering
what came before is the entire point of a chat UI. So a case too big to type at once is split
into PARTS that each fit the box and sent as consecutive messages; every part but the last
says "this is reference material, do not answer yet", and only the final one carries the rules
and the question. At the defaults — 90,000 characters a message, 8 parts — that is a budget
far past anything a case needs, with no site's limit raised.

**"Max size of one message" defaults to 90,000, not to a measured limit,** and that is a
deliberate change from the original 12,000. The old figure was where a chat turn was KNOWN to
fit. M365 Copilot's composer is a contenteditable with no `maxlength`, and it has not in
practice refused what the relay types, so the conservative figure was costing eight round
trips for a case that fits in one. Nothing is lost if a site does cap its box: the relay reads
the box back after typing, reports what it actually held, re-splits to that size, retries once
and stores the measurement — and a stored measurement outranks this setting from then on
(`composerCap`). The number to bring down if a long case ever comes back answered as though
its opening had gone missing is **Context parts**, not this one: the product is what has to
fit the conversation's own window, and that window is the limit nothing can see.

Three things make that safe rather than merely bigger, and each exists because of a failure
that is invisible from the outside:

- **Every part must be echoed back before the next is typed.** A part the page silently
  dropped would leave a hole in the middle of the case that nothing downstream could detect.
  Each part carries a per-run stamp (`⟦SOTI a3f9 3/8⟧`) because the first 40 characters are
  identical across parts — matching on those, part 3 would find part 1's bubble and a lost
  message would read as a delivered one.
- **The page must go idle between parts.** Typing into a composer that is still streaming
  loses the text, without an error.
- **The split never cuts mid-line.** Half a log line is not weaker evidence, it is FALSE
  evidence: a timestamp severed from its message, or a citation whose line number lost its
  last digit, reads to the model as a fact.

**When even that is not enough** the material is condensed — sent back through the same relay
in a scratch conversation, asked to come back shorter, and the result analysed instead. This
costs a round trip per chunk and it is the one place the tool lets a model rewrite evidence,
so every line reference that comes back is checked against the material it was made from and
the ones that cannot be found are NAMED in place (`flagUnsupportedCitations`). A model asked
to shorten a log block will produce a plausible `setup.log:Line 103679` for a line that is not
there, and downstream nothing can tell the difference. Beyond the condenser's reach the tail
is trimmed and the cut declared, as everywhere else in this application.

**The box also measures itself.** When a site accepts fewer characters than were typed, the
relay reports what it actually held; the adapter re-splits to that size, retries once, and
remembers the measurement (`learnedCap`) so the next request starts from evidence rather than
from the setting. And because a site caps its OUTPUT as well as its input, an answer that ends
mid-sentence is reported as `done_reason: "length"`, which routes it into the continuation
path the panel already had.

**Reading the answer is not the same as receiving one.** Every other provider hands over a
stream of tokens. The bridge has to READ its answer out of a page that is still writing it,
and a half-rendered reply is not marked up the way the finished one is. Two artefacts come
from that, and both were visible in the same case summary:

- **A paragraph one word per line.** Copilot streams a paragraph by appending each arriving
  word to it as its own node, so mid-answer the paragraph really is a run of one-word nodes.
  Serialised as blocks, each became its own line — and the panel renders every newline
  faithfully, so the summary came out as a column of single words. `domToMarkdown` now builds
  a line from a run of INLINE nodes and only ends it at a block, which is what the browser
  itself does with them; `tighten` will no longer descend into inline markup either, because
  early in an answer the "biggest child" of a short paragraph is one word, and that word was
  being returned as the whole reply.
- **The answer twice.** Nothing already streamed can be un-said, so when the finished page
  turns out to be laid out differently from the half-rendered one, the relay can only APPEND.
  Comparing the two raw texts, a re-laid-out answer shares only a few leading characters with
  what was streamed — so the whole summary was appended a second time, the interrupted copy
  first. `reconcileTail` compares them with the SHAPE taken out (no whitespace, no emphasis,
  no list markers, which are drawn by CSS until the answer completes) and sends only the words
  that are genuinely new. A real divergence still falls back to appending from the common
  prefix: repeating a little text is cheaper than losing the end of an answer.

Both are also repaired in the panel (`repairRelayArtifacts` in `sidepanel.js`), because a
summary an earlier build already saved into a case still carries them, and because the next
chat UI this relay is pointed at will have a shape nobody has met yet. Both passes are hard
to trigger on purpose: a column of words is only rejoined when it is long AND contains words
that only occur inside sentences, and a repeated opening is only dropped when the first copy
is strictly the shorter one.

**What it still cannot promise.** The conversation's own window is finite and invisible: parts
are bounded (12 maximum) so the total stays well inside it, but if a site compacts an early
turn there is no way to see that from the DOM. Driving a chat UI programmatically is also a
different thing, contractually, from calling a documented API, and these prompts carry
customer data — check your organisation's acceptable-use terms. `SECURITY.md` documents this
tool's data-protection position, and it was rewritten for this build: the case now goes to
Microsoft 365 Copilot. The mitigating fact is that Copilot is already licensed and approved
in this organisation, so the bridge connects to a service that is already sanctioned rather
than opening a new one — it automates what an engineer may already do by hand. Read
`SECURITY.md` §4.2 before changing anything on the prompt path.
---
6. Key design decisions & trade-offs (the "why X not Y" summary)
Decision	Chosen	Rejected alternative	Why
AI backend	M365 Copilot via the browser bridge	A hosted API key (OpenAI/Claude/Azure), or a local model	A key would have to live in `chrome.storage.local`, readable by anyone who can unpack the extension, and would engage a new processor. Copilot is already licensed and approved here, and the engineer is already signed in — so the bridge needs no key at all. A local model was the previous answer and kept data on the device, but needed a 7 GB download, 3-4 GB resident, and was slow on a support laptop.
Prompt size	Up to 8 chat messages of 90,000 chars	One message, or an unbounded upload	A composer caps a MESSAGE; a conversation caps nothing. Splitting is what lets a big case arrive whole. §5.12.
`num_ctx`	Fixed per session	Grow-to-fit per request	Avoids costly model reloads between turns
Context size (small)	Auto: num_ctx ≤32,768, prompt budget 16,384 tokens	The full 131,072, or a fixed 8,192	Prefill cost is the PROMPT, not the window; 8K is ~2× faster but drops the case history
Logs → AI	Uploaded as a file where the site accepts one; otherwise a pre-analysed brief + key lines	Always pasting the raw dump	An upload has no composer limit, so a megabyte of log arrives intact. Where it is not available the brief is what fits.
Logs → AI (uploaded)	The log files themselves, verbatim	The same pre-analysed brief	The brief's sizes describe a composer, not an upload — a 2.7 MB log was arriving as 15,000 characters and the exception that explained the case never arrived at all
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
  // (j) Stream the answer and render tokens as they arrive.
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
8. Performance (why it is the speed it is)
> **Rewritten for the bridge.** This section used to be about CPU inference speed on the
> engineer's own laptop, which is no longer where the answer comes from. The model runs in
> Microsoft's datacentre now, so generation is fast; what costs time instead is the relay.

Each request is a round trip through a real web page: open or reuse the window, type the
prompt, wait for the site to answer, watch until the text stops changing. A big case is sent
as several messages and **each part is its own round trip** — roughly 10-15 seconds apiece —
so the first token on an eight-part case arrives well after the first token on a one-part
one. That is the trade the multi-part design makes: the model sees the whole case instead of
its first page.

Historical note, for anyone reading old benchmarks in this repo: on the previous local
backend (2-core laptop, no GPU) the model generated ~6 tokens/sec and read the prompt at
~22 tokens/sec, and that arithmetic was the whole story:
A big prompt takes minutes just to read before answering → feels frozen.
Most of the machinery that exists to fight that is still here and still earns its place —
compact prompts, manifest-only answers for conversational questions, sending the log as an
attachment rather than as pasted text — because a chat composer rewards exactly the same
economy that a slow CPU did. What is gone is the on-device tuning: no model to warm, no
engine flags to set, and no hardware to buy.
What is left to tune is the size of what you send: keep Context Size on Auto unless an
answer is wanted quickly, and attach large logs rather than pasting them.
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
spawns Tesseract WASM workers for OCR, and streams an answer back. On a developer machine
that is fine. On a support engineer's laptop — already running Chrome itself, Salesforce and
Teams, and at the time **a local model holding 3-4 GB resident** — the same work pushed the
machine into swap, and "the app froze" was the result. The local model is gone, which removes
the largest single pressure the governor was written against; everything else it does still
applies, because the log bundles did not get smaller.
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
The `0.17` share is deliberately conservative. We are **one tenant** on this machine, not the
only one: the engineer already has Chrome, Salesforce and Teams open, and this tool adds a
relay window running Copilot's page on top. It used to have to leave room for a local model
holding 3-4 GB as well, which the browser could not see at all — that is no longer true, but
the conservative share is kept, because the machine is still shared (see 9.10).
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
**Time to first token** (wall clock — the part you actually sit through) and, where the
provider reports them in its terminal stream frame, the authoritative `prompt_eval_count` /
`eval_count` and prefill and generation durations. The local backend supplied real counts;
the bridge is reading a rendered web page and cannot, so those fields are absent and the wall
clock is what you have. Time to first token is the honest number for the bridge anyway: it
includes opening the window and typing the prompt, which is most of the wait.
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
**The budget governs *this browser tab*, and nothing else.** Earlier builds had a far larger
blind spot here: a local model held 3-4 GB in a separate process the browser could not see and
this app could not reclaim, and on a 16 GB laptop it was the bigger tenant by a wide margin.
**That is gone** — there is no local inference in this build, so the governor's number is now
close to the whole of what this tool costs the machine.

What it still does not count: WASM memory (Tesseract), image bitmaps, and the relay window,
which is an ordinary browser window running Copilot's page and costs whatever that page costs.
**Readings are the JavaScript heap only.** Detached DOM nodes, Tesseract's WASM linear
memory and image bitmaps live outside it, so the real tab footprint is somewhat higher.
That is part of why the budget only claims 75% of the heap ceiling — the difference is
headroom, not an oversight.
**Firefox and Safari expose no `performance.memory`,** so there the governor senses
responsiveness only and uses the conservative `minimal` profile. It degrades rather than
disabling itself.
9.11 Verifying and tuning it
```bash
node --check power.js         # syntax only — the suites were removed with tests/
```
The suites that used to pin this down are gone with `tests/`. Verify by hand instead: open the
Power Monitor (the pill in the top bar) on a realistic session — several cases, a dozen files,
tens of MB of log text — and read the result off the panel:
```
Idle heap after boot:   119.2 MB  ->  8.5 MB     (92.9% lower)
Forced reclaim:         123.6 MB  ->  12.4 MB
After a full workout:   12.4 MB of a 975 MB budget
```
To tune: the constants live in one block at the top of `power.js` (`RAM_FRACTION`,
`CORE_FACTOR_STEPS`, `HEAP_LIMIT_SHARE`, the tier and threshold tables). They are re-exported
for the tests, so changing one produces a **visible failing test naming the machine class you
changed** rather than silent drift. Re-check the Power Monitor readings by hand after any edit — the unit suite was removed with `tests/`.
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
it; it does NOT include WASM memory (Tesseract), image bitmaps, or other browser windows —
which now includes the relay window running Copilot.
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
values in `AIEngine.completions.create` (answer length).
Change what counts as "analyse" vs a question → `wantsLogAnalysis()`.
Change how much memory the app allows itself → the constants block at the top of `power.js`
(`RAM_FRACTION`, `CORE_FACTOR_STEPS`, `HEAP_LIMIT_SHARE`, the tier and threshold tables).
They were re-exported for the removed suite, so re-check them by hand afterwards — a change
that moves any machine class shows up as a named failing test rather than silent drift.
Change what gets sacrificed under pressure → the `Power.registerReclaimer({...})` blocks
near the bottom of `sidepanel.js`. Lower `priority` = given up first. Never register
anything whose loss would destroy the user's work.
Add a language, or a phrase in one already covered → the `_ML_RE` cue tables in
`sidepanel.js` (section 5.10), then verify by hand (section 5.11). Use `\p{L}`, never `\w`, and never a
leading `\b` before non-Latin text — both are ASCII-only and fail silently.
Golden rule: after any edit to `sidepanel.js`, run `node --check sidepanel.js` before reloading,
then actually LOAD the panel. The syntax check catches typos that would otherwise break the
whole panel, but it cannot catch a regex assembled at runtime (`new RegExp(...)`): that parses
fine and throws on load, so an unbalanced bracket in one multilingual cue takes the whole side
panel down and only loading the file finds it. With `tests/` removed there is nothing else
standing between such an edit and a dead panel.
Reload the extension at `chrome://extensions` → Reload, then open the side panel and press
F12 (choose the side-panel document) to see the console — the `[AI Request]` line
shows the exact context / sizes for each call.
---
12. Known limitations (be honest with users)
Speed is hardware-bound. A full multi-log analysis on a 2-core, no-GPU laptop takes
tens of seconds to a couple of minutes. That's physics, not a bug.
Small models can still be wrong. The pipeline maximises accuracy, but gemma4:2b is
not infallible — the 👍/👎 loop exists precisely to catch and remember corrections.
Salesforce scraping is HTML-dependent. If Salesforce changes its markup, `content.js`
selectors may need updating.
The usage dashboard address ships EMPTY, and the section is admin-only. It used to come
pre-filled with one particular board's address, so every fresh install pointed at somebody
else's dashboard by default — sharing is a decision, and a default that makes it for you is
the wrong default however harmless the destination. Nothing is shared until an address is
typed in; every counter, the printed report and "Copy report" work exactly as before without
one, and `sendUsageToDashboard` refuses rather than guessing. Usage & Feedback is not in AI
Settings at all now unless `soti_usage_admin` is set locally — a UI decision rather than an
access control, and one that changes nothing about the counting. Section 5.8.4.
Usage counters are per install, not per person. They live in this browser profile's
storage, so an engineer on two machines is two rows on the dashboard, and a shared
machine is one row for everybody on it. The name is the only thing tying rows to a human
and it can be cleared. Section 5.8.4.
The Cc step waits for the composer rather than asking it once. "The email composer opened
but no Cc field could be found or revealed" was almost never true about the page: the
readiness wait in `writeEmailDraft` is satisfied by the FIRST of a body editor, a stub
button or a recipient box, and Salesforce's TinyMCE iframe is routinely up before the Aura
recipient row is — so the Cc step ran against a composer that had no recipients on it yet,
got a truthful "no" from every branch, and gave up in the same tick. `openCcRecipientInput`
now waits for the row, nudges it (some layouts only grow their Cc/Bcc links once the
recipient area is focused), retries a toggle that did nothing, and re-clicks only a toggle
that provably did nothing — a second click on one that worked would collapse the row again,
which is the one mistake in there that would look exactly like success. When it does give
up, the message names what was actually on the page. Section 5.8.1.
The Cc list on an Account Email is only as good as the Account record. The tool reads the
seven person fields and copies in whoever is in them — it has no way to know that an aligned
engineer moved off the account three months ago and nobody cleared the field. The review box
puts every name in front of the engineer with an × on it for exactly that reason, and a name
Salesforce's own recipient lookup cannot resolve is reported rather than guessed at. Section
5.8.1.
"Self-learning" is memory, not retraining. The base model never changes; confirmed
insights are re-injected as context.
Online research needs connectivity. The "Failed to fetch" message just means the live
SOTI Pulse lookup couldn't reach the network; analysis still runs from logs + offline KB.
The Power Monitor covers this browser tab only. With no local model in this build there is no
longer a multi-gigabyte process outside it, but the relay window still costs whatever the
Copilot page costs. If the whole machine is short of memory, the
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
