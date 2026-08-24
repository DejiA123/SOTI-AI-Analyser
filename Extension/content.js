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

/*
 * REPLIES TO A POST, which are a different element from the post and were being lost.
 *
 * A Chatter comment is its own <article class="cuf-commentItem forceChatterComment">
 * nested INSIDE the feed item it answers. That nesting is why the miss was invisible:
 * the post was found, counted and scraped, so the feed looked fully read — while every
 * reply under it went unscraped. On an internal note that is where the actual answer
 * usually lives ("we are still working on this, we need 2026.1.3 before we can quote"),
 * so the case would sync with the question and without the response.
 *
 * Matched on the class rather than on `article`, because the same comment renders as a
 * plain div in some layouts.
 */
const FEED_COMMENT_SELECTOR = '.cuf-commentItem, .forceChatterComment';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/*
 * Read the replies under one feed item.
 *
 * `readText` is passed in rather than closed over: the caller's version falls back from
 * innerText to textContent, which is what makes a comment readable when the page has it
 * collapsed. A comment nobody expanded is CSS-hidden, and innerText on hidden text is ''.
 *
 * The author, the time and the body each have two shapes, and the second one is not a
 * hypothetical — the sample this was written against carries the timestamp in a title
 * attribute ("13 Aug 2026, 12:58") and a machine-readable one in a nested <time datetime>,
 * and other layouts render only the relative "11 days ago". Absolute beats relative:
 * "11 days ago" is meaningless in a case record read weeks later.
 */
function readFeedComments(item, readText) {
    if (!item || typeof item.querySelectorAll !== 'function') return [];

    const comments = Array.from(item.querySelectorAll(FEED_COMMENT_SELECTOR));
    if (!comments.length) return [];

    const out = [];
    for (const c of comments) {
        // A comment nested inside ANOTHER comment belongs to that one, not to this post.
        // Salesforce does not thread replies today, but querySelectorAll is deep and a
        // future layout that does would otherwise report every reply twice.
        const owner = c.parentElement && c.parentElement.closest
            ? c.parentElement.closest(FEED_COMMENT_SELECTOR)
            : null;
        if (owner && owner !== c) continue;

        const parsed = parseFeedComment(c, readText);
        if (parsed) out.push(parsed);
    }
    return out;
}

/*
 * WHICH POST A REPLY BELONGS TO, when the reply is not inside it.
 *
 * The first version of this read replies with item.querySelectorAll(), which assumes the
 * comment is a DESCENDANT of the feed item. On the layout that prompted the fix it is not:
 * the replies live in a `.cuf-compactFeedBack` block that Salesforce renders as a SIBLING
 * of the post's article, so searching inside the article found nothing and the sync came
 * back exactly as empty as before. Both arrangements exist in the wild — it depends on the
 * Lightning release and whether the feed is compact — so neither may be assumed.
 *
 * Containment first, because it is exact. Failing that, the nearest post ABOVE the reply in
 * document order, which is what the page itself is expressing: a reply renders under the
 * thing it answers.
 */
function ownerFeedItem(comment, feedItems) {
    const inside = comment.closest ? comment.closest(FEED_ITEM_SELECTOR) : null;
    if (inside && feedItems.indexOf(inside) !== -1) return inside;

    // feedItems is in document order, so the last one the comment FOLLOWS is the nearest
    // one above it. Bit 4 is DOCUMENT_POSITION_FOLLOWING, bit 1 is DISCONNECTED — the
    // latter happens across shadow roots, where "nearest above" has no meaning and a guess
    // would attach somebody's reply to an unrelated post.
    let best = null;
    for (const it of feedItems) {
        if (typeof it.compareDocumentPosition !== 'function') continue;
        const pos = it.compareDocumentPosition(comment);
        if (pos & 1) continue;
        if (pos & 4) best = it;
    }
    return best;
}

/*
 * Every reply on the page, grouped by the post it answers. Searched from the scrape root
 * rather than from each item, so it does not matter which of the two layouts is rendered,
 * and it crosses shadow boundaries the way the feed-item search already does.
 */
function collectFeedComments(feedItems, root, readText) {
    const byItem = new Map();
    const stats = { parsed: 0, attached: 0, orphaned: 0 };
    if (!feedItems || !feedItems.length) return { byItem, stats };

    let all = [];
    try {
        all = findInShadows(FEED_COMMENT_SELECTOR, root, false);
    } catch (e) {
        all = [];
    }
    // Belt and braces: if the root search came back empty, still look inside the items.
    // A comment found twice is deduplicated below; a comment never looked for is lost.
    if (!all.length) {
        for (const it of feedItems) {
            try { all = all.concat(Array.from(it.querySelectorAll(FEED_COMMENT_SELECTOR))); } catch (e) {}
        }
    }

    const seen = new Set();
    for (const c of all) {
        if (seen.has(c)) continue;
        seen.add(c);

        // Nested inside another comment → it belongs to that one, not to a post.
        const inner = c.parentElement && c.parentElement.closest
            ? c.parentElement.closest(FEED_COMMENT_SELECTOR)
            : null;
        if (inner && inner !== c) continue;

        const parsed = parseFeedComment(c, readText);
        if (!parsed) continue;
        stats.parsed++;

        const owner = ownerFeedItem(c, feedItems);
        if (!owner) { stats.orphaned++; continue; }
        if (!byItem.has(owner)) byItem.set(owner, []);
        byItem.get(owner).push(parsed);
        stats.attached++;
    }
    return { byItem, stats };
}

/*
 * One comment element → {author, time, body}, or null when there was nothing to read.
 */
