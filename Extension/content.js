// SOTI AI Analyser - Salesforce Content Script (v2)
console.log('SOTI AI Analyser: Salesforce Content Script Loaded');

function cleanFieldValue(raw) {
    if (!raw) return '';
    
    // Salesforce often jams everything together: "CompanyNameOpen CompanyName PreviewEdit Account Name"
    // We want the text BEFORE the first action word.
    let clean = raw.trim();
    
    // Split by any of the known Salesforce "button" words
    const actionWords = ['Open', 'Preview', 'Edit', 'Close', 'Show Actions'];
    for (const word of actionWords) {
        if (clean.includes(word)) {
            const parts = clean.split(word);
            if (parts[0].trim().length > 0) {
                clean = parts[0].trim();
                break; // Found the split point
            }
        }
    }

    // Secondary cleanup for common label noise
    return clean
        .replace(/(Account Name|Contact Name|Case Number|Subject|Case Owner|Account|Contact)/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// Helper to check if an element is actually visible to the user
function isVisible(el) {
    if (!el) return false;
    
    // Basic CSS checks
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    
    // Salesforce-specific hidden classes
    if (el.classList.contains('slds-hide') || el.classList.contains('slds-is-collapsed')) return false;
    
    // Check for aria-hidden
    if (el.getAttribute('aria-hidden') === 'true') return false;

    // Check positioning (Salesforce often moves background tabs off-screen)
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (rect.left < -500 || rect.top < -500) return false;

    return true;
}

// Helper to find elements across Shadow DOM boundaries
function findInShadows(selector, root = document, onlyVisible = false) {
    let results = Array.from(root.querySelectorAll(selector));
    if (onlyVisible) results = results.filter(isVisible);

    const walkers = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    
    let node = walkers.nextNode();
    while (node) {
        if (node.shadowRoot) {
            results.push(...findInShadows(selector, node.shadowRoot, onlyVisible));
        }
        node = walkers.nextNode();
    }
    return results;
}

// Recursive search for a specific ID across Shadow DOMs
function findElementByIdInShadows(id, root = document) {
    if (!id) return null;
    let el = root.querySelector(`[id="${id}"]`);
    if (el) return el;
    
    const walkers = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walkers.nextNode();
    while (node) {
        if (node.shadowRoot) {
            el = findElementByIdInShadows(id, node.shadowRoot);
            if (el) return el;
        }
        node = walkers.nextNode();
    }
    return null;
}

// Helper to find the main container for the currently active Salesforce tab/workspace
function getActiveWorkspaceRoot() {
    // 1. Try to find the active tab in the tab bar and follow its 'aria-controls' to the content
    const activeTabs = findInShadows('.oneConsoleTabItem.slds-is-active a, .oneConsoleTabItem.active a, a[aria-selected="true"]', document, false);
    for (const tab of activeTabs) {
        const controlsId = tab.getAttribute('aria-controls');
        const target = findElementByIdInShadows(controlsId);
        if (target) {
            console.log('SOTI AI Analyser: Found active root via aria-controls', target);
            return target;
        }
    }

    // 2. Fallback to scoring if the tab bar mapping fails
    const containers = findInShadows('.oneWorkspaceTabWrapper, .navexWorkspaceCard, .viewport, .oneConsoleTabWrapper, .forceRecordLayout', document, false);
    
    if (containers.length === 0) return document;

    // Score each container based on visibility signals
    const scored = containers.map(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        let score = 0;
        
        if (style.display !== 'none') score += 10;
        if (style.visibility !== 'hidden') score += 10;
        if (parseFloat(style.opacity) > 0.1) score += 10;
        if (el.getAttribute('aria-hidden') !== 'true') score += 15;
        if (!el.classList.contains('slds-hide')) score += 15;
        if (el.classList.contains('slds-is-active') || el.classList.contains('active')) score += 20;

        if (rect.width > 100 && rect.height > 100) score += 20;
        if (rect.left >= -50 && rect.top >= -50 && rect.left < window.innerWidth) score += 50;
        
        return { element: el, score };
    });

    scored.sort((a, b) => b.score - a.score);
    
    if (scored.length > 0 && scored[0].score > 50) {
        return scored[0].element;
    }
    
    return document;
}

function getFieldValue(labelEl) {
    const fieldComponent = labelEl.closest('records-record-layout-item, lightning-output-field, .slds-form-element');
    if (fieldComponent) {
        // Try the most specific value element first
        const valueEl = fieldComponent.querySelector(
            'lightning-formatted-text, ' +
            'lightning-formatted-name, ' +
            'lightning-formatted-url a, ' +
            'a[data-refid="recordId"], ' +
            'a[href*="/lightning/r/"], ' +
            '.slds-form-element__static, ' +
            'slot[name="outputField"] lightning-formatted-text'
        );
        if (valueEl) {
            return cleanFieldValue(valueEl.textContent);
        }

        // Broader container fallback
        const control = fieldComponent.querySelector('.slds-form-element__control');
        if (control) {
            const clone = control.cloneNode(true);
            clone.querySelectorAll('button, .slds-button, [class*="action"], .test-id__action').forEach(el => el.remove());
            return cleanFieldValue(clone.textContent);
        }
    }

    // Simple sibling fallback
    const sibling = labelEl.nextElementSibling;
    if (sibling) {
        return cleanFieldValue(sibling.textContent);
    }

    return '';
}

function scrapeSalesforce() {
    const data = {
        caseNumber: '',
        contactName: '',
        accountName: '',
        subject: '',
        description: '',
        currentVersion: '',
        product: '',
        licenseType: '',
        emailChain: ''
    };

    // Find the root of the active case to avoid pulling data from background tabs
    const activeRoot = getActiveWorkspaceRoot();
    console.log('SOTI AI Analyser: Scraping from root', activeRoot);

    const fieldLabels = findInShadows(
        '.test-id__field-label, .slds-form-element__label, span.test-id__field-label',
        activeRoot,
        false
    );

    fieldLabels.forEach(label => {
        const text = label.textContent.trim().toLowerCase();
        if (text.includes('case number') && !data.caseNumber) {
            data.caseNumber = getFieldValue(label);
        }
        if ((text === 'contact name' || text === 'contact') && !data.contactName) {
            data.contactName = getFieldValue(label);
        }
        if ((text === 'account name' || text === 'account') && !data.accountName) {
            data.accountName = getFieldValue(label);
        }
        if (text === 'subject' && !data.subject) {
            data.subject = getFieldValue(label);
        }
        if (text === 'description' && !data.description) {
            data.description = getFieldValue(label);
        }
        if (text.includes('current version') && !data.currentVersion) {
            data.currentVersion = getFieldValue(label);
        }
        if (text === 'product' && !data.product) {
            data.product = getFieldValue(label);
        }
        if (text.includes('license type') && !data.licenseType) {
            data.licenseType = getFieldValue(label);
        }
    });

    // Fallback: Try the page header for Case Number
    if (!data.caseNumber) {
        const headerTitle = document.querySelector('lightning-formatted-text[slot="primaryField"], .slds-page-header__title .uiOutputText');
        if (headerTitle) {
            const val = headerTitle.textContent.trim();
            if (/^\d{6,}$/.test(val)) data.caseNumber = val;
        }
    }

    // Attempt to capture Email Chain / Feed
    // Look for common Salesforce email/chatter body selectors (Lightning & Classic)
    const feedItems = findInShadows('article.cuf-feedItem', activeRoot, false);
    
    if (feedItems.length > 0) {
        const chain = feedItems.slice(0, 700).map(item => {
            // Target the header columns specifically
            const leftCol = item.querySelector('.preamble_left');
            const rightCol = item.querySelector('.preamble_right');
            
            const sender = leftCol ? (leftCol.innerText || leftCol.textContent).trim() : 'Unknown';
            const time = rightCol ? (rightCol.innerText || rightCol.textContent).trim() : '';
            
            // Identify type using attributes and icons
            const typeAttr = item.getAttribute('data-type') || '';
            const hasCallIcon = item.querySelector('.slds-icon-standard-log-a-call, [title*="Call"]');
            const isInternal = item.innerText.includes('Internal') || item.querySelector('.preamble_custom-preamble')?.innerText.includes('Internal');
            
            let typePrefix = '';
            if (typeAttr.includes('Call') || hasCallIcon) typePrefix = '[CALL LOG] ';
            else if (isInternal) typePrefix = '[INTERNAL] ';

            // Collect content from all possible body locations
            // Using textContent for summary because Salesforce often hides it with CSS
            const summary = item.querySelector('.preamble_custom-summary')?.textContent.trim() || '';
            const emailBody = item.querySelector('.emailMessageBody')?.innerText.trim() || '';
            const callBody = item.querySelector('.logCallDescription')?.innerText.trim() || '';
            const postBody = item.querySelector('.forceChatterFeedBodyText, .feedBodyInner')?.innerText.trim() || '';
            
            // Special check for EmailMessageEvent rich text attributes
            const richTextEl = item.querySelector('emailui-rich-text-output');
            let richText = '';
            if (richTextEl && richTextEl.getAttribute('value')) {
                const raw = richTextEl.getAttribute('value');
                // Simple HTML-to-text conversion for the encoded value
                richText = raw.replace(/<[^>]*>/g, ' ')
                             .replace(/&nbsp;/g, ' ')
                             .replace(/&quot;/g, '"')
                             .replace(/&lt;/g, '<')
                             .replace(/&gt;/g, '>')
                             .trim();
            }

            // Prefer the longest content to avoid truncated summaries
            let content = [emailBody, callBody, postBody, richText, summary]
                .filter(Boolean)
                .sort((a, b) => b.length - a.length)[0] || '';
            
            if (content.length < 5) return null;
            
            return `[${time}] ${typePrefix}${sender}:\n${content}`;
        }).filter(Boolean).join('\n\n' + '='.repeat(40) + '\n\n');
        
        if (chain) data.emailChain = chain;
    }

    // Fallback: If feed scraping failed, try broader selectors
    if (!data.emailChain) {
        const emailSelectors = [
            '.email-body',
            '.email-thread-view',
            '.forceChatterEmailMessageBody',
            '.forceChatterFeedItemBody',
            '.slds-feed__item-content',
            'lightning-formatted-rich-text.email-message-body',
            '.email-message-body',
            '.email-thread-item',
            '.email-item-body'
        ];
        
        const emailItems = findInShadows(emailSelectors.join(', '), activeRoot, false);
        if (emailItems.length > 0) {
            const seen = new Set();
            data.emailChain = emailItems
                .slice(0, 700)
                .map(item => (item.innerText || item.textContent).trim())
                .filter(txt => {
                    if (txt.length < 40 || seen.has(txt.slice(0, 100))) return false;
                    seen.add(txt.slice(0, 100));
                    return true;
                })
                .join('\n\n' + '='.repeat(40) + '\n\n');
        }
    }

    return data;
}

// Listen for requests from the side panel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "GET_SALESFORCE_DATA") {
        const data = scrapeSalesforce();
        console.log('SOTI AI Analyser: Scraped Data', data);
        sendResponse(data);
    }
    return true;
});
