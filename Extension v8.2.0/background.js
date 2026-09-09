/* ============================================================================
 * SOTI AI Analyser — Background Service Worker
 * ============================================================================
 * A "service worker" is a tiny script Chrome runs in the background for the
 * extension. It has NO user interface and Chrome may stop/restart it at any time,
 * so it must be small and stateless. (See PROJECT_OVERVIEW.md §4.)
 *
 * It does three things:
 *   1. setPanelBehavior(...) — tells Chrome to open our side panel when the user
 *      clicks the toolbar icon (instead of a popup).
 *   2. Fires the reminders set on Sticky Notes, as real desktop notifications.
 *   3. Keeps a CLOCK running for the Copilot relay — see THE RELAY'S CLOCK at
 *      the bottom of this file. This is the one job here that cannot be done
 *      anywhere else, because a service worker is the only part of the
 *      extension Chrome does not slow down when nobody is looking at a window.
 *
 * It holds NO network permissions and issues no requests. All the real work
 * happens in sidepanel.js — not here.
 * ============================================================================ */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

/* ============================================================================
 * STICKY NOTE REMINDERS
 * ============================================================================
 * WHY THIS IS IN THE SERVICE WORKER AND NOT IN THE PANEL.
 *
 * The panel has its own timer and pops its own reminder dialog — that is the good
 * case, and it is the one that shows the note's whole text and offers snooze. But
 * the panel only runs while it is OPEN, and a reminder to call a customer at three
 * o'clock is worth nothing if it needs you to have left a side panel open since
 * this morning. Only the service worker survives that, so the DESKTOP notification
 * is fired from here.
 *
 * Nothing is duplicated in the two places: the notes live in chrome.storage.local
 * and both sides read the same records. A reminder that has fired here is stamped
 * `notifiedAt` so the desktop notification goes out exactly once; the panel's own
 * dialog keys off `reminderDone` instead, so anything you were away for is still
 * waiting for you on screen when you come back — which is the behaviour every
 * reminder people actually rely on has.
 *
 * NO POLLING. One alarm is armed for the NEXT reminder due and re-armed after each
 * firing, so an engineer with no reminders set costs exactly zero wakeups. Chrome
 * may run an alarm up to a minute late; for "ring me when it is time to call" that
 * is well inside tolerance, and the panel's own timer is exact when it is open.
 * ========================================================================== */
const NOTES_KEY = 'soti_sticky_notes';
const NOTE_ALARM = 'soti-note-reminders';
const NOTE_PREFIX = 'sotinote:';

async function readNotes() {
  try {
    const got = await chrome.storage.local.get(NOTES_KEY);
    const v = got && got[NOTES_KEY];
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

async function writeNotes(notes) {
  try { await chrome.storage.local.set({ [NOTES_KEY]: notes }); } catch (e) { /* best effort */ }
}

function noteIsPending(n) {
  return !!(n && n.reminderAt && !n.reminderDone && !n.notifiedAt);
}

// What the notification says on its title line. The KIND is the point of the
// reminder — "call" and "email" are different jobs — so it leads, and the case
// number follows it where there is one.
const REMINDER_KIND_LABEL = {
  call: '📞 Reminder: call',
  email: '📧 Reminder: email',
  followup: '🔁 Reminder: follow up',
  check: '🔍 Reminder: check',
  meeting: '📅 Reminder: meeting',
  other: '⏰ Reminder'
};

function reminderTitle(n) {
  const base = REMINDER_KIND_LABEL[n && n.reminderKind] || REMINDER_KIND_LABEL.other;
  const caseNo = (n && n.caseNumber) ? String(n.caseNumber).trim() : '';
  return caseNo ? `${base} — ${caseNo}` : base;
}

// The note's own words, trimmed to what a notification will actually show.
function reminderMessage(n) {
  const t = String((n && n.text) || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'This note has no text yet — open SOTI AI Analyser to see it.';
  return t.length > 220 ? t.slice(0, 219) + '…' : t;
}

async function armNextReminder() {
  const notes = await readNotes();
  const due = notes.filter(noteIsPending).map(n => n.reminderAt).sort((a, b) => a - b);
  try { await chrome.alarms.clear(NOTE_ALARM); } catch (e) { /* nothing armed */ }
  if (!due.length) return;
  // `when` in the past fires straight away, which is exactly right for a reminder
  // whose time passed while the browser was closed.
  try { await chrome.alarms.create(NOTE_ALARM, { when: Math.max(Date.now() + 500, due[0]) }); }
  catch (e) { /* alarms unavailable — the panel's own timer still covers the open case */ }
}

async function fireDueReminders() {
  const notes = await readNotes();
  const now = Date.now();
  let changed = false;

  for (const n of notes) {
    if (!noteIsPending(n) || n.reminderAt > now) continue;
    // Stamped BEFORE the notification is raised. If creating it throws, the reminder
    // is still marked as fired rather than re-raised on every subsequent alarm — the
    // panel's dialog is what makes sure it is not lost.
    n.notifiedAt = now;
    changed = true;
    try {
      await chrome.notifications.create(NOTE_PREFIX + n.id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: reminderTitle(n),
        message: reminderMessage(n),
        priority: 2,
        // A reminder that vanishes after five seconds is a reminder you can miss by
        // looking away. It stays until it is answered.
        requireInteraction: true,
        buttons: [{ title: 'Snooze 10 min' }, { title: 'Done' }]
      });
    } catch (e) { /* notifications turned off at the OS level — nothing else to do here */ }
  }

  if (changed) await writeNotes(notes);
  await armNextReminder();
}

async function updateNote(id, patch) {
  const notes = await readNotes();
  const n = notes.find(x => x && x.id === id);
  if (!n) return;
  Object.assign(n, patch, { updatedAt: Date.now() });
  await writeNotes(notes);
  await armNextReminder();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === NOTE_ALARM) fireDueReminders();
});

