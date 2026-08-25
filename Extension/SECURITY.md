# SOTI AI Analyser — Security & Data-Protection Assessment

> **This document was rewritten for build 3.0.0 and reviewed for 3.1.0.** Every version before it assessed a
> local-only tool: AI inference ran on the analyst's own machine and no case content left
> the device. **That is no longer what ships.** The tool now sends case content to
> Microsoft 365 Copilot. If you are holding an older copy of this assessment, its
> conclusions do not apply to the current build.

## 1. Executive summary

The application analyses Salesforce case content and customer diagnostic logs. **Case
content leaves the analyst's device**: it is relayed to **Microsoft 365 Copilot** and the
answer is read back.

How it gets there is the unusual part, and it matters to the assessment:

- **There is no API key, no endpoint, and no service account.** The extension holds no
  credential for Microsoft and makes **no network request to Microsoft at all** — the
  Content-Security-Policy `connect-src` does not include any Microsoft host, so it
  physically cannot.
- Instead, the extension **automates a Copilot tab in the analyst's own browser**, typing
  the prompt into the composer and reading the reply out of the page. The data travels as
  chat messages **inside the analyst's existing, signed-in Microsoft 365 session** — the
  same channel, and the same tenant, as if they had pasted the case into Copilot by hand.
- Consequently **the recipient is the organisation's own Microsoft 365 tenant**, governed by
  the M365 agreement and Copilot data-handling commitments already in place, rather than a
  new third-party processor procured by this tool.
- **Microsoft 365 Copilot is already an approved, licensed, in-use enterprise service here.**
  This tool does not introduce it, procure it, or route around it — it connects to the
  deployment the organisation has already sanctioned, through the engineer's own licensed
  session. In practical terms the tool automates something an engineer is already permitted
  to do by hand: put case material into Copilot and read the answer.
- Access to that origin is an **optional** Chrome permission, granted by an explicit click
  and revocable in browser settings.

Unchanged from earlier assessments:

- **No telemetry, analytics or tracking** of any kind.
- **No third-party CDNs, fonts or scripts.** Tesseract OCR runs on-device and is vendored.
- Case data at rest stays in `chrome.storage.local` on the device, with 30/90-day purges.

**Open risks material to a rollout decision:**

1. **[MEDIUM] Customer personal data is disclosed to Microsoft 365 Copilot** (§9.1). This is
   the defining change in this build, and it is *not* accompanied by redaction: case
   narratives, email chains and log text are sent as written. (`.har` network captures are the
   one exception — they are redacted for tokens, cookies and auth headers before any send.)
   Substantially mitigated by the destination being an **already-approved enterprise service
   in the organisation's own tenant**. What remains is narrower than "is Copilot allowed": it
   is whether that existing approval was scoped to include **customer** case content and
   diagnostic logs, and whether customer contracts and sub-processor disclosures reflect it.
   A question to confirm, not to start from scratch.
2. **[MEDIUM] Automating a Microsoft web UI.** Acceptable-use question for the business, and
   the relay breaks whenever Microsoft changes that UI (§9.2).
3. **[MEDIUM] Local data is not encrypted at rest** (§9.3) — open by prior customer
   decision, with mandated OS disk encryption as the compensating control.
4. **[MEDIUM] Case-derived keywords are sent to `pulse.soti.net`** (§9.4, detail in §4.1) —
   first-party recipient, but outside this application's retention controls. **Not closed.**

**Assessment.** The engineering controls are sound, and the egress path is narrower than a
hosted-API integration would be: no key to leak, no new processor, no direct connection, and
a destination the organisation has already licensed and approved. The tool is best understood
as **automating an action engineers are already permitted to perform manually** — putting case
material into enterprise Copilot — rather than as opening a new channel out of the business.

On that basis the application is assessed as **suitable for a controlled, policy-managed
rollout**, subject to §10: confirming the scope of the existing Copilot approval covers
customer case content, the standing items carried over from earlier assessments, and the
security team's own review and pen-test of the bridge path.

---

## 2. Architecture & trust model

- Chrome **Manifest V3** side-panel extension.
  - `sidepanel.js` — all application logic (UI, prompt building, research, storage).
  - `ai-provider.js` — the provider layer. Translates the panel's requests into whatever the
    active provider speaks and translates the reply back, so nothing above it knows which
    provider answered. **The shipped build offers one provider: the Copilot bridge.**
  - `copilot-bridge.js` — the bridge itself. Runs **inside the Copilot page** via
    `chrome.scripting`: finds the composer, types the prompt, watches for the answer to stop
    changing, and returns the text. Makes no network requests of its own.
  - `background.js` — minimal service worker; only opens the side panel. **Holds no network
    permissions and makes no requests.**
  - `content.js` — content script injected on Salesforce and JIRA pages; **reads the case DOM
    only** and returns it to the side panel via internal messaging. Makes no network requests.
