# SOTI AI Analyser — Independent Penetration Test & Security Assessment

**Assessment type:** Fresh, independent white-box security review + code-level penetration test.
**Target:** Chrome MV3 extension in this repository — `manifest.json`, `background.js`, `content.js`, `sidepanel.js`, `SOTI_AI_Analyser.html`, bundled `lib/` + `knowledge/`, and the offline installer (`setup_local_ai.bat` / `setup_local_ai.ps1`).
**Date:** 2026-07-04.
**Assessor note:** This report was produced from scratch by re-auditing the source independently. It does **not** rely on the previous SECURITY.md and supersedes it. It remains an engineering assessment and is **not** a substitute for the security team's own dynamic pen-test of the packed/signed artefact.

---

## 1. Executive summary

**Overall verdict: the extension is well-engineered and has clearly been through deliberate security hardening. No critical or high-severity, remotely-exploitable vulnerability was found in the current code.** The design is local-first and privacy-favourable: AI inference is local (Ollama on `127.0.0.1`), there is no telemetry, no third-party data processor, no hardcoded secret, and all network egress is constrained by a tight Content-Security-Policy and scoped host permissions.

The residual risk is concentrated in **deployment posture and data-at-rest**, not in exploitable code defects:

| # | Severity | Finding | Type |
|---|---|---|---|
| F1 | **MEDIUM** | Customer PII stored unencrypted at rest (`chrome.storage.local`) | Data protection |
| F2 | **MEDIUM** | Broad permission blast radius (`tabs` + `scripting` + host perms) if the extension is ever compromised | Least privilege |
| F3 | **MEDIUM** | `OLLAMA_ORIGINS=chrome-extension://*` as shipped lets *any* installed extension reach the local model | Deployment / hardening |
| F4 | LOW | Indirect prompt injection from logs / case / OCR content skews AI output (no exfil path) | Integrity |
| F5 | LOW → **RESOLVED** | `md()` preserved arbitrary attributes on `data:` `<img>` tags before escaping (CSP-mitigated latent XSS) | Defence-in-depth |
| F6 | LOW → **RESOLVED** | Version `<option>` built with unescaped interpolation (inconsistent with escaped file-name path) | Defence-in-depth |
| F7 | LOW | Installer retains a remote-script (`irm \| iex`) fallback with no hash/signature check | Supply chain |
| F8 | LOW → **RESOLVED** | Session-export filename embedded unsanitised `caseNum` (browser-sanitised; no real traversal) | Hardening |
| F9 | LOW → **RESOLVED** | Vendored Tesseract/WASM blobs were not integrity-pinned | Supply chain |
| F10 | INFO | `web_accessible_resources` make the extension fingerprintable from SOTI/Salesforce origins | Privacy |

> **Update (2026-07-04):** the four cheap code-level items (F5, F6, F8, F9) were fixed in this pass and verified — see the ✅ notes in §5. F1–F3 remain operational/deployment items for the security team.

**Conclusion:** suitable for a **controlled, policy-managed rollout** once F1–F3 are addressed operationally (disk encryption, enterprise force-install with a pinned ID, and a pinned `OLLAMA_ORIGINS`). None of these block a pilot on managed, disk-encrypted machines.

---

## 2. Methodology

White-box source review of 100% of the extension code plus the installer, targeting:

