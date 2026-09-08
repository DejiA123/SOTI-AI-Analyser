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
(Case Summary, Draft Email, With a meeting request, Account Email, JIRA,
Problem & Resolution).

Working your queue:

  1. Open your case list in Salesforce (e.g. Cases → My Open Cases).
  2. In the panel, click the "Open Cases" tab, then "Sync from Salesforce".

The ↻ on the end of that blue button does the same thing but presses Salesforce's
OWN Refresh on the list first — the ↻ beside "Current View" — and waits for the
new rows before reading them. Use it when the tab has been open a while: a
Lightning list view is a snapshot of the moment it loaded and does not re-query
because time has passed, so a plain sync on a tab you have had open all day reads
this morning's queue. Nothing about that result looks wrong, which is exactly why
the button exists.

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


DRAFTING AN EMAIL WITH A MEETING REQUEST
----------------------------------------

Quick Options -> "📅 With a meeting request".

The same email "Draft an email to the customer" writes, but the live session is
asked for outright rather than left to the tool's own reading of the case. The
booking link goes in exactly as you set it, with an agenda built from what this
case actually needs directly underneath it.

The plain draft above it still decides for itself whether a call is warranted —
On-Prem log collection, a session already offered, the customer asking for one —
and it is right to; most replies should not propose one. This button is for when
you already know the answer.

It reads the case first, so it does not get the history wrong: if a session is
already booked it writes the email as confirming that appointment, if one has been
offered and not booked it chases it, and if one has already been held it says
plainly that this is a further session. And if the reply also establishes the fix,
the fix still goes in — asking for a call is not a substitute for answering.


BOOKINGS LINKS (Settings -> AI Settings)
----------------------------------------

You can keep several, each with a NAME.

The name is the important part. Three Microsoft Bookings pages are
indistinguishable from one another — they are all
outlook.office.com/bookwithme/user/<guid> — so name them by what you would choose
them by: "30-min triage", "Deep dive", "Team escalation".

  * The FIRST link is the default. It is the one added automatically when a draft
    genuinely needs a session, and the one "With a meeting request" takes without
    asking when it is the only one you have.
  * With more than one, pressing "With a meeting request" asks which to use.
  * Clear a link's address, or press its ×, to remove it. Nothing is saved until
    you press Save.
  * An address that does not start with https:// is refused and named, and the
    good ones beside it are still saved.

If you had a single bookings link set in an earlier version it is already in the
list — you do not have to type it again.


USAGE & FEEDBACK (Settings -> AI Settings)
------------------------------------------

A count, on this device, of what you actually use: which Quick Options you press,
how often you sync, how long your cases stay open, and your 👍/👎.

The point is feedback. Knowing which of twenty actions people press decides what
gets built next and, more usefully, what gets removed — a panel of twenty
shortcuts where five are used is a panel where the five are hard to find.

WHAT IS COUNTED: presses, per action, with when you last used each; the sync
buttons, each separately; the three actions that write to Salesforce; questions
typed into the chat, as distinct from buttons pressed; 👍/👎; cases opened and
closed, and how long each was open.

WHAT IS NOT: any case content, of any kind. No case number, account, customer,
contact, subject, description, log line, question or answer. There is no free-text
field in the report at all except your own name and the panel version, so nothing
about a case can reach it even by accident. Press "Copy report" to read the exact
bytes.

SHARING IT. Press "Send to the dashboard". That opens the shared board in a
background tab with your report on the end of the address, and the page writes it
into the board itself — this extension cannot post anywhere and does not. Tick
"Send automatically, once a day" if you would rather not remember. Clear the
dashboard address to keep everything on this device; the counters still work and
nothing is shared.

The shared board:

  https://claude.ai/code/artifact/f34ef254-178b-4774-b11b-b2cf47a7a51e

Everyone signed in to this organisation who has the link can read it. It shows
which actions are used most, by whom, the sync and case-timing figures, and — the
part that is actually the point — the list of actions nobody has ever pressed.

"Clear counters" deletes the numbers on this device. Anything already sent to the
board stays there.

ACCOUNT EMAIL
-------------

Quick Options -> "Account Email".

The same reply "Draft an email to the customer" writes, but it also fills the
email in on the case for you, with the account's own team on the Cc line.

What it does, in order:

  1. Reads which account the case is against.
  2. Opens that Account record in the background — the same hidden window the
     queue sync uses — and reads the Account Owner, TAM, Backup TAM and Aligned
     Support Engineers 1 to 4 off it. Your Salesforce tab is not moved.
  3. Drafts the email to the customer.
  4. Shows you the draft with the Cc list beside it. Every name has an × on it,
     so you can drop anyone who should not be on this one, and the subject and
     the message are both editable.
  5. Presses "Fill in Salesforce" and the case's own Email composer is filled
     in — Feed tab, Email, Cc, subject, message.

