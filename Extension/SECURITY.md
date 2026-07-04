# SOTI AI Analyser — Security & Data-Protection Assessment

**Audience:** SOTI internal security / data-protection review, prior to global rollout.
**Scope:** Chrome MV3 extension in this repository (`sidepanel.js`, `background.js`, `content.js`, `manifest.json`, bundled `lib/` and `knowledge/`).
**Status:** Code-level technical assessment. It is a strong input to — **not a replacement for** — an independent security review and penetration test.
**Last updated:** 2026-07-03.

---

## 1. Executive summary

The application has a **privacy-favourable, local-first architecture**:

- **All AI processing is local** (Ollama on `127.0.0.1:11434`). No cloud AI, no API keys, no third-party data processor.
- **No telemetry, analytics, or tracking** of any kind.
- **All network egress is restricted** to localhost plus first-party SOTI/Salesforce hosts, enforced by tightly-scoped `host_permissions` and a hardened Content-Security-Policy.
- Personal data stays on the analyst's device.

**One residual technical risk is open by customer decision: local data is not encrypted at rest** (see §9.1). With the compensating controls documented below, the application is assessed as **suitable for a controlled, policy-managed rollout**, subject to the operational recommendations in §10 and the security team's own review/pen-test.

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
- `https://pulse.soti.net` — release notes / help (first-party). Only **product/version terms** travel here; **no personal data**.
- `salesforce.com` / `force.com` — content script **reads the DOM only** (no outbound fetch of case data).
- Local bundled files (`lib/`, `knowledge/`).

**Confirmed absent:** telemetry/analytics (Google Analytics, Sentry, Segment, etc.), third-party CDNs, CORS proxies, external fonts/scripts/CSS, cookies, clipboard/geolocation access, `externally_connectable`.

**Verified live:** with every external fetch failing, the app still functions from local data; and an injected external image beacon to a *resolvable* host is **blocked by CSP** (`securitypolicyviolation`, directive `img-src`, disposition `enforce`).

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
2. **[LOW] No app-level authentication.** Anyone with the unlocked browser profile can open the panel and read cases. Ties to (1).
3. **[LOW] Prompt injection.** Attacker-influenced case/email content flows into the local LLM and could skew its analysis output. No data-exfiltration risk (local model); analysts should treat AI output as advisory.
4. **[LOW] Standalone mode** uses `localStorage` (wiped by site-data clears) and relies only on the meta-CSP (no `host_permission` enforcement). Deploy the **extension** only.
5. **[LOW] Learned insights** may retain incidental PII fragments (now 90-day bounded).
6. **[INFO] Vendored libraries are not integrity-pinned.**

---

## 10. Recommendations before global rollout

1. **Mandate OS disk encryption (BitLocker/FileVault)** on all analyst machines; document as the compensating control for §9.1. (Or commission the passphrase-based at-rest encryption feature.)
2. **Deploy via managed/enterprise policy** (force-installed, pinned version), **not** the standalone page.
3. ~~Remove the unused `declarativeNetRequest` permission~~ — **done**; consider further narrowing `tabs`/`scripting`.
4. ~~Add HTML-escaping in `md()`~~ — **done** (defence-in-depth alongside CSP).
5. **Harden the Ollama host:** bind to localhost, set `OLLAMA_ORIGINS`, keep it off the network.
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
| Recipients | None external — processed locally on the analyst device |
| International transfers | None (local processing) |
| Retention | Cases 30 days inactivity; insights 90 days; manual erasure available |
| Technical/organisational measures | Local-only processing; scoped permissions; hardened CSP; retention limits; OS disk encryption (mandated); see this document |

### 11.3 DPIA trigger assessment
- Automated processing of customer support data with AI **likely warrants a DPIA**. Recommend completing a full DPIA covering: necessity/proportionality, the §9 risks, and the mitigations in this document.

### 11.4 Retention policy statement
- Case working data: auto-deleted after **30 days** of inactivity.
- Learned insights: auto-deleted after **90 days**.
- Analysts may erase any case immediately ("Clear all cases & logs").
- Salesforce remains the system of record; the local store is a working cache.

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

---

## 13. Scope & disclaimer

This assessment covers the extension source in this repository at the stated date. It does **not** cover: the security of the Ollama installation or host OS, Salesforce-side access controls, physical/endpoint security, or the organisational GDPR programme. It is an engineering assessment and must be validated by the security team's own review and an independent penetration test before global rollout.