function parseFeedComment(c, readText) {
    if (!c || typeof c.querySelector !== 'function') return null;

    {
        // FIRST ONE WITH TEXT IN IT, not first one that matches — they are different here,
        // and the difference cost the author name on the very markup this was written from.
        // Salesforce renders the name block as a <div class="cuf-preamble"> INSIDE a
        // <p class="cuf-commentNameLink">, which is invalid: every HTML parser closes the
        // <p> when the <div> opens, so the class you would reach for first survives as an
        // EMPTY element and the name is now its sibling. A plain querySelector over both
        // finds the empty one, in document order, and reports "Unknown" for a comment
        // whose author is sitting right there.
        const firstText = (selectors) => {
            for (const sel of selectors) {
                for (const el of c.querySelectorAll(sel)) {
                    const t = readText(el);
                    if (t) return t;
                }
            }
            return '';
        };
        const author = firstText([
            '.cuf-commentNameLink .uiOutputText',
            '.cuf-preamble .uiOutputText',
            '.cuf-entityLink .uiOutputText',
            '.cuf-commentNameLink',
            '.cuf-preamble'
        ])
            // Last resort: the avatar's alt text. It is the one place the name appears
            // that is not inside the broken <p>.
            || (c.querySelector('.cuf-smallActorImage img[title], .forceChatterUserPhoto img[title]') || {}).title
            || 'Unknown';

        // Absolute time first, in this order: the human string Salesforce puts in the
        // title, then the ISO datetime, then whatever the element renders (relative).
        const ageEl = c.querySelector('feeds_timestamping-comment-creation, .cuf-commentAge');
        const timeEl = c.querySelector('time[datetime]');
        const time = (ageEl && ageEl.getAttribute('title'))
            || (timeEl && timeEl.getAttribute('datetime'))
            || readText(ageEl)
            || '';

        const body = readText(c.querySelector('.slds-comment__content .feedBodyInner'))
            || readText(c.querySelector('.slds-comment__content'))
            || readText(c.querySelector('.cuf-feedBodyText, .feedBodyInner'));

        // Same floor the posts use. A comment whose body did not come back is worse than
        // absent — "Andries Luten:" with nothing after it reads as an empty reply rather
        // than as a reply this tool failed to read.
        if (!body || body.length < 5) return null;

        return { author, time, body };
    }
}

/*
 * Comment bodies are indented under their post so the shape of the exchange survives into
 * the prompt: the model has to be able to tell "the customer asked" from "we answered",
 * and in a flat transcript the reply reads as a second post from whoever is named next.
 */
function formatFeedComments(comments) {
    return (comments || []).map(c => {
        const head = `    ↳ [${c.time}] [REPLY] ${c.author}:`;
        const body = String(c.body).split('\n').map(l => '      ' + l).join('\n');
        return `${head}\n${body}`;
    }).join('\n\n');
}

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

/*
 * THE ONE RULE EVERY CLICK IN THIS FILE OBEYS: never open something.
 *
 * The sync clicks a handful of things on a live case — the Feed tab, "View more" at the
 * bottom of the feed, the expand-post chevrons, "N more comments". Each one is meant to
 * REVEAL TEXT IN PLACE so it can be read. None of them is meant to open a popover, a menu
 * or a dialog, and when one does the engineer watching sees the tool doing something they
 * did not ask for — which is the complaint that produced this rule: the ⓘ beside an email's
 * recipients kept opening during a sync.
 *
 * That ⓘ is reachable from two directions, which is why the guard lives here rather than at
 * one call site. It is a disclosure control, so `aria-expanded="false"` matches it and the
 * chevron sweep clicks it. And its label is assistive text INSIDE the button, so it lands in
 * textContent — "Show more recipients" satisfies LOAD_MORE_RE's `show\s+more` and the feed
 * loader clicks it too.
 */
// Word START only, no closing boundary. Every one of these arrives plural on a real
// control — "Show all recipientS", "Show more detailS", "Email addresseS" — and a trailing
// \b rejects all three, which is precisely the shape the reported icon comes in.
const OPENS_A_PANEL_RE = /\b(recipient|address|detail|attachment|action|menu|option|informa|info|preview)/i;

function opensSomethingElse(el) {
    if (!el || typeof el.getAttribute !== 'function') return true;

    // A popup trigger says so itself. This is the reliable half of the test.
    if (el.getAttribute('aria-haspopup')) return true;
    if (el.closest && el.closest('.cuf-commentActionButton, .slds-dropdown-trigger, [role="menu"], [role="dialog"], .cuf-commentInput, .commentInputArea')) return true;

    // And the naming half, for the controls that declare nothing. Assistive text counts:
    // on an icon-only button it IS the label, and it is what textContent returns.
    const label = ((el.textContent || '') + ' ' + (el.getAttribute('title') || '')
        + ' ' + (el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
    if (label.length <= 60 && OPENS_A_PANEL_RE.test(label)) return true;

    return false;
}

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
        // "Show more recipients" reads exactly like "Show more posts" to the regex above.
        if (opensSomethingElse(el)) continue;
        el.click();
        clicked++;
    }
    return clicked;
}

/* ----------------------------------------------------------------------------
 * The feed has to be ON SCREEN before it can be read
 * ----------------------------------------------------------------------------
 * A Lightning case record is split into sub-tabs — Feed, Details, Related — and
 * Salesforce renders only the ACTIVE one. Sync from a case sitting on Details and
 * there is no feed anywhere in the DOM: the loader above reports "no-feed-found",
 * not one post is scraped, and the panel says "no email chain was found — open the
 * case Feed tab and sync again". That instruction worked, and the engineer had to
 * follow it once per case.
 *
 * So the sync opens the tab itself. Three rules keep that from becoming a nuisance
 * of its own:
 *
 *   • It only clicks when no feed is on screen. On a case already showing its Feed
 *     — the common case — nothing is touched and nothing moves.
 *   • It runs AFTER the fields have been read (see scrapeSalesforce). Leaving a
 *     sub-tab unmounts it, so opening the Feed first would trade an empty chain
 *     for empty case fields.
 *   • It matches the tab by its LABEL, never by `data-tab-value`. Those values
 *     ("flexipage_tab3") are assigned per layout — the number differs between orgs
 *     and changes when somebody edits the page, so hard-coding one would work here
 *     and silently click the wrong tab elsewhere.
 * -------------------------------------------------------------------------- */

// The word, not the substring: "Feedback" is a real tab on some support layouts and
// must never be mistaken for the feed, while "Case Feed" must still match.
const FEED_TAB_RE = /(^|\W)(feed|chatter)(\W|$)/i;
const NOT_FEED_TAB_RE = /feedback|survey|newsfeed reader/i;