- Injection sinks: `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `DOMParser`, and the `md()` markdown renderer.
- Code-execution primitives: `eval`, `new Function`, string-timers, dynamic `import`.
- Network egress: every `fetch` / `XMLHttpRequest` / beacon / `WebSocket`; SSRF and open-redirect paths.
- Privilege model: manifest permissions, `host_permissions`, CSP (manifest **and** standalone `<meta>`), `web_accessible_resources`.
- Extension messaging: `chrome.runtime.onMessage`, `chrome.tabs.sendMessage`, `chrome.scripting.executeScript`, `chrome.tabs.create`.
- Data lifecycle: `chrome.storage.local` / `localStorage` / `sessionStorage`, retention, erasure.
- Secrets & supply chain: hardcoded credentials, git-tracked sensitive files, vendored third-party blobs.
- Installer: PowerShell execution flow, remote code fetch, environment/CORS changes.

---

## 3. Attack surface & trust model

- **`background.js`** — minimal service worker; only calls `setPanelBehavior`. No network permissions, no message handling, no request issuance. Negligible surface.
- **`content.js`** — injected on `*.salesforce.com` / `*.force.com`. **Reads the case DOM only** and returns it over internal messaging on demand (`GET_SALESFORCE_DATA`). Makes no network request. Traverses Shadow DOM to scrape case fields and the email/chatter feed.
- **`sidepanel.js`** (≈456 KB) — all application logic: prompt building, Ollama streaming, Pulse "deep research" crawl, storage, OCR, self-learning.
- **Standalone `SOTI_AI_Analyser.html`** — same UI served over `http://127.0.0.1:8765`. Because a served page does **not** inherit the manifest CSP, it ships its own mirrored `<meta http-equiv="Content-Security-Policy">`.
- **Trust boundary:** the app trusts the local machine, the local Ollama, and first-party SOTI/Salesforce origins. It trusts no external third party.

---

## 4. Controls verified effective (what held up)

These were actively probed and are genuinely protective — credit where due:

1. **Content-Security-Policy is tight and dual-enforced.** `script-src 'self' 'wasm-unsafe-eval'` (no `unsafe-inline`), `connect-src` limited to `'self'`, localhost/127.0.0.1, and `*.soti.net` / `*.salesforce.com` / `*.force.com`, `img-src 'self' data:`, `object-src 'self'`, `frame-src 'none'`, `base-uri 'self'`, `form-action 'none'`. The standalone page mirrors it via `<meta>` ([SOTI_AI_Analyser.html:9](SOTI_AI_Analyser.html:9)). This blocks external beacons, inline event handlers, and remote scripts even if input sanitisation is bypassed.
2. **`md()` HTML-escapes before markdown** ([sidepanel.js:114](sidepanel.js:114)). Untrusted case/log/OCR/AI text has `& < >` escaped before any markup is generated, so injected tags cannot become live DOM. This is real defence-in-depth on top of the CSP.
3. **`escapeHtml()` is correct** ([sidepanel.js:2420](sidepanel.js:2420)) — escapes `& < > " '` — and is used for the user-controlled file-name render path ([sidepanel.js:6969](sidepanel.js:6969)).
4. **No dangerous code-execution primitives** — zero `eval` / `new Function` / string `setTimeout`/`setInterval` in app code.
5. **No hardcoded secrets** — no API keys, tokens, passwords, or private keys anywhere in the tree; no sensitive files are git-tracked (32 tracked files; the stale `Backup/` copy is git-ignored and will not ship).
6. **Outbound AI traffic is localhost-only** — the chat/stream request targets `${baseUrl}/api/chat` where `baseUrl` is the local Ollama URL ([sidepanel.js:5936](sidepanel.js:5936)); customer data never leaves the device.
7. **Deep-research crawler is host-locked** to `pulse.soti.net` using proper URL parsing (`new URL(u).hostname === 'pulse.soti.net'`), not substring matching, and only queues links that pass `isPulseSupportUrl` ([sidepanel.js:8283](sidepanel.js:8283), [sidepanel.js:8417](sidepanel.js:8417)). Substring-spoof (`pulse.soti.net.attacker.example`) and credential-spoof (`pulse.soti.net@evil`) are rejected.
8. **`DOMParser` output is inert** — remote HTML is parsed with `parseFromString(html, 'text/html')` (no scripts run, no sub-resources load) and used only for text/version extraction.
9. **OCR is 100% local** — Tesseract engine, worker, WASM, and language data all load from the bundled `lib/` via `chrome.runtime.getURL` / relative paths ([sidepanel.js:7257](sidepanel.js:7257)); `worker-src 'self'` blocks any remote worker.
10. **Data retention & erasure exist and actually delete** — 30-day case inactivity purge ([sidepanel.js:418](sidepanel.js:418)), 90-day learned-insight purge ([sidepanel.js:6005](sidepanel.js:6005)), and a "Clear all cases & logs" control ([sidepanel.js:8534](sidepanel.js:8534)).

