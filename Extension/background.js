/* ============================================================================
 * SOTI AI Analyser — Background Service Worker
 * ============================================================================
 * A "service worker" is a tiny script Chrome runs in the background for the
 * extension. It has NO user interface and Chrome may stop/restart it at any time,
 * so it must be small and stateless. (See PROJECT_OVERVIEW.md §4.)
 *
 * This one does exactly one thing:
 *   1. setPanelBehavior(...) — tells Chrome to open our side panel when the user
 *      clicks the toolbar icon (instead of a popup).
 *
 * It holds NO network permissions and issues no requests. All the real work
 * happens in sidepanel.js — not here.
 * ============================================================================ */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

chrome.runtime.onInstalled.addListener(() => {
  console.log('SOTI AI Analyser Extension Installed');
});
