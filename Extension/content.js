/* ============================================================================
 * SOTI AI Analyser — Salesforce Content Script
 * ============================================================================
 * A "content script" is JavaScript that Chrome injects INTO another web page —
 * here, Salesforce (see manifest.json "content_scripts"). Its job: read the open
 * case's fields off the Salesforce page and send them to our side panel, so the
 * engineer doesn't have to retype the case number, product, version, etc.
 *
 * Why scrape the page instead of using the Salesforce API? The API needs OAuth,
 * admin setup, and credentials; scraping the already-open page needs none of that.
 * The trade-off: if Salesforce changes its HTML, the selectors below may need
 * updating. (Full rationale in PROJECT_OVERVIEW.md §5.8.)
 *
 * The tricky parts, and the helpers that handle them:
 *   • Salesforce hides fields inside "Shadow DOM" (isolated DOM sub-trees) →
 *     findInShadows() / findElementByIdInShadows() walk into those sub-trees.
 *   • Background tabs are moved off-screen, not removed → isVisible() filters them.
 *   • Field text is jammed together with button labels
 *     (e.g. "Acme CorpOpen Preview Edit") → cleanFieldValue() strips the noise.
 *   • scrapeSalesforce() ties it together; the onMessage listener at the bottom
 *     responds when the side panel asks for a scrape.
 * ============================================================================ */
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

/* ----------------------------------------------------------------------------
 * Feed auto-load — "scroll to the bottom before scraping"
 * ----------------------------------------------------------------------------
 * Salesforce renders only the newest handful of feed posts and lazy-loads older
 * ones as you scroll. A plain scrape therefore captures the TAIL of the email
 * chain and silently misses everything before it. So before scraping we drive
 * the feed's own infinite scroll to the end.
 *
 * Two things make this fiddly:
 *   • The Lightning Console does NOT scroll `window`. The feed sits inside a
 *     nested scroller (.forceChatterScroller, the workspace tab body, ...), so
 *     window.scrollTo() does nothing. We walk up from a real feed item and
 *     scroll every scrollable ancestor we find.
 *   • There is no reliable "end of feed" flag — the "End of Feed" marker is in
 *     the DOM even when more posts can still load. We stop when the post count
 *     stops growing for a few rounds instead, with hard round/time caps so a
 *     slow or enormous case can never hang the sync.
 * -------------------------------------------------------------------------- */

// Set to false to stop the sync expanding collapsed posts (see expandFeedPosts).
const EXPAND_FEED_POSTS = true;

const FEED_ITEM_SELECTOR = 'article.cuf-feedItem, article.cuf-feedElement';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The feed list itself. Prefer whichever candidate holds the most posts — a case
// page can contain more than one feed-ish container (e.g. a background tab).
function findFeedContainer(root) {
    const countIn = el => el.querySelectorAll(FEED_ITEM_SELECTOR).length;

    const feeds = findInShadows('.cuf-feed', root, false);
    if (feeds.length) {
        return feeds.slice().sort((a, b) => countIn(b) - countIn(a))[0];
    }

    // No .cuf-feed (Salesforce markup drift) — climb from any feed item instead.
    const items = findInShadows(FEED_ITEM_SELECTOR, root, false);
    if (items.length) {
        return items[0].closest('.forceChatterFeed, .forceChatterScroller, .cuf-feed') || root;
    }
    return null;
}

// Every element between `el` and the document, crossing shadow boundaries.
// We keep the whole chain rather than pre-filtering for "currently scrollable",
// because a container only starts overflowing once enough posts have loaded —
// filter on each pass instead (see scrollChainToBottom).
function getAncestorChain(el) {
    const chain = [];
    let node = el;

    while (node && node !== document) {
        if (node.nodeType === Node.ELEMENT_NODE) chain.push(node);
        node = node.parentNode;
        // A shadow root's parentNode is null; hop to its host to keep climbing.
        if (node && node.nodeType === Node.DOCUMENT_FRAGMENT_NODE && node.host) node = node.host;
    }

    const doc = document.scrollingElement || document.documentElement;
    if (doc && !chain.includes(doc)) chain.push(doc);
    return chain;
}

