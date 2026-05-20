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
  
  const rules = [
    {
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'remove' }
        ],
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
          { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, POST, OPTIONS, PUT, DELETE' },
          { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' }
        ]
      },
      condition: {
        urlFilter: '*://localhost:11434/*',
        resourceTypes: ['xmlhttprequest']
      }
    },
    {
      id: 2,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'remove' }
        ],
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
          { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, POST, OPTIONS, PUT, DELETE' },
          { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' }
        ]
      },
      condition: {
        urlFilter: '*://127.0.0.1:11434/*',
        resourceTypes: ['xmlhttprequest']
      }
    }
  ];

  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existingRules.map(r => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
      addRules: rules
    });
    console.log('CORS bypass rules updated successfully');
  } catch (e) {
    console.error('Failed to setup CORS bypass rules:', e);
  }
}