function isFeedTabLabel(label) {
    const t = String(label || '').replace(/\s+/g, ' ').trim();
    // A long label is a paragraph that happens to contain the word, not a tab.
    if (!t || t.length > 30) return false;
    if (NOT_FEED_TAB_RE.test(t)) return false;
    return FEED_TAB_RE.test(t);
}

// The label Salesforce puts on a tab, in the order the markup is worth trusting:
// data-label is the layout's own name for it, title is the accessible name, and the
// link text is what is actually drawn.
function tabLabelOf(el) {
    const li = el.closest ? el.closest('li') : null;
    const pick = (a, name) => (a && a.getAttribute && a.getAttribute(name)) || '';
    return (pick(el, 'data-label') || pick(li, 'data-label') ||
            pick(el, 'title') || pick(li, 'title') ||
            (el.textContent || '')).replace(/\s+/g, ' ').trim();
}

// Every visible tab control that names itself the feed. Invisible ones are excluded
// deliberately: a background workspace tab keeps its whole tab bar in the DOM, and
// clicking that one would switch a case the engineer is not looking at.
const TAB_LINK_SELECTOR = 'a[role="tab"], button[role="tab"], .slds-tabs_default__link';

function findFeedTabLinks(root) {
    const out = [];
    const seen = new Set();
    for (const el of findInShadows(TAB_LINK_SELECTOR, root, false)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const label = tabLabelOf(el);
        if (!isFeedTabLabel(label) || !isVisible(el)) continue;
        const li = el.closest ? el.closest('li') : null;
        const active = el.getAttribute('aria-selected') === 'true' ||
                       !!(li && li.className && /slds-is-active/.test(li.className));
        out.push({ el, label, active, exact: /^(feed|chatter)$/i.test(label) });
    }
    // "Feed" before "Case Feed Settings"-ish labels: the plainest name is the tab.
    out.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0));
    return out;
}

// Is a feed rendered and on screen right now?
function feedIsShowing(root) {
    const feed = findFeedContainer(root) || (root !== document ? findFeedContainer(document) : null);
    return !!(feed && isVisible(feed));
}

/**
 * Open the case's Feed tab if it is not already open.
 * Returns { clicked, label, reason } — never throws; every failure just leaves the
 * page as it was and lets the scrape read whatever is there, exactly as before.
 */
async function activateFeedTab(root, opts = {}) {
    const { waitMs = 6000, stepMs = 200, maxTries = 2 } = opts;

    if (feedIsShowing(root)) return { clicked: false, reason: 'already-showing' };

    let candidates = findFeedTabLinks(root);
    if (!candidates.length && root !== document) candidates = findFeedTabLinks(document);
    if (!candidates.length) return { clicked: false, reason: 'no-feed-tab' };

    // ALREADY OPEN, and still no feed. Clicking the tab you are on opens nothing, so
    // the six seconds spent waiting for it would be six seconds added to every sync
    // of a case whose feed is genuinely empty. Say what is true and get on with it.
    if (candidates[0].active) return { clicked: false, label: candidates[0].label, reason: 'already-active' };

    let last = '';
    for (const c of candidates.slice(0, maxTries)) {
        last = c.label;
        try { c.el.click(); } catch (_) { continue; }
        // Lightning mounts the panel asynchronously, and on a cold tab that is a
        // server round trip — so this waits for the feed to EXIST rather than
        // assuming a click is the same thing as a rendered tab.
        const until = Date.now() + waitMs;
        while (Date.now() < until) {
            await sleep(stepMs);
            if (feedIsShowing(root)) return { clicked: true, label: c.label, reason: 'opened' };
        }
    }
    // Clicked, and still nothing. Said out loud rather than swallowed, because the
    // panel's "no email chain" message is otherwise indistinguishable from a case
    // that genuinely has no posts.
    return { clicked: true, label: last, reason: 'clicked-no-feed' };
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
    } else {
        // Fallback: click each post's own collapsed chevron.
        //
        // `aria-expanded="false"` is the markup for ANY collapsed disclosure control, not
        // just a post — the ⓘ that expands an email's recipients is one, and this swept it
        // up with the rest. The post chevrons are what this is for; anything that opens a
        // panel is not a post.
        const chevrons = Array.from(feed.querySelectorAll('a[role="button"][aria-expanded="false"]'))
            .filter(el => !opensSomethingElse(el));
        if (chevrons.length) {
            chevrons.forEach(c => { try { c.click(); } catch (_) {} });
            await sleep(900);
        }
    }

    // Always, on BOTH paths. "Expand all" is the common one and it opens posts only —
    // returning early after it, as this used to, would have left every hidden reply
    // hidden on exactly the layout most cases use.
    await expandFeedComments(feed);
}

/*
 * "Expand all" opens POSTS. It does not touch replies, and replies are hidden two
 * separate ways:
 *
 *   • Salesforce shows the most recent few and puts the rest behind a "N more comments"
 *     link. Those unshown ones are not in the DOM at all, so no amount of careful reading
 *     finds them — the link has to be clicked.
 *   • A long reply is truncated with its own "Expand Post" control, leaving the tail
 *     rendered but hidden. That half the scraper can still read (readText falls back to
 *     textContent), so it is worth clicking but not worth failing over.
 *
 * Both are best-effort and deliberately quiet: this runs on someone's live case page, and
 * a click that does not land should cost the sync nothing. Bounded to two rounds because
 * "more comments" can reveal another "more comments" on a long thread, and unbounded
 * clicking on a stranger's page is not a trade worth making for the third page of replies.
 */
