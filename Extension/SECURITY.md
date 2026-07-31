# SOTI AI Analyser — Security & Data-Protection Assessment

## 1. Executive summary

The application has a **privacy-favourable, local-first architecture**:

- **All AI processing is local** (Ollama on `127.0.0.1:11434`). No cloud AI, no API keys, no third-party data processor.
- **No telemetry, analytics, or tracking** of any kind.
- **All network egress is restricted** to localhost plus first-party SOTI/Salesforce hosts, enforced by tightly-scoped `host_permissions` and a hardened Content-Security-Policy.
- **No personal data reaches any third party.** Case content is processed and stored on the analyst's device. One **first-party** exception is documented at §4.1: a small number of case-derived keywords are sent to SOTI's own `pulse.soti.net` in a search query string.

**Two residual technical risks are open:**

1. **Local data is not encrypted at rest** (§9.1) — open by customer decision, with mandated OS disk encryption as the compensating control.
2. **Case-derived keywords are sent to `pulse.soti.net`** (§9.2, detail in §4.1) — first-party recipient, but the data lands in access logs outside this application's retention controls. Remediation options are listed; **this one is not yet closed.**

With the compensating controls documented below, the application is assessed as **suitable for a controlled, policy-managed pilot**, subject to the operational recommendations in §10, closure of risk 2, and the security team's own review/pen-test.

---

## 2. Architecture & trust model

- Chrome **Manifest V3** side-panel extension.
  - `sidepanel.js` — all application logic (UI, prompt building, research, storage).
  - `background.js` — minimal service worker; only opens the side panel. **Holds no network permissions and makes no requests.**
  - `content.js` — content script injected on Salesforce pages; **reads the case DOM only** and returns it to the side panel via internal messaging. Makes no network requests.
- **AI inference** is performed by a **locally-installed Ollama** instance (model `gemma4:e2b`) over `http://127.0.0.1:11434`.
- **Trust boundary:** the extension trusts the local machine, the local Ollama, and first-party SOTI/Salesforce web properties. It trusts **no external third party**.

---

## 3. Personal data processed (GDPR-relevant)

| Data | Source | Where it lives |
|---|---|---|
| Customer names, emails, phone numbers, company identifiers | Scraped Salesforce case | `chrome.storage.local` (device) |
| Case narratives / email chains | Scraped Salesforce case | `chrome.storage.local` |
| Diagnostic log files (may contain device IDs, IPs, usernames) | Analyst upload | `chrome.storage.local` |
| Chat history with the local AI | Local | `chrome.storage.local` |
| OCR text extracted from screenshots | Local (Tesseract) | `chrome.storage.local` |
| Derived "learned insights" | Local | `chrome.storage.local` |

- Data is **not redacted** before the local model — defensible because processing never leaves the device. (The former misleadingly-named no-op `scrubPII()` wrapper has been **removed** so the code no longer implies redaction it did not perform.)

---

## 4. Network egress (verified by full-codebase audit)

Every `fetch` / `XMLHttpRequest` / `WebSocket` / beacon path was traced. Destinations are **exclusively**:

- `http://127.0.0.1:11434` / `localhost` — local Ollama.
- `https://pulse.soti.net` — release notes, help pages and community search (first-party SOTI). **Case-derived text reaches this host — see §4.1.**
- `salesforce.com` / `force.com` — content script **reads the DOM only** (no outbound fetch of case data).
- Local bundled files (`lib/`, `knowledge/`).

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

## 5. Permissions (`manifest.json`)

| Permission | Purpose | Assessment |
|---|---|---|
| `storage`, `unlimitedStorage` | Local session storage | Justified |
| `sidePanel` | UI surface | Justified |
| `activeTab`, `tabs`, `scripting` | Salesforce scraping | Broad but justified; note for review |
| `downloads` | Session export to file | Justified |
| `host_permissions` | `*.soti.net`, `*.salesforce.com`, `*.force.com`, `localhost`/`127.0.0.1` **only** | **Strong** — no `<all_urls>`, no wildcard; physically prevents reaching any non-approved host |

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
- **Ollama + local model** — a **separate dependency** installed and secured outside the extension. Its hardening (`OLLAMA_ORIGINS`, local-only binding) is the deploying team's responsibility.
- **No npm runtime dependency tree** in the shipped extension (no bundler / `node_modules`).

---

## 9. Residual risks (critical view)

1. **[MEDIUM] No encryption at rest.** Case PII sits in `chrome.storage.local` in plaintext, protected only by OS/profile security. **Open by customer decision.** *Compensating controls:* sandboxed per-extension storage, 30/90-day retention, and mandated OS disk encryption (§10.1). A passphrase-based AES-GCM option is designed but not built.
2. **[MEDIUM] Case-derived text leaves the device to a first-party host.** Up to six keywords taken from the case issue summary and customer email bodies are sent to `pulse.soti.net` in a URL query string, on essentially every quick action against an open case (§4.1). The recipient is SOTI-internal — no third party — but the data lands in web-server/CDN access logs governed by that service's retention policy, outside this application's controls. **Open**; remediation options in §4.1.
3. **[LOW] No app-level authentication.** Anyone with the unlocked browser profile can open the panel and read cases. Ties to (1).
4. **[LOW] Prompt injection.** Attacker-influenced case/email content flows into the local LLM and could skew its analysis output. No data-exfiltration risk (local model); analysts should treat AI output as advisory.
5. **[LOW] Standalone mode** uses `localStorage` (wiped by site-data clears) and relies only on the meta-CSP (no `host_permission` enforcement). Deploy the **extension** only.
6. **[LOW] Learned insights** may retain incidental PII fragments (now 90-day bounded).
7. **[INFO] Vendored libraries are not integrity-pinned.**

---

## 10. Recommendations before global rollout

1. **Mandate OS disk encryption (BitLocker/FileVault)** on all analyst machines; document as the compensating control for §9.1. (Or commission the passphrase-based at-rest encryption feature.)
2. **Deploy via managed/enterprise policy** (force-installed, pinned version), **not** the standalone page.
3. ~~Remove the unused `declarativeNetRequest` permission~~ — **done**; consider further narrowing `tabs`/`scripting`.
4. ~~Add HTML-escaping in `md()`~~ — **done** (defence-in-depth alongside CSP).
5. ~~**Harden the Ollama host:** bind to localhost, set `OLLAMA_ORIGINS`, keep it off the network.~~ — **done**; `OLLAMA_ORIGINS` is pinned to this extension's ID and `OLLAMA_NO_CLOUD=1` enforces local-only inference (see §15.1–15.2).
6. **Produce the organisational GDPR artefacts** (see §11) — the code supports these but cannot *be* them.
7. **Commission an independent penetration test** of the packed extension.

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