- **AI inference** happens in **Microsoft 365 Copilot** (`m365.cloud.microsoft`), reached by
  automating a browser tab that is already authenticated as the analyst.

**Trust boundary.** The extension trusts the local machine, first-party SOTI/Salesforce web
properties, and — as of this build — **the analyst's own Microsoft 365 tenant**, to which it
discloses case content.

**What this architecture does NOT do, and why it matters:**

| | |
|---|---|
| Hold a credential for the AI service | No. There is no API key, token or service account anywhere in the extension or its storage — so there is none to leak, rotate or misuse. |
| Connect to Microsoft from the extension | No. `connect-src` in the CSP lists no Microsoft host. Egress happens in the Copilot **page**, as ordinary session traffic. |
| Send data to a processor the org has not already engaged | No. The destination is the tenant the analyst is signed in to. |
| Work without the analyst's knowledge | No. The relay drives a real window; the host permission is optional and must be granted by a click. |

The corollary is the risk: because the tool rides the analyst's own session, **it inherits
whatever that session is allowed to do**, and the disclosure is as real as if they had
pasted the case in themselves. See §9.1.

### 2.1 The relay window

Each request opens (or reuses) **one minimized browser window** holding the Copilot chat,
off the tab strip and unfocused. It is reused across turns and never touches a Copilot tab
the analyst opened themselves. Relayed chats are titled with the case number so the Copilot
history is navigable rather than anonymous; deletion of those chats is **off by default**
and, when enabled, only ever removes conversations this tool created, identified by that
title.

The same mechanism fetches a single case Description for the Open Cases queue — a
deliberately narrow message (`GET_SALESFORCE_CASE_BRIEF`) that reads two fields from a
Salesforce record and touches nothing else.

---

## 3. Personal data processed (GDPR-relevant)

| Data | Source | Where it lives |
|---|---|---|
| Customer names, emails, phone numbers, company identifiers | Scraped Salesforce case | `chrome.storage.local` (device) |
| Case narratives / email chains | Scraped Salesforce case | `chrome.storage.local` |
| Diagnostic log files (may contain device IDs, IPs, usernames) | Analyst upload | `chrome.storage.local` |
| Chat history with the AI | Local | `chrome.storage.local` **and the analyst's Copilot chat history** |
| OCR text extracted from screenshots | Local (Tesseract) | `chrome.storage.local` |
| Derived "learned insights" | Local | `chrome.storage.local` |

- Data is **not redacted** before it is sent. This used to be defensible on the grounds that
  processing never left the device; **that defence is gone.** Case narratives, email chains,
  customer names and log text now reach Microsoft 365 Copilot as written. The former
  misleadingly-named no-op `scrubPII()` wrapper was removed so the code no longer implies a
  redaction it never performed — the honest position is that **there is no PII redaction on
  the prompt path**, and if the organisation requires one before customer data may go to
  Copilot, it has to be built. See §9.1.
- **Network captures (`.har`) are the exception, and always are.** A capture records whole
  requests, so it carries the `Authorization` headers, cookies and — on an SSO capture — the
  `id_token`s and authorization codes of the session it recorded. Every path that can put a
  capture in front of a model runs it through `redactHarSecrets()` first, and the eight
  line-by-line log scanners refuse to read one at all (`withoutNetworkCaptures()`): a scanner
  quoting "the highest-scoring line" out of a one-line JSON capture is quoting a bearer token.
  **This is now the single most important control in the document**: with the prompt leaving
  the device, an unredacted capture would put live session tokens into a Copilot chat.
  Verified by planting a bearer token, a session cookie and an OAuth code in a capture and
  running the shipping panel over the bundle.

---

## 4. Network egress (verified by full-codebase audit)

Every `fetch` / `XMLHttpRequest` / `WebSocket` / beacon path was traced. Destinations the
**extension itself** connects to are **exclusively**:

- `https://pulse.soti.net` — release notes, help pages and community search (first-party SOTI). **Case-derived text reaches this host — see §4.1.**
- `salesforce.com` / `force.com` — content script **reads the DOM only** (no outbound fetch of case data).
- Local bundled files (`lib/`, `knowledge/`).

> **The largest disclosure in this application is not on that list, because it is not a
> `fetch`.** Case content reaches Microsoft 365 Copilot by being **typed into a page**, and
> the page's own session carries it. Auditing this application's network calls will therefore
> never show it. See §4.2 — it is the flow that matters most.

**Confirmed absent:** telemetry/analytics (Google Analytics, Sentry, Segment, etc.), third-party CDNs, CORS proxies, external fonts/scripts/CSS, cookies, clipboard/geolocation access, `externally_connectable`.

**Verified live:** with every external fetch failing, the app still functions from local data; and an injected external image beacon to a *resolvable* host is **blocked by CSP** (`securitypolicyviolation`, directive `img-src`, disposition `enforce`).

### 4.1 Case-derived text sent to `pulse.soti.net` — CORRECTION

