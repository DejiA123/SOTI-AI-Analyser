# SOTI AI Analyser — Security & Data-Protection Assessment

> **This document was rewritten for build 3.0.0 and has been maintained against every build
> since. It describes build 7.0.0, re-verified against source on 2026-09-03.** Every version
> of this assessment before 3.0.0 assessed a local-only tool: AI inference ran on the
> analyst's own machine and no case content left the device. **That is no longer what
> ships.** The tool now sends case content to Microsoft 365 Copilot. If you are holding an
> older copy of this assessment, its conclusions do not apply to the current build.
>
> **Re-verification of 2026-09-03.** The five questions a data-protection review asks of this
> tool — chat retention, what the insight store holds, whether anything is trained, whether a
> deletion at source propagates, and who can read an analyst's history — were re-answered by
> executing the shipping code rather than by re-reading this document. 37 checks, all passing;
> the suite is `security-answers-check.js` in the verification harness and is written to be
> re-run by a reviewer.
>
> **The one open personal-data flow it confirmed has since been closed.** §4.1 — case-derived
> keywords, including surnames, company names and hostnames, travelling to `pulse.soti.net` in a
> URL query string — is **resolved in this build**: the query is now built from an allowlist of
> recognised technical terms rather than a blocklist of field labels. §1, §4, §9.4, §11.2 and
> §11.4 are updated to match, and `pulse-allowlist-check.js` pins both halves of it.
>
> Two documentation defects were also corrected: every `sidepanel.js:NNNN` citation in §4.1 and
> §6.2 had drifted and pointed at unrelated code, and §11.2 still described the superseded
> two-pass de-identification of learned insights. One code defect is fixed: `ai-provider.js`
> announced `providers: bridge, openai, anthropic` in the console at start-up, three builds after
> the last two were deleted (§9.11).

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
*(A fourth — case-derived keywords reaching `pulse.soti.net` in a search URL — was open in
earlier revisions of this document and is **closed in 7.0.0**: the query is now built from an
allowlist of recognised technical terms rather than a blocklist of field labels. See §4.1 and
§9.4.)*

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
  - `content.js` — content script injected on Salesforce and JIRA pages. Reads the case DOM and
    returns it to the side panel via internal messaging, and — only on an action the analyst
    has pressed and confirmed — **drives the case's own publisher** to file a call note, post
    to the case feed, or fill in the email composer (`POST_SALESFORCE_FEED`,
    `WRITE_SALESFORCE_EMAIL`). Those three are the only writes in the extension. It makes no
    network requests of its own: every write is a click or a keystroke in a page the analyst
    is already signed in to and already permitted to type in.
    **The email composer write does not send.** It fills in Cc, subject and body and stops;
    there is no code in it that finds the Send button. See PROJECT_OVERVIEW §5.8.1.
- **AI inference** happens in **Microsoft 365 Copilot** (`m365.cloud.microsoft`), reached by
  automating a browser tab that is already authenticated as the analyst.
- **Usage counters** (PROJECT_OVERVIEW §5.8.4) are recorded in `chrome.storage.local` and
  are shared only if the analyst turns that on. There are **two** destinations, and
  **neither makes a network request** — see the removed third below:
  - **Open my board** — a page inside the extension (`usage-board.html`), reached at a
    `chrome-extension://` address with the report in the URL fragment. No network at all.
  - **Send to the dashboard** — the original route: the panel **opens** a hosted page in a
    background tab with the report in the URL **fragment**, and that page writes it to its
    own store. A fragment is never part of an HTTP request, so this route on its own adds
    no `connect-src` entry, no host permission and no credential. *It only works if the
    destination is top-level:* a page the browser renders in a frame reads its own address,
    which is empty, and neither side can tell — the tab opens either way.
  - ~~**Send to the team**~~ — **REMOVED in 7.7.0.** This was the only route that made a
    **request**: a `POST` of the report to a Power Automate "When an HTTP request is
    received" address, which filed it in a SharePoint list. It has been deleted from the
    source, not disabled. Removed with it: the button and the endpoint field in Settings,
    `usage.teamEndpoint` and its bookkeeping, the three `connect-src` entries and the three
    `optional_host_permissions` patterns for `*.logic.azure.com`,
    `*.api.flow.microsoft.com` and `*.powerplatform.com`. **The extension once again
    originates no outbound request of its own.** A profile saved before 7.7.0 may still
    carry a `teamEndpoint` string in `chrome.storage.local`; nothing reads it, no code path
    could act on it, and the manifest no longer permits — or can be granted — access to
    those hosts.

  Both remaining routes carry the same payload: counters, the analyst's name and the panel
  version, and **no case content of any kind** — there is no free-text field in it besides
  the name, so the property holds by shape rather than by a filter that has to be correct.

  **The readout is now admin-only.** The whole *Usage & Feedback* section is hidden in AI
  Settings unless `soti_usage_admin` is set in `chrome.storage.local` on that machine,
  which an admin does by clicking an unlabelled 22px square in the dialog's bottom-left
  corner (`#adminSpot`) — a toggle, so the same click turns it back off. This is a
  **UI decision, not an access control, and must not be assessed as one.** It is obscurity
  and nothing more: the corner is discoverable by anyone who reads this document or the
  source, the key is writable by anything that can reach the store, and anything that can
  reach the store can read the counters out of it directly without touching either. It
  changes what the dialog offers, not what the store protects, and it should not appear in
  any control narrative as a restriction on access. Counting is unaffected either way.

- **The Stats tab** (7.7.0; made to actually render in 8.0.0) frames the team's **Power BI**
  report at its secure-embed address. It is the extension's only frame, and `frame-src` allows Power BI
  and the Microsoft **sign-in** hosts the embed flow redirects through — and nothing else.
  **No credential, no host permission, and no case data**: the embed URL is a fixed
  workspace/report id built from constants, the report renders for whoever the browser is
  already signed in as, and the panel can neither read the frame nor message it. The screen
  still carries an **Open in Power BI** button, because sign-in cannot always finish inside
  a third-party frame and the panel cannot see whether it did. See §5.

**Trust boundary.** The extension trusts the local machine, first-party SOTI/Salesforce web
properties, and — as of this build — **the analyst's own Microsoft 365 tenant**, to which it
discloses case content.

**What this architecture does NOT do, and why it matters:**