---

## 5. Findings (detailed)

### F1 — [MEDIUM] Customer PII unencrypted at rest
**Where:** `chrome.storage.local` (and `localStorage`/`sessionStorage` fallbacks) — `saveState()` [sidepanel.js:293](sidepanel.js:293), quick-cache [sidepanel.js:317](sidepanel.js:317), learned insights [sidepanel.js:6048](sidepanel.js:6048).
**Issue:** Scraped Salesforce case data (customer/contact/account names, subjects, descriptions, full email chains), uploaded diagnostic logs (device IDs, IPs, usernames), OCR'd screenshot text, chat history, and derived "learned insights" are persisted in plaintext. Chrome's extension local storage is not encrypted; only OS-level full-disk encryption protects it. On a shared, lost, or malware-infected endpoint, another local principal can read case PII directly from the profile.
**Impact:** Confidentiality of customer personal data (GDPR-relevant).
**Recommendation:** Mandate BitLocker/FileVault as the compensating control and document it; consider an optional passphrase-derived AES-GCM at-rest layer; keep retention windows as short as the workflow tolerates. Note that "learned insights" persist case-derived root-cause/resolution text for 90 days ([sidepanel.js:6067](sidepanel.js:6067)).

### F2 — [MEDIUM] Broad permission blast radius
**Where:** [manifest.json:6](manifest.json:6) — `tabs`, `scripting`, `activeTab`, `downloads`, `unlimitedStorage`; host permissions for `*.soti.net`, `*.salesforce.com`, `*.force.com`, localhost.
**Issue:** `tabs` exposes the URL/title of **all** tabs to the extension, and `scripting` + host permissions allow programmatic script injection into any SOTI/Salesforce/localhost page. `chrome.tabs.create` + `chrome.scripting.executeScript` are used for the Pulse crawl ([sidepanel.js:7888](sidepanel.js:7888), [sidepanel.js:7898](sidepanel.js:7898)) and Salesforce scrape ([sidepanel.js:6898](sidepanel.js:6898)). This is justified by the feature set, but it is a wide capability set: a future supply-chain compromise of the extension (or of a vendored lib) would inherit it.
**Impact:** Amplifies the consequence of any future code compromise.
**Recommendation:** Deploy only via enterprise force-install with a pinned extension ID and pinned version; review whether `tabs` can be narrowed (much of the flow could rely on `activeTab` + explicit tab IDs); keep host permissions as-is (they are already correctly minimal — no `<all_urls>`).

### F3 — [MEDIUM] `OLLAMA_ORIGINS=chrome-extension://*` (as shipped)
**Where:** installer [setup_local_ai.ps1:202](setup_local_ai.ps1:202).
**Issue:** The setup script correctly avoids `*`, but `chrome-extension://*` still allows **every** Chrome extension on the machine to call the local Ollama API (list/run/pull models). A malicious or compromised unrelated extension could abuse local compute or poison locally-pulled models. The value is stored as a User-scope env var, so any process running as the user can also alter it.
**Impact:** Local resource abuse / model integrity via a co-resident extension.
**Recommendation:** For managed rollout, replace `chrome-extension://*` with the pinned `chrome-extension://<id>` (the script comment already flags this). Consider setting `OLLAMA_ORIGINS` via managed policy rather than a user env var.

### F4 — [LOW] Indirect prompt injection
**Where:** prompt assembly feeds logs, scraped Salesforce fields, OCR text, and crawled Pulse content into the model.
**Issue:** Attacker-influenced content (a crafted log line or case email) can contain instructions that steer the local model's analysis. Because the model has **no tools, no network actions, and its output is rendered escaped**, there is no data-exfiltration or code-execution path — the only impact is misleading root-cause/advice shown to the analyst.
**Recommendation:** Treat AI output as advisory (already the design intent); optionally add a system-prompt guard and delimit untrusted evidence. Accept-risk is reasonable given the bounded impact.