> **A previous version of this section stated that "only product/version terms" travel to `pulse.soti.net` and that "no personal data" does. That was incorrect.** The flow below was identified in a later source review and is recorded here in full. §11.2 and §11.4 have been corrected to match.

When the assistant researches a case it searches the SOTI Pulse community forum:

```js
// sidepanel.js:10251
sotiFetch(`${PULSE_ORIGIN}/community/search?query=${encodeURIComponent(kq)}`, 6000)
```

`kq` is **up to six keywords taken from the case itself**, not a fixed product vocabulary:

- Quick actions build the research query in `buildCaseResearchQuery()` (`sidepanel.js:7002`) from `buildCaseSymptomText(600)` (`:6972`), which concatenates the **scraped Salesforce issue summary** with the **bodies of up to four emails from the case chain** (300 chars each).
- A short or deictic chat message ("fix it", "what next?") is enriched at `:9789` with the case's issue summary before keywords are extracted.
- That text is tokenised at `:10162` — `split(/\W+/)`, keep tokens longer than 3 characters, minus a stopword list — and the **first six surviving tokens** are sent (`:10233`).

**The stopword list removes Salesforce field *labels* (`firstname`, `lastname`, `phone`, `customer`, `company`) but not the *values* behind them.** Any token over three characters passes, so customer surnames, company names, site and host identifiers, usernames and device model strings can all be transmitted.

**Frequency — this is the default path, not an edge case.** `buildCaseResearchQuery()` prefixes every quick-action query with the literal string `"troubleshoot issue: "`, which by itself satisfies the `isTroubleshoot` test at `:9806`, so the community search fires on essentially **every quick action against an open case**.

**Assessment**

- The recipient is **first-party SOTI infrastructure**. No data reaches an external organisation, and there is no third-party processor involved.
- The data travels in a **URL query string** — the worst available carrier. Query strings are written in cleartext to web-server access logs and to any CDN, WAF or forward proxy in the path, and are retained under *those* systems' policies, **outside** this application's 30/90-day retention controls.
- Volume is bounded (≤ 6 tokens per search); the *kind* of content is not.

**Status: OPEN.** Remediation options: restrict the query to a product/symptom allowlist, or remove the community-search feature. Until it is closed, the Pulse access-log retention period should be obtained from that service's owner and recorded in §11.4.

---

### 4.2 Case content sent to Microsoft 365 Copilot — the primary disclosure

**What is sent.** Whatever the panel has built the prompt from, which for a case analysis is
the case record (number, account, contact, status, versions, platform), the **email chain**,
**internal notes and their replies**, the analyst's meeting notes, the relevant excerpts from
the offline SOTI knowledge base, and — for a log analysis — **the log text itself**. Large
cases are split across several chat messages, or uploaded as a `.txt` attachment when the
site accepts one. **None of it is redacted** (except `.har` captures, §3).

**How it is sent.** Not by an HTTP call from the extension. `chrome.scripting` executes the
bridge inside the Copilot page, which:

1. finds the message composer,
2. sets its value to the prompt and dispatches the events the site expects,
3. clicks send,
4. watches the answer element until it stops changing, and
5. returns the rendered text through the extension's internal messaging.

The network request that carries the case to Microsoft is **issued by Copilot's own page
code, on the analyst's own authenticated session**. The extension never sees it.

**Who receives it.** The Microsoft 365 tenant the analyst is signed in to, under the Copilot
data-handling terms that tenant already operates under. This is materially different from a
hosted-API integration, where the vendor would be a *new* processor engaged by this tool:
here the processor relationship, the licensing and the organisational approval **already
exist**, and the tool is connecting to them rather than creating them.

**The honest limit of that argument.** "Copilot is approved for the organisation" and "customer
case content may be put into Copilot" are two statements, and only the first is established
here. The tool does not widen the destination, but it does industrialise the volume: what was
an engineer occasionally pasting a case becomes every case, every log, every queue expansion.
Confirming the existing approval was scoped with that in mind is §9.1 — a scope check against
an approval that exists, not an approval to be sought.

**Evidence trail.** Each relayed chat is titled with the case number it came from, so what
was sent is auditable from Copilot's own history. Deletion of those chats is off by default
precisely so that trail survives.

---

## 5. Permissions (`manifest.json`)

| Permission | Purpose | Assessment |
|---|---|---|
| `storage`, `unlimitedStorage` | Local session storage | Justified |
| `sidePanel` | UI surface | Justified |
| `activeTab`, `tabs`, `scripting` | Salesforce scraping | Broad but justified; note for review |
| `downloads` | Session export to file | Justified |
| `host_permissions` | `*.soti.net`, `*.salesforce.com`, `*.force.com`, `localhost`/`127.0.0.1` **only** | **Strong** — no `<all_urls>`, no wildcard; physically prevents reaching any non-approved host |
| `optional_host_permissions` | `m365.cloud.microsoft`, `copilot.microsoft.com` (plus unused entries for providers this build does not offer) | **Not granted at install.** Chrome only issues them from an explicit user gesture — the "Grant access" button in Settings — and the analyst can revoke them in browser settings. Without the grant the bridge cannot read the answer and the tool simply does not work. |