| | |
|---|---|
| Hold a credential for the AI service | No. There is no API key, token or service account anywhere in the extension or its storage — so there is none to leak, rotate or misuse. |
| Connect to Microsoft from the extension | No. `connect-src` in the CSP lists no Microsoft host. Egress happens in the Copilot **page**, as ordinary session traffic — and, for the Stats tab, in the framed Power BI **document**, which is likewise the analyst's own session. Neither is a request this extension makes. |
| Send data to a processor the org has not already engaged | No. The destination is the tenant the analyst is signed in to. |
| Work without the analyst's knowledge | No. The relay drives a real window; the host permission is optional and must be granted by a click. |
| Send email, or write to Salesforce unprompted | No. The three write paths each require a button press and then a confirmation box the analyst reads; the email path fills a composer in and never presses Send. |
| Report on the analyst without their knowledge | No, and as of 7.7.0 the extension cannot post anywhere at all. Usage counters are local until the analyst presses **Send to the dashboard**, which needs an address pasted in first and ships with none — and which *opens a page* rather than sending, with the report in the URL fragment. Once-a-day sending is off until ticked. The report is printed in Settings and copyable in full; clearing the address stops all sharing while the counters keep working. **Open my board** never leaves the device. |

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

- `https://pulse.soti.net` — release notes, help pages and community search (first-party SOTI). Case-derived text reached this host until 7.0.0; the search terms are now **allowlisted technical vocabulary** and carry no customer or personal data — see §4.1.
- `salesforce.com` / `force.com` — content script **reads the DOM only** (no outbound fetch of case data).
- `https://api.github.com` — **version check only**, added in 8.0.0. Unauthenticated `GET`s for the public repository's latest release, tag list or `manifest.json`, sent **only** after the analyst has granted the optional host permission by pressing the update button. No body, no token, no identifier and no case-derived text of any kind travels on them; the answer is compared with the version Chrome is running and nothing else is done with it. See §5.1. The update *download* is not on this list because the page never fetches it — the URL is handed to `chrome.downloads`.
- Local bundled files (`lib/`, `knowledge/`).

> **The largest disclosure in this application is not on that list, because it is not a
> `fetch`.** Case content reaches Microsoft 365 Copilot by being **typed into a page**, and
> the page's own session carries it. Auditing this application's network calls will therefore
> never show it. See §4.2 — it is the flow that matters most.

**Confirmed absent:** telemetry/analytics (Google Analytics, Sentry, Segment, etc.), third-party CDNs, CORS proxies, external fonts/scripts/CSS, cookies, clipboard/geolocation access, `externally_connectable`.

**Verified live:** with every external fetch failing, the app still functions from local data; and an injected external image beacon to a *resolvable* host is **blocked by CSP** (`securitypolicyviolation`, directive `img-src`, disposition `enforce`).

### 4.1 Case-derived text sent to `pulse.soti.net` — CORRECTION, then RESOLVED

> **A previous version of this section stated that "only product/version terms" travel to `pulse.soti.net` and that "no personal data" does. That was incorrect.** The flow below was identified in a later source review and is recorded here in full. §11.2 and §11.4 have been corrected to match.
>
> **The flow described below was closed in build 7.0.0.** It is kept in full rather than deleted:
> the mechanism it describes is why the fix takes the shape it does, and a reviewer holding an
> earlier revision needs to be able to find what changed. The resolution is at the end of this
> section.

When the assistant researches a case it searches the SOTI Pulse community forum:

```js
// sidepanel.js:20684
sotiFetch(`${PULSE_ORIGIN}/community/search?query=${encodeURIComponent(kq)}`, 6000)
```

`kq` is **up to six keywords taken from the case itself**, not a fixed product vocabulary:

- Quick actions build the research query in `buildCaseResearchQuery()` (`sidepanel.js:15890`) from `buildCaseSymptomText(900)` (`:15839`), which concatenates the **scraped Salesforce issue summary** with the **bodies of up to four emails from the case chain** (300 chars each) and caps the result at 600 characters.
- A short or deictic chat message ("fix it", "what next?") is enriched at `:20025` with the case's issue summary before keywords are extracted.
- That text is tokenised at `:20407` — `split(/\W+/)`, keep tokens longer than 3 characters, minus a stopword list — and the **first six surviving tokens** were sent (`:20493`).

**The stopword list removes Salesforce field *labels* (`firstname`, `lastname`, `phone`, `customer`, `company`) but not the *values* behind them.** Any token over three characters passes, so customer surnames, company names, site and host identifiers, usernames and device model strings can all be transmitted.

**Frequency — this is the default path, not an edge case.** `buildCaseResearchQuery()` prefixes every quick-action query with the literal string `"troubleshoot issue: "`, which by itself satisfies the `isTroubleshoot` test at `:20043`, so the community search fires on essentially **every quick action against an open case**.

**Assessment**

- The recipient is **first-party SOTI infrastructure**. No data reaches an external organisation, and there is no third-party processor involved.
- The data travels in a **URL query string** — the worst available carrier. Query strings are written in cleartext to web-server access logs and to any CDN, WAF or forward proxy in the path, and are retained under *those* systems' policies, **outside** this application's 30/90-day retention controls.
- Volume is bounded (≤ 6 tokens per search); the *kind* of content is not.

**Status: RESOLVED (build 7.0.0).** The query is now built from an **allowlist**, and the
direction of the check is what changed: a term travels only if it is a **recognised technical
word**, rather than travelling unless someone thought to block it.

- `pulseQuerySafeTerms()` reduces the keyword string to terms present in `pulseQueryVocab()` —
  514 terms: a curated list of SOTI product, platform, symptom and networking vocabulary, **plus
  every failure category in `LOG_SIGNAL_RULES` and every exception class in
  `INSIGHT_SIGNATURE_VOCAB`**, folded in so the two cannot drift out of step with it. An
  unrecognised token is not masked or rewritten — it is **not sent**.
- There is **one shape rule**, and only because the set it stands for is unbounded: a four-digit
  `20xx` release year. Everything else is exact membership — no stemming, no partial match, no
  fallback to the input, so a customer name cannot arrive by being *almost* something.
- **The guard is inside `searchPulseCommunity()`, not at its call site**, for the reason given
  at `withoutNetworkCaptures()`: a call site can be added and a guard forgotten. That function is
  the only thing in the codebase that puts case-derived text into a URL, and it now allowlists
  its own input and returns `''` — searching nothing — when no term survives.