### F5 — [LOW] `md()` preserves arbitrary attributes on `data:` images
**Where:** [sidepanel.js:106](sidepanel.js:106).
**Issue:** Before escaping, `md()` extracts and restores verbatim any `<img src="data:image/…;base64,…"[^>]*>`. The trailing `[^>]*` permits arbitrary attributes, so a model-emitted `<img src="data:…" onerror="…">` survives into `innerHTML`. **Not currently exploitable** — `script-src 'self'` blocks the handler and `img-src 'self' data:` blocks any external beacon — but it is a latent XSS if the CSP is ever weakened.
**Recommendation:** Tighten the regex to reject extra attributes (or rebuild the preview via `document.createElement('img')` with an assigned `src`), so protection does not depend solely on the CSP.
**✅ Resolved:** `md()` now extracts only the `data:` URI and **reconstructs** the tag with a fixed safe style, discarding every other attribute ([sidepanel.js:106](sidepanel.js:106)). Verified with a unit test: `onerror` before/after `src`, the no-space `"onerror=` recovery vector, and a second `javascript:` `src` are all stripped; legitimate previews still render; external and `svg` data URIs remain escaped.

### F6 — [LOW] Unescaped `<option>` interpolation
**Where:** [sidepanel.js:5556](sidepanel.js:5556) — `sotiOpts.map(v => \`<option value="${v}">${v}</option>\`)`.
**Issue:** Version strings are interpolated without `escapeHtml`, inconsistent with the escaped file-name path. The source is first-party `pulse.soti.net` and constrained by the version-extraction regex, and the CSP mitigates, so it is not exploitable today — but it is a latent sink and an inconsistency.
**Recommendation:** Wrap interpolated values in `escapeHtml()` for consistency.
**✅ Resolved:** both the SOTI and Agent version `<option>` builds now use `escapeHtml(v)` ([sidepanel.js:5556](sidepanel.js:5556)).

### F7 — [LOW] Installer remote-script fallback
**Where:** [setup_local_ai.ps1:38](setup_local_ai.ps1:38) — `Invoke-WebRequest https://ollama.com/install.ps1 | Invoke-Expression`; launched by [setup_local_ai.bat:12](setup_local_ai.bat:12) with `-ExecutionPolicy Bypass`.
**Issue:** winget (signed, hash-verified) is correctly preferred, but the fallback fetches and executes a remote PowerShell script with no signature/hash pinning. TLS 1.2 is enforced, but a compromise of `ollama.com` or a MITM on the proxy path would run arbitrary code with user privileges outside the browser sandbox.
**Recommendation:** For a locked-down rollout, pre-stage a vetted Ollama MSI via managed software distribution and remove the remote-script fallback; never let end users run the setup script from an untrusted source.

### F8 — [LOW] Session-export filename embeds `caseNum`
**Where:** [sidepanel.js:6844](sidepanel.js:6844) — `a.download = \`SOTI_AI_Session_${caseNum}.txt\``.
**Issue:** The user-controlled `caseNum` is placed into the download filename. The HTML `download` attribute is browser-sanitised (path separators stripped), so there is **no real path traversal**, but the value is otherwise unvalidated. (Note: a prior claim that "download filenames are hardcoded" is inaccurate here.)
**Recommendation:** Sanitise `caseNum` to `[A-Za-z0-9._-]` before use for tidiness and defence-in-depth.
**✅ Resolved:** the export path now sanitises `caseNum` to `[A-Za-z0-9._-]` and caps it at 60 chars before building the filename ([sidepanel.js:6844](sidepanel.js:6844)).