- The two Microsoft origins are granted **together**, because signing in to
  `copilot.microsoft.com` with a work account redirects to `m365.cloud.microsoft`; granting
  only the configured one leaves the request failing on a host the analyst never chose.
- **Note for review:** `optional_host_permissions` still lists Anthropic, OpenAI, Azure OpenAI,
  OpenRouter, `claude.ai` and `chatgpt.com`. **This build offers none of them** — the provider
  picker is gone and the bridge is the only provider. They are unreachable without a user
  gesture that the UI never triggers, but they are surplus surface and should be pruned from
  the manifest (and from `connect-src`) before rollout. Tracked at §10.8.

- The previously-unused **`declarativeNetRequest` permission has been removed** (and its dead service-worker code), reducing attack surface.
- **CSP** (`content_security_policy.extension_pages`, mirrored in a `<meta>` for standalone mode):
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:* https://*.soti.net https://*.salesforce.com https://*.force.com; object-src 'self'; worker-src 'self'; frame-src 'none'; base-uri 'self'; form-action 'none'`.

---

## 6. Storage, retention & data-subject rights

- **Store:** `chrome.storage.local` — sandboxed, per-extension, **survives Chrome "Clear browsing data"** (history/cache/cookies); only lost on extension uninstall or explicit clear. `localStorage` is used **only** in the standalone fallback page. **Plaintext at rest — see §9.1.**
- **Retention (storage limitation):**
  - Cases auto-purge after **30 days** of inactivity.
  - Learned insights auto-purge after **90 days**.
  - Both verified to **delete from storage**, not merely hide.
- **Erasure (right to be forgotten):** a **"Clear all cases & logs"** control plus per-case deletion.
- **Data minimisation:** raw log dumps are stripped from persisted chat history.

---

## 7. Content-injection / XSS posture

- `md()` renders AI output and case-derived text to `innerHTML`. It now **HTML-escapes its input before markdown rendering**, so injected `<img src="http…">` beacons, `<script>`, `<iframe>`, and inline event handlers cannot render (verified: injected external `<img>`/`<script>` produce zero DOM elements). The app's own `data:` screenshot previews are preserved.
- This is **defence-in-depth**: the hardened CSP independently blocks script execution and external resource loads. Injection protection is therefore **input-sanitisation + CSP**, not CSP-only.

---

## 8. Third-party components / supply chain

- **Tesseract.js v5.1.0** (Apache-2.0) — OCR engine; **fully vendored locally** in `lib/`, with **all CDN default URLs removed** (verified: OCR loads engine + WASM + language data from local files only, zero external requests). Auditable but **not hash-pinned**.
- **Microsoft 365 Copilot** — not a bundled component but a **runtime dependency on a web UI
  the vendor changes without notice**. The bridge locates the composer, the send control and
  the answer container by CSS selector. When Microsoft changes that markup the relay stops
  working; the failure is loud (the test button reports which stage failed) rather than
  silent, and the selectors are **settings, not constants**, so the fix is a settings edit
  rather than a release. This is a supportability risk, not a confidentiality one — see §9.2.
- **No npm runtime dependency tree** in the shipped extension (no bundler / `node_modules`).
- **No local model or inference server** is installed by this build. Earlier versions
  required Ollama; that dependency and its installer are no longer part of the product, which
  removes a locally-listening HTTP service and its CORS configuration from the attack surface
  entirely (the findings that dealt with it are retained as history at §14.1 and §15.1–15.2).

---

## 9. Residual risks (critical view)

1. **[MEDIUM] Customer personal data is disclosed to Microsoft 365 Copilot.** Case narratives,
   email chains, customer names and contact details, and diagnostic log text are sent
   **unredacted** (§4.2). *Mitigating factors:* the destination is **Microsoft 365 Copilot
   Enterprise, already licensed and approved for use in this organisation** — not a new
   processor engaged by this tool; the data stays within the organisation's own tenant and its
   existing Copilot data-handling commitments; there is no API key to leak; the host permission
   is optional and revocable; and the disclosure is auditable from Copilot's own chat history,
   which the tool titles by case number and does not delete by default. *Residual, and the
   reason this is not closed:* the approval establishes the **destination**, not necessarily
   the **content class and volume** — this tool sends customer case material systematically
   rather than occasionally. *To confirm before rollout:* that the existing Copilot approval
   was scoped to include customer support content and diagnostic logs, and that customer
   contracts and sub-processor disclosures are consistent with it. If any of that turns out to
   be narrower than assumed, the mitigation is a PII redaction pass on the prompt path, which
   **does not currently exist** and would have to be built. **Open — scope confirmation.**