- **The local offline index is deliberately untouched.** `PulseKB.search()` still receives the
  full keyword set: it never leaves the device, so narrowing it would cost retrieval quality and
  buy no privacy.

**Verified** by `pulse-allowlist-check.js`, which pins both halves — because a filter that
achieves privacy by returning nothing is not a fix. 13 identifier shapes (surname, company,
hostname, email, `DOMAIN\user`, street address, postcode, case number, site code, serial,
project name, IPv4, a person named in prose): **0 reach the URL.** 12 realistic support symptoms
(Zebra FOTA, enrolment, certificate expiry, SQL deadlock, high CPU, profile deployment, SAML
redirect, APNS push, licensing, kiosk lockdown, MSI installer, release compatibility): **12 still
produce a usable query.** The worked example from this section now behaves as:

```
in   Jane Doe at Fabrikam Holdings reports that Zebra TC52 devices at store RDC-4471 are
     stuck on update status after the FOTA firmware push, agent 2026.1, mdmserver.contoso.com
out  https://pulse.soti.net/community/search?query=zebra%20devices%20stuck%20update%20firmware%20push
```

**Still worth doing:** obtain the Pulse access-log retention period from that service's owner and
record it in §11.4. The flow is now non-identifying, which lowers that from a gap to housekeeping,
but a live data flow with an unknown retention figure should not stay unknown.

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
| `downloads` | Session export to file; Sticky Notes export; the update zip | Justified — the update download is handed to Chrome as a URL, so the panel never fetches the file itself and needs no host permission for the host serving it |
| `alarms` | Fires the reminders set on Sticky Notes | Justified — no network capability of any kind. One alarm is armed for the next reminder due and cleared when none is pending, so it costs nothing while unused. |
| `notifications` | Shows a reminder on the desktop when the side panel is shut | Justified — the notification carries the note's own text and nothing else. It is raised locally by the service worker; no data leaves the machine and no server is contacted. |
| `host_permissions` | `*.soti.net`, `*.salesforce.com`, `*.force.com` **only** | **Strong** — no `<all_urls>`, no wildcard, and no `localhost` (removed with the on-device engine); physically prevents reaching any non-approved host |
| `optional_host_permissions` | **`m365.cloud.microsoft` and `api.github.com` — two entries, nothing else** | **Neither is granted at install.** Chrome only issues either from an explicit user gesture — the "Grant access" button in Settings for the first, the update button in the top bar for the second — and the analyst can revoke both in browser settings. Without the Copilot grant the bridge cannot read the answer and the tool does not work; without the GitHub grant the version check simply reports that it cannot see what has been published, and nothing else in the panel is affected. The three Power Automate patterns that briefly joined this list were removed in 7.7.0 with the route that needed them. |

- **`api.github.com`, and what it can and cannot do.** It was added for the update check
  (see §5.1). It is read-only and outbound to one host: the panel asks GitHub for the
  published release, tag list or `manifest.json` of the **public** SOTI AI Analyser
  repository and compares the version it finds with the one Chrome is running. **No case
  content, no account data, no identifier and no credential is sent** — the requests are
  unauthenticated `GET`s carrying no body and no token, which is why they are rate-limited
  by GitHub as anonymous traffic. `raw.githubusercontent.com` is deliberately **not** on the
  list and not in `connect-src`: the GitHub API returns file contents base64-encoded in the
  JSON, so one host is enough and a second would widen the surface for nothing.
- **The update download does not go through this permission at all.** The zip is handed to
  `chrome.downloads` as a URL; the page never fetches it, never sees its bytes and holds no
  permission for the host serving it. Nothing is installed by the extension — it cannot
  rewrite its own folder, no API exists for that, and the last step is always the analyst
  unzipping the file and pressing Reload themselves.
- **This list was pruned to one entry** and has since gained exactly one more. It previously carried `api.anthropic.com`,
  `api.openai.com`, `*.openai.azure.com`, `openrouter.ai`, `claude.ai`, `chatgpt.com` and
  `copilot.microsoft.com` as well. The adapters and relay targets behind every one of those
  have been **deleted from the source**, not disabled — see §9.11 and §12. `copilot.microsoft.com`
  went with them: the relay starts at `m365.cloud.microsoft`, which is where a work account
  signing in at the former is redirected to anyway, so the pairing that used to justify
  granting both is no longer needed.
- **The remaining override, and why it is contained.** `bridge.url` is a hidden free-text
  field that overrides the target URL. A URL outside `m365.cloud.microsoft` still opens a tab,
  but the relay types the prompt by **injecting a script**, and `chrome.scripting` requires a
  host permission the extension does not hold and the UI will not request. The relay fails
  with a 403 naming the host **before anything is typed**, so no case content is disclosed.
  This is an architectural stop, not a configuration one.