/* The panel writes the notes; this is how the worker hears about it. Re-arming on
 * every change is what makes a reminder set thirty seconds ago fire on time instead
 * of whenever the next unrelated alarm happened to be. The worker's own write of
 * `notifiedAt` comes back through here too — harmless, because a notified reminder
 * is no longer pending and cannot re-arm itself. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes && changes[NOTES_KEY]) armNextReminder();
});

chrome.runtime.onStartup.addListener(() => { armNextReminder(); });

chrome.runtime.onInstalled.addListener(() => {
  console.log('SOTI AI Analyser Extension Installed');
  armNextReminder();
});

// The worker is also restarted cold by an alarm or a message; re-arming on load
// covers the case where it was evicted with a reminder still outstanding.
armNextReminder();

chrome.notifications.onButtonClicked.addListener(async (id, index) => {
  if (!String(id).startsWith(NOTE_PREFIX)) return;
  const noteId = String(id).slice(NOTE_PREFIX.length);
  if (index === 0) {
    // Snooze — the reminder is pushed forward and un-fired, so it rings again.
    await updateNote(noteId, { reminderAt: Date.now() + 10 * 60 * 1000, notifiedAt: null, reminderDone: false });
  } else {
    await updateNote(noteId, { reminderDone: true });
  }
  try { await chrome.notifications.clear(id); } catch (e) {}
});

chrome.notifications.onClicked.addListener(async (id) => {
  if (!String(id).startsWith(NOTE_PREFIX)) return;
  try { await chrome.notifications.clear(id); } catch (e) {}
  // Open the panel on the window the person is actually looking at. A notification
  // click counts as the user gesture sidePanel.open() asks for; where it does not,
  // this simply does nothing rather than throwing into the worker's log.
  try {
    const win = await chrome.windows.getLastFocused();
    if (win && win.id != null) await chrome.sidePanel.open({ windowId: win.id });
  } catch (e) { /* the notification itself already did the job */ }
});

/* ============================================================================
 * THE RELAY'S CLOCK
 * ============================================================================
 * THIS IS THE FIX FOR "sometimes I have to hover over the taskbar before the
 * Copilot page loads and the message sends".
 *
 * The relay runs in a window nobody is looking at — that is the whole point of
 * it. Chrome treats such a window as OCCLUDED, and occlusion does three things,
 * of which only two were ever addressed:
 *
 *   · it reports the page as hidden        — the liveness shim in
 *                                            copilot-bridge.js lies about that;
 *   · it stops painting, so animation      — the shim schedules a fallback;
 *     frames never arrive
 *   · it CLAMPS EVERY TIMER IN THE PAGE.   — nothing addressed this.
 *
 * The third is the one that was still costing runs. setTimeout in a hidden page
 * is clamped to roughly once a second, and after the window has been hidden for
 * five minutes Chrome throttles it INTENSIVELY: about once a MINUTE. Every wait
 * in the relay is built on setTimeout — waiting for the composer to mount,
 * waiting for the send button to come alive, waiting for the composer to empty
 * so the send can be proved, waiting between rounds of the frame survey. Under a
 * one-minute clamp a fifteen-second wait gets ONE look at the page and then
 * reports that there is nothing there. That is "no message box found" on a page
 * that has one, and "it would not send" on a message that went perfectly — both
 * of them cured by touching the taskbar, because hovering the taskbar makes
 * Chrome paint the window, and painting it un-throttles every timer in it.
 *
 * A service worker has no window, so it has no visibility, so nothing throttles
 * it. It ticks the relay tab every 200ms, and the page's waits step off those
 * ticks instead of off their own clamped timers — see sleep() and
 * SOTI_BRIDGE_TICK in copilot-bridge.js. The side panel borrows the same clock
 * through SOTI_SW_SLEEP, because the panel lives in the engineer's window and is
 * hidden the moment they look at another application.
 *
 * The ticking itself is what keeps this worker alive: an extension API call
 * resets Chrome's 30-second idle timer, and there is one every 200ms. It is
 * bounded three ways all the same — a hard deadline, the relay tab closing, and
 * the panel switching it off when the answer is in.
 * ========================================================================== */