2. **[MEDIUM] Automation of a third-party web UI.** The tool drives Microsoft's interface
   rather than an API. Two consequences: automated use may not be permitted by the
   organisation's acceptable-use terms **(a question for the business, not for this
   document)**, and the relay breaks when Microsoft changes the page. The second is
   self-announcing and fixable from Settings without a release; the first is not a technical
   control at all. **Open — organisational.**
3. **[MEDIUM] No encryption at rest.** Case PII sits in `chrome.storage.local` in plaintext, protected only by OS/profile security. **Open by customer decision.** *Compensating controls:* sandboxed per-extension storage, 30/90-day retention, and mandated OS disk encryption (§10.1). A passphrase-based AES-GCM option is designed but not built.
4. **[MEDIUM] Case-derived text leaves the device to a first-party host.** Up to six keywords taken from the case issue summary and customer email bodies are sent to `pulse.soti.net` in a URL query string, on essentially every quick action against an open case (§4.1). The recipient is SOTI-internal — no third party — but the data lands in web-server/CDN access logs governed by that service's retention policy, outside this application's controls. **Open**; remediation options in §4.1.
5. **[MEDIUM] Prompt injection now has an exfiltration path.** Attacker-influenced case and
   email content flows into a model **that is not local any more**. It can still skew the
   analysis, and it can additionally attempt to induce the model to act on instructions
   planted in a customer's email. The panel's own guards check citations and next steps
   deterministically rather than trusting the answer, but analysts must treat AI output as
   **advisory**, and content arriving from a customer as **untrusted input**. Upgraded from
   LOW: the "no data-exfiltration risk (local model)" justification no longer holds.
6. **[LOW] No app-level authentication.** Anyone with the unlocked browser profile can open the panel and read cases. Ties to (3).
7. **[LOW] The relay inherits the analyst's session.** It can do anything in Copilot that the
   signed-in analyst can. It is scoped to typing in a composer and reading a reply, and it
   never touches a Copilot tab the analyst opened themselves, but there is no technical
   boundary enforcing that beyond the code itself.
8. **[LOW] Standalone mode** uses `localStorage` (wiped by site-data clears) and relies only on the meta-CSP (no `host_permission` enforcement). It also **cannot reach the bridge** — no `chrome.scripting` — so it has no AI at all. Deploy the **extension** only.
9. **[LOW] Learned insights** may retain incidental PII fragments (now 90-day bounded).
10. **[INFO] Vendored libraries are not integrity-pinned.**
11. **[INFO] Unused provider origins remain in the manifest** (§5) — surplus surface to prune.

---

## 10. Recommendations before global rollout

**Confirm before rollout** (these are checks against decisions the organisation has already
taken, not new approvals to obtain):

1. **Confirm the scope of the existing Copilot approval** (§9.1). Microsoft 365 Copilot is
   already licensed and approved here, so the destination is settled. What to verify is that
   the approval contemplated **customer support content and diagnostic logs**, sent
   systematically rather than ad hoc, and that customer contracts and sub-processor
   disclosures are consistent with that. Update the record of processing (§11.2) to name
   Copilot as a recipient either way. If the scope turns out to be narrower, the remedy is a
   redaction pass on the prompt path — it does not exist today and would need commissioning.
2. **Get the business to confirm that automating the Copilot UI** is acceptable under the
   organisation's acceptable-use terms (§9.2). The tool performs an action engineers are
   already permitted to perform by hand; what is new is that a script does it.
3. **Tell analysts what the tool does with a case**, plainly, in whatever training or
   acceptable-use note accompanies it. The panel no longer warns at run time — that was
   removed deliberately once the relay became the only provider, on the grounds that a
   permanent banner over a setting nobody can change is noise rather than consent — so the
   explanation has to live in the rollout material instead of in the UI.

**Operational:**

4. **Mandate OS disk encryption (BitLocker/FileVault)** on all analyst machines; document as the compensating control for §9.3. (Or commission the passphrase-based at-rest encryption feature.)
5. **Deploy via managed/enterprise policy** (force-installed, pinned version), **not** the standalone page — which in this build has no AI at all.
6. **Produce the organisational GDPR artefacts** (see §11) — the code supports these but cannot *be* them. §11.2 and §11.3 need rewriting for the Copilot recipient.
7. **Commission an independent penetration test** of the packed extension, specifically including the bridge's injected code path.
8. **Prune the manifest**: remove `optional_host_permissions` and `connect-src` entries for the providers this build does not offer (§5).
9. ~~Remove the unused `declarativeNetRequest` permission~~ — **done**; consider further narrowing `tabs`/`scripting`.
10. ~~Add HTML-escaping in `md()`~~ — **done** (defence-in-depth alongside CSP).
11. ~~**Harden the Ollama host**~~ — **no longer applicable.** Ollama is not part of this build; the local inference server and its installer are gone (§8).

---

## 11. GDPR artefact skeletons (to be completed by the DPO/business)

> These are starting templates only. They must be reviewed and completed by the accountable data owner / DPO.