- The previously-unused **`declarativeNetRequest` permission has been removed** (and its dead service-worker code), reducing attack surface.
- **CSP** (`content_security_policy.extension_pages`, mirrored in a `<meta>` for standalone mode):
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://*.soti.net https://*.salesforce.com https://*.force.com https://api.github.com; object-src 'self'; worker-src 'self'; frame-src https://app.powerbi.com https://*.powerbi.com https://login.microsoftonline.com https://*.microsoftonline.com https://login.microsoft.com https://login.windows.net https://login.live.com https://*.analysis.windows.net; base-uri 'self'; form-action 'none'`. The `http://127.0.0.1:*` and `http://localhost:*` entries are gone with the on-device engine, and the three Power Automate hosts are gone with the team-endpoint route (7.7.0). `api.github.com` is the update check and is `connect-src` **only** — it is not on `frame-src`, so no GitHub page can be framed in the panel, and it is useless without the optional host permission above, which the policy does not grant.
  - **The two policies must say the same thing.** The `<meta>` policy in
    `SOTI_AI_Analyser.html` and the manifest's `extension_pages` policy are BOTH live on
    the side panel and the browser enforces the **intersection**, so a host named in one
    and not the other is blocked. In 7.7.0 as shipped, the `<meta>` said `frame-src 'none'`
    while the manifest allowed `app.powerbi.com`: the allowance was therefore `'none'`, and
    the Stats tab rendered Chrome's *"This content is blocked"* page instead of the report.
    Both now carry the identical list, and `tests/quick-action-fixes.test.js` asserts they
    match and loads the extension unpacked to check Chrome refuses nothing. **Any future host
    has to be added in both places**, and a refusal is no longer silent: the panel listens for
    `securitypolicyviolation` and names the blocked host and both files on screen.
  - **`frame-src` is no longer `'none'`.** The Stats tab frames the team's Power BI report
    at its secure-embed address (`app.powerbi.com/reportEmbed?…&autoAuth=true`), and Power
    BI plus the Microsoft sign-in hosts are the entire allowance. What this does and does
    not mean:
    - **No credential is involved.** The panel holds no Microsoft token and requests none.
      The report renders for whoever the browser is already signed in as, exactly as the
      Copilot bridge rides the analyst's own session. `autoAuth=true` is the parameter Power
      BI's own *Embed report → Website or portal* dialog generates: it makes the frame's
      sign-in exchange happen silently for a browser that already has a Microsoft session.
      It is not a credential and it is not a grant — the alternative embedding model, the
      one that *does* need a secret, is the service-principal + embed-token route, which
      this extension deliberately does not use.
    - **No host permission is added.** Framing is not `chrome.scripting`: the panel cannot
      read the frame's document, cannot inject into it, and cannot see whether it rendered.
      The frame is same-origin-isolated from the panel in both directions. `host_permissions`
      still names no Microsoft host, and neither does `connect-src` — so this extension
      cannot make a request to any of the added origins; it can only frame them.
    - **Why sign-in had to be on the list.** `frame-src` applies to navigations *inside* the
      frame too, and `/reportEmbed` answers a browser with no Power BI **embed** session by
      redirecting the frame to `login.microsoftonline.com`. Naming Power BI alone therefore
      blocked the sign-in half of the very flow it was allowing, and the report rendered for
      nobody. The added entries are Microsoft sign-in and Power BI hosts only.
    - **The frame still cannot go anywhere else.** Everything outside that list is refused,
      and a refusal is now *reported*: the panel listens for `securitypolicyviolation`,
      names the host that was blocked in the strip above the frame, and says which two
      files have to agree. See `statsFrameSetState`.
    - **Nothing case-related is passed to it.** The embed URL is a fixed workspace and
      report id, built from constants; no case, account, analyst name or counter is put in
      the address, and there is no `postMessage` channel to it. The Regional and Global
      sub-tabs added in 8.0.0 are two further **constant** addresses in the same Power BI
      app, differing only in the report section; they widen no policy and add no host.

### 5.1 The update check, and the backup file it exists to protect

This is an **unpacked** extension — a folder on the analyst's machine — so Chrome has no
update channel for it and nothing tells anybody that a newer build has been published. The
top bar carries a button that asks, and a screen that explains how to take the new version
without destroying the old one's data.

- **What leaves the machine: a version number request, and nothing else.** Unauthenticated
  `GET`s to `api.github.com` for the public repository's latest release, its tags, or its
  `manifest.json`. No body, no token, no identifier, no case content, no analyst name. The
  requests say nothing about who is asking beyond what any anonymous reader of a public
  repository discloses.
- **It cannot run until somebody presses the button.** The host permission is optional and
  is requested from the button's own user gesture. The periodic re-check (six-hourly at
  most) runs **only** once that permission exists, and `chrome.permissions.contains` — never
  `request` — is used on that path, so no prompt can appear for something nobody pressed.
- **Nothing is installed.** An extension cannot rewrite its own folder; no API exists for it.
  The zip is handed to `chrome.downloads` and the analyst unzips it, replaces the files and
  presses Reload. The panel's own code is therefore never replaced by anything this feature
  fetched, and the code that runs is always code a human put on disk.
- **THE BACKUP FILE IS THE SENSITIVE ARTEFACT HERE, not the version check.** "Back up my
  data" writes **everything** in `chrome.storage.local` plus `localStorage` to a single JSON
  file in the analyst's Downloads folder: cases, full chat transcripts, email chains, account
  and customer names, learned insights and settings. That is the same personal data described
  in §3, **in plaintext, outside the extension sandbox, on the local disk**, where Chrome's
  own protections no longer apply to it.
  - It is written **only** on an explicit press, never automatically, and never uploaded
    anywhere — there is no endpoint in this feature that accepts a file.
  - Treat a backup file as a case export: keep it on managed storage, and delete it once
    the new version is confirmed running. The same handling §11.4 states for session exports
    applies to it unchanged.
  - **Restore replaces, and says so twice.** It refuses anything that is not a backup of this
    tool, requires the word `RESTORE` to be typed, and writes a dated copy of whatever is
    currently stored to Downloads **before** clearing anything — so a restore of the wrong
    file is recoverable rather than terminal.
- **The safer route needs no file at all**, and it is step one on the screen: replace the
  files *inside* the folder Chrome is already loading and press Reload. Chrome sees the same
  extension updated in place and deletes nothing. Data is lost only when the extension is
  **removed**, which is Chrome deleting its storage — not a fault in this tool, and not
  something the tool can prevent from the other side of it.

---

## 6. Storage, retention & data-subject rights

- **Store:** `chrome.storage.local` — sandboxed, per-extension, **survives Chrome "Clear browsing data"** (history/cache/cookies); only lost on extension uninstall or explicit clear. `localStorage` is used **only** in the standalone fallback page. **Plaintext at rest — see §9.1.**
- **Retention (storage limitation):**
  - Cases auto-purge after **30 days** of inactivity.
  - Learned insights auto-purge after **90 days**.
  - Both verified to **delete from storage**, not merely hide.
- **Erasure (right to be forgotten):** a **"Clear all cases & logs"** control plus per-case deletion.
- **Data minimisation:** raw log dumps are stripped from persisted chat history.
- **No cross-device or cross-analyst propagation.** `chrome.storage.sync` is not used anywhere
  in the codebase (verified). There is no backend, no shared store and no central console: one
  analyst's cases, transcripts and insights are not reachable by another analyst through this
  tool. **The chat history relayed into Copilot is the exception** — see §6.3.

### 6.1 Learned insights — a structured store that cannot hold personal data

A learned insight is written when an analyst rates an analysis 👍/👎, and is re-injected into
later prompts whose logs carry the same failure signature. Insights are **device-local** and are
never transmitted anywhere except back into a later Copilot prompt.