function isScrollable(el) {
    if (el === document.scrollingElement || el === document.documentElement) {
        return el.scrollHeight > el.clientHeight + 4;
    }
    const oy = window.getComputedStyle(el).overflowY;
    return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
           el.scrollHeight > el.clientHeight + 4;
}

function scrollChainToBottom(chain) {
    for (const el of chain) {
        if (isScrollable(el)) el.scrollTop = el.scrollHeight;
    }
}

const LOAD_MORE_RE = /(view|show|load)\s+more|older posts|more posts/i;

/**
 * On a long chain Salesforce stops auto-loading and puts a "View More" button at
 * the foot of the feed — scrolling alone then gets you nowhere. Click it.
 *
 * Scope note: `region` must be the whole Chatter feed component (.forceChatterFeed),
 * NOT the .cuf-feed post list — the button renders in a container that sits
 * OUTSIDE the post list. It must also stay narrower than the page, because the
 * case sidebar has its own unrelated "Show More" buttons (Milestones, Knowledge)
 * we mustn't touch.
 */
function clickFeedLoadMore(region) {
    let clicked = 0;
    // Salesforce has shipped this as a <button>, a bare <a href="javascript:void(0)">
    // and a role="button" span over the years, so accept all three.
    for (const el of region.querySelectorAll('button, a, [role="button"]')) {
        const label = ((el.textContent || '') + ' ' + (el.getAttribute('title') || '')).trim();
        // A long label means we've matched some wrapper that merely CONTAINS the
        // words (e.g. a post whose body says "show more"), not the control itself.
        if (label.length > 40 || !LOAD_MORE_RE.test(label)) continue;
        if (!isVisible(el)) continue;
        el.click();
        clicked++;
    }
    return clicked;
}

/**
 * Scroll the case feed until no more posts load.
 * Returns { items, rounds, reason } — never throws; a failure just means we
 * scrape whatever was already on screen, exactly as before this existed.
 */
async function loadEntireFeed(root, opts = {}) {
    const {
        maxRounds    = 80,     // hard cap on scroll attempts
        settleMs     = 700,    // pause after each scroll so Salesforce can fetch
        stableRounds = 3,      // stop after this many rounds with no new posts
        maxMs        = 60000   // overall time budget
    } = opts;

    const feed = findFeedContainer(root);
    if (!feed) return { items: 0, rounds: 0, reason: 'no-feed-found' };

    const countItems = () => feed.querySelectorAll(FEED_ITEM_SELECTOR).length;

    // Remember where the user was so we can put the page back afterwards.
    const anchor = feed.querySelector(FEED_ITEM_SELECTOR) || feed;
    const chain = getAncestorChain(anchor);
    const originalTops = chain.map(el => el.scrollTop);

    // Salesforce's infinite-scroll sentinel lives on the scroller, a few levels
    // ABOVE .cuf-feed — so look for it from there, not from the feed's parent.
    const scroller = feed.closest('.forceChatterScroller') || feed.parentElement || feed;
    // The "View More" button renders OUTSIDE the .cuf-feed post list (in a
    // .cuf-showMoreContainer), so searching for it needs the whole feed component.
    // Prefer the OUTER container: the button can sit as a sibling of .forceChatterFeed
    // rather than inside it. Still far narrower than the page, so the sidebar's own
    // Show More buttons stay out of reach (see clickFeedLoadMore).
    const feedRegion =
        feed.closest('.supportCompactRecordFeedContainerDesktop') ||
        feed.closest('.forceChatterFeed') ||
        scroller;

    const started = Date.now();
    let previous = countItems();
    let stable = 0;
    let rounds = 0;
    let reason = 'exhausted-rounds';

    while (rounds < maxRounds) {
        if (Date.now() - started > maxMs) { reason = 'time-budget'; break; }
        rounds++;

        // Push every scroller to its bottom; one of them is the real one.
        scrollChainToBottom(chain);
        // Belt and braces: pull the last post (and the infinite-scroll sentinel,
        // if present) into view, which is what actually trips Salesforce's
        // IntersectionObserver on some layouts.
        const trigger = scroller.querySelector('.loadMoreTrigger');
        const items = feed.querySelectorAll(FEED_ITEM_SELECTOR);
        const last = items[items.length - 1];
        try { (trigger || last)?.scrollIntoView({ block: 'end' }); } catch (_) {}

        // Now that the foot of the feed is on screen, click any "View More" that
        // was blocking further scrolling. Order matters: clicking after the scroll
        // mirrors what a human does, and guarantees the button is rendered.
        const clicked = clickFeedLoadMore(feedRegion);

        // A click fires a server round-trip, which routinely outlasts one settle.
        await sleep(clicked ? settleMs * 2 : settleMs);

        const current = countItems();
        if (current > previous) {
            previous = current;
            stable = 0;
        } else {
            stable++;
        }

        // Be more patient while we're actively clicking "View More" — the posts
        // may simply still be in flight. Bounded, so a button that never resolves
        // still terminates (and maxRounds/maxMs bound the whole loop regardless).
        if (stable >= (clicked ? stableRounds + 3 : stableRounds)) {
            reason = 'no-new-posts';
            break;
        }
    }

    if (EXPAND_FEED_POSTS) await expandFeedPosts(root, feed);

    // Put the user's scroll position back — the sync shouldn't move their page.
    chain.forEach((el, i) => { el.scrollTop = originalTops[i]; });

    return { items: countItems(), rounds, reason };
}