const PUMP = { tabId: null, timer: null, until: 0 };
// Fast enough that a wait built on it is as responsive as an unthrottled page
// (150ms is the relay's own polling step), slow enough to be free.
const PUMP_INTERVAL_MS = 200;
// A ceiling, not a schedule. Nothing should ever reach it — the panel stops the
// pump when the answer lands — but a panel closed mid-answer cannot, and a pump
// nobody can stop is a pump that runs until the browser does.
const PUMP_MAX_MS = 15 * 60 * 1000;

function pumpStop() {
  if (PUMP.timer) clearTimeout(PUMP.timer);
  PUMP.timer = null;
  PUMP.tabId = null;
  PUMP.until = 0;
}

function pumpBeat() {
  PUMP.timer = null;
  const tabId = PUMP.tabId;
  if (tabId == null) return;
  if (Date.now() > PUMP.until) return pumpStop();
  try {
    const p = chrome.tabs.sendMessage(tabId, { type: 'SOTI_BRIDGE_TICK' });
    if (p && typeof p.catch === 'function') {
      p.catch((e) => {
        /* A tick that lands nowhere is NORMAL and must not stop the clock: the
         * page is mid-navigation, or the bridge has not been injected yet, and
         * the ticks are needed most in exactly those moments. Only the tab
         * itself being gone ends it. */
        if (/No tab with id/i.test((e && e.message) || '') && PUMP.tabId === tabId) pumpStop();
      });
    }
  } catch (e) { /* same reasoning — transient */ }
  if (PUMP.tabId === tabId) PUMP.timer = setTimeout(pumpBeat, PUMP_INTERVAL_MS);
}

function pumpStart(tabId) {
  if (tabId == null) return false;
  // Re-asserting extends the deadline. The panel does this on every survey round
  // precisely so that a worker Chrome recycled mid-request starts ticking again.
  PUMP.until = Date.now() + PUMP_MAX_MS;
  if (PUMP.tabId === tabId && PUMP.timer) return true;
  if (PUMP.timer) clearTimeout(PUMP.timer);
  PUMP.tabId = tabId;
  pumpBeat();
  return true;
}

chrome.tabs.onRemoved.addListener((id) => { if (PUMP.tabId === id) pumpStop(); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'SOTI_RELAY_PUMP') {
    if (msg.on) pumpStart(msg.tabId);
    else if (msg.tabId == null || PUMP.tabId === msg.tabId) pumpStop();
    sendResponse({ ok: true, tabId: PUMP.tabId });
    return false;
  }

  /* THE PANEL'S OWN SLEEP, MEASURED SOMEWHERE THAT IS NOT THROTTLED.
   *
   * The side panel is a page in the engineer's window, so the moment they look
   * at another application it is hidden and its timers are clamped exactly like
   * the relay's. The panel drives the whole startup sequence — settle the tab,
   * survey the frames, wait, survey again — on a 40-second deadline, and under
   * intensive throttling one 1.5-second wait between rounds can swallow the
   * whole of it. So the wait is measured here and the answer posted back; the
   * panel keeps its own timer racing this one and takes whichever arrives
   * first, so a recycled worker degrades to the old behaviour rather than
   * hanging. Capped, because this holds the response channel open. */
  if (msg.type === 'SOTI_SW_SLEEP') {
    const ms = Math.max(0, Math.min(30000, Number(msg.ms) || 0));
    setTimeout(() => { try { sendResponse({ ok: true, ms }); } catch (e) { /* panel closed */ } }, ms);
    return true;
  }
});