**The record holds five fields, and every one is drawn from a fixed vocabulary declared in
source** (`sidepanel.js`, `buildInsightRecord`):

| Field | Permitted values | Where the vocabulary is defined |
|---|---|---|
| `product` | one of the 5 SOTI products in the Product `<select>`, or empty | `INSIGHT_PRODUCT_VOCAB` |
| `category` | one of the 19 failure categories, or empty | derived from `LOG_SIGNAL_RULES`, so the two cannot drift |
| `signature` | one of ~75 curated exception/error class names, or empty | `INSIGHT_SIGNATURE_VOCAB` |
| `verdict` | `confirmed` or `corrected` | literal check |
| `id`, `ts` | a random local id and a timestamp | generated on device |

**Nothing derived from case text, log text, the analyst's question or the model's answer is
persisted.** A value that is not in the vocabulary is not redacted — it is simply not stored.

> **This is a guarantee by construction, not by filtering.** The claim is not that identifiers
> are removed; it is that **no path exists to put customer or personal data into the store.**
> It is verified by reading one function, not by testing a filter against inputs someone
> thought of.

**Why the previous design was replaced.** Until this build an insight stored the model's prose —
root cause, resolution, and the analyst's typed correction — and two scrubbing passes stripped
identifiers from it. That is a **blocklist over unbounded free text**, and testing the shipped
functions against adversarial inputs found it leaking mixed-case hostnames
(`MdmServer.Contoso.com`), phone numbers, IPv6 addresses, postal addresses, any person named in a
sentence an engineer typed, and — where a case's account and contact fields were never populated —
names the first pass had nothing to match against. Each gap was individually closable. The class
of failure was not: *"no identifier we thought of survives"* is not *"no identifying data"*, and
only the second answers the question a data-protection review actually asks.

**Verification (re-runnable).** This is not a claim to be taken on trust: it is pinned by
`security-answers-check.js` in the verification harness, which loads the shipping `sidepanel.js`
and drives the real functions — nothing is copied or re-implemented. Re-run it before accepting
this section. The shipping `buildInsightRecord` was driven with a case object
carrying 13 distinct identifiers pushed through every available channel — a customer name typed
into the Product field, a customer-authored exception class (`Contoso.Payments.OrderException`), a
customer name as a log category, plus email, phone, IPv6, postcode, street address, case number,
username and account name elsewhere on the case:

- **13 identifiers in, 0 in the record.** The hostile case produced an entirely empty record,
  which `saveLearnedInsight` then declines to store at all.
- Namespaces are discarded before matching, so `System.IO.IOException` is stored as
  `IOException` and `Contoso.Payments.OrderException` is stored as nothing.

**Migration of existing records.** Insights written by the previous build are **rebuilt, not
re-scrubbed**, the first time this build reads them: every field is put back through the
vocabulary checks and everything unrecognised is discarded along with the prose it came from.
Verified on a legacy record containing a customer name, company, phone number, hostname and a
third party's name — **0 survived**, while the structured signal (`SOTI MobiControl` /
`Auth/Permission` / `SecurityException` / `corrected`) was preserved. Free-text fields therefore
stop existing at first load rather than at the end of their 90 days.

**Retention** remains 90 days (`INSIGHT_RETENTION_MS`), kept even though a current-schema record
holds no personal data: the store is still a record of support activity and should not accumulate
without bound.

**What this costs, stated plainly.** An insight can no longer say *why* a past case failed. It can
say that `SecurityException / Auth/Permission on SOTI MobiControl` was confirmed once and
**corrected twice**, and that is what the model is told — a calibration signal pointing at the
failure modes this tool has been overturned on, not a remembered diagnosis. The narrative was the
feature's main value and it was given up deliberately to make the guarantee above unconditional.

### 6.2 Deletion at source does **not** propagate

**A deletion in Salesforce has no effect on any copy held by this tool.** Nothing watches
Salesforce for deletions; the local store is a one-way cache and Salesforce remains the system
of record. Specifically, when a case disappears from a synced list view the local row is
**deliberately kept** and flagged `notInLastSync` (`sidepanel.js:4929`), on the reasoning that a
case vanishing is a fact the analyst should see rather than have silently hidden. Case content
already scraped into a working tab is never re-checked. On the Copilot side a source deletion
has no effect whatsoever on chats already relayed.

**Consequence for an erasure request:** after deletion at source, the local copy persists until
the 30-day inactivity purge or a manual clear, and the Copilot copy persists under tenant
policy. Erasure is therefore a **manual, multi-step, per-device process** — see §11.5, which
this makes a rollout blocker rather than a documentation task.

### 6.3 Who can read an analyst's chat history

| Who | Can they? | Basis |
|---|---|---|
| The analyst | Yes | Their own panel |
| Anyone with access to that OS profile or device | **Yes — plaintext** | No app-level authentication (§9.6) and no encryption at rest (§9.3). Includes admin, backup and disk-image access. BitLocker is the mandated compensating control (§10.4) and is not enforced by the tool |
| Another analyst, through this tool | **No** | No `chrome.storage.sync`, no backend, no shared store (verified) |
| M365 tenant administrators, eDiscovery / Purview, legal hold | **Yes, for the Copilot copy** | Relayed chats sit in the analyst's own Copilot history, titled by case number, and are reachable exactly as any other Copilot chat that analyst has. **Governed by the tenant, not by this application** — the M365 administrator must answer this one |
| Anyone given an exported file | Yes | The panel can export a session to a file; once exported it is an ordinary file outside every control above |

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
- **No local model, inference server or installer** is part of this build. An earlier
  architecture required one; removing it takes a locally-listening HTTP service, its CORS
  configuration and a third-party installer off the attack surface entirely, along with the
  `localhost` host permission and `connect-src` entries that reached them.

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
4. **[RESOLVED] Case-derived text leaving the device to a first-party host.** Previously open:
   up to six keywords taken from the case issue summary and customer email bodies were sent to
   `pulse.soti.net` in a URL query string — a carrier that lands in web-server/CDN access logs
   under that service's retention policy, outside this application's controls — on essentially
   every quick action against an open case. The tokeniser behind it ran a **blocklist**, which
   removed Salesforce field *labels* and kept the *values*, so surnames, company names,
   hostnames and usernames all travelled. **Replaced with an allowlist** built from a curated
   technical vocabulary plus the failure taxonomy and exception classes already declared in
   source; an unrecognised token is not sent, and the guard sits inside `searchPulseCommunity()`
   rather than at its call site. 13 identifier shapes produce nothing; 12 realistic symptoms
   still search normally. Detail and re-runnable verification in §4.1.
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
9. **[RESOLVED] Learned insights can no longer hold personal data.** Previously open: insights
   stored the model's prose behind two scrubbing passes, and adversarial testing of the shipped
   functions found that blocklist leaking mixed-case hostnames, phone numbers, IPv6, postal
   addresses, third parties named in free text, and names in cases whose account/contact fields
   were never populated. **Replaced with a structured store** whose every field comes from a
   fixed vocabulary declared in source — product, failure category, exception class, verdict.
   13 identifiers pushed through every input channel produced an empty record; legacy records
   are rebuilt rather than re-scrubbed on first read. Detail and re-runnable verification in
   §6.1.
