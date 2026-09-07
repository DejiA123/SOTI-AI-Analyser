# Rollback & Uninstall — SOTI AI Analyser

Everything this extension puts on a machine, and how to reverse it. Written for support
teams and for IT/Security review.

There is **no installer**. The extension is a folder of files loaded into Chrome; it needs
no Administrator rights, writes nothing to `HKLM`, `C:\Program Files` or the Windows
directory, creates no service, no scheduled task, no environment variable and no firewall
rule. Nothing is installed on the machine outside Chrome's own profile.

> **Earlier builds shipped a local-AI installer** (`setup_local_ai.bat` /
> `setup_local_ai.ps1`) which installed an on-device model server and downloaded a ~7 GB
> model. That path is gone: this build has no on-device engine and asks for no localhost
> permission. If you ran that installer on a machine and need the rollback steps for it,
> they are in this file's own history — `git log --follow -- Extension/UNINSTALL.md`.

---

## 1. What the extension holds

| # | What | Where | Reversible |
|---|---|---|---|
| 1 | Cases, chat history, case fields | `chrome.storage.local` (this extension's own area) | Yes — §3 |
| 2 | Attached log text, per case | `chrome.storage.local`, under `caseLogs:<id>` keys | Yes — §3 |
| 3 | Learned insights (👍/👎 feedback) | `chrome.storage.local` | Yes — §3 |
| 4 | The open-case queue and its column layout | `chrome.storage.local` | Yes — §3 |
| 5 | AI provider settings (relay target, context size, answer language) | `chrome.storage.local` | Yes — §3 |
| 6 | The offline SOTI Pulse knowledge index | `chrome.storage.local` | Yes — §3 |
| 7 | Sticky Notes and their reminders | `chrome.storage.local`, under `soti_sticky_notes` | Yes — §3, and they can be exported to a file first |

All seven live in the same store and all seven go when the extension is removed.

> **Sticky Notes are the one thing here that is not recoverable from Salesforce.** Everything
> else in this list can be synced again from the record it came from; a note an engineer typed
> cannot. Export them (Quick Options → Sticky Notes → Export) before removing the extension if
> they are worth keeping — the file is plain JSON and imports back into a fresh install.

> Reminders are scheduled with `chrome.alarms` and shown with `chrome.notifications`. Both are
> local to the browser profile, neither can reach the network, and removing the extension
> cancels every outstanding alarm along with it.

### Host access

Granted in `manifest.json` and visible on the extension's own Chrome page:

- `https://*.salesforce.com/*`, `https://*.force.com/*` — reading the case you are on.
- `https://*.soti.net/*` — SOTI Pulse and JIRA.

Plus **optional** hosts, which Chrome asks about the first time they are needed and which
are granted only for the AI provider actually in use — the Copilot relay
(`m365.cloud.microsoft`, `copilot.microsoft.com`), or an API endpoint if one is configured.
Revoke any of them at `chrome://extensions` → SOTI AI Analyser → **Details** → *Site access*.

### What it does *not* do

No Administrator elevation, no machine-wide environment variables, no antivirus exclusions,
no firewall changes, no registry writes, no accounts, no scheduled tasks, no telemetry, and
no network listener of any kind.

---

## 2. Where case data goes

This is the part worth reading before a rollout, because removing the extension does not
un-send anything.

The panel relays each prompt through a **Microsoft 365 Copilot browser tab the engineer is
already signed in to**. The prompt carries scraped Salesforce case content and customer log
text, so that material reaches Copilot under your own M365 tenancy and its retention rules
— the same place it would go if the engineer had pasted it into Copilot by hand. Nothing is
sent to any other AI service unless an API provider is deliberately configured in
Settings (⚙) → AI Provider.

`SECURITY.md` in this folder is the full account, and it is what a data-protection review
should be reading.

---

## 3. Remove the extension and its data

Go to `chrome://extensions`, find **SOTI AI Analyser**, click **Remove**.

That deletes every item in §1 — all case data, chat history, attached logs and learned
insights — and it is **not recoverable afterwards**. Export anything still needed first:
⋮ menu → **Export Session**.

To clear the data but keep the extension, use Settings (⚙) → **Clear all cases & logs now**.
That wipes cases, logs and learned insights immediately and keeps the AI settings and the
offline knowledge base, neither of which is customer data.

Conversations the relay created in Copilot are **not** part of the extension's storage and
are not removed with it. The panel titles them by case number and cleans up after itself
where it can; anything left is deleted from Copilot's own chat history.

---

## 4. Extension ID

`manifest.json` contains a `key` field that fixes the extension ID to:

```
odkmlcpmfgdfoikmcmhoongggbepbdna
```

Keeping it matters for one reason: **Chrome keys `chrome.storage.local` by extension ID**.

- **If you change or remove the `key`**, the ID changes and the extension presents as a
  first run with no saved cases. Export before changing it.
- **If you deploy from the Chrome Web Store or by enterprise policy**, that ID wins, and
  the same reset applies to anyone moving from a hand-loaded copy to the deployed one.
- Reloading the unpacked extension **from a different folder** keeps the same ID as long as
  the `key` is unchanged, so moving or renaming the folder does not lose any data — Chrome
  simply needs the new path pointed at once.

The private half of the key lives at `soti-extension-signing-key.pem` in the repository
root and is **git-ignored**. It is needed only to publish a `.crx` under this same ID —
back it up somewhere secure. The extension does not need it to run.