### 11.1 Lawful basis (Art. 6)
- **Processing activity:** AI-assisted analysis of customer support cases and diagnostic logs.
- **Proposed basis:** Legitimate interests (Art. 6(1)(f)) — providing and improving technical support to customers — **subject to a Legitimate Interests Assessment (LIA).**
- **Special category data:** none expected; confirm logs do not contain Art. 9 data.

### 11.2 Record of processing (Art. 30)
| Field | Entry |
|---|---|
| Controller | SOTI (business owner: _____) |
| Purpose | AI-assisted support case/log analysis |
| Categories of data subjects | Customer contacts named in support cases |
| Categories of personal data | Names, emails, phone numbers, company, log-embedded identifiers |
| Recipients | **No third party.** Case analysis and AI inference happen entirely on the analyst device. **One first-party flow exists:** up to six case-derived keywords are sent to `pulse.soti.net` (SOTI-operated) in a search query string — see §4.1 |
| International transfers | **None to any third party.** The `pulse.soti.net` flow in §4.1 is SOTI-internal; **confirm the hosting region of that service with its owner** before signing off this entry |
| Retention | Cases 30 days inactivity; insights 90 days; manual erasure available. **Note:** the §4.1 keywords fall under Pulse's own access-log retention, not this app's — see §11.4 |
| Technical/organisational measures | On-device processing and inference; scoped permissions; hardened CSP; retention limits; OS disk encryption (mandated); see this document |

### 11.3 DPIA trigger assessment
- Automated processing of customer support data with AI **likely warrants a DPIA**. Recommend completing a full DPIA covering: necessity/proportionality, the §9 risks, and the mitigations in this document.

### 11.4 Retention policy statement
- Case working data: auto-deleted after **30 days** of inactivity.
- Learned insights: auto-deleted after **90 days**.
- Analysts may erase any case immediately ("Clear all cases & logs").
- Salesforce remains the system of record; the local store is a working cache.
- **Not controlled by this application:** the case-derived keywords sent to `pulse.soti.net` (§4.1) are retained under that service's own web-server/CDN access-log policy. Obtain that retention period from the service owner and record it here: _____.

### 11.5 Data-subject rights handling
- **Erasure/access:** local data is per-analyst-device; document the process for locating and clearing it on request (extension "Clear all" + profile).

---

## 12. Security-hardening change log (this codebase)

- Removed all external CDN/proxy dependencies (jsdelivr, allorigins, codetabs); OCR + research are fully local/first-party.
- Hardened CSP (manifest + meta) blocking external resource loads and beacons.
- Added HTML-escaping in `md()` (input sanitisation).
- Removed the misleading no-op `scrubPII()` wrapper.
- Removed the unused `declarativeNetRequest` permission and its dead service-worker code.
- Extended case retention to 30 days; added 90-day retention purge for learned insights.
- **Build 3.0.0 — the architecture changed.** Local inference was removed and Microsoft 365
  Copilot became the only provider, reached through the analyst's own signed-in session. This
  is a **reduction** in some surface (no locally-listening inference server, no API key, no
  newly-engaged processor) and an **increase** in disclosure (customer case content now leaves
  the device). §1–§5 and §9–§10 were rewritten for it; §14–§15 were not, and are marked as
  historical.
- Build 3.0.0 also removed the run-time off-device warnings — the amber banner, the warning
  toast on save, and the "OFF-DEVICE" wording — on the grounds that a permanent warning over
  a setting nobody can change is noise rather than consent. **The consequence for this
  document is that the disclosure is no longer signalled in the UI**, so it must be carried by
  training and policy instead (§10.3).
- **Scoped `OLLAMA_ORIGINS`** in the installer from `*` to the extension + standalone origins only (see §14.1).
- **Made winget (verified package) the primary Ollama install path** ahead of the remote-script installer (see §14.2).
- **Reordered the installer fallback chain to most-verified-first** — the signature-verified `OllamaSetup.exe` path now runs ahead of the `install.ps1` fetch-and-eval, which is now the last resort (see §14.2, §15.3).
- **Corrected §4, §9, §11.2 and §11.4**, which previously stated that only product/version terms reached `pulse.soti.net` and that there were no external recipients. A source review found case-derived keywords are sent to that host; the flow is now documented in full at §4.1 and tracked as an open risk at §9.2. **This was a documentation error, not a regression** — the behaviour pre-dated the claim.
- **Hardened the Pulse-sync domain check** from a substring match to strict hostname parsing (see §14.4).
- **Pinned the extension ID** via a `key` in `manifest.json`, replacing `chrome-extension://*` in `OLLAMA_ORIGINS` (see §15.1).
- **Enforced local-only inference** with `OLLAMA_NO_CLOUD=1` (see §15.2).
- **Added Authenticode verification** of the downloaded `OllamaSetup.exe` before it is executed (see §15.3).
- **Fixed the backend fallback** to launch `ollama serve` rather than the interactive CLI (see §15.4).
- **Added a rollback/uninstall procedure** (`UNINSTALL.md`).