10. **[INFO] Vendored libraries are not integrity-pinned.**
11. **[RESOLVED] Dormant third-party AI adapters and their origins — removed.** Previously
    open: the OpenAI, Azure OpenAI and Anthropic adapters were present and functional in
    `ai-provider.js`, the hidden provider `<select>` carried their options, `connect-src`
    permitted `api.anthropic.com`, `api.openai.com`, `*.openai.azure.com` and `openrouter.ai`,
    and the bridge's own target table offered `claude.ai` and `chatgpt.com` alongside the two
    Microsoft hosts. Nothing selected any of it and no data ever reached them — there was no
    API key committed, `active()` was pinned to the bridge, and the host permissions were never
    granted — but the guarantee rested on **configuration rather than construction**. Now
    removed outright; see §5 and the change log at §12. The claim this supports is stronger and
    is the one to give a reviewer: **there is no code in the build capable of sending case
    content anywhere except `m365.cloud.microsoft`.**

12. **[LOW] Model-drafted text is placed in a customer-facing email composer.** "Account Email"
   (PROJECT_OVERVIEW §5.8.1) writes an AI-drafted body, a subject, and a Cc list read off the
   Account record into the case's Email composer. It follows (5): case content is
   attacker-influenceable, so the drafted text must be treated as advisory and read before it
   goes. *Compensating controls, all three deliberate rather than incidental:* **it never
   presses Send** — there is no Send lookup in the code, so no defect in it can result in mail
   leaving; the analyst sees the full draft and the whole Cc list, each name removable, in a
   confirmation box before anything touches the page; and the **To** field is read and never
   written, so the tool cannot decide who a customer email is addressed to. Cc addresses come
   from Salesforce's own recipient lookup by name — the tool never composes an address out of
   a name, and a name the org's lookup does not resolve is reported rather than guessed at.