### F9 — [LOW] Vendored libraries not integrity-pinned
**Where:** `lib/tesseract.v5.min.js`, `lib/worker*.js`, `lib/*.wasm`, `lib/eng.traineddata.gz`.
**Issue:** Third-party minified/WASM blobs are vendored with no recorded upstream version or hash. If swapped, they execute with the extension's privileges (CSP limits them to `'self'`/`wasm`).
**Recommendation:** Record the exact upstream Tesseract.js release + SHA-256 of each vendored file in-repo and verify at build/package time.
**✅ Resolved:** SHA-256 + byte size of every vendored blob is now pinned in [lib/INTEGRITY.md](lib/INTEGRITY.md), with PowerShell/bash verification commands. Still to do (owner action): confirm the pinned hashes against the official upstream Tesseract.js release and wire the check into the package step.

### F10 — [INFO] Fingerprintable via `web_accessible_resources`
**Where:** [manifest.json:30](manifest.json:30).
**Issue:** `knowledge/*.md`, `lib/*.wasm`, `lib/*.gz`, `lib/worker.min.js` are exposed to `*.soti.net` / `*.salesforce.com` / `*.force.com`. Those origins can probe `chrome-extension://<id>/knowledge/PulseKnowledge.md` to detect the extension and read its bundled (public) KB. No sensitive data leaks, but it enables extension enumeration.
**Recommendation:** Keep the resource list as narrow as possible; consider `use_dynamic_url: true` to reduce fingerprinting.

**Also noted (INFO):** `content.js` builds a `[id="${id}"]` selector from a page-controlled `aria-controls` value ([content.js:93](content.js:93)); a malformed value can throw or mis-match but cannot execute code — the Salesforce page is a semi-trusted origin. No action required beyond wrapping in try/catch if scraping robustness matters.

---

## 6. Recommendations before company rollout

1. **F1/F2 —** Deploy via managed/enterprise policy: **force-install, pinned extension ID, pinned version**; mandate **OS disk encryption** on all analyst machines and document it as the at-rest control. Do **not** roll out the standalone `http://127.0.0.1:8765` page (it has no `host_permission` enforcement and uses `localStorage`).
2. **F3 —** Change installer `OLLAMA_ORIGINS` to the pinned `chrome-extension://<id>` (drop the wildcard); keep Ollama bound to localhost and off the network; prefer setting it via policy.
3. **F7 —** Replace the per-machine internet Ollama install with a vetted, hash-verified package pushed by your software-distribution system.
4. **F5/F6 —** Tighten the `md()` data-image regex and use `escapeHtml()` for the version `<option>` path (small, cheap hardening).
5. **F9 —** Add a hash/version manifest for the vendored `lib/` blobs and verify at package time.
6. **Governance —** Complete the GDPR artefacts (§7); commission an independent dynamic pen-test of the **packed, signed** extension before global rollout.

---

## 7. Data-protection / GDPR notes (templates for the DPO)

Local-only processing means there is **no external recipient and no international transfer**, which materially simplifies the position — but the organisational artefacts still need completing by the accountable owner/DPO:

- **Lawful basis (Art. 6):** likely legitimate interests (support delivery/improvement) — complete an LIA.
- **Record of processing (Art. 30):** Controller = SOTI; purpose = AI-assisted support case/log analysis; data subjects = customer contacts in cases; personal data = names/emails/phones/company + log-embedded identifiers; recipients = none external; transfers = none; retention = 30-day case inactivity / 90-day insights / manual erasure; measures = local-only processing, scoped permissions, hardened CSP, retention limits, mandated disk encryption.
- **DPIA:** AI processing of customer support data likely warrants a DPIA covering necessity/proportionality and the F1–F4 risks above.
- **Data-subject rights:** data is per-analyst-device; document the locate-and-erase process (extension "Clear all" + profile).
- Salesforce remains the system of record; the local store is a working cache.

---

## 8. Scope & disclaimer

This covers the extension source and installer in this repository at the stated date. It does **not** cover: host-OS security, Salesforce-side access controls, physical/endpoint security, the security of the separately-installed Ollama binary, or the organisational GDPR programme. It must be validated by the security team's own review and an independent penetration test of the packed/signed artefact before global rollout.