---

## 13. Scope & disclaimer

This assessment covers the extension source in this repository at the stated date. It does **not** cover: the security of the host OS, Salesforce-side access controls, physical/endpoint security, or the organisational GDPR programme. It is an engineering assessment and must be validated by the security team's own review and an independent penetration test of the packed/signed artefact before global rollout.

---

## 14. Penetration test — findings & resolutions

A dynamic pentest was performed against the running application (live browser: network capture, CSP-violation instrumentation, 14 HTML-injection payloads, ReDoS timing) **and** against a live local Ollama instance. Findings and their resolutions:

> **Historical record — read as history, not as current state.** These findings are from the
> local-inference architecture. Ollama is no longer part of the product, so the findings that
> concern it (§14.1, §15.1–15.3, §15.5) describe an attack surface that **no longer exists**
> in this build. They are kept because deleting closed findings from a security assessment
> destroys the audit trail of what was found and what was done about it. **Nothing in §14 or
> §15 has been re-tested against the Copilot bridge** — that is §10.7, and it is outstanding.

### 14.1 [HIGH → RESOLVED] Local Ollama API exposed to any website (permissive CORS)
- **Found:** the installer set `OLLAMA_ORIGINS=*`, disabling Ollama's CORS protection. Proven live — a browser page at an unrelated origin (`http://127.0.0.1:8765`, not the extension) successfully called `POST /api/chat` on the local model and received `Access-Control-Allow-Origin: *`. Any website the analyst visits could reach the local model.
- **Resolved:** `setup_local_ai.ps1` now sets `OLLAMA_ORIGINS="chrome-extension://*,http://localhost:8765,http://127.0.0.1:8765"` — the extension and standalone page only.
- **Verified:** on a temporary scoped instance, arbitrary web origins (`evil.example.com`, `random-ad-network.com`, `attacker.local`) receive **no** `Access-Control-Allow-Origin` header (browser denies them), while the extension and standalone origins are allowed.
- **For managed rollout:** replace `chrome-extension://*` with the pinned extension ID (`chrome-extension://<id>`).

### 14.2 [HIGH → MITIGATED] Unverified remote code execution in the installer
- **Found:** the installer fetched `https://ollama.com/install.ps1` and ran it via `Invoke-Expression` with no integrity check ("fetch-and-eval"), with full user privileges outside the browser sandbox.
- **Mitigated:** the installer's fallback chain is ordered **most-verified first**, so the fetch-and-eval path is only reachable once every verified path is unavailable:
  1. **winget** (`winget install Ollama.Ollama`) — signed, hash-verified package; fetches and evaluates no remote script at all.
  2. **`OllamaSetup.exe`** — downloaded, then Authenticode- and publisher-verified by `Test-InstallerSignature` before execution (§15.3).
  3. **`install.ps1`** — last resort, reached only on a machine with no winget **and** no usable signed installer.