13. **[LOW → CLOSED in 7.7.0] Usage telemetry left the device once the analyst opted in.**
   PROJECT_OVERVIEW §5.8.4. The finding was against the **team endpoint** route, which
   `POST`ed the report to a Power Automate trigger that wrote it into a SharePoint list.
   **That route has been removed from the source** — the send function, the button, the
   endpoint field, the stored setting, the three `connect-src` hosts and the three
   `optional_host_permissions` patterns all went together. The extension **originates no
   outbound request of its own** again, holds no credential, and can no longer be granted
   permission to reach those hosts. Both remaining sharing controls are *pages*: **Open my
   board** renders inside the extension, and **Send to the dashboard** opens a tab with the
   report in the URL **fragment**, which is never part of an HTTP request.
   *What is left, and it is unchanged:* the counters themselves — presses per action, sync
   counts, cases opened and closed, the span each was open, 👍/👎 — plus the analyst's own
   name, a random per-install id and the panel version, held in `chrome.storage.local` and
   **plaintext at rest like everything else there (§9.1)**. There is still **no case content
   in the report**, which remains a property of its shape rather than of a redaction step.
   As of 7.7.0 the *Usage & Feedback* readout is also hidden in Settings unless
   `soti_usage_admin` is set locally — a UI decision, **not** an access control, and not to
   be assessed as one.
   *The open question that survives the removal:* whether an engineer's activity metrics
   being collected at all is acceptable under the organisation's monitoring and
   works-council obligations. The levers are unchanged — the counters are per-install, the
   name is clearable, and every sharing control ships with an empty address.

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
8. ~~**Prune the manifest**: remove `optional_host_permissions` and `connect-src` entries for the providers this build does not offer~~ — **done.** The adapters, the relay targets, the settings panes, the manifest origins and the `connect-src` entries were removed together (§5, §9.11, §12). `connect-src` is now `'self'` plus the three first-party SOTI/Salesforce origins only, and no code path exists that could reach a third-party AI service.
9. ~~Remove the unused `declarativeNetRequest` permission~~ — **done**; consider further narrowing `tabs`/`scripting`.
10. ~~Add HTML-escaping in `md()`~~ — **done** (defence-in-depth alongside CSP).
11. ~~**Harden the local inference host**~~ — **no longer applicable.** There is no on-device inference server or installer in this build (§8).

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
| Recipients | **Microsoft** (Microsoft 365 Copilot), as processor to the organisation's own M365 tenant. Full case content — case record, email chain, internal notes, meeting notes and log text — is disclosed **unredacted** (§4.2). No new processor is engaged by this tool: the data enters the tenant's existing, licensed Copilot service through the analyst's own authenticated session. **Second, first-party flow:** up to six search terms are sent to `pulse.soti.net` (SOTI-operated) in a query string. Until 7.0.0 these were case-derived keywords and could carry personal data; they are now drawn from a fixed technical vocabulary and **no longer constitute a disclosure of personal data** — see §4.1 |
| International transfers | **Determined by the M365 tenant, not by this application.** The tool makes no direct connection to Microsoft; the transfer occurs inside the analyst's Copilot session and follows the tenant's own data-residency configuration and the Microsoft DPA/SCCs already in place. **Obtain the tenant's Copilot data-residency position from the M365 administrator and record it here:** _____. The `pulse.soti.net` flow in §4.1 is SOTI-internal; **confirm the hosting region of that service with its owner** before signing off this entry |
| Retention | **Two stores, two owners.** *Controlled by this application:* cases (including the analyst's chat transcript) auto-purge after 30 days of inactivity; learned insights after 90 days; manual erasure available. *Not controlled by this application:* (a) the copy of every prompt and answer held in the analyst's **Copilot chat history**, retained under the tenant's M365/Purview policy — obtain and record it here: _____; (b) the §4.1 keywords, under Pulse's own access-log retention — see §11.4 |
| Technical/organisational measures | Scoped host permissions (no `<all_urls>`); optional, revocable, user-granted permission for the Copilot origins; hardened CSP; no API key or service account for the AI service; 30/90-day retention limits; learned insights restricted by construction to a fixed vocabulary, so no free text can be stored (§6.1); `.har` credential redaction; OS disk encryption (mandated, §10.4). **Note the gaps:** local storage is **not encrypted at rest** (§9.3) and the prompt path to Copilot is **not redacted** (§4.2). See this document |

### 11.3 DPIA trigger assessment

**A DPIA is required, not merely advisable.** The earlier "likely warrants" wording was written
for a build whose inference ran on the analyst's own device and disclosed case content to nobody.
That is no longer the architecture, and the change removes the discretion: this build performs
**systematic, large-scale processing of customer personal data by an AI service, with a
disclosure to a processor**, and does so on every case an analyst opens rather than occasionally.

**Art. 35(3) triggers engaged:**

| Trigger | Engaged? | Basis |
|---|---|---|
| (a) Systematic and extensive automated evaluation | **Yes** | Every open case is analysed automatically; the tool industrialises what was previously ad hoc |
| (b) Large-scale special category data | **Not expected** | Confirm logs and case narratives carry no Art. 9 data — see §11.1 |
| (c) Systematic monitoring of a publicly accessible area | No | — |
| Innovative use of new technology (Rec. 91) | **Yes** | Generative AI applied to customer support content |
| Data processed without the data subject's knowledge | **Yes** | Customer contacts named in a case are not told their case content is put to an AI |

**The DPIA must cover, at minimum:**

1. **Necessity and proportionality** of disclosing full, unredacted case content — including
   customer names, contact details and diagnostic logs — to Copilot, versus a redacted or
   summarised prompt. **A redaction pass on the prompt path does not exist today** (§9.1); the
   DPIA is where the decision to build one or accept its absence should be recorded.
2. **The scope question in §9.1** — whether the organisation's existing Copilot approval was
   scoped to customer support content and diagnostic logs at this volume.
3. **The two retention surfaces this application does not control** (§11.2): Copilot chat
   history under tenant policy, and `pulse.soti.net` access logs.
4. **The §9 residual risks**, in particular no encryption at rest (§9.3) and prompt injection
   now having an exfiltration path (§9.5). The case-derived keyword flow (§9.4) is closed.
5. **The erasure process** (§11.5), which is manual, per-device, and does **not** follow a
   deletion in Salesforce — see §6.2.
6. **The residual identifiability of learned insights** (§6.1) — de-identified, not anonymous,
   with the measured gaps recorded there.

**Accountability:** the DPIA is the DPO's and the business owner's to complete. This document
supplies the technical facts it needs; it is not itself a DPIA and must not be filed as one.

### 11.4 Retention policy statement

**Controlled by this application** (device-local, verified to delete from storage):
- Case working data, **including the analyst's chat transcript with the tool**: auto-deleted after **30 days of inactivity**. The clock runs on last activity, not creation, so an actively worked case does not age out.
- Learned insights: auto-deleted after **90 days** from creation.
- Analysts may erase everything immediately ("Clear all cases & logs"), or delete per case.
- Salesforce remains the system of record; the local store is a working cache. **A deletion in Salesforce does not propagate here — see §6.2.**

**NOT controlled by this application** — both must be filled in by their owners before this section is signed off:
- **Copilot chat history.** Every prompt and answer also exists as an ordinary chat in the analyst's own M365 Copilot history, retained under the tenant's M365/Purview policy. **No 30- or 90-day figure applies to it.** The tool does not delete these by default (deliberately — the case-numbered titles are the audit trail of what was sent); an optional setting deletes each relayed chat after its answer is read, and that sweep only ever matches chats this tool titled. Whether a compliance copy survives such a deletion is a tenant question. Obtain the retention period and the deletion semantics from the M365 administrator and record here: _____.
- **`pulse.soti.net` access logs.** Retained under that service's own web-server/CDN access-log policy. **As of 7.0.0 the search terms reaching it are allowlisted technical vocabulary and carry no customer or personal data (§4.1)**, so this is no longer a personal-data retention gap — but a live outbound flow should still have a known retention figure. Obtain from the service owner and record here: _____.

> **Correction for anyone holding an earlier statement of this section:** "90 days" has never been
> the chat-history figure. Local chat history is bounded at **30 days of inactivity**; 90 days
> applies to learned insights only; and the Copilot-side copy is bounded by neither.

### 11.5 Data-subject rights handling

- **Access/erasure is manual, multi-step and per-device.** There is no central store to query and no single control that satisfies a request. Document and rehearse this process **before** rollout — §6.2 makes it a blocker, not a paperwork item.
- **The steps a request requires:**
  1. Identify every analyst who worked the case — there is no index, so this comes from Salesforce case ownership, not from the tool.
  2. On each such device: extension → "Clear all cases & logs" (clears cases, per-case log text, learned insights and the queue), or per-case deletion for a narrower scope.
  3. Tenant-side: locate and remove the relayed Copilot chats, which are titled with the case number and therefore findable — and confirm with the M365 administrator whether that removal is sufficient for a Purview/legal-hold copy.
  4. Any session the analyst **exported to a file** is outside all of the above and must be handled separately.
- **Rectification** has no mechanism at the insight level and no longer needs one: an insight holds no case detail to correct, only a verdict counter against a failure signature.
- **No longer required:** the previous recommendation to clear learned insights at rollout is withdrawn. Legacy records are rebuilt to the structured schema the first time this build reads them (§6.1), so the free-text fields are gone at first load rather than after 90 days.

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
  the device). §1–§5 and §9–§10 were rewritten for it.
- **Build 4.1.0 — the last of the local-inference path was deleted from the codebase**: the
  provider adapter, the model probes and picker, the setup scripts, the `localhost` host
  permissions and `connect-src` entries, and the settings pane that configured them. §8, §12,
  §14 and `UNINSTALL.md` were rewritten to match, and the superseded findings were removed
  with the architecture they described (§14).
