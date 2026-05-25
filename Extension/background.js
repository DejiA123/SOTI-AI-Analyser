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