- **Verified:** all 8 combinations of path availability were executed against the shipped Step-1 block; `Install-OllamaOfficial` is never invoked while `winget` or the signature-verified `.exe` can still succeed, and the script exits `1` only when all three fail.
- **Residual (accept-risk):** the last-resort fallback still trusts `ollama.com` over HTTPS (the vendor's own documented method), and a *signature rejection* in step 2 currently falls through to it rather than aborting — so a machine with no winget facing a tampered download would still reach the unverified path. For a locked-down rollout, pre-stage a vetted Ollama installer via managed software deployment instead of per-machine internet fetch.

### 14.3 [MEDIUM] No encryption at rest — unchanged, open by prior decision (see §9.1).

### 14.4 [LOW → RESOLVED] Weak substring domain check
- **Found:** `isPulseUrl = url.includes('pulse.soti.net')` would also accept `pulse.soti.net.attacker.example`.
- **Resolved:** now `new URL(url).hostname === 'pulse.soti.net'`. **Verified:** real Pulse URLs accepted; subdomain-spoof, path-spoof, and credential-spoof (`pulse.soti.net@attacker.example`) all rejected. (Chrome `host_permissions` remain an independent second layer.)

### 14.5 Controls that held under active attack (verified, no change needed)
- **14 HTML-injection payloads** (external `<img>` beacon, SVG `onload`, `<script>`, meta-refresh, form-action hijack, `object`/`embed`, `<base href>`, CSS `@import`, `javascript:` URI, `onerror`, `data:` URI script, iframe `srcdoc`) — **all neutralised** by `md()` escaping; none reached the DOM as a live element.
- **CSP as an independent second layer** — with escaping deliberately bypassed (raw `innerHTML`), the external image beacon was still **blocked** (`securitypolicyviolation`, `img-src`, `enforce`) and SVG `onload` did **not** execute.
- **ReDoS** — all 506 regex literals scanned; the one flagged pattern ran in 4 ms against a 300 KB pathological payload. No catastrophic backtracking.
- **No** `eval`/`new Function`/dynamic-string timers in app code; **no** hardcoded secrets; download filenames are hardcoded (no path traversal); tab/case names use `.textContent`.
- **Network egress** during full normal usage: only `127.0.0.1:11434` (Ollama), `pulse.soti.net` (first-party), and local files.

---

## 15. Third-party installer review — findings & resolutions

An external static review of `setup_local_ai.bat` / `setup_local_ai.ps1` (dated 17 July 2026)
was assessed against the code and re-tested dynamically. Its verdict — *no malware, moderate
corporate risk, changes required before managed deployment* — was confirmed. All seven of its
technical findings were reproduced. Resolutions below; scope was the **installer only**, so it
does not supersede §14.

### 15.1 [HIGH → RESOLVED] `chrome-extension://*` allowed every installed extension
- **Found:** `OLLAMA_ORIGINS` used `chrome-extension://*`. **Proven live** — arbitrary extension
  origins received `200` + a matching `Access-Control-Allow-Origin` from the local model. This
  was the residual gap left open by §14.1.
- **Resolved:** `manifest.json` now carries a `key`, fixing the extension ID at
  `odkmlcpmfgdfoikmcmhoongggbepbdna` on every machine; the installer pins `OLLAMA_ORIGINS` to
  that exact ID. A `-ExtensionId` parameter (validated `^[a-p]{32}$`) covers Web Store /
  enterprise-policy rollouts.
- **Verified:** the ID was confirmed as ground truth by packing the extension with Chrome's own
  `--pack-extension` and reading the `crx_id` from the CRX3 header. Against a live instance:
  our ID `200`; two other extension IDs `403`; `evil.example.com` `403`; standalone page `200`.
- **Scope limit (documented, accepted):** `OLLAMA_ORIGINS` is a browser-boundary control only.
  Requests with no `Origin` header (any local process) are always served, and Ollama
  independently allows `localhost`/`127.0.0.1` on any port plus `app://`, `tauri://` and
  `vscode-webview://`. Verified; not removable via `OLLAMA_ORIGINS`.

### 15.2 [MEDIUM → RESOLVED] Local-only operation was assumed, not enforced
- **Found:** the installer never disabled Ollama's cloud features (remote inference, web search).
- **Resolved:** the installer now sets `OLLAMA_NO_CLOUD=1` (User scope) before starting the server.
- **Verified:** against a **clean** Ollama profile the server reports `OLLAMA_NO_CLOUD:false` by
  default and `true` with the variable set — i.e. Ollama ships with cloud **enabled**, so this is
  a real change of default, not a no-op. Local inference is unaffected (`/api/chat` on a local
  model returns `200`; a `*-cloud` model returns `403`).

### 15.3 [MEDIUM → RESOLVED] Unverified installer executable
- **Found:** the `OllamaSetup.exe` fallback downloaded and silently executed a binary with no
  integrity check — the same supply-chain exposure as §14.2, which the external review did not flag.
- **Resolved:** `Test-InstallerSignature` verifies Authenticode status **and** publisher
  (`CN=Ollama Inc.`) before execution; a failing binary is deleted, not run.
- **Verified:** genuine Ollama binary accepted; a byte-tampered copy rejected (`HashMismatch`);
  an unsigned file rejected; a validly-signed Google binary rejected (wrong publisher).
- **Ordering:** this verified path now runs **ahead of** the `install.ps1` fetch-and-eval fallback, not behind it (§14.2) — previously the unverified path ran second and the verified one third, so on a machine without winget the signature check was never reached.
- **Residual:** the `install.ps1` fetch-and-eval fallback remains as accepted risk per §14.2, now as the last resort rather than the first fallback.

### 15.4 [LOW → RESOLVED] Backend fallback never started the server
- **Found:** the non-tray fallback ran `ollama.exe` with no argument. Confirmed on 0.32.1 this
  launches an **interactive menu**, not the API — so with `-WindowStyle Hidden` it hung invisibly
  until the API check timed out. A functional bug, not merely a reliability concern.
- **Resolved:** now `-ArgumentList "serve"`. **Verified:** API answers and the log shows `Listening on`.

### 15.5 [INFO → RESOLVED] Documentation understated the download
- `gemma4:e2b` is **7.2 GB** (measured), not the ~2 GB stated in the UI and README. Corrected in
  both, plus the installer banner; disk guidance (~12 GB) added to `UNINSTALL.md`.

### 15.6 [ADVISED → DONE] Rollback procedure
- `UNINSTALL.md` documents every machine change and how to reverse it, and records that the
  installer needs no Administrator rights and makes no machine-scope, firewall, or registry changes.

### 15.7 Open — organisational, not code
- **IT/Security approval remains required** before deployment on a SOTI-managed device. The tool
  installs third-party software, opens a local API, and processes customer case content; no code
  change removes that requirement.