- Build 3.0.0 also removed the run-time off-device warnings — the amber banner, the warning
  toast on save, and the "OFF-DEVICE" wording — on the grounds that a permanent warning over
  a setting nobody can change is noise rather than consent. **The consequence for this
  document is that the disclosure is no longer signalled in the UI**, so it must be carried by
  training and policy instead (§10.3).
- **Hardened the local-inference installer** across several findings — origin scoping, a
  verified install path ahead of a fetch-and-eval one, and Authenticode verification of the
  downloaded binary. **All of it was superseded when that architecture was removed**; the
  installer no longer ships and its findings are no longer live controls. See §14.
- **Corrected §4, §9, §11.2 and §11.4**, which previously stated that only product/version terms reached `pulse.soti.net` and that there were no external recipients. A source review found case-derived keywords are sent to that host; the flow is now documented in full at §4.1 and tracked as an open risk at §9.4. **This was a documentation error, not a regression** — the behaviour pre-dated the claim.
- **Hardened the Pulse-sync domain check** from a substring match to strict hostname parsing (see §14.4).
- **Pinned the extension ID** via a `key` in `manifest.json`. Still live, and still load-bearing:
  Chrome keys `chrome.storage.local` by extension ID, so the pin is what stops a redeploy
  presenting as a first run with no saved cases (`UNINSTALL.md` §4).
- **Added a rollback/uninstall procedure** (`UNINSTALL.md`).
- **Build 7.0.0 — re-verified by execution, and three defects corrected.** The five
  data-protection questions were re-answered by running the shipping code under the
  verification harness (`security-answers-check.js`, 37 checks) rather than by re-reading this
  document. It found and this revision fixes: (a) **every line-number citation in §4.1 and §6.2
  had drifted** — all eight pointed at unrelated code, which for a document whose value is that
  a reviewer can check it is the most damaging kind of error it can carry; (b) §11.2 still
  listed "two-pass de-identification of learned insights" as a technical measure, describing the
  design §6.1 records as **replaced**; (c) `ai-provider.js` logged `providers: bridge, openai,
  anthropic` at start-up, so a reviewer opening the console would have seen three providers in a
  build whose `ADAPTERS` table has held exactly one since 4.1.0. The **behaviour** claims in
  §6.1, §6.2, §6.3 and §4.1 were re-tested and all held, including the 13-identifier hostile
  case producing an empty insight record.
- **Build 7.0.0 — the `pulse.soti.net` keyword flow (§4.1 / §9.4) is closed.** The community
  search query is now built from an **allowlist** of recognised technical terms — curated
  product, platform, symptom and networking vocabulary, plus the failure taxonomy and vetted
  exception classes already declared in source, 514 terms in total — rather than from a
  blocklist that removed Salesforce field labels and kept the values behind them. An
  unrecognised token is not sent. The guard sits inside `searchPulseCommunity()` rather than at
  its call site, so a future call site cannot bypass it, and the function searches nothing when
  no term survives. The **offline index was deliberately left alone**: it never leaves the
  device, so narrowing it would cost retrieval quality for no privacy gain. Pinned by
  `pulse-allowlist-check.js`, which tests both halves — 13 identifier shapes produce nothing,
  12 realistic support symptoms still search normally.

---

## 13. Scope & disclaimer

This assessment covers the extension source in this repository as of **build 7.0.0, 2026-09-03**. It does **not** cover: the security of the host OS, Salesforce-side access controls, physical/endpoint security, or the organisational GDPR programme. It is an engineering assessment and must be validated by the security team's own review and an independent penetration test of the packed/signed artefact before global rollout.

---

## 14. Penetration test — findings & resolutions

A dynamic pentest was performed against the running application: live browser network
capture, CSP-violation instrumentation, 14 HTML-injection payloads and ReDoS timing.
Findings and their resolutions:

> **Read as history, not as current state.** These findings were raised against an earlier
> architecture, and **none of them has been re-tested against the Copilot relay** — that is
> §10.7, and it is outstanding.
>
> **Findings that concerned the on-device inference server and its installer have been
> removed along with them.** They covered a locally-listening HTTP service, its CORS
> configuration and a third-party installer, none of which exists in this build, and a
> closed finding about a component that is gone reads as a live control somebody must still
> be maintaining. The full text of every one of them, and of the installer review that was
> §15, remains in this file's own history: `git log -p --follow -- Extension/SECURITY.md`.

### 14.3 [MEDIUM] No encryption at rest — unchanged, open by prior decision (see §9.1).

### 14.4 [LOW → RESOLVED] Weak substring domain check
- **Found:** `isPulseUrl = url.includes('pulse.soti.net')` would also accept `pulse.soti.net.attacker.example`.
- **Resolved:** now `new URL(url).hostname === 'pulse.soti.net'`. **Verified:** real Pulse URLs accepted; subdomain-spoof, path-spoof, and credential-spoof (`pulse.soti.net@attacker.example`) all rejected. (Chrome `host_permissions` remain an independent second layer.)

### 14.5 Controls that held under active attack (verified, no change needed)
- **14 HTML-injection payloads** (external `<img>` beacon, SVG `onload`, `<script>`, meta-refresh, form-action hijack, `object`/`embed`, `<base href>`, CSS `@import`, `javascript:` URI, `onerror`, `data:` URI script, iframe `srcdoc`) — **all neutralised** by `md()` escaping; none reached the DOM as a live element.
- **CSP as an independent second layer** — with escaping deliberately bypassed (raw `innerHTML`), the external image beacon was still **blocked** (`securitypolicyviolation`, `img-src`, `enforce`) and SVG `onload` did **not** execute.
- **ReDoS** — all 506 regex literals scanned; the one flagged pattern ran in 4 ms against a 300 KB pathological payload. No catastrophic backtracking.
- **No** `eval`/`new Function`/dynamic-string timers in app code; **no** hardcoded secrets; download filenames are hardcoded (no path traversal); tab/case names use `.textContent`.
- **Network egress** during full normal usage: only `pulse.soti.net` (first-party), the
  Copilot relay tab's own origin, and local files. **The one exception to that — the
  Power Automate `POST` — was removed in 7.7.0**, so the extension again originates no
  request on its own behalf. The Stats tab's Power BI frame is not a counter-example: the
  requests are the framed document's own, made as the analyst's existing session, and the
  panel neither sees them nor can put anything of its own into them.

