/* ============================================================================
 * SOTI AI Analyser — Background Service Worker
 * ============================================================================
 * A "service worker" is a tiny script Chrome runs in the background for the
 * extension. It has NO user interface and Chrome may stop/restart it at any time,
 * so it must be small and stateless. (See PROJECT_OVERVIEW.md §4.)
 *
 * This one does just two things:
 *   1. setPanelBehavior(...) — tells Chrome to open our side panel when the user
 *      clicks the toolbar icon (instead of a popup).
 *   2. setupCorsBypassRules() — clears any leftover dynamic network rules so the
 *      extension doesn't accidentally alter request headers on the user's other
 *      tabs. We deliberately add NO active rules (addRules: []).
 *
 * All the real work happens in sidepanel.js — not here.
 * ============================================================================ */
// SOTI AI Analyser - Background Service Worker
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

chrome.runtime.onInstalled.addListener(async () => {
  console.log('SOTI AI Analyser Extension Installed');
  await setupCorsBypassRules();
});

chrome.runtime.onStartup.addListener(async () => {
  await setupCorsBypassRules();
});

async function setupCorsBypassRules() {
  if (!chrome.declarativeNetRequest) return;
  
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existingRules.map(r => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
      addRules: [] // No active rules, preventing header corruption on other tabs
    });
    console.log('CORS bypass rules cleared successfully');
  } catch (e) {
    console.error('Failed to clear CORS bypass rules:', e);
  }
}