/**
 * Posts arrive collapsed, and Salesforce doesn't render a collapsed post's body
 * at all — only its truncated one-line summary. So after everything has loaded,
 * click the feed's own "Expand all visible posts" toolbar button to materialise
 * the full email bodies the scraper reads.
 */
async function expandFeedPosts(root, feed) {
    const expandAll = findInShadows('button[title*="Expand all"]', root, false).filter(isVisible);
    if (expandAll.length) {
        expandAll[0].click();
        await sleep(900);
        return;
    }

    // Fallback: click each post's own collapsed chevron.
    const chevrons = Array.from(feed.querySelectorAll('a[role="button"][aria-expanded="false"]'));
    if (!chevrons.length) return;
    chevrons.forEach(c => { try { c.click(); } catch (_) {} });
    await sleep(900);
}

/*
 * `exact` skips cleanFieldValue's action-word surgery. That surgery exists to cut the
 * "Open"/"Edit"/"Preview" button text Salesforce jams onto LOOKUP values, but it also
 * fires on a picklist whose own value ENDS in one of those words: a Case Status of
 * "Case Closed" comes back as "Case", "Ready to Close" as "Ready to", "Awaiting Edit"
 * as "Awaiting". (Values where the word is the whole string, like "Closed", survive —
 * the split only wins when there is text in front of it.) Passing exact is safe
 * precisely when a specific value element was found, because then there is no button
 * text on the end to strip. The container fallbacks below still clean, since that is
 * the case the cleaning was written for.
 */