async function expandFeedComments(feed) {
    if (!feed || typeof feed.querySelectorAll !== 'function') return;

    // Where replies live. Everything below is searched from HERE and not from the feed,
    // so an email header, a post's action menu and the record's own chrome are outside
    // the blast radius of every click this makes.
    const COMMENT_REGIONS = '.cuf-feedback, .cuf-compactFeedBack, .forceChatterFeedback, .slds-feed__item-comments';

    const regions = Array.from(feed.querySelectorAll(COMMENT_REGIONS));
    if (!regions.length) return;

    for (let round = 0; round < 2; round++) {
        const links = [];
        for (const region of regions) {
            for (const el of region.querySelectorAll('a, button')) {
                if (isMoreCommentsControl(el)) links.push(el);
            }
        }
        if (!links.length) break;
        links.forEach(el => { try { el.click(); } catch (_) {} });
        await sleep(700);
    }

    // Truncated reply bodies. `.cuf-more` carries `hidden` when there is nothing to
    // expand, so filtering on it avoids a pile of no-op clicks on an ordinary feed.
    const moreText = [];
    for (const region of regions) {
        for (const el of region.querySelectorAll('.cuf-more')) {
            if (el.classList && el.classList.contains('hidden')) continue;
            if (opensSomethingElse(el)) continue;
            moreText.push(el);
        }
    }
    if (moreText.length) {
        moreText.forEach(el => { try { el.click(); } catch (_) {} });
        await sleep(500);
    }
}

/* opensSomethingElse() is defined once, beside LOAD_MORE_RE — every click site shares it. */

/*
 * Is this the "3 more comments" link, and nothing else?
 *
 * Matched on VISIBLE TEXT only. The first version also searched the title attribute, which
 * is where icon buttons keep their labels — so a bare icon whose tooltip happened to pair
 * "show" with "comment" became a click target, and the regex made that easy by allowing
 * `.*` to leap between the two words across an entire label.
 *
 * The real link says one of a few short things — "2 more comments", "Show all comments",
 * "View more comments" — so the test is: it must NAME comments, be short enough to be a
 * link rather than a paragraph that mentions them, and START like a count or a verb.
 */