IT DOES NOT SEND. The composer is left filled in and open in front of you. You
read it and press Send yourself. Nothing about this action puts mail in front of
a customer on its own.

The Cc line is filled through Salesforce's own recipient lookup, by name — the
Account record holds names, not addresses, and this tool never makes an address
up out of a name. If the lookup does not recognise somebody, you are told who,
by name, so you can add them by hand. It never quietly leaves a name off.

Two other things it tells you rather than deciding for you:

  * If the To field is empty, it says so. Salesforce normally fills To in from
    the case contact; this tool does not touch it, because who the email is
    ADDRESSED to is not a decision to make from a field on another record.
  * If Salesforce has already put a subject in (a reply carries "RE: <their
    subject>", which is the thread their mail client recognises), that subject is
    kept and the drafted one is not forced over the top of it.

If the write stops halfway — a tab that had gone stale, a composer caught
mid-render — the draft is not lost. There is a "Put in the Salesforce email"
button under the answer in the chat that opens the same box again, with the same
Cc list, so you can have another go without drafting the email a second time.

STICKY NOTES AND REMINDERS
--------------------------

Your own notes about cases — the things that are not in the record. Off until
you ask for it:

  Quick Options -> + Add actions -> tick "Sticky Notes & Reminders"

Then press the button it puts on the panel. "+ New note" and start typing; the
note saves itself. Each note can take a colour, a pin, and the case number it is
about (one button stamps the case you have open), and the board filters down to
one case, to what is pinned, or to what is due.

REMINDERS. Put a time on a note and pick what it is for — call, email, follow
up, check, meeting. At that time you get a desktop notification with the note's
own words on it, whether or not the side panel is open, with Snooze 10 min and
Done on the notification itself. If the panel IS open you get the fuller version
on screen: everything that fell due, each row snoozeable for ten minutes, an
hour or until tomorrow morning. Anything that came due while you were away is
still waiting when you come back.

IMPORT AND EXPORT. "Export" writes every note and reminder to a .json file —
for a backup, for a new laptop, or to hand a case's notes to a colleague.
"Import" reads one back and asks whether to merge it with what you already have
(the newer edit wins where the same note is in both) or replace the board.

Notes live only on this machine, in the extension's own storage. They are the
one thing here that cannot be synced again from Salesforce, so export them
before you remove the extension.


WHERE YOUR DATA GOES
--------------------

Worth understanding before you use it on a customer case.

  * Case content and log text are sent to Microsoft 365 Copilot to be analysed.
    They leave your machine.
  * Usage counters — presses, syncs, timings, your name and the panel version —
    are kept on this device. No case content is in that report; see the section
    above for exactly what is and is not. The extension never posts them anywhere:
    the sharing controls OPEN a page, they do not send. Those controls live in an
    admin-only section of Settings, and they ship with no address, so on an
    ordinary install nothing is shared at all.
  * The Stats tab shows your team's Power BI report, rendered by Power BI itself
    for the Microsoft account your browser is already signed in to. Nothing about
    your cases is passed to it, and the extension holds no Microsoft credential.
    If it comes up blank, press "Open in Power BI" — signing in cannot always
    finish inside an embedded frame.
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
  background.js            Service worker; opens the side panel and fires the
                           reminders set on Sticky Notes
  styles.css               UI styling
  icons/                   The toolbar icon, and the icon on a reminder
                           notification (16/32/48/128 px)

OCR (lib/ — required):
  tesseract.v5.min.js, worker.min.js, tesseract-core*.wasm(.js),
  eng.traineddata.gz       On-device screenshot OCR (Tesseract v5)

Knowledge base (knowledge/ — required):
  MobiControl.md, Connect.md, XSight.md, and their *_Knowledge.md companions
                           Product context sent alongside a case, so a hosted
                           model knows what a Deployment Server is
  PulseKnowledge.md        Offline copy of SOTI Pulse, used by the search index
  KB Articles.md           1,958 compiled Salesforce Knowledge articles. LOADED ON
                           FIRST START — the panel reads it into its own store once,
                           on a machine that has none of its own, so the articles are
                           searchable and their index goes up with the product
                           reference without anybody pressing Sync Knowledge. Press
                           Sync Knowledge when you want anything newer than the file;
                           a base you have synced yourself is never overwritten.

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