function getFieldValue(labelEl, exact = false) {
    const fieldComponent = labelEl.closest('records-record-layout-item, lightning-output-field, .slds-form-element');
    if (fieldComponent) {
        // Try the most specific value element first
        const valueEl = fieldComponent.querySelector(
            'lightning-formatted-text, ' +
            'lightning-formatted-name, ' +
            'lightning-formatted-number, ' +      // formula/number fields (e.g. Case Age in days)
            'lightning-formatted-url a, ' +
            'a[data-refid="recordId"], ' +
            'a[href*="/lightning/r/"], ' +
            '.slds-form-element__static, ' +
            'slot[name="outputField"] lightning-formatted-text'
        );
        if (valueEl) {
            return exact
                ? (valueEl.textContent || '').replace(/\s{2,}/g, ' ').trim()
                : cleanFieldValue(valueEl.textContent);
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

/*
 * The link back to the case record. In the Salesforce CONSOLE the address bar shows the
 * console, not the record — the record lives on a workspace tab whose anchor carries a
 * RELATIVE href ("/lightning/r/Case/500OF00000ShNVtYAN/view"). It is resolved against the
 * page's OWN origin, never a hard-coded one, so a sandbox, a different pod or a My Domain
 * rename all keep working.
 *
 * Several case tabs are normally open at once, so the tab that NAMES the case we just
 * scraped wins over the merely-active one; the record page's own URL is the last resort.
 */
function findCaseRecordUrl(caseNumber) {
    const CASE_PATH = /\/lightning\/r\/Case\/[A-Za-z0-9]{15,18}(\/|$)/;
    const abs = (href) => { try { return new URL(href, location.origin).href; } catch (e) { return ''; } };
    const hrefOf = (a) => a.getAttribute('href') || '';

    const anchors = findInShadows('a[href*="/lightning/r/Case/"]', document, false)
        .filter(a => CASE_PATH.test(hrefOf(a)));

    const num = (caseNumber || '').trim();
    if (num) {
        const byNumber = anchors.find(a => `${a.getAttribute('title') || ''} ${a.textContent || ''}`.includes(num));
        if (byNumber) return abs(hrefOf(byNumber));
    }
    const active = anchors.find(a => a.getAttribute('aria-selected') === 'true');
    if (active) return abs(hrefOf(active));
    if (CASE_PATH.test(location.pathname)) return location.href.split('?')[0];
    return anchors.length ? abs(hrefOf(anchors[0])) : '';
}

async function scrapeSalesforce(options = {}) {
    const { loadFullFeed = true } = options;
    const data = {
        caseNumber: '',
        caseStatus: '',
        contactName: '',
        accountName: '',
        subject: '',
        description: '',
        currentVersion: '',
        product: '',
        licenseType: '',
        // "MC Hosted" (Cloud vs On-Prem) decides whether SOTI Support can pull the server logs
        // itself or has to request them from the customer, so it is scraped from the case
        // rather than inferred from License Type (which only ever guessed at it).
        mcHosted: '',
        caseAge: '',
        // Absolute link back to this case record, so the panel can reopen it.
        caseUrl: '',
        // The engineering defect raised off this case (e.g. MCMR-42071).
        jiraNumber: '',
        emailChain: '',
        feedItemCount: 0,
        feedLoad: null      // { items, rounds, reason } — see loadEntireFeed
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
        // Matched EXACTLY: a case layout is full of other "… Status" labels (Sub Status,
        // Escalation Status, Approval Status), and any of them would win a loose match.
        if ((text === 'status' || text === 'case status') && !data.caseStatus) {
            data.caseStatus = getFieldValue(label, true);
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
        // "MC Hosted" is the field name on the SOTI case layout; the others are the variants
        // seen on older/renamed layouts. Matched narrowly so unrelated labels that merely
        // contain "host" (e.g. "Hostname") never win.
        if (!data.mcHosted && (
            text.includes('mc hosted') || text.includes('mobicontrol hosted') ||
            text === 'hosted' || text === 'hosting' ||
            text === 'hosted by' || text === 'hosting type' || text === 'deployment type'
        )) {
            data.mcHosted = getFieldValue(label);
        }
        if (text.includes('case age') && !data.caseAge) {
            data.caseAge = getFieldValue(label);
        }
        // The engineering defect. "JIRA Number" is the label on the SOTI case layout;
        // the rest are the variants seen on older/renamed ones. Matched on the LABEL,
        // never on the value's shape, so a case number or an asset tag cannot win.
        if (!data.jiraNumber && (
            text.includes('jira') || text.includes('mcmr') ||
            text.includes('defect') || text.includes('bug number') || text.includes('bug id')
        )) {
            data.jiraNumber = getFieldValue(label);
        }
    });

    data.caseUrl = findCaseRecordUrl(data.caseNumber);

    // Fallback for a layout whose JIRA label we do not recognise. An MCMR-##### value is
    // a SOTI engineering defect key and nothing else on a case is shaped like it, so the
    // field holding one IS the JIRA number. Deliberately anchored to MCMR rather than a
    // generic PROJ-123 shape, which would also match order numbers and asset tags.
    if (!data.jiraNumber) {
        for (const label of fieldLabels) {
            const val = getFieldValue(label);
            if (/^MCMR-\d+$/i.test(val)) { data.jiraNumber = val; break; }
        }
    }

    // Fallback: Try the page header for Case Number
    if (!data.caseNumber) {
        const headerTitle = document.querySelector('lightning-formatted-text[slot="primaryField"], .slds-page-header__title .uiOutputText');
        if (headerTitle) {
            const val = headerTitle.textContent.trim();
            if (/^\d{6,}$/.test(val)) data.caseNumber = val;
        }
    }

    // Drive the feed's lazy-loading to the end BEFORE reading it, otherwise we
    // only capture the newest posts. Failures here are non-fatal: we fall through
    // and scrape whatever is already rendered.
    if (loadFullFeed) {
        try {
            data.feedLoad = await loadEntireFeed(activeRoot);
            console.log('SOTI AI Analyser: Feed load complete', data.feedLoad);
        } catch (e) {
            console.warn('SOTI AI Analyser: Feed auto-load failed, scraping visible posts only', e);
        }
    }

    // Attempt to capture Email Chain / Feed
    // Look for common Salesforce email/chatter body selectors (Lightning & Classic)
    const feedItems = findInShadows('article.cuf-feedItem', activeRoot, false);
    data.feedItemCount = feedItems.length;
    
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

/* ===========================================================================
 *  JIRA (server / Data Center) ISSUE SCRAPE
 * ---------------------------------------------------------------------------
 *  Reads the classic JIRA issue view on jira.soti.net. Every value is taken
 *  from the ids JIRA has used for years (#type-val, #priority-val, the
 *  li[id^="rowForcustomfield_"] rows, #attachment_thumbnails, the comment
 *  blocks) with a fallback wherever one exists, because a field that is not on
 *  the layout must leave a blank rather than throw and lose the whole scrape.
 * ========================================================================= */

// A value cell carries inline "Edit" affordances and a "(4)" expander that are
// chrome, not content. Strip them, then collapse whitespace: JIRA pretty-prints
// its markup, so the raw textContent is full of newlines and runs of spaces.
function jiraFieldText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll(
        '.overlay-icon, .aui-iconfont-edit, .shortener-expand, .assign-to-me-link, ' +
        '.user-hover-trigger, script, style, img'
    ).forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim().replace(/[,\s]+$/, '');
}

function scrapeJira() {
    const data = {
        key: '', summary: '', status: '', type: '', priority: '', resolution: '',
        fixVersions: '', affectsVersions: '', components: '', labels: '',
        assignee: '', reporter: '', watchers: '',
        fields: [], attachments: [], comments: [], digest: ''
    };
    const one = (sel) => jiraFieldText(document.querySelector(sel));

    // --- Key. #key-val is the canonical element; the URL and the hidden <h2>
    // ("[MCMR-42071] summary") are the fallbacks for layouts that drop it.
    data.key = one('#key-val');
    if (!data.key) {
        const fromUrl = location.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i);
        if (fromUrl) data.key = fromUrl[1].toUpperCase();
    }
    let headline = '';
    for (const h2 of document.querySelectorAll('h2')) {
        const m = (h2.textContent || '').trim().match(/^\[([A-Z][A-Z0-9]+-\d+)\]\s*([\s\S]+)$/i);
        if (m) { if (!data.key) data.key = m[1].toUpperCase(); headline = m[2].trim(); break; }
    }
    data.summary = one('#summary-val') || headline;

    // --- Workflow state. #status-val is the badge; the transitions button
    // ("Plan Queue") carries it on boards that render the workflow instead.
    data.status = one('#status-val') || one('#opsbar-transitions_more .dropdown-text');

    data.type = one('#type-val');
    data.priority = one('#priority-val');
    data.resolution = one('#resolution-val');
    data.fixVersions = one('#fixfor-val');
    data.affectsVersions = one('#versions-val');
    data.components = one('#components-val');
    data.assignee = one('#assignee-val');
    data.reporter = one('#reporter-val');
    data.watchers = one('#watcher-data');

    const labels = Array.from(document.querySelectorAll('#wrap-labels .labels li, .labels-wrap .labels li'))
        .map(li => jiraFieldText(li)).filter(Boolean);
    data.labels = labels.join(', ');

    // --- Custom fields: Salesforce Case #, MC Hosted, Workaround exists,
    // Customer Phase, Found In Build # and friends all live in these rows.
    document.querySelectorAll('li[id^="rowForcustomfield_"]').forEach(li => {
        const label = jiraFieldText(li.querySelector('.name label') || li.querySelector('.name')).replace(/:$/, '');
        const value = jiraFieldText(li.querySelector('[id$="-val"]'));
        if (label && value) data.fields.push({ label, value });
    });

    document.querySelectorAll('#attachment_thumbnails li.attachment-content').forEach(li => {
        const name = jiraFieldText(li.querySelector('.attachment-title'));
        if (!name) return;
        data.attachments.push({
            name,
            size: jiraFieldText(li.querySelector('.attachment-size')),
            date: jiraFieldText(li.querySelector('.attachment-date'))
        });
    });

    // --- Comments. Each block renders TWICE — a "verbose" copy and a "concise"
    // one — so read only the verbose half or every comment arrives doubled.
    document.querySelectorAll('#issue_actions_container .activity-comment, .issuePanelContainer .activity-comment')
        .forEach(block => {
            const verbose = block.querySelector('.twixi-wrap.verbose') || block;
            const bodyEl = verbose.querySelector('.action-body');
            if (!bodyEl) return;
            const body = (bodyEl.innerText || bodyEl.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
            if (!body) return;
            const dateEl = verbose.querySelector('.action-details .date, .action-details time');
            data.comments.push({
                author: jiraFieldText(verbose.querySelector('.action-details a.user-hover')),
                when: (dateEl && (dateEl.getAttribute('title') || dateEl.getAttribute('datetime'))) || jiraFieldText(dateEl),
                body: body.slice(0, 4000)
            });
        });
    data.comments = data.comments.slice(0, 300);

    data.digest = buildJiraDigest(data);
    return data;
}

// One readable block for the JIRA Details field. Same shape as the Salesforce
// email chain — "[when] Who:" then the text — so a chain and a JIRA thread read
// the same way whether a human or the model is doing the reading.
function buildJiraDigest(d) {
    const out = [];
    const head = [d.key, d.summary].filter(Boolean).join(' — ');
    if (head) out.push(head);

    const line = (label, value) => { if (value) out.push(`${label}: ${value}`); };
    line('Status', d.status);
    line('Type', d.type);
    line('Priority', d.priority);
    line('Resolution', d.resolution);
    line('Affects Version/s', d.affectsVersions);
    line('Fix Version/s', d.fixVersions);
    line('Component/s', d.components);
    line('Labels', d.labels);
    line('Assignee', d.assignee);
    line('Reporter', d.reporter);
    line('Watchers', d.watchers);
    d.fields.forEach(f => line(f.label, f.value));

    if (d.attachments.length) {
        out.push('', `ATTACHMENTS (${d.attachments.length})`);
        d.attachments.forEach(a => out.push(`- ${a.name}${a.size ? ` (${a.size}` : ''}${a.date ? `, ${a.date})` : (a.size ? ')' : '')}`));
    }
    if (d.comments.length) {
        out.push('', `COMMENTS (${d.comments.length}, newest first)`);
        d.comments.forEach(c => {
            out.push('', `[${c.when || 'no date'}] ${c.author || 'Unknown'}:`);
            out.push(c.body);
        });
    }
    return out.join('\n').trim();
}

// Listen for requests from the side panel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "GET_JIRA_DATA") {
        try {
            const data = scrapeJira();
            console.log('SOTI AI Analyser: Scraped JIRA', data);
            sendResponse(data);
        } catch (err) {
            console.error('SOTI AI Analyser: JIRA scrape failed', err);
            sendResponse(null);
        }
        return true;
    }
    if (request.action === "GET_SALESFORCE_DATA") {
        // Scraping is now asynchronous (it scrolls the feed to the bottom first),
        // so we reply from the promise. `return true` below keeps the message
        // channel open until then — without it Chrome closes it immediately and
        // the side panel receives undefined.
        scrapeSalesforce({ loadFullFeed: request.loadFullFeed !== false })
            .then(data => {
                console.log('SOTI AI Analyser: Scraped Data', data);
                sendResponse(data);
            })
            .catch(err => {
                console.error('SOTI AI Analyser: Scrape failed', err);
                sendResponse(null);
            });
    }
    return true;
});