function isMoreCommentsControl(el) {
    if (opensSomethingElse(el)) return false;

    const label = ((el.innerText || el.textContent || '')).replace(/\s+/g, ' ').trim();
    if (!label || label.length > 40) return false;
    if (!/\bcomments?\b/i.test(label)) return false;
    return /^(\d+|show|view|see|all|more|load)\b/i.test(label);
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
/*
 * Every shape a Salesforce case layout renders a FIELD LABEL in. A case record does not have one
 * canonical markup — it depends on the org's layout, the release, and whether the record is being
 * viewed in the console, on its own page, or in Classic:
 *
 *   .test-id__field-label / .slds-form-element__label  Lightning record detail and Dynamic Forms
 *   records-highlights-details-item .slds-text-title   the compact highlights strip at the top of
 *                                                     the record — on a good number of org layouts
 *                                                     that is the ONLY place Case Number, Status
 *                                                     and Owner are rendered at all
 *   .labelCol                                         Salesforce Classic, whose detail page is a
 *                                                     plain table and matches none of the above
 *
 * Scraping only the first pair is what makes the sync look broken on somebody else's view: the
 * page is a case, the feed loads and scrolls, and not one field is found.
 */
const FIELD_LABEL_SELECTOR = [
    '.test-id__field-label',
    '.slds-form-element__label',
    'records-highlights-details-item .slds-text-title',
    '.slds-page-header__detail-block .slds-text-title',
    'td.labelCol',
    'th.labelCol',
    '.labelCol'
].join(', ');

/*
 * A field LABEL, normalised. Classic writes "Status:" with a colon, a required field is
 * rendered "* Status", and a wrapped label arrives with a newline in the middle — all three
 * miss an exact match on "status", which is how a layout ends up syncing no fields at all.
 * Used for BOTH halves of the scrape: to recognise a label, and to recognise a "value" that is
 * really just that label handed back to us (see getFieldValue).
 */
function normaliseLabel(raw) {
    return (raw || '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[*\s]+/, '')
        .replace(/\s*[:：]\s*$/, '')
        .trim()
        .toLowerCase();
}

const labelTextOf = (el) => normaliseLabel(el && el.textContent);

/*
 * Every shape a case renders a field VALUE in, MOST SPECIFIC FIRST — and the order is the whole
 * point of the list. These used to be joined into one querySelector, which returns the first
 * match in DOCUMENT order, not the first selector that matches. In the highlights strip at the
 * top of a case the label sits ABOVE the value and is itself a <p title="Status">Status</p>, so
 * the generic `p[title]` at the tail of the list won on document order and the sync came back
 * with the words "Status" and "JIRA Number" — each field's own label, stored as its value.
 * Tried one selector at a time, the element Salesforce actually marks as the output field wins
 * wherever on the page it sits.
 */
const FIELD_VALUE_SELECTORS = [
    '[data-output-element-id="output-field"]',
    'slot[name="outputField"] lightning-formatted-text',
    'lightning-formatted-text',
    'lightning-formatted-name',
    'lightning-formatted-number',        // formula/number fields (e.g. Case Age in days)
    'lightning-formatted-date-time',
    'lightning-formatted-rich-text',
    'lightning-formatted-url a',
    'a[data-refid="recordId"]',
    'a[href*="/lightning/r/"]',
    '.slds-form-element__static',
    '.uiOutputText',
    '.slds-text-body_regular',
    'p[title]'
];

// querySelectorAll that also descends into shadow roots — including the container's own, which
// findInShadows() skips because its TreeWalker starts at the container's descendants.
function queryDeep(root, selector) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const found = findInShadows(selector, root, false);
    if (root.shadowRoot) found.push(...findInShadows(selector, root.shadowRoot, false));
    return found;
}

/*
 * The chrome Salesforce renders INSIDE a field's value box: the inline-edit pencil, whose whole
 * text is a screen-reader label reading "Edit JIRA Number", plus any other button and any
 * assistive-text run. On a field the case has left EMPTY that affordance is the only text in the
 * box, which is how a case with no defect raised against it came back with the words "Edit JIRA
 * Number" sitting in the JIRA Number field. Anchors are deliberately NOT in here: a lookup and a
 * URL field render their value as one.
 */
const VALUE_CHROME_SELECTOR = [
    'button',
    '.slds-button',
    '[role="button"]',
    '.slds-assistive-text',
    '.assistiveText',
    'lightning-primitive-icon',
    '.slds-form-element__icon',
    'svg'
].join(', ');

// A value element's text with that chrome taken out. Cloned rather than edited — this runs on
// the live Salesforce page the engineer is reading.
function valueText(el) {
    if (!el) return '';
    let source = el;
    if (typeof el.cloneNode === 'function' && typeof el.querySelector === 'function' &&
        el.querySelector(VALUE_CHROME_SELECTOR)) {
        source = el.cloneNode(true);
        source.querySelectorAll(VALUE_CHROME_SELECTOR).forEach(node => node.remove());
    }
    return source.textContent || '';
}

/*
 * Is this candidate the field's own LABEL rather than its value? Salesforce renders a label more
 * than once — the visible title, the form element's <span>, an assistive-text copy for screen
 * readers — and any of them can match a generic value selector such as `p[title]`.
 */
function isLabelElement(el, labelEl, wanted) {
    if (!el || el === labelEl) return true;
    if (typeof el.contains === 'function' && (el.contains(labelEl) || labelEl.contains(el))) return true;
    try { if (el.matches(FIELD_LABEL_SELECTOR)) return true; } catch (_) {}
    if (el.classList && el.classList.contains('slds-assistive-text')) return true;
    return labelTextOf(el) === wanted;
}

/*
 * The boxes this field's value could be sitting in, NARROWEST FIRST, so the value nearest the
 * label wins. A box that also holds ANOTHER field's label is skipped outright: whatever we found
 * inside it may belong to the neighbour, and a confidently wrong value is worse than a blank —
 * it reads as the case's real status and every later step believes it. A second copy of the SAME
 * label is not a neighbour; Salesforce routinely renders one.
 */
function valueScopes(labelEl) {
    const wanted = labelTextOf(labelEl);
    const seen = new Set();
    const scopes = [];

    const consider = (el) => {
        if (!el || el.nodeType !== Node.ELEMENT_NODE || seen.has(el)) return;
        seen.add(el);
        const foreign = Array.from(el.querySelectorAll(FIELD_LABEL_SELECTOR))
            .some(other => other !== labelEl && labelTextOf(other) !== wanted);
        if (foreign) return;
        scopes.push(el);
    };

    consider(labelEl.parentElement);
    consider(labelEl.closest('records-highlights-details-item'));
    consider(labelEl.closest('.slds-page-header__detail-block'));
    consider(labelEl.closest('lightning-output-field'));
    consider(labelEl.closest('.slds-form-element'));
    consider(labelEl.closest('records-record-layout-item'));
    consider(labelEl.parentElement && labelEl.parentElement.parentElement);

    return scopes;
}

// The value element inside one box: first by SELECTOR priority, then by document order, never
// the label itself, never an element with no text in it — where "no text" means none once the
// edit pencil has been discounted, so an empty field does not pass its own affordance off as a
// value.
function findValueElement(scope, labelEl, wanted) {
    const candidates = queryDeep(scope, FIELD_VALUE_SELECTORS.join(', '));
    if (!candidates.length) return null;

    for (const selector of FIELD_VALUE_SELECTORS) {
        for (const el of candidates) {
            let matches = false;
            try { matches = el.matches(selector); } catch (_) {}
            if (!matches) continue;
            if (isLabelElement(el, labelEl, wanted)) continue;
            if (!valueText(el).trim()) continue;
            return el;
        }
    }
    return null;
}

function getFieldValue(labelEl, exact = false) {
    if (!labelEl) return '';
    const wanted = labelTextOf(labelEl);

    const read = (el) => {
        if (!el) return '';
        return exact
            ? valueText(el).replace(/\s{2,}/g, ' ').trim()
            : cleanFieldValue(valueText(el));
    };
    // Nothing leaves here that is the field describing ITSELF rather than saying what it holds —
    // the label read back, or the button offering to fill the field in. Both were reported: Case
    // Status syncing as "Status", and a case with no defect raised against it syncing "Edit JIRA
    // Number" as its JIRA number. Either is worse than an empty field, because the panel leaves a
    // blank field open for the engineer to fill in and silently trusts a filled one.
    const accept = (value) => {
        const v = (value || '').trim();
        if (!v) return '';
        const n = normaliseLabel(v);
        if (n === wanted) return '';
        // The inline-edit affordance, reached by a fallback broad enough to have swept the pencil
        // up along with the value it sits beside.
        if (n === `edit ${wanted}` || n === `${wanted} edit`) return '';
        if (n === 'edit' || n === 'open' || n === 'preview') return '';
        return v;
    };

    // SALESFORCE CLASSIC: the detail page is a table, and the value is the sibling cell on the
    // same row. None of the Lightning containers below exist there. Walk forward from THIS label
    // to its own cell rather than taking the row's first .dataCol — a Classic row normally
    // carries two label/value pairs, so the first cell belongs to the left-hand pair and every
    // right-hand label would read its neighbour's value.
    if (labelEl.classList && labelEl.classList.contains('labelCol')) {
        let cell = labelEl.nextElementSibling;
        while (cell && !(cell.classList && cell.classList.contains('dataCol'))) {
            cell = cell.nextElementSibling;
        }
        if (!cell) {
            const row = labelEl.closest('tr');
            cell = row && row.querySelector('td.dataCol, .dataCol');
        }
        const classic = accept(read(cell));
        if (classic) return classic;
    }

    // LIGHTNING: the highlights strip, the record detail, Dynamic Forms — all of them are a
    // label with its value in one of the boxes around it.
    for (const scope of valueScopes(labelEl)) {
        const value = accept(read(findValueElement(scope, labelEl, wanted)));
        if (value) return value;
    }

    // Broader container fallback: the field's whole control box with its action buttons removed.
    // Cleaned even when `exact` was asked for — a whole control carries the button text that
    // `exact` is only safe to skip when a specific value element was found.
    const fieldComponent = labelEl.closest('records-record-layout-item, lightning-output-field, .slds-form-element');
    if (fieldComponent) {
        const control = fieldComponent.querySelector('.slds-form-element__control');
        if (control) {
            const clone = control.cloneNode(true);
            clone.querySelectorAll(VALUE_CHROME_SELECTOR + ', [class*="action"], .test-id__action').forEach(el => el.remove());
            const value = accept(cleanFieldValue(clone.textContent));
            if (value) return value;
        }
    }

    // Simple sibling fallback — skipping a sibling that is itself a label, which is the next
    // FIELD, not this one's value.
    const sibling = labelEl.nextElementSibling;
    if (sibling) {
        let siblingIsLabel = false;
        try { siblingIsLabel = sibling.matches(FIELD_LABEL_SELECTOR); } catch (_) {}
        if (!siblingIsLabel) return accept(cleanFieldValue(valueText(sibling)));
    }

    return '';
}

/*
 * The issue key inside a JIRA field's value. Most layouts hold a bare key ("MCMR-44187"), but
 * others render the field as a link or wrap it in words, and the panel turns whatever it is
 * given into a jira.soti.net/browse/<key> link — so pull the key out rather than storing the
 * wrapping. A label read back ("JIRA Number") holds no key, so it can never survive this.
 */
function issueKeyIn(raw) {
    const m = (raw || '').toUpperCase().match(/\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/);
    return m ? `${m[1]}-${m[2]}` : '';
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
        feedTab: null,      // { clicked, label, reason } — see activateFeedTab
        feedLoad: null      // { items, rounds, reason } — see loadEntireFeed
    };

    // Find the root of the active case to avoid pulling data from background tabs
    const activeRoot = getActiveWorkspaceRoot();
    console.log('SOTI AI Analyser: Scraping from root', activeRoot);

    let fieldLabels = findInShadows(FIELD_LABEL_SELECTOR, activeRoot, false);
    // getActiveWorkspaceRoot is a HEURISTIC — it scores containers and picks a winner. When it
    // picks one that does not actually hold the record detail (an unfamiliar console layout, a
    // record opened in its own browser tab, Classic), it returns a subtree with no fields in it
    // and the whole sync comes back empty. Searching the entire document is strictly better than
    // returning an empty case: the worst case is reading a background tab's fields, and the case
    // number is reconciled against the page's own URL below anyway.
    let rootFellBack = false;
    if (!fieldLabels.length && activeRoot !== document) {
        fieldLabels = findInShadows(FIELD_LABEL_SELECTOR, document, false);
        rootFellBack = true;
        console.warn('SOTI AI Analyser: no fields under the active root — falling back to the whole document');
    }

    // Whether data.jiraNumber holds a real issue key yet, or merely the best guess so far.
    let jiraNumberIsKey = false;

    // Run over a set of labels, filling in whatever is still blank. Every assignment below is
    // guarded on the field being empty, so this is safe to run more than once over widening sets
    // of labels — the first (narrowest, most trustworthy) reading of a field always wins.
    const readFields = (labels) => labels.forEach(label => {
        // NORMALISED before it is matched (see normaliseLabel). Several of the tests below are
        // deliberately EXACT ("status", not anything containing it — a case layout is full of
        // Sub Status / Escalation Status), and an exact test is only as good as the string it
        // is given.
        const text = labelTextOf(label);
        if (!text) return;
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
        // Among the labels that DO match, an issue key wins outright: a layout carrying both
        // "JIRA Number" and "JIRA Status" would otherwise sync whichever of the two Salesforce
        // happened to render first, and put "In Progress" in the JIRA Number box.
        if (!jiraNumberIsKey && (
            text.includes('jira') || text.includes('mcmr') ||
            text.includes('defect') || text.includes('bug number') || text.includes('bug id')
        )) {
            const raw = getFieldValue(label);
            const key = issueKeyIn(raw);
            if (key) {
                data.jiraNumber = key;
                jiraNumberIsKey = true;
            } else if (!data.jiraNumber) {
                data.jiraNumber = raw;
            }
        }
    });

    readFields(fieldLabels);

    /* The HIGHLIGHTS strip at the top of a record sits OUTSIDE the record-detail container, and
     * getActiveWorkspaceRoot() scores .forceRecordLayout as a candidate root — so on a layout
     * where it wins, the strip is not in the subtree we just read. On the many org layouts that
     * render Case Number and Status ONLY in the highlights, those fields then come back blank
     * while Product and Version sync fine, which reads as "the sync half works".
     *
     * The whole-document fallback above cannot rescue it: that only fires when NOT ONE label was
     * found. So widen by climbing towards the page one ancestor at a time, stopping the moment
     * the case is complete. Staying as close to the record as possible is the point — a console
     * routinely has several case tabs open, and jumping straight to the document would let a
     * background case's Status fill this case's blank. */
    let scannedLabels = fieldLabels;
    const incomplete = () => !data.caseNumber || !data.caseStatus || !data.subject;
    if (!rootFellBack && activeRoot !== document && incomplete()) {
        let scope = activeRoot.parentElement;
        for (let hops = 0; scope && hops < 6 && incomplete(); hops++) {
            const wider = findInShadows(FIELD_LABEL_SELECTOR, scope, false);
            if (wider.length > scannedLabels.length) {
                scannedLabels = wider;
                readFields(wider);
            }
            scope = scope.parentElement;
        }
    }

    data.caseUrl = findCaseRecordUrl(data.caseNumber);

    // Fallback for a layout whose JIRA label we do not recognise — or one where the label we did
    // recognise turned out not to be the number field. An MCMR-##### value is a SOTI engineering
    // defect key and nothing else on a case is shaped like it, so the field holding one IS the
    // JIRA number. Deliberately anchored to MCMR rather than a generic PROJ-123 shape, which
    // would also match order numbers and asset tags.
    if (!jiraNumberIsKey) {
        for (const label of scannedLabels) {
            const val = (getFieldValue(label) || '').trim();
            if (/^MCMR-\d+$/i.test(val)) { data.jiraNumber = val.toUpperCase(); break; }
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
        // OPEN THE FEED TAB FIRST — and only here, once every field above has been
        // read. Salesforce unmounts the sub-tab being left, so doing this any earlier
        // would trade an empty email chain for empty case fields. A case already on
        // its Feed is left untouched (see activateFeedTab).
        try {
            data.feedTab = await activateFeedTab(activeRoot);
            if (data.feedTab.clicked) {
                console.log('SOTI AI Analyser: opened the case Feed tab', data.feedTab);
            }
        } catch (e) {
            console.warn('SOTI AI Analyser: could not open the Feed tab, reading whatever is on screen', e);
        }
        try {
            data.feedLoad = await loadEntireFeed(activeRoot);
            console.log('SOTI AI Analyser: Feed load complete', data.feedLoad);
        } catch (e) {
            console.warn('SOTI AI Analyser: Feed auto-load failed, scraping visible posts only', e);
        }
    }

    // Attempt to capture Email Chain / Feed.
    // FEED_ITEM_SELECTOR, not 'article.cuf-feedItem' alone. The feed LOADER counts posts with the
    // full selector (it matches cuf-feedElement too), so on a view that renders the element form
    // the loader scrolled the entire case to the bottom and then this line matched NOTHING —
    // the case scrolled, and not one message came back. The two must use the same selector or the
    // scrape silently disagrees with the thing that just did the work.
    let feedItems = findInShadows(FEED_ITEM_SELECTOR, activeRoot, false);
    // Same reasoning as the field labels: never let a bad root guess be the reason a case with a
    // visible feed syncs as empty.
    if (!feedItems.length && activeRoot !== document) {
        feedItems = findInShadows(FEED_ITEM_SELECTOR, document, false);
    }
    data.feedItemCount = feedItems.length;

    // Declared out here, not in the block below, because the diagnostics at the end of this
    // function report them.
    let commentsSeen = 0;
    let commentsOrphaned = 0;

    if (feedItems.length > 0) {
        // innerText, then textContent. innerText is the better read — it respects line breaks the
        // way the post is laid out — but it is the RENDERED text, so it comes back EMPTY for
        // anything the page has hidden with CSS. Salesforce hides plenty (see the summary line
        // below, which was already reading textContent for exactly this reason), and a post that
        // expandFeedPosts could not open is hidden by definition. Reading innerText alone loses
        // those messages silently: the feed is found, the post is counted, and its body is blank.
        const readText = (el) => {
            if (!el) return '';
            const rendered = typeof el.innerText === 'string' ? el.innerText.trim() : '';
            return rendered || (el.textContent || '').trim();
        };

        // Replies are gathered ONCE, from the scrape root, and grouped by the post they
        // answer — see collectFeedComments. Doing it per item would re-assume the reply is
        // inside the article, which is the assumption that made this miss them entirely.
        const collected = collectFeedComments(feedItems, activeRoot, readText);
        const commentsByItem = collected.byItem;
        commentsSeen = collected.stats.attached;
        commentsOrphaned = collected.stats.orphaned;

        const chain = feedItems.slice(0, 700).map(item => {
            // Target the header columns specifically
            const leftCol = item.querySelector('.preamble_left');
            const rightCol = item.querySelector('.preamble_right');

            const sender = readText(leftCol) || 'Unknown';
            const time = readText(rightCol);

            // Identify type using attributes and icons
            const typeAttr = item.getAttribute('data-type') || '';
            const hasCallIcon = item.querySelector('.slds-icon-standard-log-a-call, [title*="Call"]');
            const itemText = readText(item);
            const isInternal = itemText.includes('Internal') ||
                readText(item.querySelector('.preamble_custom-preamble')).includes('Internal');

            let typePrefix = '';
            if (typeAttr.includes('Call') || hasCallIcon) typePrefix = '[CALL LOG] ';
            else if (isInternal) typePrefix = '[INTERNAL] ';

            // Collect content from all possible body locations
            const summary = readText(item.querySelector('.preamble_custom-summary'));
            const emailBody = readText(item.querySelector('.emailMessageBody'));
            const callBody = readText(item.querySelector('.logCallDescription'));
            // Scoped past the replies. A comment's body carries the SAME classes as a
            // post's, so on a post with no body of its own — an attachment-only note, a
            // record-change entry — this used to return the first REPLY's text and file it
            // under the post's author. Harmless while replies were invisible; a duplicate
            // now that they are read separately, and one attributed to the wrong person.
            const postBodyEl = Array.from(item.querySelectorAll('.forceChatterFeedBodyText, .feedBodyInner'))
                .find(el => !el.closest(FEED_COMMENT_SELECTOR));
            const postBody = readText(postBodyEl);
            
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

            const comments = commentsByItem.get(item) || [];

            // The guard is now "did this item say ANYTHING", not "did the post body".
            // A note whose own body is empty but which carries three replies is one of
            // the most useful items in the feed, and the old test dropped the whole
            // article — post, replies and all — because the first half came back short.
            if (content.length < 5 && !comments.length) return null;

            const head = content.length >= 5
                ? `[${time}] ${typePrefix}${sender}:\n${content}`
                : `[${time}] ${typePrefix}${sender}:`;
            return comments.length
                ? `${head}\n\n${formatFeedComments(comments)}`
                : head;
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
        
        let emailItems = findInShadows(emailSelectors.join(', '), activeRoot, false);
        if (!emailItems.length && activeRoot !== document) {
            emailItems = findInShadows(emailSelectors.join(', '), document, false);
        }
        if (emailItems.length > 0) {
            const seen = new Set();
            data.emailChain = emailItems
                .slice(0, 700)
                .map(item => {
                    const rendered = typeof item.innerText === 'string' ? item.innerText.trim() : '';
                    return rendered || (item.textContent || '').trim();
                })
                .filter(txt => {
                    if (txt.length < 40 || seen.has(txt.slice(0, 100))) return false;
                    seen.add(txt.slice(0, 100));
                    return true;
                })
                .join('\n\n' + '='.repeat(40) + '\n\n');
        }
    }

    // WHY A SYNC CAME BACK EMPTY. Without this the panel could only say "nothing happened",
    // which is indistinguishable from the button not working — the shape the original report
    // arrived in. These are facts about what was actually looked at, so the panel can tell an
    // engineer whose tab is not a case apart from one whose LAYOUT was not understood.
    data.diagnostics = {
        onCasePage: !!(data.caseNumber || /\/lightning\/r\/Case\//i.test(location.pathname) ||
                       /[?&]id=500/i.test(location.search) || /\/500[A-Za-z0-9]{12,15}/.test(location.pathname)),
        labelsSeen: scannedLabels.length,
        feedItemsSeen: feedItems.length,
        // Replies read, and replies read but attached to no post. Zero seen on a case that
        // visibly has replies says the layout changed, not that the case is quiet — which
        // is the one thing this scraper cannot work out for itself. A non-zero orphan count
        // says the opposite: they were found and read, and the association is what failed.
        feedCommentsSeen: commentsSeen,
        feedCommentsOrphaned: commentsOrphaned,
        rootFellBack,
        rootWasDocument: activeRoot === document,
        href: (location.href || '').split('?')[0]
    };

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
/* ---------------------------------------------------------------------------
 * THE OPEN-CASE LIST (Salesforce list view, e.g. "My Open Cases")
 * ---------------------------------------------------------------------------
 * A different shape of page from a case record, and a much friendlier one: the
 * Lightning datatable labels every cell with data-label="Case Number", "Subject",
 * "Status" and so on, so the columns are read by NAME rather than by position.
 * That matters because the engineer chooses their own columns and order — reading
 * the 5th cell would work until someone dragged a column.
 *
 * Rows are read from the DOM, so this reflects the list view as displayed: the
 * filter, the sort and the row limit are whatever Salesforce is showing. That is
 * the intended behaviour — "my open cases" means the list the engineer curated,
 * not every case in the org.
 * ------------------------------------------------------------------------- */
function caseListCell(row, label) {
    const cell = row.querySelector(`[data-label="${label}"]`);
    if (!cell) return '';
    // The case number and lookups render as links; their title carries the clean
    // value even when the visible text is truncated with an ellipsis.
    const link = cell.querySelector('a[title]');
    if (link) return cleanFieldValue(link.getAttribute('title') || link.textContent || '');
    const titled = cell.querySelector('[title]');
    if (titled) return cleanFieldValue(titled.getAttribute('title') || titled.textContent || '');
    return cleanFieldValue(cell.textContent || '');
}

function scrapeSalesforceCaseList() {
    const rows = [...document.querySelectorAll('tr[data-row-key-value]')];
    const out = [];
    for (const row of rows) {
        const caseNum = caseListCell(row, 'Case Number');
        if (!caseNum) continue;                       // header/spacer rows carry none
        const link = row.querySelector('[data-label="Case Number"] a');
        const href = link ? (link.getAttribute('href') || '') : '';
        let url = '';
        try { if (href) url = new URL(href, location.origin).href; } catch (e) { /* relative junk */ }
        out.push({
            recordId: row.getAttribute('data-row-key-value') || '',
            url,
            caseNum,
            subject:  caseListCell(row, 'Subject'),
            status:   caseListCell(row, 'Status'),
            priority: caseListCell(row, 'Case Priority'),
            account:  caseListCell(row, 'Account Name'),
            contact:  caseListCell(row, 'Contact Name'),
            jira:     caseListCell(row, 'JIRA Number'),
            ageDays:  caseListCell(row, 'Case Age (in days)'),
            opened:   caseListCell(row, 'Date/Time Opened'),
            modified: caseListCell(row, 'Last Modified Date')
        });
    }
    // The list's own title, so the panel can say WHICH list these came from rather
    // than implying it holds every open case in Salesforce.
    const titleEl = document.querySelector('.slds-page-header__title, h1 .slds-page-header__title');
    return {
        listName: titleEl ? cleanFieldValue(titleEl.textContent || '') : '',
        // The org this list came from. Each row already carries its own absolute url, but
        // a row whose Case Number cell rendered without a link has only a recordId — and a
        // record id is useless without knowing which Salesforce to ask. Captured once here
        // rather than guessed later, because the org host differs per customer and a
        // hardcoded one would send someone to a login page for a org that is not theirs.
        origin: location.origin,
        scrapedAt: Date.now(),
        cases: out
    };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "GET_SALESFORCE_CASE_LIST") {
        try {
            const data = scrapeSalesforceCaseList();
            console.log('SOTI AI Analyser: Scraped case list', data.cases.length, 'rows');
            sendResponse(data);
        } catch (err) {
            console.error('SOTI AI Analyser: Case list scrape failed', err);
            sendResponse(null);
        }
        return true;
    }
    /* "IS THE CASE ON SCREEN YET?" — asked repeatedly while a case opens, so it must be
     * cheap and must not touch the page. No scrolling, no expanding, no clicking: the
     * engineer is watching their own tab load and the auto-sync has not started yet.
     *
     * Ready means the RECORD is rendered, not that the document finished loading. Lightning
     * reaches readyState complete with an empty shell and fills it in afterwards, so
     * 'complete' on its own would hand the sync a page with no case on it. Any one of these
     * is proof the record itself has arrived: a case number read off the layout, a field
     * label from the record detail, or a feed item. */
    if (request.action === "GET_SALESFORCE_CASE_READY") {
        try {
            const onCaseUrl = /\/lightning\/r\/(?:[^/]+\/)?500[A-Za-z0-9]{12,15}\//.test(location.pathname)
                || /[?&]id=500/i.test(location.search);
            const hasFeed = !!document.querySelector(FEED_ITEM_SELECTOR);
            // getFieldValue takes a label ELEMENT, so the case-number probe reads the label
            // the same way the scrape does — find it, then ask it for its value. Passing the
            // string would have returned '' every time and the check would never have fired.
            const caseNum = [...document.querySelectorAll(FIELD_LABEL_SELECTOR)]
                .some(l => labelTextOf(l).includes('case number') && getFieldValue(l));
            const hasLabels = document.querySelectorAll(FIELD_LABEL_SELECTOR).length > 3;
            sendResponse({ ready: !!(caseNum || hasFeed || hasLabels), onCaseUrl });
        } catch (err) {
            sendResponse({ ready: false });
        }
        return true;
    }
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
