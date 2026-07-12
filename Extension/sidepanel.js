/* ============================================================================
 * SOTI AI Analyser — Sidepanel Engine (the whole application brain)
 * ============================================================================
 * This single file runs the entire side panel: the UI, the case/state store, the
 * log-analysis pipeline, the local-AI engine, the prompts, the offline knowledge
 * search, and the self-learning loop. There is no framework and no build step —
 * it is plain JavaScript that talks directly to the DOM and to Ollama over HTTP.
 *
 * READ THIS FIRST: a full plain-English explanation of how everything works and
 * WHY it was built this way lives in  PROJECT_OVERVIEW.md  (same folder).
 *
 * ----------------------------------------------------------------------------
 * MAP OF THIS FILE (search for these function names to jump around)
 * ----------------------------------------------------------------------------
 *  • State / cases ...... getDefaultCase, saveState, loadState, switchCase
 *  • UI plumbing ........ md (markdown→HTML), renderTabs, toast, addMsg
 *  • Log Intelligence ... getLogPanelIntel, classifyLogLine, scoreRootCauseCandidate,
 *                         buildCrossLogIncidentIndex, getSmartLogSnippet, buildFileManifest
 *  • Prompt budgeting ... getModelContextLength, getSessionCtx, computeSnippetBudget,
 *                         allocatePerFileBudgets, buildCaseContextForPrompt
 *  • AI engine .......... OllamaAI.completions.create  (sizes num_ctx, trims, streams)
 *  • Personas/prompts ... TIER3_IDENTITY, getLeanLogPrompt, getCompactLogPrompt,
 *                         getConversationalPrompt, getLeanQAPrompt
 *  • Intent routing ..... isLogForensicsRequest, wantsLogAnalysis
 *  • Offline RAG ........ PulseKB (ensureIndex + search), searchPulseAndDocs
 *  • Self-learning ...... saveLearnedInsight, matchLearnedInsights, attachFeedbackUI
 *  • THE HEART .......... send()  — assembles the prompt and talks to the AI
 *
 * KEY IDEAS (the non-obvious design choices, explained in full in the overview):
 *  1. Logs are PRE-ANALYSED in code (Log Intelligence) before the AI sees them, so a
 *     small CPU model gets a short high-signal brief instead of a raw 50,000-line dump.
 *  2. num_ctx is FIXED per model (getSessionCtx) — Ollama reloads the model whenever
 *     num_ctx changes, which is very slow on a CPU, so we keep it constant + warm.
 *  3. The log section is BUDGETED against everything else and placed early in the prompt
 *     so a big Case Info panel can never push the logs out of the context window.
 *  4. The request's intent (analyse vs. just answer) is detected per message, so
 *     "what's the case number?" gets a direct answer, not a forensic report.
 * ============================================================================ */
/* SOTI AI Analyser - Elite Sidepanel Engine */
const $ = id => document.getElementById(id);
// Build stamp — bump when shipping. If the side panel's DevTools console does NOT show this
// exact line after reloading the extension, Chrome is still running an old cached copy.
console.log('%c[SOTI AI Analyser] build 2.4.9 — SOTI Version live product-switch fix (boot onchange clobber resolved: MobiControl 2026.0.0 / XSight 2026.0)', 'color:#0a84ff;font-weight:bold');
let cases = []; // { id, name, msgs, logs, ci }
let activeCaseId = null;
// Per-case busy tracking — enables simultaneous AI chats across cases
const busyMap = new Map();       // caseId -> true/false
const streamControllers = new Map(); // caseId -> AbortController
const streamingElements = new Map(); // caseId -> live aib DOM element currently being streamed into

// Keep-alive: prevent browser from throttling the side panel when user switches tabs.
// Without this, the fetch/stream loop is paused mid-response when the panel is hidden.
(function installVisibilityKeepAlive() {
    let keepAliveInterval = null;
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            // Start a no-op interval to keep the JS event loop warm while tab is hidden
            if (!keepAliveInterval) {
                keepAliveInterval = setInterval(() => { /* keep-alive ping */ }, 200);
            }
        } else {
            // Tab is visible again — clear the keep-alive and re-scroll to any active stream
            if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
                keepAliveInterval = null;
            }
            // Re-scroll to the live streaming element so user can see it resumed
            if (activeCaseId) {
                const liveEl = streamingElements.get(activeCaseId);
                const chat = document.getElementById('chatMsgs');
                if (liveEl && chat && chat.contains(liveEl)) {
                    liveEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
                }
            }
        }
    });
})();
let RELEASE_NOTES_CONTENT = "";
let PULSE_SEARCH_RESULTS = "";
let DOCS_SEARCH_RESULTS = "";
let RESEARCHED_ARTICLE_CONTENT = "";
let VERSIONS = [], AGENT_VERSIONS = [], IDENTITY_VERSIONS = [];
const PULSE_ORIGIN = 'https://pulse.soti.net';
const DOCS_ORIGIN = 'https://docs.soti.net';
let PULSE_RELEASE_NOTE_CATALOG = {};

function isChromeExtension() {
    return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
}

function isStandalonePage() {
    return !isChromeExtension();
}

function md(t) {
    if (!t) return "";
    // SECURITY (defence-in-depth on top of the CSP): md() output goes to innerHTML, and its
    // input can include untrusted text (a scraped case/email, OCR text, or the local model's
    // echo of that content). HTML-escape the input BEFORE applying markdown so no injected tag
    // (<img src="http…"> beacon, <script>, <iframe>, event handler) can ever render — the CSP
    // already blocks execution/exfiltration, this closes the gap if the CSP is ever relaxed.
    // The app's OWN inline previews (self-contained base64 data: images for attached
    // screenshots) and its OWN static UI markup (the "thinking…" loading spinner, injected as
    // literal HTML while a response streams) are the only trusted HTML this function ever
    // receives — set them aside so escaping doesn't destroy them, then restore after the
    // markdown pass. Nothing here is templated with user/case/AI-controlled data.
    const _safeImgs = [];
    t = String(t)
        .replace(/<img\s+src="data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[^"]*"[^>]*>/gi, (m) => {
            _safeImgs.push(m);
            return `%%SAFEIMG${_safeImgs.length - 1}%%`;
        })
        .replace(/<div class="thinking-dot"><\/div>/g, (m) => {
            _safeImgs.push(m);
            return `%%SAFEIMG${_safeImgs.length - 1}%%`;
        });
    t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = t.trim()
        // 1. Fix token-mashing where AI forgets spaces around bold tags (e.g. the**Android**tab)
        .replace(/([A-Za-z0-9.,])\*\*/g, '$1 **')
        .replace(/\*\*([A-Za-z0-9])/g, '** $1')
        
        // 2. Force newlines before markdown headings (###) that got squashed inline (e.g. Procedure:### Method)
        .replace(/([^\n])\s*(#{1,3})\s/g, '$1\n\n$2 ')
        
        // 3. Force newlines before numbered lists that got squashed (e.g. UUID 1. Log into)
        .replace(/([a-zA-Z:).*\"])\s*(\d+\.\s+[A-Z])/g, (match, p1, p2, offset, string) => {
            let before = string.slice(Math.max(0, offset - 15), offset);
            if (/(Step|Method)\s*$/i.test(before)) return match;
            return p1 + '\n\n' + p2;
        })
        
        // 4. Force newlines before bullet points that got squashed (e.g. Tips:- Ensure)
        .replace(/([a-zA-Z:.])\s*([•*+-])\s+([A-Z])/g, '$1\n\n$2 $3')
        
        // 5. Force spacing before common inline headers and guide steps (Case-insensitive, safe headers only)
        .replace(/(^|\W)(\*\*)?(Time of the meeting|Summary|Troubleshooting tips|Troubleshooting steps|Next steps|Additional information|Root cause|Resolution|Pre-requisites|Prerequisites|Step \d+|Method \d+):\s*(\*\*)?/gi, '$1\n\n**$3:** ')
        
        .replace(/```([\s\S]*?)```/g, '<div style="background:rgba(0,0,0,0.3); padding:12px; border-radius:8px; font-family:monospace; margin:15px 0; border:1px solid rgba(255,255,255,0.1); white-space:pre-wrap; word-break:break-all; font-size:12px">$1</div>')
        .replace(/\*\*\s*([\s\S]*?)\s*\*\*/g, '<strong>$1</strong>')
        .replace(/\*\s*([\s\S]*?)\s*\*/g, '<em>$1</em>')
        .replace(/^\s*###\s*(.*$)/gim, '<h3 style="margin:22px 0 10px; color:var(--blue); font-weight:700; line-height:1.3">$1</h3>')
        .replace(/^\s*##\s*(.*$)/gim, '<h2 style="margin:28px 0 12px; color:var(--blue); font-weight:700; line-height:1.3">$1</h2>')
        .replace(/^\s*#\s*(.*$)/gim, '<h1 style="margin:35px 0 15px; color:var(--blue); font-weight:700; line-height:1.3">$1</h1>')
        .replace(/^\s*---\s*$/gm, '<hr style="border:0; border-top:1px solid var(--border); margin:25px 0">')
        .replace(/\n\n/g, '<div style="margin-bottom:18px"></div>')
        .replace(/\n/g, '<br>')
        .replace(/^\s*(\d+\.)\s+(.*)$/gim, '<div style="margin-left:10px; margin-bottom:10px; display:flex; align-items:flex-start"><span style="min-width:25px; font-weight:bold; color:var(--blue)">$1</span><span>$2</span></div>')
        .replace(/^\s*[•*+-]\s+(.*)$/gim, '<div style="margin-left:10px; margin-bottom:10px; display:flex; align-items:flex-start"><span style="min-width:25px; color:var(--blue)">•</span><span>$1</span></div>');
        
    // Restore the app's own inline image previews that were protected before escaping.
    html = html.replace(/%%SAFEIMG(\d+)%%/g, (m, i) => _safeImgs[+i] || '');
    // Clean up any stray leading/trailing breaks that might have been injected
    return html.replace(/^(<br>|<div style="margin-bottom:18px"><\/div>|\s)+/, '').replace(/(<br>|<div style="margin-bottom:18px"><\/div>|\s)+$/, '');
}

// Strip leaked [EMAIL CHAIN] "Message N" markers from ANY model output. The numbering is
// internal prompt structure; user-facing text must reference emails by author/date. Handles
// parentheticals with any short lead-in ("(Provided in Message 23)", "(see Message 3)",
// "(Message 19)"), inline references ("as noted in Message 4 of 13"), plural lists
// ("Messages 3 and 5"), and bare noun uses ("Message 7 shows..."). "Message" is matched
// case-SENSITIVELY (the markers always capitalize it) so real prose like
// "the error message 404" is never touched.
function stripEmailChainMarkers(text) {
    return String(text)
        .replace(/\s*\(\s*[^()]{0,40}?Messages?\s+\d+[^()]{0,24}?\s*\)/g, "")
        .replace(/\b(?:in|from|per|at)\s+Message\s+\d+(?:\s+of\s+\d+)?\b/g, "in the email chain")
        .replace(/\bMessage\s+\d+\s+of\s+\d+,?\s*/g, "the message ")
        .replace(/\bMessages\s+\d+(?:\s*(?:,|and|&|to|through|[-–])\s*\d+)*\b/g, "earlier emails")
        .replace(/\bMessage\s+\d+\b(?!\s*(?:of|\)))/g, "an email in the chain");
}

function sanitizeAssistantResponse(text) {
    if (!text) return "";
    
    // Strip thinking/reasoning blocks from models like Gemma 4 e2b/e4b, QwQ, etc.
    // These models may wrap internal reasoning in <think>...</think> or <|think|>...<|/think|> tags.
    // IMPORTANT: only remove WELL-FORMED (closed) blocks. The old version stripped to end-of-string
    // on an unclosed tag, which nuked the entire answer to blank when a model emitted a stray/unclosed
    // <think>. Any leftover lone markers are removed but their inner text is kept.
    let cleaned = text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<\|think\|>[\s\S]*?<\|\/?think\|>/gi, '')
        .replace(/<\/?\|?think\|?>/gi, '')
        .trim();
    
    // Replace bracketed labels with natural English to maintain grammar if the model outputs them as nouns
    cleaned = cleaned
        .replace(/\[LATEST MOBICONTROL VERSION\]/gi, "latest MobiControl version")
        .replace(/\[ALL MOBICONTROL VERSIONS\]/gi, "MobiControl versions")
        .replace(/\[LATEST ANDROID AGENT VERSION\]/gi, "latest Android Agent version")
        .replace(/\[ALL ANDROID AGENT VERSIONS\]/gi, "Android Agent versions")
        .replace(/\[LATEST IDENTITY VERSION\]/gi, "latest SOTI Identity version")
        .replace(/\[ALL IDENTITY VERSIONS\]/gi, "SOTI Identity versions")
        .replace(/\[RELEASE NOTES\]/gi, "release notes")
        .replace(/\[PULSE SEARCH\]/gi, "SOTI Pulse search")
        .replace(/\[DOCS SEARCH\]/gi, "SOTI Docs search")
        .replace(/\[DEEP RESEARCH\]/gi, "deep research");

    const LABELS = 'MC VERSIONS|AGENT VERSIONS|IDENTITY VERSIONS|LATEST MOBICONTROL VERSION|ALL MOBICONTROL VERSIONS|LATEST ANDROID AGENT VERSION|ALL ANDROID AGENT VERSIONS|LATEST IDENTITY VERSION|ALL IDENTITY VERSIONS|RELEASE NOTES|RELEASE_NOTES|PULSE SEARCH|PULSE_SEARCH|PULSESEARCH|DOCS SEARCH|DOCS_SEARCH|DOCSSEARCH|DEEP RESEARCH|DEEP_RESEARCH|DEEPRESEARCH|CASE|CASE CONTEXT|CASE_CONTEXT|ISSUE SUMMARY|ISSUE_SUMMARY|ISSUESUMMARY';
    const labelRx = new RegExp(`\\[(?:${LABELS})\\]`, 'gi');
    const accordingRx = new RegExp(`\\b(?:According to|based on)\\s+(?:available information|(?:${labelRx.source}(?:,\\s*|\\s+and\\s+)?)+)\\s*,?\\s*`, 'gi');
    const strayRx = new RegExp(`\\s*${labelRx.source}(?:,\\s*|\\s+and\\s+)?\\s*`, 'gi');
    const refRx = /\b(?:for more (?:detailed )?information|reference|see)\s*,?\s*(?:at\s*)?\[(?:DEEP RESEARCH|DEEP_RESEARCH|DEEPRESEARCH|DOCS SEARCH|DOCS_SEARCH|DOCSSEARCH|PULSE SEARCH|PULSE_SEARCH|PULSESEARCH)\][^\n.]*/gi;
    
    cleaned = cleaned
        .replace(accordingRx, "")
        .replace(strayRx, " ")
        .replace(refRx, "")
        .replace(/\bNo specific highlights[^.]*\./gi, "")
        // Remove leftover citation PLACEHOLDERS the model copies from the template instead of
        // real values ("Line N", "Line X", "@ Timestamp T", "(timestamp)", "ExceptionClass").
        // Real citations use digits ("Line 8924") and real dates, so these only match garbage.
        .replace(/\s*@\s*Timestamp(?:\s+[A-Z]\b)?/g, "")     // "@ Timestamp T" / "@ Timestamp"
        .replace(/:?\s*Lines?\s+[A-Z]\b(?:\s*-\s*[A-Z]\b)?/g, "")  // ":Line N" / "Lines X-Y" placeholders
        .replace(/\(\s*timestamp\s*\)/gi, "")
        .replace(/`?\bExceptionClass\b`?/g, "the exception")
        // Strip any "Based on …," preamble at the very START of the answer (the user never wants
        // the response to open with "Based on the provided documentation / the logs / …").
        .replace(/^\s*[Bb]ased (?:on|upon)\b[^,.\n]{0,90}[,:]\s*/, "")
        // Strip source meta-commentary the model sometimes prepends mid-text and the unhelpful
        // "consult/contact support" deflections.
        .replace(/\b[Bb]ased on (?:the )?(?:provided|retrieved|available|the above)[^,.\n]*,?\s*/g, "")
        .replace(/\b(?:the )?(?:retrieved|provided) (?:knowledge base|documentation|context|information)\b/gi, "the SOTI documentation")
        .replace(/[^.\n]*\b(?:consult the full SOTI documentation|contact SOTI support|was not (?:explicitly )?detailed in[^.\n]*)\b[^.\n]*\.?/gi, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n {1,}/g, "\n")
        .trim();
    return stripEmailChainMarkers(cleaned).replace(/[ \t]{2,}/g, " ").trim();
}

function getDefaultCI() {
    return {
        caseNum: '', sotiVer: '', platform: '', agentVer: '', caseAge: '',
        scrubAccount: '', scrubCustomer: '',
        meetingNotes: 'Time of the meeting:\n\nSummary:\n\nTroubleshooting steps:\n\nNext steps:',
        issueSummary: '', product: '', emailChain: '',
        jiraExpected: '', jiraImpact: '', jiraPriority: 'Medium', jiraRepro: ''
    };
}

function getDefaultCase(name = 'Case 1') {
    return {
        id: 'case-' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.floor(Math.random() * 10000)),
        name,
        msgs: [],
        logs: [],
        imgs: [], // { name, data, text }
        ci: getDefaultCI(),
        createdAt: Date.now() // Used for data retention enforcement
    };
}

let _suppressStorageReload = false;
let _saveStateTimer = null;
let _renderTabsTimer = null;
// Deterministic guard against reloading our OWN storage writes. The old 80ms timer was too
// short once a case held megabytes of logs: chrome.storage.local.set took longer than 80ms,
// so the suppress flag cleared before our own onChanged fired, the listener reloaded our
// write, re-rendered (tab flicker, scroll jump) and re-saved — a self-sustaining glitch loop.
// Now every write carries a unique token; the listener ignores any change carrying our token.
let _lastWriteToken = '';
function _newWriteToken() {
    _lastWriteToken = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    return _lastWriteToken;
}

function buildCaseCiFromForm() {
    return {
        caseNum: $('caseNum').value,
        sotiVer: $('sotiVer').value,
        platform: $('platform').value,
        agentVer: $('agentVer').value,
        caseAge: $('caseAge').value,
        scrubAccount: $('scrubAccount').value,
        scrubCustomer: $('scrubCustomer').value,
        meetingNotes: $('meetingNotes').value,
        issueSummary: $('issueSummary').value,
        product: $('product').value,
        emailChain: $('emailChain').value,
        jiraExpected: $('jiraExpected').value,
        jiraImpact: $('jiraImpact').value,
        jiraPriority: $('jiraPriority').value,
        jiraRepro: $('jiraRepro').value
    };
}

function syncActiveCaseCiFromForm() {
    if (!activeCaseId) return false;
    const idx = cases.findIndex(c => c.id === activeCaseId);
    if (idx === -1) return false;
    cases[idx].ci = buildCaseCiFromForm();
    return true;
}

function scheduleSaveState(delayMs = 450) {
    if (_saveStateTimer) clearTimeout(_saveStateTimer);
    const caseIdAtSchedule = activeCaseId;
    _saveStateTimer = setTimeout(() => {
        _saveStateTimer = null;
        if (!caseIdAtSchedule || activeCaseId !== caseIdAtSchedule) return;
        saveState();
    }, delayMs);
}

function scheduleRenderTabs(delayMs = 280) {
    if (_renderTabsTimer) clearTimeout(_renderTabsTimer);
    _renderTabsTimer = setTimeout(() => {
        _renderTabsTimer = null;
        renderTabs();
    }, delayMs);
}

async function saveState() {
    if (!activeCaseId) return;
    try {
        if (!syncActiveCaseCiFromForm()) return;

        // Stamp the active case as "touched now" so the 30-day inactivity retention clock
        // resets whenever the user works on it (saveState runs on edits, attaches, sends).
        const _activeCase = cases.find(x => x.id === activeCaseId);
        if (_activeCase) _activeCase.updatedAt = Date.now();

        // Write a lightweight quick-cache to sessionStorage for instant UI on next open.
        // This is synchronous and extremely fast — it only stores tab names and the last 20 msgs.
        try {
            const quickCache = {
                activeCaseId,
                cases: cases.map(c => ({
                    id: c.id,
                    name: c.name,
                    createdAt: c.createdAt,
                    ci: c.ci,
                    logs: (c.logs || []).map(l => ({ name: l.name, size: l.content ? l.content.length : 0 })),
                    msgs: (c.msgs || []).filter(m => !m.hidden).slice(-20)
                }))
            };
            sessionStorage.setItem('soti_ai_quick_cache', JSON.stringify(quickCache));
        } catch (e) { /* sessionStorage may be unavailable in some contexts */ }

        _suppressStorageReload = true;
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            await chrome.storage.local.set({ cases, activeCaseId, _stateWriteToken: _newWriteToken() });
        } else {
            localStorage.setItem('soti_ai_state', JSON.stringify({ cases, activeCaseId }));
        }
    } catch (e) {
        console.error('CRITICAL: Save failed', e);
        if (e.message.includes('quota')) {
            toast('Storage quota exceeded! Clear old cases.', 'e');
        } else {
            toast('Failed to save session state', 'e');
        }
    } finally {
        setTimeout(() => { _suppressStorageReload = false; }, 80);
    }
}

async function loadState() {
    // --- PHASE 1: INSTANT RENDER from sessionStorage quick-cache (synchronous, zero delay) ---
    // Paint the UI immediately so the user sees their cases the moment the extension opens.
    try {
        const raw = sessionStorage.getItem('soti_ai_quick_cache');
        if (raw) {
            const quick = JSON.parse(raw);
            if (quick.cases && quick.cases.length > 0) {
                // Inflate minimal case objects enough to render tabs and chat history
                cases = quick.cases.map(c => ({
                    ...c,
                    logs: [],  // log content not cached (too large) — restored in phase 2
                    imgs: []
                }));
                activeCaseId = null;
                renderTabs();
                switchCase(quick.activeCaseId || cases[0].id);
            }
        }
    } catch (e) { /* ignore quick-cache errors, full load below will fix everything */ }

    // --- PHASE 2: FULL LOAD from chrome.storage (async, replaces quick render if needed) ---
    try {
        let data = {};
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            data = await chrome.storage.local.get(['cases', 'activeCaseId', 'msgs', 'ci', 'logs', 'cachedVersions']);
        } else {
            // Fallback to localStorage if chrome API is missing (standalone mode)
            const local = localStorage.getItem('soti_ai_state');
            if (local) data = JSON.parse(local);
            const cached = localStorage.getItem('soti_ai_cached_versions');
            if (cached) data.cachedVersions = JSON.parse(cached);
        }
        
        // Populate cached versions immediately on startup to avoid race conditions
        if (data.cachedVersions) {
            VERSIONS = data.cachedVersions.VERSIONS || [];
            AGENT_VERSIONS = data.cachedVersions.AGENT_VERSIONS || [];
            IDENTITY_VERSIONS = data.cachedVersions.IDENTITY_VERSIONS || [];
            updateVersionDropdowns();
        }
        
        // Migration logic for old single-session data
        if (data.msgs && !data.cases) {
            const oldCase = {
                id: 'case-' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.floor(Math.random() * 10000)),
                name: 'Case 1',
                msgs: data.msgs || [],
                logs: data.logs || [],
                ci: data.ci || {}
            };
            cases = [oldCase];
            activeCaseId = oldCase.id;
        } if (data.cases && data.cases.length > 0) {
            cases = data.cases;
            const targetId = data.activeCaseId || cases[0].id;
            
            // Patch existing cases for missing properties
            const template = 'Time of the meeting:\n\nSummary:\n\nTroubleshooting steps:\n\nNext steps:';
            cases.forEach(c => {
                if (c.ci && (!c.ci.meetingNotes || c.ci.meetingNotes.trim() === "")) {
                    c.ci.meetingNotes = template;
                }
                if (!c.imgs) c.imgs = [];
                if (!c.createdAt) c.createdAt = Date.now(); // Backfill for older cases
                // Migration: older versions stored full log dumps inside chat messages,
                // which crowded newly added logs out of the model's context. Strip them.
                if (Array.isArray(c.msgs)) {
                    c.msgs.forEach(m => {
                        if (m && typeof m.content === 'string' && m.content.includes('=== FILE:')) {
                            m.content = m.content.replace(/=== FILE:[\s\S]*?=== END[^\n]*\n?/g, '[log snippet removed — logs are attached to the case]\n');
                        }
                    });
                }
            });

            // DATA RETENTION: auto-purge cases (and their stored logs) after 30 days of
            // INACTIVITY. Sensitive customer logs shouldn't sit on disk longer than needed.
            // Keyed on last activity (updatedAt/lastSentAt), not creation time, so a case you
            // keep working on survives and only genuinely idle cases are cleared.
            const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days of inactivity
            const now = Date.now();
            const before = cases.length;
            const lastTouch = c => c.updatedAt || c.lastSentAt || c.createdAt || now;
            cases = cases.filter(c => (now - lastTouch(c)) < RETENTION_MS);
            const purged = before - cases.length;
            if (purged > 0) {
                console.warn(`[Security] Data retention: purged ${purged} case(s) idle for over 30 days.`);
                toast(`${purged} idle case(s) auto-cleared (30-day retention policy)`, 'w', 5000);
                if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.set({ cases, _stateWriteToken: _newWriteToken() });
                }
            }

            // If all cases were purged, create a fresh default
            if (cases.length === 0) {
                const newCase = getDefaultCase('Case 1');
                cases = [newCase];
                activeCaseId = null; // Force re-render
                renderTabs();
                switchCase(newCase.id);
                return;
            }

            const safeTargetId = cases.find(c => c.id === targetId) ? targetId : cases[0].id;
            renderTabs();
            activeCaseId = null; // Force re-render and avoid saving stale DOM state
            switchCase(safeTargetId);
            return;
        } 
        
        // If we reach here, we need a default case
        const newCase = getDefaultCase('Case 1');
        cases = [newCase];
        activeCaseId = null; // Force re-render
        saveState();

        renderTabs();
        switchCase(newCase.id);
    } catch (e) { 
        console.warn('Load failed', e);
        // Absolute fallback if everything fails
        if (cases.length === 0) {
            const id = 'case-fallback';
            cases = [{ id, name: 'Case 1', msgs: [], logs: [], ci: getDefaultCI() }];
            activeCaseId = id;
            renderTabs();
            switchCase(id);
        }
    }
}

function createNewCase() {
    // Cancel any pending renderTabs timer
    if (_renderTabsTimer) { clearTimeout(_renderTabsTimer); _renderTabsTimer = null; }
    // Find the highest number in existing case names to determine next name
    let nextNum = cases.length + 1;
    const names = cases.map(c => c.name);
    while (names.includes(`Case ${nextNum}`)) {
        nextNum++;
    }
    const name = `Case ${nextNum}`;
    const newCase = getDefaultCase(name);
    cases.push(newCase);
    renderTabs();
    switchCase(newCase.id);
}

let _switching = false; // true while switchCase is executing — blocks field handlers

function switchCase(id) {
    if (!id || !cases.find(x => x.id === id)) {
        if (cases.length > 0 && cases[0].id !== id) switchCase(cases[0].id);
        return;
    }

    // If already fully rendered on this tab, just ensure highlight is correct
    if (activeCaseId === id) {
        document.querySelectorAll('.tab-item').forEach(t =>
            t.classList.toggle('active', t.dataset.id === id)
        );
        return;
    }

    // Reentrance guard — if we're already mid-switch, just update the target
    if (_switching) return;
    _switching = true;

    // Cancel all pending timers — we're doing a definitive switch right now
    if (_saveStateTimer) { clearTimeout(_saveStateTimer); _saveStateTimer = null; }
    if (_renderTabsTimer) { clearTimeout(_renderTabsTimer); _renderTabsTimer = null; }

    try {
        const c = cases.find(x => x.id === id);
        if (!c) { _switching = false; return; }

        // Snapshot the OLD case's form values before overwriting the DOM
        if (activeCaseId) syncActiveCaseCiFromForm();
        activeCaseId = id;

        // Update UI Fields
        $('caseNum').value = c.ci.caseNum || '';
        $('sotiVer').value = c.ci.sotiVer || '';
        $('platform').value = c.ci.platform || '';
        $('agentVer').value = c.ci.agentVer || '';
        $('caseAge').value = c.ci.caseAge || '';
        $('scrubAccount').value = c.ci.scrubAccount || '';
        $('scrubCustomer').value = c.ci.scrubCustomer || '';
        $('meetingNotes').value = c.ci.meetingNotes || '';
        $('issueSummary').value = c.ci.issueSummary || '';
        $('product').value = c.ci.product || '';
        $('emailChain').value = c.ci.emailChain || '';
        $('jiraExpected').value = c.ci.jiraExpected || '';
        $('jiraImpact').value = c.ci.jiraImpact || '';
        $('jiraPriority').value = c.ci.jiraPriority || 'Medium';
        $('jiraRepro').value = c.ci.jiraRepro || '';

        // Rebuild the version dropdowns for the restored product (e.g. so MobiControl shows
        // "2026.0.0" while XSight shows "2026.0"). Setting .value above doesn't fire the
        // product 'onchange', and updateVersionDropdowns() rebuilds the <option> lists, so
        // re-apply the saved version selections afterward.
        updateVersionDropdowns();
        $('sotiVer').value = c.ci.sotiVer || '';
        $('agentVer').value = c.ci.agentVer || '';

        // Re-render Chat
        const chat = $('chatMsgs');
        if (chat) {
            chat.querySelectorAll('.msg').forEach(m => m.remove());

            if (c.msgs.length === 0) {
                if ($('welcome')) $('welcome').style.display = 'flex';
            } else {
                if ($('welcome')) $('welcome').style.display = 'none';
                const frag = document.createDocumentFragment();
                c.msgs.forEach(m => {
                    if (m.hidden) return;
                    const w = document.createElement('div'); w.className = `msg ${m.role}`;
                    const b = document.createElement('div'); b.className = 'mb'; b.innerHTML = md(m.content);
                    w.appendChild(b);
                    // Re-attach 👍/👎 so rated answers keep their confirmation and unrated ones keep their buttons.
                    if (m.role === 'assistant') attachFeedbackUI(b, c, m);
                    frag.appendChild(w);
                });
                chat.appendChild(frag);

                // Re-attach any live streaming element for this case
                const liveAib = streamingElements.get(id);
                if (liveAib) {
                    const liveWrapper = document.createElement('div');
                    liveWrapper.className = 'msg assistant';
                    liveWrapper.appendChild(liveAib);
                    chat.appendChild(liveWrapper);
                }

                chat.scrollTop = chat.scrollHeight;
            }
        }

        renderImgs();
        renderLogs();
        updateAllValidations();

        // Update tab highlight
        document.querySelectorAll('.tab-item').forEach(t =>
            t.classList.toggle('active', t.dataset.id === id)
        );

        // Deferred storage write — token-tagged so our own onChanged is ignored (no reload loop)
        _suppressStorageReload = true;
        requestAnimationFrame(() => {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ cases, activeCaseId, _stateWriteToken: _newWriteToken() }).catch(e =>
                    console.error('SwitchCase save failed', e)
                ).finally(() => {
                    setTimeout(() => { _suppressStorageReload = false; }, 80);
                });
            } else {
                try { localStorage.setItem('soti_ai_state', JSON.stringify({ cases, activeCaseId })); } catch(e) {}
                setTimeout(() => { _suppressStorageReload = false; }, 80);
            }
        });
    } finally {
        _switching = false;
    }
}

function closeCase(id, e) {
    if (e) e.stopPropagation();
    if (cases.length <= 1) {
        const c = cases[0];
        c.name = 'Case 1';
        c.msgs = []; 
        c.logs = []; 
        c.ci = getDefaultCI();
        // Force switchCase to run even if it's already active to refresh the UI
        const oldId = activeCaseId;
        activeCaseId = null;
        switchCase(oldId || c.id);
        renderTabs();
        return;
    }

    const idx = cases.findIndex(c => c.id === id);
    if (idx === -1) return;
    
    const wasActive = (activeCaseId === id);
    cases.splice(idx, 1);
    
    if (wasActive) {
        const nextId = cases[Math.max(0, idx - 1)].id;
        switchCase(nextId);
    }
    renderTabs();
    saveState();
}

function renderTabs() {
    const bar = $('tabBar');
    if (!bar) return;
    const scrollLeft = bar.scrollLeft;

    // --- Smart in-place patch ---
    // Build a map of existing tab elements by case ID so we can reuse them.
    // This avoids destroying DOM nodes mid-click, which was causing the glitch.
    const existingMap = new Map();
    bar.querySelectorAll('.tab-item').forEach(el => {
        existingMap.set(el.dataset.id, el);
    });

    const usedIds = new Set();

    cases.forEach((c, i) => {
        const label = c.ci.caseNum ? `Case ${c.ci.caseNum}` : c.name;
        let t = existingMap.get(c.id);

        if (!t) {
            // Brand-new tab — create the element
            t = document.createElement('div');
            t.dataset.id = c.id;
            t.draggable = true;

            const name = document.createElement('span');
            name.className = 'tab-name';
            t.appendChild(name);

            const close = document.createElement('div');
            close.className = 'tab-close';
            close.textContent = '×';
            close.onclick = (e) => closeCase(c.id, e);
            t.appendChild(close);

            // Wire click on the tab itself (not the close button)
            t.onclick = (e) => {
                if (e.target.classList.contains('tab-close')) return;
                switchCase(c.id);
            };
            t.ondragstart = (e) => {
                e.dataTransfer.setData('text/plain', i);
                t.classList.add('dragging');
            };
            t.ondragend = () => t.classList.remove('dragging');
            t.ondragover = (e) => e.preventDefault();
            t.ondrop = (e) => {
                e.preventDefault();
                const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
                const toIdx = cases.findIndex(x => x.id === c.id);
                if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
                const [moved] = cases.splice(fromIdx, 1);
                cases.splice(toIdx, 0, moved);
                renderTabs();
                saveState();
            };
        }

        // Always update class and label (cheap — no DOM destruction)
        t.className = `tab-item${c.id === activeCaseId ? ' active' : ''}`;
        t.querySelector('.tab-name').textContent = label;
        usedIds.add(c.id);

        // Ensure correct order: append moves it to the right position
        bar.appendChild(t);
    });

    // Remove tabs for cases that no longer exist
    existingMap.forEach((el, id) => {
        if (!usedIds.has(id)) bar.removeChild(el);
    });

    bar.scrollLeft = scrollLeft;
}




const SOTI_KB = {
    common: {
        "SQL": "SQL Collation: Case-insensitive (CI) and Accent-sensitive (AS) required (e.g., SQL_Latin1_General_CP1_CI_AS). DB Maintenance: DBInstall.log. Port: 1433.",
        "MCAU": "MCAU: Manage services, Verbose logging, DB connection string decryption.",
        "PORT": "Critical: MS/DS (5494), Signal (13131), APNS (2197), Web (443).",
        "UPGRADE": "Upgrade Check: ProgramData\\SOTI\\DBInstall.log for schema failures."
    },
    android: {
        "Enrollment": "Android Enterprise Work Managed via QR/ZeroTouch/afw#mobicontrol. Play Store for GMS devices.",
        "Zebra": "StageNow requires MX compatibility with Android agent.",
        "Samsung": "KME requires SOTI Agent APK URL for Knox devices.",
        "Application Run Control": "Primary tool for blocking/allowing apps. Found in: Profiles -> Configurations -> Application Run Control. Use 'Blacklist' to prevent apps from running.",
        "Google Assistant": "Package: com.google.android.apps.googleassistant. To disable, add to Application Run Control Blacklist or check 'Restrictions' configuration for a specific toggle.",
        "Packages": "Google Assistant: com.google.android.apps.googleassistant, Play Store: com.android.vending, Settings: com.android.settings."
    },
    navigation: {
        "Profiles_v15": "Profiles -> [Profile Name] -> Configurations -> Add (+) -> [Feature Name]",
        "App_Policies": "Apps -> App Policies (Used for deployment, not usually for blocking)."
    },
    identity: {
        "Authentication": "Supports NFC Tag, NFC + PIN, Passkey, and standard LDAP/Entra ID authentication.",
        "SSO": "Centralized Single Sign-On for SOTI ONE apps and third-party integrations (O365, Google, Okta, etc.) via App Catalog.",
        "User Management": "Unified portal for managing users across multiple directories (LDAP, Azure AD/Entra ID).",
        "Security": "Conditional access policies, persistent PIN for lockdown, and multi-factor authentication (MFA)."
    },
    services: {
        "CORE": ["SOTI Management Service", "SOTI Deployment Server", "SOTI Deployment Server Extensions"],
        "SECONDARY": ["SOTI Search Service", "SOTI Activation Service", "SOTI Location Service", "SOTI Enrollment Service", "SOTI Agent Builder Service"],
        "HOSTING": "The SOTI Management Service hosts the Web Console. There is NO separate 'Web Hosting' service."
    }
};

// --- UTILS ---
const LOG_UPLOAD_TOASTS = new Set(['Uploading logs...', 'Logs uploaded']);

function toast(msg, t = '', dur = 3000) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show' + (t ? ' ' + t : '');
    if (dur > 0) setTimeout(() => el.className = 'toast', dur);
}

function extractLogTimestamp(line) {
    const patterns = [
        /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,7})?(?:Z|[+-]\d{2}:?\d{2})?\b/,
        /\b\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}(?:[.,]\d{1,7})?(?:\s*(?:AM|PM))?\b/i,
        /\b\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}(?:[.,]\d{1,7})?\b/,
        /\b\d{1,2}:\d{2}:\d{2}:\d{1,7}\b/,
        /\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,7})?(?:\s*(?:AM|PM))?\b/i
    ];
    for (const p of patterns) {
        const m = line.match(p);
        if (m) return normalizeLogTimestamp(m[0]);
    }
    return "";
}

function normalizeLogTimestamp(ts) {
    if (!ts) return "";
    let text = String(ts).trim();
    const ampm = (text.match(/\s+(AM|PM)$/i) || [])[1] || "";
    if (ampm) text = text.replace(/\s+(AM|PM)$/i, "");
    text = text.replace(',', '.');

    // MSI logs use HH:MM:SS:mmm. Normalize to HH:MM:SS.mmm so sorting and display
    // preserve millisecond precision consistently with ISO/.NET timestamps.
    text = text.replace(/\b(\d{1,2}:\d{2}:\d{2}):(\d{1,7})\b/, (_, hms, frac) => {
        return `${hms}.${frac.padEnd(3, "0").slice(0, 7)}`;
    });

    return ampm ? `${text} ${ampm.toUpperCase()}` : text;
}

function extractInstallerBaseDate(content) {
    const m = (content || "").match(/Verbose logging started:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}:\d{2}:\d{2})/i);
    if (!m) return { date: "", startTime: "" };
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3];
    const month = a > 12 ? b : a;
    const day = a > 12 ? a : b;
    const pad = n => String(n).padStart(2, "0");
    return {
        date: `${year}-${pad(month)}-${pad(day)}`,
        startTime: normalizeLogTimestamp(m[4])
    };
}

function combineInstallerDateTime(baseDate, timestamp) {
    if (!timestamp) return "";
    if (/^\d{4}-\d{2}-\d{2}/.test(timestamp)) return timestamp.replace("T", " ");
    const time = formatInstallerTime(timestamp);
    return baseDate && time && time !== "No timestamp" ? `${baseDate} ${time}` : (timestamp || "");
}

function normalizeLogSignature(text) {
    return (text || "")
        .replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,7})?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "")
        .replace(/\b\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}(?:[.,]\d{1,7})?(?:\s*(?:AM|PM))?\b/gi, "")
        .replace(/\b\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}(?:[.,]\d{1,7})?\b/g, "")
        .replace(/\b\d{1,2}:\d{2}:\d{2}:\d{1,7}\b/g, "")
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "{guid}")
        .replace(/0x[0-9a-fA-F]+/g, "{hex}")
        .replace(/\b\d+\b/g, "{n}")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 260);
}

const EXCEPTION_CLASS_PATTERN = String.raw`((?:[A-Za-z_]\w*\.)+[A-Za-z_]\w*(?:Exception|Error)|[A-Za-z_]\w*(?:Exception|Error)|AggregateException|SqlException|SQLException|TimeoutException|SocketException|WebException|IOException|UnauthorizedAccessException|InvalidOperationException|NullReferenceException|OutOfMemoryException|StackOverflowException|AuthenticationException|SecurityException|TypeError|ReferenceError|RangeError|SyntaxError|ValueError|KeyError|IndexError|RuntimeError|OSError)`;

const FAST_FORENSIC_PREFILTER = /\b(error|err|warn|warning|fail|except|fatal|critic|panic|sever|cannot|can't|unable|deny|denied|refus|reject|block|abort|crash|fault|corrupt|invalid|unsupport|timeout|deadlock|rollback|unreach|unavail|mismat|malform|miss|expir|revok|hresult|win32|mcmr|mobicontrol|mcau|customaction|1603|returning|value\s+3|fqdn|uri|validation|cert|tls|ssl|connection|refused|econnrefused|etimedout|deploy|database|sql|db|server|dns|http|port|sso|oauth|saml|oidc|idp|issuer|identityserver|identity|unauthor|forbidden|logon|login|redirect|authoriz|entity|token|429|403|401|404|500|502|503)\b|^\s*at\s+/i;

const DEFAULT_LINE_CLASSIFICATION = {
    categories: [],
    hasException: false,
    hasErrorWord: false,
    hasLogSeverity: false,
    hasStackFrame: false,
    severityToken: "",
    exceptionClasses: [],
    keywordHits: [],
    isForensic: false
};

let _lastYield = performance.now();
async function yieldIfNeeded() {
    const now = performance.now();
    if (now - _lastYield > 20) {
        await new Promise(r => setTimeout(r, 0));
        _lastYield = performance.now();
    }
}

function findLogObject(fileName, content) {
    const c = cases.find(x => x.id === activeCaseId);
    if (!c || !c.logs) return null;
    return c.logs.find(l => l.name === fileName && (l.content === content || (content && l.content.length === content.length))) || null;
}

async function precomputeLogIntel(log) {
    if (!log) return;
    const content = log.content || "";
    const lines = log.lines || (content ? content.split('\n') : []);
    const cacheKey = `${log.name || ""}:${content.length}`;
    if (log.precomputedIntel && log.precomputedIntel.cacheKey === cacheKey) return;

    if (log.precomputing) {
        while (log.precomputing) {
            await new Promise(r => setTimeout(r, 50));
        }
        return;
    }

    log.precomputing = true;
    try {
        const len = lines.length;
        const prefilteredIndices = [];
        const intelCache = new Array(len);
        const timestampCache = new Array(len);
        const signatureCache = new Array(len);
        const installerEventCache = new Array(len);

        for (let idx = 0; idx < len; idx++) {
            if (idx % 2000 === 0 && idx > 0) {
                await yieldIfNeeded();
            }
            const line = lines[idx];
            // Cap the length every per-line regex scans. The forensic signal (timestamp, level,
            // exception class, error message) lives at the START of a line; multi-KB data-export
            // CSV rows (several thousand chars) otherwise make each of the ~25 regexes scan the whole
            // line × 150k lines = many minutes of CPU on a big multi-file bundle. Normal log lines
            // (<1KB) are unaffected. The full line is still kept in `lines` for snippets/windows.
            const scanLine = (line && line.length > 1500) ? line.slice(0, 1500) : line;
            const hasPrefilter = FAST_FORENSIC_PREFILTER.test(scanLine);

            const ts = extractLogTimestamp(scanLine);
            if (ts) timestampCache[idx] = ts;

            if (hasPrefilter) {
                prefilteredIndices.push(idx);

                const intel = classifyLogLine(scanLine);
                intelCache[idx] = intel;

                if (intel.isForensic && !intel.hasStackFrame) {
                    signatureCache[idx] = normalizeLogSignature(scanLine);
                }

                const instEv = getInstallerEvent(scanLine, log.name || "Attached log", idx + 1);
                if (instEv) installerEventCache[idx] = instEv;
            } else {
                intelCache[idx] = DEFAULT_LINE_CLASSIFICATION;
            }
        }

        log.precomputedIntel = {
            cacheKey,
            prefilteredIndices,
            intelCache,
            timestampCache,
            signatureCache,
            installerEventCache
        };
    } finally {
        log.precomputing = false;
    }
}


const LOG_SIGNAL_RULES = [
    { category: 'SQL/Database', weight: 42, regex: /\b(SqlException|SqlError|System\.Data\.SqlClient|Microsoft\.Data\.SqlClient|java\.sql\.SQLException|SQL Server|ODBC|JDBC|ADO\.NET|Deadlock|deadlocked|victim|Timeout expired|Execution Timeout|Login failed|Cannot open database|ALTER DATABASE statement is not supported|SET RECOVERY SIMPLE|Connection pool|pooled connection|max pool size|connection string|transaction|rollback|schema|collation|stored procedure|sp_|xp_|DBInstall|database\s+(?:unavailable|offline|locked|corrupt|failed|failure|error|timeout|deadlock|inaccessible)|could not (?:open|connect to) database|invalid object name|invalid column name|could not find stored procedure|primary key|foreign key|constraint|duplicate key)\b/i },
    { category: 'SSO/Identity/Redirect', weight: 42, regex: /\b(No SSO entity found|SSO entity (?:is )?not found|invalid_client_configuration|request issuer\s*[:=]|wrong issuer|issuer mismatch|unknown client|client (?:not found|is unknown|is not configured)|relying party (?:not|trust)|audience (?:validation failed|mismatch)|redirect_uri|reply ?URL|ACS URL|invalid redirect|redirect loop|Too many requests|HTTP 429|\b429\b.*(?:request|limit)|IdentityServer|IdpInitiated|SAML response|authoriz(?:ation|e) (?:request )?(?:failed|invalid|error)|invalid_grant|invalid_request|access_denied)\b/i },
    { category: 'Certificate/TLS', weight: 38, regex: /\b(certificate|cert\b|SSL|TLS|handshake failed|X509|trust|chain|CRL|OCSP|SCEP|signing|expired cert|revoked|untrusted|RemoteCertificateNameMismatch|RemoteCertificateChainErrors|AuthenticationException|Schannel|PKIX|certificate verify failed|unable to get local issuer|self-signed|hostname mismatch)\b/i },
    { category: 'HTTP/Network', weight: 30, regex: /\b(HTTP\/|HTTP [45]\d\d|StatusCode|BadRequest|Unauthorized|Forbidden|NotFound|Conflict|TooManyRequests|InternalServerError|BadGateway|ServiceUnavailable|GatewayTimeout|WebException|SocketException|ConnectFailure|ConnectionReset|connection dropped|connection lost|lost connection|DNS|resolve|resolution|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|host not found|No such host|network unreachable|proxy|firewall|port \d+|connection refused|connection reset|timed out connecting|name or service not known)\b/i },
    { category: 'Service Lifecycle', weight: 24, regex: /\b(service start|service stop|starting service|stopping service|service failed|failed to start|failed to stop|restarting|OnStart|OnStop|ServiceBase|hosted service|application pool|recycl|terminated unexpectedly|process exited|crashed|crash dump|service control manager|SCM|watchdog|heartbeat lost)\b/i },
    { category: 'Memory/Thread', weight: 34, regex: /\b(OutOfMemory|StackOverflow|ThreadAbort|thread pool|GC heap|memory pressure|heap size|working set|AccessViolation|deadlock detected|hang detected|blocked thread|thread starvation|CPU spike|high CPU|resource exhausted|insufficient memory)\b/i },
    { category: 'Auth/Permission', weight: 36, regex: /\b(Access denied|Unauthorized|forbidden|permission|credentials|credential|login|logon|authentication failed|authorization failed|token expired|invalid token|bearer|OAuth|SAML|OIDC|LDAP bind|Kerberos|NTLM|impersonat|account locked|principal|claims|MFA|passwordless|FIDO|invalid grant|invalid audience|signature validation failed)\b/i },
    { category: 'Enrollment/Agent', weight: 28, regex: /\b(DeviceEnrollmentException|enrollment failed|enrolment failed|AFW provisioning failed|Android Enterprise|QR code invalid|EMM token expired|Device already enrolled|check-in failed|check in failed|heartbeat missed|profile deployment failed|policy deployment failed|agent crash|agent error|agent failed|device check-in failed|device sync failed|package install failed|OEMConfig|managed Google Play|KME|Zero Touch)\b/i },
    { category: 'Storage/IO', weight: 30, regex: /\b(IOException|DirectoryNotFound|FileNotFound|PathTooLong|disk full|no space|access to the path|sharing violation|write failed|read failed|file locked|permission denied|cannot create file|cannot delete file|corrupt(ed)? file|I\/O error)\b/i },
    { category: 'Installer/MSI', weight: 38, regex: /\b(CustomAction|Return value 3|Return 1603|error code 1603|MainEngineThread is returning|Back from server\. Return value|Fatal error|Deploy[A-Za-z]*Database|DbUp|DeploymentEngine|PerformUpgrade|Installation failed|SetupSOTI|Location Service database deployment|Upgrade failed due to an unexpected exception|Soti\.XSight\.LocationService\.Database\.Migration)\b/i },
    { category: 'Config/Validation', weight: 26, regex: /\b(validation (?:failed|error|warning)|invalid value|required setting|required property|missing setting|malformed|parse error|cannot parse|deseriali[sz]e|schema validation|FQDN.*(?:incorrect|invalid|failed)|hostname.*(?:incorrect|invalid|failed)|base URL.*(?:incorrect|invalid|failed)|URL is invalid|not configured|misconfigured|incorrect configuration|unsupported configuration|configuration (?:failed|invalid|missing|incorrect))\b/i },
    { category: 'Version/Compatibility', weight: 24, regex: /\b(version mismatch|incompatible|not supported|unsupported|requires version|minimum version|downgrade|upgrade required|migration failed|schema version|plugin incompatible|API version|protocol version|build mismatch)\b/i },
    { category: 'License/Activation', weight: 22, regex: /\b(license|licence|activation|entitlement|subscription|trial expired|not activated|activation failed|license expired|licensed devices exceeded)\b/i },
    { category: 'Queue/Messaging', weight: 24, regex: /\b(queue (?:overflow|full|blocked|backlog|failed|failure|error)|message bus.*(?:failed|error|timeout|unavailable)|Kafka.*(?:failed|error|timeout|unavailable)|RabbitMQ.*(?:failed|error|timeout|unavailable)|MSMQ.*(?:failed|error|timeout|unavailable)|Service Bus.*(?:failed|error|timeout|unavailable)|poison message|dead letter|DLQ|broker unavailable|event pipeline.*(?:failed|error|backlog)|ingestion failed|collector heartbeat lost|telemetry ingestion failed)\b/i },
    { category: 'Serialization/Data', weight: 20, regex: /\b(JSON|XML|YAML|serialization|deserialization|deserialize|serialize|parser|parse failed|unexpected token|invalid payload|payload parse|schema mismatch|data contract|protobuf|cannot convert|format exception)\b/i },
    { category: 'Time/Clock', weight: 18, regex: /\b(clock skew|time skew|NTP|certificate not yet valid|expired|timestamp expired|nonce expired|token lifetime|not before|not after)\b/i },
    { category: 'External Integration', weight: 18, regex: /\b(SMTP|SNMP|WMI|APNS|FCM|Google Play|Entra|Azure AD|Active Directory|LDAP|SFTP|proxy|webhook|MobiControl API|XSight API|Connect API|Identity Provider|IdP)\b.*\b(failed|failure|error|timeout|timed out|refused|denied|unreachable|expired|invalid|unauthorized|forbidden)\b/i }
];

const HIGH_SIGNAL_KEYWORDS = [
    { label: 'fatal/critical', score: 36, regex: /\b(FATAL|CRITICAL|PANIC|SEVERE|EMERGENCY|ALERT)\b/i },
    { label: 'exception', score: 32, regex: new RegExp(`\\b${EXCEPTION_CLASS_PATTERN}\\b|\\bUnhandled exception\\b|\\bInner Exception\\b|\\bCaused by:\\b`, 'i') },
    { label: 'explicit failure', score: 22, regex: /\b(failed|failure|fails|fatal error|cannot|can't|unable|denied|refused|rejected|blocked|aborted|crashed|faulted|corrupt|invalid|unsupported|not supported|timed out|timeout|deadlock|rollback|unreachable|unavailable|mismatch|malformed|missing|required|expired|revoked|not found)\b/i },
    { label: 'error severity', score: 18, regex: /(?:^|[\s\[({<,"'=])(?:ERR|ERROR)(?:[\s\])}:>,]|$)|\blevel\s*[:=]\s*["']?error\b|\bseverity\s*[:=]\s*["']?error\b/i },
    { label: 'warning severity', score: 8, regex: /(?:^|[\s\[({<,"'=])(?:WARN|WARNING)(?:[\s\])}:>,]|$)|\blevel\s*[:=]\s*["']?warn/i },
    { label: 'return/error code', score: 18, regex: /\b(?:error code|return code|exit code|Return value|returning 1603|MainEngineThread is returning)\s*[:=]?\s*(?:0x[0-9a-f]+|1603|\d{4,5})\b/i },
    { label: 'HRESULT/Win32', score: 20, regex: /\b(HRESULT|Win32Exception|0x8[0-9a-f]{7}|0xC[0-9a-f]{7})\b/i }
];

function extractSeverityToken(line) {
    const text = line || "";
    const m = text.match(/(?:^|[\s\[({<,"'=])(?:level|severity)?\s*[:=]?\s*["']?(FATAL|CRITICAL|PANIC|SEVERE|ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE)(?:["'\s\])}:>,]|$)/i);
    if (!m) return "";
    const raw = m[1].toUpperCase();
    if (raw === "ERR") return "ERROR";
    if (raw === "WARNING") return "WARN";
    return raw;
}

function isNegatedSignalLine(line) {
    const text = line || "";
    return /\b(no|without)\s+(errors?|warnings?|failures?|exceptions?)\b/i.test(text)
        || /\b(errors?|warnings?|failures?)\s*[:=]\s*0\b/i.test(text)
        || /\berror\s*(?:code|level)?\s*[:=]?\s*0\b/i.test(text)
        || /\b(completed|succeeded|successful|successfully)\b/i.test(text) && /\b(no errors?|without errors?|error\s*code\s*0)\b/i.test(text);
}

function hasRealFailureSignal(line) {
    const text = line || "";
    return /\b(SqlException|System\.Data\.SqlClient|Cannot open database|Login failed for user|ALTER DATABASE statement is not supported|Setting Recovery mode|error code 1603|MainEngineThread is returning|Return value 3|Fatal error|Installation failed|Upgrade failed due to an unexpected exception|exception has occurred in script|Location Service database deployment|SQL exception has occurred|DeploymentEngine:|Product: SOTI.*--\s+.*(?:SqlException|error|failed|ALTER DATABASE))\b/i.test(text);
}

function isMsiNoiseLine(line) {
    const text = line || "";
    if (hasRealFailureSignal(text)) return false;
    if (/\bNote:\s*1:\s*\d{3,5}\b/i.test(text)) return true;
    if (/^\s*MSI\s*\([sc]/i.test(text)) return true;
    if (/^\s*\|/.test(text) && !/\b(SqlException|Error while reading|Cannot open database|Login failed|ALTER DATABASE)\b/i.test(text)) return true;
    return false;
}

function getKeywordHits(line) {
    if (isMsiNoiseLine(line)) return [];
    if (isNegatedSignalLine(line) && !new RegExp(EXCEPTION_CLASS_PATTERN, 'i').test(line || "")) return [];
    return HIGH_SIGNAL_KEYWORDS
        .filter(rule => rule.regex.test(line || ""))
        .map(rule => ({ label: rule.label, score: rule.score }));
}

function isStackTraceLine(line) {
    return /^\s*(at\s+|---\s*>|---\s*End|Caused by:|Suppressed:|Inner Exception| ---> |--->|Traceback \(most recent call last\):|File ".+?", line \d+|at .+?\(.+?:\d+(?::\d+)?\)|\.\.\. \d+ more)/i.test(line || "");
}

function classifyLogLine(line) {
    if (!FAST_FORENSIC_PREFILTER.test(line)) {
        return DEFAULT_LINE_CLASSIFICATION;
    }
    // Bound the cost of the ~22 classification regexes below. Forensic signal lives at the START
    // of a line; very long lines (data-export CSV rows can be several KB) otherwise make each regex
    // scan thousands of chars across 150k+ lines = minutes of CPU on a big multi-file bundle.
    if (line && line.length > 2000) line = line.slice(0, 2000);

    if (isMsiNoiseLine(line)) {
        return {
            categories: [],
            hasException: false,
            hasErrorWord: false,
            hasLogSeverity: false,
            hasStackFrame: false,
            severityToken: "",
            exceptionClasses: [],
            keywordHits: [],
            isForensic: false
        };
    }

    const categories = [];
    const add = c => { if (!categories.includes(c)) categories.push(c); };

    const exceptionClasses = extractExceptionClasses(line);
    const hasException = exceptionClasses.length > 0 || 
                        /\b(Unhandled exception|Inner Exception|Caused by:|Traceback \(most recent call last\))\b/i.test(line || "");
    
    const keywordHits = getKeywordHits(line);
    const hasErrorWord = keywordHits.some(hit => hit.label === 'explicit failure' || 
                         hit.label === 'fatal/critical' || 
                         hit.label === 'return/error code' || 
                         hit.label === 'HRESULT/Win32');
                         
    const severityToken = extractSeverityToken(line);
    const hasLogSeverity = /^(FATAL|CRITICAL|PANIC|SEVERE|ERROR|WARN)$/i.test(severityToken) || 
                         keywordHits.some(hit => /severity/.test(hit.label));
                         
    const hasStackFrame = isStackTraceLine(line);
    const isSotiCode = /\b(MCMR-\d+|MobiControl)\b/i.test(line);

    // Check for SOTI MC patterns before general categories
    if (isSotiCode || 
        /\b(SOTI MC|MC Management Service|MC Deployment Server|MCAU)\b/i.test(line)) {
        add('SOTI MC');
        
        if (hasException || 
            /\b(Error|Failed|Failure|Connection Issue|Web Console|Database Connection)\b/i.test(line)) {
            add('SOTI MC/Infrastructure');
        }
        
        if (/\b(Deployment|Package|Content|Task Execution)\b/i.test(line)) {
            add('SOTI MC/Deployment');
        }
        
        if (/\b(Baseline|Compliance|Audit|Remediation)\b/i.test(line)) {
            add('SOTI MC/Baseline');
        }
    }

    LOG_SIGNAL_RULES.forEach(rule => { if (rule.regex.test(line || "")) add(rule.category); });
    if (hasException) add('Exception');
    if (hasLogSeverity || hasErrorWord) add('Error/Warning');
    if (isSotiCode) add('SOTI Fix Reference');

    return {
        categories,
        hasException,
        hasErrorWord,
        hasLogSeverity,
        hasStackFrame,
        severityToken,
        exceptionClasses,
        keywordHits,
        isForensic: categories.length > 0 || 
                    hasStackFrame || 
                    isSotiCode || 
                    keywordHits.length > 0
    };
}

function scoreRootCauseCandidate(event) {
    let score = 0;
    
    // Base scores for different types of issues
    if (event.hasException) score += 60;
    
    // SOTI MC-specific scoring
    if (event.categories.includes('SOTI MC/Infrastructure')) {
        score += 80;
        if (/\b(MCMR-\d+|Device Debug Report generated|Database Connection Failure|Web Console Error|Service Health Check Failed)\b/i.test(event.text)) {
            score += 60;
        }
    }
    
    if (event.categories.includes('SOTI MC/Deployment')) {
        score += 50;
        if (/\b(Unknown Deployment Error|Content Sync Error|Package Installation Failed|Task Scheduling Error)\b/i.test(event.text)) {
            score += 40;
        }
    }
    
    if (event.categories.includes('SOTI MC/Baseline')) {
        score += 45;
        if (/\b(Baseline Evaluation Error|Compliance Check Error|Remediation Execution Failed)\b/i.test(event.text)) {
            score += 35;
        }
    }
    
    // General signal rules scoring
    (event.categories || []).forEach(category => {
        const rule = LOG_SIGNAL_RULES.find(x => x.category === category);
        if (rule) score += rule.weight;
    });
    
    // Keyword hit scoring
    (event.keywordHits || getKeywordHits(event.text)).forEach(hit => { 
        score += hit.score;
        if (hit.label === 'explicit failure' && hit.score > 20) {
            score += 15; // Extra boost for critical failures
        }
    });
    
    // Severity level scoring
    if (/\b(FATAL|CRITICAL|PANIC|SEVERE)\b/i.test(event.text)) score += 35;
    if (/\b(ERROR|ERR)\b/i.test(event.text)) score += 18;
    if (/\b(WARN|WARNING)\b/i.test(event.text)) score += 6;
    
    // Specific error pattern scoring
    if (/\b(timeout|deadlock|login failed|cannot open database|certificate|access denied|connection refused|connection reset|unsupported|not supported|invalid object|schema|return value 3)\b/i.test(event.text)) {
        score += 18;
    }
    if (/\b(SqlException|System\.Data\.SqlClient|Microsoft\.Data\.SqlClient|SqlConnection|SqlCommand|SqlDataReader)\b/i.test(event.text)) {
        score += 90;
    }
    if (/\bALTER DATABASE statement is not supported\b/i.test(event.text)) score += 120;
    if (/\bSetting Recovery mode to SIMPLE\b/i.test(event.text)) score += 40;
    if (/\bUpgrade failed due to an unexpected exception\b/i.test(event.text)) score += 85;
    if (/\bLocation Service database deployment\b/i.test(event.text)) score += 75;
    if (/\b(Microsoft SQL Azure|SQL Azure|database\.windows\.net)\b/i.test(event.text)) score += 25;
    
    // Penalty for negated signals and installation noise
    if (isNegatedSignalLine(event.text) && !event.hasException) score -= 50;
    if (isMsiNoiseLine(event.text)) score -= 200;
    
    // Priority for earlier failures
    score += Math.max(0, 30 - Math.floor(event.lineNum / 3000));
    
    // Maximum score floor to ensure critical issues stand out
    return Math.max(score, 30);
}

function parseLogTimestampForSort(ts) {
    if (!ts) return Number.POSITIVE_INFINITY;
    let normalized = normalizeLogTimestamp(ts)
        .replace(',', '.')
        .replace(/^(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1');
    if (/^\d{1,2}:\d{2}:\d{2}/.test(normalized)) {
        normalized = `1970-01-01 ${normalized}`;
    }
    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function extractExceptionClasses(text) {
    const found = [];
    const re = new RegExp(`\\b${EXCEPTION_CLASS_PATTERN}\\b`, 'gi');
    let m;
    while ((m = re.exec(text || "")) !== null) {
        if (!found.includes(m[1])) found.push(m[1]);
    }
    return found;
}

function extractStackFrames(blockText) {
    return (blockText || "")
        .split('\n')
        .map(line => line.trim())
        .filter(line => /^at\s+/i.test(line)
            || /^File ".+?", line \d+/i.test(line)
            || /^Caused by:/i.test(line)
            || /^Suppressed:/i.test(line)
            || /^Traceback \(most recent call last\):/i.test(line));
}

function diagnoseSqlIssue(text) {
    const sqlLike = /\b(SqlException|SqlError|System\.Data\.SqlClient|Microsoft\.Data\.SqlClient|java\.sql\.SQLException|SQL Server|ODBC|JDBC|deadlock|Timeout expired|Execution Timeout|Login failed|Cannot open database|ALTER DATABASE statement is not supported|SET RECOVERY SIMPLE|connection pool|pooled connection|max pool size|database\s+(?:unavailable|offline|locked|corrupt|failed|failure|error|timeout|deadlock|inaccessible)|stored procedure|invalid object name|invalid column name|could not find stored procedure|duplicate key|constraint|primary key|foreign key)\b/i.test(text || "");
    if (!sqlLike) return null;

    const pick = regex => {
        const m = (text || "").match(regex);
        return m ? m[1].trim() : "";
    };

    let type = "SQL/database failure";
    if (/\bALTER DATABASE statement is not supported|SET RECOVERY SIMPLE|recovery mode to SIMPLE\b/i.test(text)) type = "Unsupported ALTER DATABASE/recovery model operation";
    else if (/\bdeadlock|deadlocked|victim\b/i.test(text)) type = "SQL deadlock";
    else if (/\btimeout expired|execution timeout|timed out\b/i.test(text)) type = "SQL timeout";
    else if (/\blogin failed|authentication failed\b/i.test(text)) type = "SQL login/authentication failure";
    else if (/\bcannot open database|database .* requested by the login\b/i.test(text)) type = "Cannot open database";
    else if (/\bconnection pool|pooled connection|pool exhausted|max pool size\b/i.test(text)) type = "SQL connection pool exhaustion";
    else if (/\binvalid object name|invalid column name|could not find stored procedure|stored procedure|collation|schema\b/i.test(text)) type = "SQL schema/procedure/collation issue";
    else if (/\bduplicate key|primary key|foreign key|constraint|conflicted with the\b/i.test(text)) type = "SQL constraint/data integrity issue";
    else if (/\bnetwork-related|instance-specific|server was not found|could not open a connection\b/i.test(text)) type = "SQL connectivity issue";

    return {
        type,
        number: pick(/\b(?:Error\s*Number|Number)\s*[:=]\s*(-?\d+)/i),
        severity: pick(/\b(?:Class|Severity)\s*[:=]\s*(\d+)/i),
        state: pick(/\bState\s*[:=]\s*(\d+)/i),
        server: pick(/\bServer\s*[:=]\s*([^,\]\r\n]+)/i),
        database: pick(/\b(?:Database|Initial Catalog)\s*[:=]\s*([^,\]\r\n;]+)/i),
        procedure: pick(/\b(?:Procedure|Stored Procedure)\s*[:=]\s*([^,\]\r\n]+)/i),
        line: pick(/\bLine(?:\s+Number)?\s*[:=]\s*(\d+)/i)
    };
}

function detectLogSeverity(text) {
    const sev = extractSeverityToken(text);
    if (/^(FATAL|CRITICAL|PANIC|SEVERE)$/.test(sev)) return "Critical";
    if (sev === "ERROR" || /\bException\b/i.test(text || "")) return "Error";
    if (sev === "WARN") return "Warning";
    return "Info";
}

function detectComponent(fileName, text, categories = []) {
    const file = (fileName || "").toLowerCase();
    const source = `${fileName || ""} ${text || ""}`.toLowerCase();
    
    // SOTI MC-specific components
    if (categories.includes('SOTI MC/Infrastructure') || 
        /\b(MCMR|MobiControl MC|MC Management Service|MC Services|SOTI MC Web Console|MCMC|MC Core)\b/i.test(source)) {
        return "SOTI MC Infrastructure";
    }
    
    if (categories.includes('SOTI MC/Deployment') ||
        /\b(MC Deployment Server|Deployment Manager|Content Distribution|Package Management|MC DDM)\b/i.test(source)) {
        return "SOTI MC Deployment";
    }
    
    if (categories.includes('SOTI MC/Baseline') || 
        /\b(Configuration Baseline|MCAU|MCSB|Baseline Engine|Compliance Management)\b/i.test(source)) {
        return "SOTI MC Baseline";
    }
    
    // SQL/Database components
    if (categories.includes('SQL/Database') || 
        /\b(sql server|sqlexception|dbinstall|sqlazure|sqlclient|sqlcommand|sqlreader|sqladapter|sqladapter)\b/i.test(source)) {
        return "SQL Database/SQL Azure";
    }
    
    // Device/Agent components
    if (/\b(agent|ddr|device|device agent|device service|ddr collector|device communication|agent installer|mobicontrol agent)\b/i.test(source)) {
        return "Device/Agent";
    }
    
    // Deployment Server
    if (/\b(dse|ds|deployment server|deployment service|ds extension|deploymentservice|dsm|deployment system module|dserver|dse service)\b/i.test(source)) {
        return "Deployment Server";
    }
    
    // Management Service
    if (/\b(ms\.log|management service|management server|mobicontrol management|soti management|mcs|web console|admin console|api service|mobilecommand|management engine|mcs engine|mcs gateway|management console)\b/i.test(source)) {
        return "Management Service";
    }
    
    // Identity Service
    if (/\b(identity|sso|auth|oauth server|oidc|saml|ldap server|token service|identity server|active directory|mcs identity|soti identity|sts|federation)\b/i.test(source)) {
        return "SOTI Identity";
    }
    
    // XSight/Telemetry
    if (/\b(xsight|collector|telemetry|elastic|analytics|xsengine|xsdata|telemetry service|usage analytics|activity tracking)\b/i.test(source)) {
        return "SOTI XSight";
    }
    
    // Connect/Integration
    if (/%\b(connect|connector|gateway|mqtt|iot hub|cloud connector|smtp connector|sms gateway|printer service|api gateway|sftp connector|ldap connector|mam connector)\b/i.test(source)) {
        return "SOTI Connect";
    }
    
    // Fallback cases
    if (/\b(dse|ds extension|deployment server|ds\.log|dserver)\b/i.test(source)) return "Deployment Server";
    if (/\b(ms\.log|mobicontrol\.management|soti management)\b/i.test(source)) return "Management Service";
    if (/\b(web console|console|api management|mobilecommand api|mcs api|mam api|mcmr api)\b/i.test(source)) return "Management Service";
    
    return "Unknown Component";
}

function classifyFailureKind(text, categories = [], sql = null) {
    if (sql) return sql.type;
    if (categories.includes('SQL/Database')) {
        const inferred = diagnoseSqlIssue(text);
        return inferred ? inferred.type : "SQL/database failure";
    }
    if (categories.includes('Certificate/TLS')) {
        if (/\b(expired|not yet valid)\b/i.test(text || "")) return "Certificate expired/not valid";
        if (/\b(name mismatch|RemoteCertificateNameMismatch)\b/i.test(text || "")) return "Certificate name mismatch";
        if (/\b(untrusted|chain|RemoteCertificateChainErrors|trust)\b/i.test(text || "")) return "Certificate trust chain failure";
        return "Certificate/TLS failure";
    }
    if (categories.includes('Auth/Permission')) return "Authentication/permission failure";
    if (categories.includes('HTTP/Network')) {
        if (/\b(ECONNREFUSED|connection refused|ConnectFailure)\b/i.test(text || "")) return "Connection refused";
        if (/\b(ConnectionReset|connection reset)\b/i.test(text || "")) return "Connection reset";
        if (/\b(DNS|resolve|ENOTFOUND|host not found|No such host)\b/i.test(text || "")) return "DNS/name resolution failure";
        if (/\b(HTTP 5\d\d|InternalServerError|BadGateway|ServiceUnavailable|GatewayTimeout)\b/i.test(text || "")) return "HTTP 5xx/server-side failure";
        if (/\b(HTTP 4\d\d|Unauthorized|Forbidden|NotFound|BadRequest)\b/i.test(text || "")) return "HTTP 4xx/client/auth failure";
        return "HTTP/network failure";
    }
    if (categories.includes('Memory/Thread')) return "Memory/thread/runtime failure";
    if (categories.includes('Service Lifecycle')) return "Service lifecycle failure";
    if (categories.includes('Storage/IO')) return "Storage/file-system failure";
    if (categories.includes('Enrollment/Agent')) return "Enrollment/agent failure";
    if (categories.includes('Config/Validation')) return "Configuration/validation failure";
    if (categories.includes('Version/Compatibility')) return "Version/compatibility failure";
    if (categories.includes('License/Activation')) return "License/activation failure";
    if (categories.includes('Queue/Messaging')) return "Queue/messaging pipeline failure";
    if (categories.includes('Serialization/Data')) return "Serialization/data parsing failure";
    if (categories.includes('Time/Clock')) return "Time/clock/certificate-validity failure";
    if (categories.includes('External Integration')) return "External integration failure";
    if (categories.includes('Exception')) return "Application exception";
    if (categories.includes('Error/Warning')) return "Error/warning event";
    return "Forensic event";
}

function componentPriority(component) {
    const priorities = {
        "SQL Database": 42,
        "SOTI Identity": 36,
        "Management Service": 30,
        "SOTI XSight": 24,
        "SOTI Connect": 24,
        "Deployment Server": 18,
        "Device/Agent": 10,
        "Unknown Component": 0
    };
    return priorities[component] || 0;
}

function scoreCausalCandidate(item) {
    let score = item.score || 0;
    score += componentPriority(item.component);
    if (item.severity === "Critical") score += 30;
    if (item.severity === "Error") score += 18;
    if (item.sql) score += 34;
    if (item.innermostException) score += 18;
    if (/\b(root cause|fatal|first chance|unhandled|startup failed|failed to start|cannot continue)\b/i.test(item.text || "")) score += 22;
    if (/\b(retry|retrying|downstream|because of previous|secondary|suppressed|handled)\b/i.test(item.text || "")) score -= 18;
    if (/\b(device check-in failed|handshake failed|profile deployment failed|request failed|HTTP 5\d\d)\b/i.test(item.text || "")) score -= 4;
    return score;
}

function formatIncidentLocation(item) {
    return `${item.file}:Line ${item.line || item.startLine}${item.endLine && item.endLine !== item.line ? `-${item.endLine}` : ""}${item.timestamp ? ` @ ${item.timestamp}` : ""}`;
}

function getComponentTier(component) {
    const tiers = {
        "SQL Database": 0,
        "SOTI Identity": 0,
        "Management Service": 1,
        "SOTI XSight": 1,
        "SOTI Connect": 1,
        "Deployment Server": 2,
        "Device/Agent": 3,
        "Unknown Component": 4
    };
    return tiers[component] ?? 4;
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "unknown time later";
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s later`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m later`;
    return `${Math.round(min / 60)}h later`;
}

function getCausalEdge(upstream, downstream) {
    if (!upstream || !downstream || upstream === downstream) return null;
    if (upstream.file === downstream.file && upstream.line === downstream.line) return null;

    const delta = downstream.sortTime - upstream.sortTime;
    if (Number.isFinite(delta) && delta < -1000) return null;

    let score = 0;
    const reasons = [];

    if (Number.isFinite(delta)) {
        if (delta <= 5000) score += 35;
        else if (delta <= 30000) score += 32;
        else if (delta <= 120000) score += 28;
        else if (delta <= 600000) score += 20;
        else if (delta <= 3600000) score += 8;
        else score -= 16;
    } else {
        score += 6;
    }

    const up = upstream.component;
    const down = downstream.component;
    const upTier = getComponentTier(up);
    const downTier = getComponentTier(down);

    if (upTier < downTier) {
        score += 24 + ((downTier - upTier) * 5);
        reasons.push(`${up} is upstream of ${down} in SOTI architecture`);
    } else if (upTier === downTier && up !== down) {
        score += 6;
        reasons.push(`${up} and ${down} are peer components in the same failure tier`);
    } else if (upTier > downTier) {
        score -= 28;
    }

    if (up === "SQL Database" && ["Management Service", "Deployment Server", "Device/Agent"].includes(down)) {
        score += 44;
        reasons.push("SQL health gates Management Service, DS sync, and device workflows");
    }
    if (up === "Management Service" && ["Deployment Server", "Device/Agent"].includes(down)) {
        score += 38;
        reasons.push("Deployment Server and device workflows depend on Management Service");
    }
    if (up === "Deployment Server" && down === "Device/Agent") {
        score += 42;
        reasons.push("device check-in/enrollment depends on Deployment Server");
    }
    if (up === "SOTI Identity" && ["Management Service", "Deployment Server", "Device/Agent", "SOTI XSight", "SOTI Connect"].includes(down)) {
        score += 32;
        reasons.push("Identity/auth failures cascade into dependent SOTI services");
    }

    const downstreamText = downstream.text || "";
    const upstreamText = upstream.text || "";
    if (upstream.sql && /\b(request failed|api failed|handshake failed|connection dropped|check-in failed|enrollment failed|timeout|service unavailable|HTTP 5\d\d)\b/i.test(downstreamText)) {
        score += 28;
        reasons.push(`${upstream.sql.type} explains later service/API/device failure`);
    }
    if (upstream.categories?.includes('Certificate/TLS') && /\b(handshake|trust|certificate|connection|check-in|enrollment)\b/i.test(downstreamText)) {
        score += 22;
        reasons.push("certificate/TLS issue plausibly breaks downstream trust/handshake");
    }
    if (upstream.categories?.includes('Auth/Permission') && /\b(unauthorized|forbidden|login|token|auth|access denied|SSO|API)\b/i.test(downstreamText)) {
        score += 22;
        reasons.push("auth/permission failure plausibly blocks the downstream operation");
    }
    if (/\b(caused by|because|due to|inner exception|timeout expired|deadlock|login failed)\b/i.test(upstreamText)) {
        score += 12;
        reasons.push("upstream text contains explicit causal wording");
    }
    if (/\b(failed|failure|dropped|unavailable|timeout|unable|cannot)\b/i.test(downstreamText)) {
        score += 8;
    }

    if (score < 28) return null;
    return {
        from: upstream,
        to: downstream,
        score,
        deltaMs: Number.isFinite(delta) ? delta : null,
        reason: reasons.slice(0, 3).join('; ') || "chronologically related forensic events"
    };
}

function getPropagationPath(root, all) {
    const path = [root];
    const edges = [];
    const used = new Set([`${root.file}:${root.line}:${root.component}`]);
    let current = root;

    for (let step = 0; step < 6; step++) {
        const candidates = all
            .filter(item => !used.has(`${item.file}:${item.line}:${item.component}`))
            .map(item => getCausalEdge(current, item))
            .filter(Boolean)
            .sort((a, b) => b.score - a.score || (a.deltaMs ?? Infinity) - (b.deltaMs ?? Infinity));

        if (candidates.length === 0) break;
        const best = candidates[0];
        if (best.score < 35) break;
        edges.push(best);
        path.push(best.to);
        used.add(`${best.to.file}:${best.to.line}:${best.to.component}`);
        current = best.to;
    }

    return { path, edges, score: edges.reduce((sum, edge) => sum + edge.score, 0) };
}

function chooseArchitectRoot(all) {
    const candidates = all.map(item => {
        const propagation = getPropagationPath(item, all);
        const incomingScore = all
            .map(other => getCausalEdge(other, item))
            .filter(Boolean)
            .reduce((max, edge) => Math.max(max, edge.score), 0);
        const symptomPenalty = item.component === "Device/Agent" ? 35 : item.component === "Deployment Server" ? 18 : 0;
        const total = item.causalScore + (propagation.score * 0.55) - (incomingScore * 0.65) - symptomPenalty;
        return { item, propagation, incomingScore, total };
    });

    candidates.sort((a, b) => {
        const diff = b.total - a.total;
        if (Math.abs(diff) > 12) return diff;
        if (a.item.sortTime !== b.item.sortTime) return a.item.sortTime - b.item.sortTime;
        return getComponentTier(a.item.component) - getComponentTier(b.item.component);
    });

    return candidates[0] || null;
}

function buildDominoAnalysis(events, blocks) {
    const normalizedEvents = events.map(e => {
        const sql = e.categories.includes('SQL/Database') ? diagnoseSqlIssue(e.text) : null;
        const component = detectComponent(e.file, e.text, e.categories);
        const severity = detectLogSeverity(e.text);
        const failureKind = classifyFailureKind(e.text, e.categories, sql);
        const item = {
            source: "event",
            file: e.file,
            line: e.lineNum,
            endLine: e.lineNum,
            timestamp: e.timestamp,
            sortTime: e.sortTime,
            text: e.text,
            categories: e.categories,
            component,
            severity,
            failureKind,
            sql,
            score: e.score
        };
        item.causalScore = scoreCausalCandidate(item);
        return item;
    });

    const normalizedBlocks = blocks.map(b => {
        const component = detectComponent(b.file, b.excerpt || b.message, b.categories);
        const severity = detectLogSeverity(b.excerpt || b.message);
        const failureKind = classifyFailureKind(b.excerpt || b.message, b.categories, b.sql);
        const item = {
            source: "exception block",
            file: b.file,
            line: b.startLine,
            startLine: b.startLine,
            endLine: b.endLine,
            timestamp: b.timestamp,
            sortTime: b.sortTime,
            text: b.message,
            categories: b.categories,
            component,
            severity,
            failureKind,
            sql: b.sql,
            innermostException: b.innermostException,
            outerException: b.outerException,
            throwingFrame: b.throwingFrame,
            originatingFrame: b.originatingFrame,
            score: b.score
        };
        item.causalScore = scoreCausalCandidate(item);
        return item;
    });

    const all = [...normalizedEvents, ...normalizedBlocks]
        .filter(item => item.severity !== "Info" || item.sql || item.innermostException)
        .sort((a, b) => {
            if (a.sortTime !== b.sortTime) return a.sortTime - b.sortTime;
            if (a.file !== b.file) return a.file.localeCompare(b.file);
            return (a.line || 0) - (b.line || 0);
        });

    if (all.length === 0) return { report: "", root: null };

    const architectChoice = chooseArchitectRoot(all);
    const root = architectChoice ? architectChoice.item : all[0];
    const rootIndex = all.findIndex(item => item === root);
    const propagation = architectChoice ? architectChoice.propagation : getPropagationPath(root, all);
    const downstream = propagation.path.slice(1);
    const preRoot = all.slice(0, Math.max(0, rootIndex)).slice(-5);

    let report = `\n--- CAUSAL DOMINO ANALYSIS (deterministic chronology + component model) ---\n`;
    report += `Architecture model: SQL/Identity -> Management Service -> Deployment Server -> Device/Agent. Events are scored by timestamp proximity, component dependency, exception depth, SQL/cert/auth severity, and whether a later event is likely a symptom.\n`;
    if (architectChoice) {
        report += `Architect root score: ${Math.round(architectChoice.total)} (causal ${root.causalScore}, propagation ${propagation.score}, incoming-cause penalty ${architectChoice.incomingScore}).\n`;
    }
    if (preRoot.length > 0) {
        report += `Events immediately before selected root candidate:\n`;
        preRoot.forEach(item => {
            report += `- ${formatIncidentLocation(item)} | ${item.component} | ${item.severity} | ${item.failureKind} | ${truncateLogLine(item.text, 260)}\n`;
        });
    }

    report += `Selected primary causal candidate:\n`;
    report += `- ${formatIncidentLocation(root)} | ${root.component} | ${root.severity} | ${root.failureKind} | causal score ${root.causalScore}\n`;
    if (root.innermostException) report += `  Innermost exception: ${root.innermostException}\n`;
    if (root.sql) {
        const details = [];
        if (root.sql.number) details.push(`Number ${root.sql.number}`);
        if (root.sql.severity) details.push(`Severity ${root.sql.severity}`);
        if (root.sql.state) details.push(`State ${root.sql.state}`);
        if (root.sql.server) details.push(`Server ${root.sql.server}`);
        if (root.sql.database) details.push(`Database ${root.sql.database}`);
        if (root.sql.procedure) details.push(`Procedure ${root.sql.procedure}`);
        report += `  SQL classification: ${root.sql.type}${details.length ? ` (${details.join('; ')})` : ""}\n`;
    }
    if (root.originatingFrame) report += `  Originating frame: ${root.originatingFrame}\n`;
    if (root.throwingFrame) report += `  Throwing frame: ${root.throwingFrame}\n`;

    report += `Domino chain after root candidate:\n`;
    if (downstream.length === 0) {
        report += `- No downstream forensic events were detected after this candidate in the supplied logs.\n`;
    } else {
        propagation.edges.forEach((edge, idx) => {
            const item = edge.to;
            const role = idx === propagation.edges.length - 1 ? "Possible user-visible symptom" : "Downstream effect";
            report += `${idx + 1}. ${role}: ${formatIncidentLocation(item)} | ${item.component} | ${item.severity} | ${item.failureKind} | ${formatDuration(edge.deltaMs)} | edge score ${edge.score}\n`;
            report += `   Why linked: ${edge.reason}\n`;
            report += `   Evidence: ${truncateLogLine(item.text, 260)}\n`;
        });
    }

    report += `\nArchitect-level master timeline around the chain:\n`;
    const chainKeys = new Set(propagation.path.map(item => `${item.file}:${item.line}:${item.component}`));
    const timelineSlice = all
        .filter(item => {
            if (chainKeys.has(`${item.file}:${item.line}:${item.component}`)) return true;
            if (!Number.isFinite(root.sortTime) || !Number.isFinite(item.sortTime)) return false;
            return Math.abs(item.sortTime - root.sortTime) <= 600000;
        })
        .slice(0, 40);
    timelineSlice.forEach(item => {
        const role = item === root ? "ROOT" : chainKeys.has(`${item.file}:${item.line}:${item.component}`) ? "DOMINO" : "CONTEXT";
        report += `- [${role}] ${formatIncidentLocation(item)} | ${item.component} | ${item.failureKind} | ${truncateLogLine(item.text, 220)}\n`;
    });

    report += `Instruction: the final AI answer must use this domino section to separate the primary cause from downstream noise. If rejecting the selected candidate, cite the earlier/stronger replacement and explain the causal logic.\n`;
    report += `--- END CAUSAL DOMINO ANALYSIS ---\n`;
    return { report, root };
}

function inferProductFromLogName(name, content = "") {
    const combined = `${name || ""} ${content.slice(0, 5000)}`;
    const setup = combined.match(/SetupSOTI([A-Za-z]+)-(\d+(?:\.\d+){2,4})/i);
    if (setup) {
        const product = setup[1].replace(/([a-z])([A-Z])/g, '$1 $2');
        return `SOTI ${product} ${setup[2]}`;
    }
    const xsight = combined.match(/\bXSight\b.*?\b(\d+(?:\.\d+){2,4})\b/i);
    if (xsight) return `SOTI XSight ${xsight[1]}`;
    const mc = combined.match(/\bMobiControl\b.*?\b(\d+(?:\.\d+){2,4})\b/i);
    if (mc) return `SOTI MobiControl ${mc[1]}`;
    const identity = combined.match(/\bIdentity\b.*?\b(\d+(?:\.\d+){2,4})\b/i);
    if (identity) return `SOTI Identity ${identity[1]}`;
    return "";
}

function extractSqlTarget(text) {
    const slice = (text || "").slice(0, 120000);
    const candidates = [];
    const addCandidate = value => {
        const cleaned = (value || "").trim().replace(/^['"]|['"].*$/g, "");
        if (cleaned && !candidates.includes(cleaned)) candidates.push(cleaned);
    };

    const explicitPatterns = [
        /\bSQL_[A-Z0-9_]*SERVERNAME\b[^'\r\n]*'([^'\r\n]+\.database\.windows\.net(?:,\d+)?)'/gi,
        /\b(?:Connecting to|SQL target|SqlServer|DatabaseServer)[^'\r\n]*?\s+([A-Za-z0-9.-]+\.database\.windows\.net(?:,\d+)?)/gi,
        /\b(?:Data Source|Server|SQL Server)\s*=\s*([^;\]\r\n]+\.database\.windows\.net(?:,\d+)?)/gi,
        /\b(?:tcp:)?([A-Za-z0-9.-]+\.database\.windows\.net(?:,\d+)?)\b/gi
    ];

    for (const p of explicitPatterns) {
        let m;
        while ((m = p.exec(slice)) !== null) addCandidate(m[1]);
    }

    if (candidates.length > 0) {
        return candidates
            .sort((a, b) => {
                const aScore = (/,\d+$/.test(a) ? 2 : 0) + (a.length / 1000);
                const bScore = (/,\d+$/.test(b) ? 2 : 0) + (b.length / 1000);
                return bScore - aScore;
            })[0];
    }

    const patterns = [
        /\b(?:Data Source|Server|SQL Server)\s*=\s*([^;\]\r\n]+)/i,
        /\b(?:SQL target|SqlServer|DatabaseServer)\s*[:=]\s*([^;\]\r\n]+)/i
    ];
    for (const p of patterns) {
        const m = slice.match(p);
        if (m) return m[1].trim();
    }
    return "";
}

function extractMachineName(text) {
    const slice = (text || "").slice(0, 120000);
    const patterns = [
        /\b(?:ComputerName|MachineName|Server Name|Hostname|Host)\s*[:=]\s*([A-Za-z0-9_.-]+)/i,
        /\bServer\s+`?([A-Z0-9_.-]{4,})`?/i
    ];
    for (const p of patterns) {
        const m = slice.match(p);
        if (m) return m[1].trim();
    }
    return "";
}

function getInstallerEvent(line, logName, lineNum) {
    const text = line || "";
    const timestamp = extractLogTimestamp(text);
    const base = {
        file: logName,
        lineNum,
        timestamp,
        sortTime: parseLogTimestampForSort(timestamp),
        text: text.trim(),
        classification: "Installer event",
        phase: "",
        score: 0
    };

    // MSI PLUMBING NOISE — property assignments, action scheduling/sequencing, op execution, and
    // successful actions are NOT failures, even when the text mentions a CustomAction name or the
    // word "rollback"/"error" (e.g. "PROPERTY CHANGE: Adding WixRollbackFirewallExceptionsInstall",
    // "PROPERTY CHANGE: Modifying VALIDATION_ERROR_MESSAGE"). Demote them so they never crowd the
    // real failure chain out of the chronological triage. Real failures still pass via the signal check.
    if (!hasRealFailureSignal(text) && /PROPERTY CHANGE:|Executing op:\s|CustomActionSchedule|Doing action:|Action (?:start|ended)[^.]*\.\s*Return value [12]\b|: Skipping action|Font created|Resetting cached policy|policy value/i.test(text)) {
        return { ...base, classification: "MSI sequencing / property change (non-fatal)", phase: "MSI plumbing", score: 4 };
    }

    if (/returned actual error code 1603 but will be translated to success due to continue marking/i.test(text)) {
        return {
            ...base,
            classification: "Continue-marked custom action result / non-fatal",
            phase: "Installer validation continuation",
            score: 5
        };
    }
    if (/XSFatalErrorDlg|CopyInstallationLog/i.test(text)) {
        return {
            ...base,
            classification: "Post-failure UI/log-copy action / symptom",
            phase: "Post-failure UI cleanup",
            score: 5
        };
    }
    if (/Cannot open database\s+"?([^"]+)"?.*requested by the login|Login failed for user/i.test(text)) {
        return {
            ...base,
            classification: "SQL authentication/database-access",
            phase: "Validation / configuration discovery",
            score: 95
        };
    }
    if (/serviceInstanceDnses|service instance dns|existing service instances/i.test(text) && /\b(failed|error|exception|cannot|unable)\b/i.test(text)) {
        return {
            ...base,
            classification: "SQL/configuration discovery",
            phase: "Validation / configuration discovery",
            score: 80
        };
    }
    if (/ALTER DATABASE statement is not supported|SET RECOVERY SIMPLE|Setting Recovery mode to SIMPLE/i.test(text)) {
        return {
            ...base,
            classification: "SQL migration/deployment",
            phase: "Database deployment / migration",
            score: 220
        };
    }
    if (/DeploymentEngine.*SQL exception|DbUp|PerformUpgrade|Upgrade failed due to unexpected exception/i.test(text)) {
        return {
            ...base,
            classification: "Database upgrade/deployment",
            phase: "DbUp migration execution",
            score: 190
        };
    }
    if (/CustomAction|Deploy[A-Za-z]*Database/i.test(text) && /\b(exception|failed|error|1603|return value 3)\b/i.test(text)) {
        return {
            ...base,
            classification: "Installer custom action",
            phase: "MSI custom action",
            score: 310
        };
    }
    if (/Return 1603|returning 1603|error code 1603|Fatal error|Return value 3|Installation failed|rollback/i.test(text)) {
        return {
            ...base,
            classification: "Installer abort/rollback",
            phase: "MSI rollback",
            score: 300
        };
    }
    if (/Closing MSIHANDLE/i.test(text)) {
        return {
            ...base,
            classification: "MSIHANDLE Closing (Immediate pre-rollback context)",
            phase: "MSIHANDLE context",
            score: 290
        };
    }
    if (/FQDN.*incorrect|validation.*(?:failed|warning)|could not validate/i.test(text)) {
        return {
            ...base,
            classification: "Validation warning / likely non-fatal",
            phase: "Validation",
            score: 35
        };
    }
    if (/\b(MSI|Windows Installer|SetupSOTI|DeploymentEngine|CustomAction|Deploy[A-Za-z]*Database)\b/i.test(text)) {
        return {
            ...base,
            classification: "Installer context",
            phase: "Installer",
            score: 10
        };
    }
    return null;
}

function formatInstallerTime(ts) {
    if (!ts) return "No timestamp";
    const normalized = normalizeLogTimestamp(ts);
    const time = normalized.match(/\b(\d{1,2}:\d{2}:\d{2}(?:\.\d{1,7})?)(?:\s*(?:AM|PM))?\b/i);
    return time ? time[1] : normalized;
}

function installerEvidenceWindow(lines, idx, before = 2, after = 6) {
    if (!lines || idx < 0) return "";
    const start = Math.max(0, idx - before);
    const end = Math.min(lines.length - 1, idx + after);
    const out = [];
    for (let i = start; i <= end; i++) {
        out.push(`Line ${i + 1}${extractLogTimestamp(lines[i] || "") ? ` @ ${extractLogTimestamp(lines[i] || "")}` : ""}: ${(lines[i] || "").trim()}`);
    }
    return out.join("\n");
}

function extractSqlErrorMetadata(text) {
    const source = text || "";
    const pick = regex => {
        const m = source.match(regex);
        return m ? m[1].trim() : "";
    };
    const details = [];
    const number = pick(/\b(?:Error\s+Number|Number)\s*[:=]\s*(-?\d+)/i);
    const state = pick(/\bState\s*[:=]\s*(\d+)/i);
    const cls = pick(/\bClass\s*[:=]\s*(\d+)/i);
    const client = pick(/\bClientConnectionId\s*[:=]\s*([0-9a-f-]+)/i);
    const script = pick(/\b(?:script|script:)\s*'([^']+)'/i);
    const blockLine = pick(/\bBlock line\s+(\d+)/i);
    if (number) details.push(`SQL Error Number ${number}`);
    if (state) details.push(`State ${state}`);
    if (cls) details.push(`Class ${cls}`);
    if (blockLine) details.push(`Script block line ${blockLine}`);
    if (script) details.push(`Script ${script}`);
    if (client) details.push(`ClientConnectionId ${client}`);
    return details;
}

function extractStackOriginSummary(text) {
    const frames = (text || "").split('\n').map(x => x.trim()).filter(x => /^at\s+/i.test(x));
    if (frames.length === 0) return "";
    const throwing = frames[0];
    const originating = frames[frames.length - 1];
    return `Throwing frame: ${throwing}\nOriginating frame: ${originating}`;
}

// DETERMINISTIC MSI ROOT CAUSE — the exact method an expert uses, in code (no AI guessing):
//   1. Find the FIRST "Action ended ...: <Action>. Return value 3." (the fatal rollback trigger).
//   2. Search BACKWARDS from there for the nearest "CustomAction <Name> returned actual error
//      code 1603" that is NOT "translated to success due to continue marking" (those are non-fatal).
//   That CustomAction is THE root cause. This removes the model's freedom to blame SQL/enumeration
//   noise, and it is 100% accurate for SOTI MSI setup logs.
function findMsiRootCause(lines) {
    if (!lines || !lines.length) return null;
    // 1) First fatal "Return value 3" on an "Action ended" line.
    let rv3Idx = -1, rv3Action = "", rv3Ts = "";
    for (let i = 0; i < lines.length; i++) {
        const ln = lines[i] || "";
        if (ln.indexOf("Return value 3") !== -1 && /Action ended/i.test(ln)) {
            rv3Idx = i;
            const m = ln.match(/([A-Za-z0-9_.]+)\.\s*Return value 3/i);
            rv3Action = m ? m[1] : "";
            rv3Ts = extractLogTimestamp(ln);
            break;
        }
    }
    // 2) Nearest preceding NON-TRANSLATED "returned actual error code 1603".
    const searchEnd = rv3Idx >= 0 ? rv3Idx : lines.length - 1;
    let causeIdx = -1, causeName = "", causeTs = "";
    for (let i = searchEnd; i >= 0; i--) {
        const ln = lines[i] || "";
        if (ln.indexOf("1603") === -1) continue;
        const m = ln.match(/CustomAction\s+(\S+)\s+returned actual error code 1603/i);
        if (m && !/translated to success due to continue marking/i.test(ln)) {
            causeIdx = i; causeName = m[1]; causeTs = extractLogTimestamp(ln);
            break;
        }
    }
    if (causeIdx < 0 && rv3Idx < 0) return null;
    return { causeIdx, causeName, causeTs, rv3Idx, rv3Action, rv3Ts };
}

async function buildInstallerFailureAnalysis(logs, opts = {}) {
    if (!logs || logs.length === 0) return "";
    const lean = !!opts.lean; // lean = tiny prompt for CPU-bound models (fast prefill)

    const events = [];
    const sources = [];
    const lineMap = new Map();
    let product = "";
    let sqlTarget = "";
    let machine = "";
    let firstTimestamp = "";
    let lastTimestamp = "";
    let returnCode = "";
    let hasRollback1603 = false;
    let hasInstallerKeyword = false;

    for (const log of logs) {
        const name = log.name || "Unknown log";
        const content = log.content || "";
        const likelyInstaller = isInstallerLogContent(name, content);
        if (likelyInstaller) {
            hasInstallerKeyword = true;
        }
        if (!likelyInstaller) continue;

        sources.push(name);
        const lines = log.lines || (content ? content.split('\n') : []);
        lineMap.set(name, lines);
        if (!product) product = inferProductFromLogName(name, content);
        if (!sqlTarget) sqlTarget = extractSqlTarget(content);
        if (!machine) machine = extractMachineName(content);
        if (!returnCode) {
            const rcMatch = content.slice(0, 150000).match(/\bMainEngineThread is returning\s+(1603|\d{3,5})\b/i) 
                            || content.slice(-150000).match(/\bMainEngineThread is returning\s+(1603|\d{3,5})\b/i);
            if (rcMatch) returnCode = rcMatch[1];
        }
        if (!hasRollback1603 && (content.includes('1603') || content.includes('Return value 3'))) {
            hasRollback1603 = true;
        }

        await precomputeLogIntel(log);
        const { prefilteredIndices, timestampCache, installerEventCache } = log.precomputedIntel;

        for (let i = 0; i < prefilteredIndices.length; i++) {
            if (i % 2000 === 0 && i > 0) {
                await yieldIfNeeded();
            }
            const idx = prefilteredIndices[i];
            const line = lines[idx];
            const ts = timestampCache[idx];
            if (ts) {
                if (!firstTimestamp) firstTimestamp = ts;
                lastTimestamp = ts;
            }

            const rc = line.match(/\b(?:Return(?:ed)?(?:\s+code)?|error code)\s*[:=]?\s*(1603|\d{3,5})\b/i);
            if (rc) returnCode = rc[1];
            
            const event = installerEventCache[idx];
            if (event) events.push(event);
        }
    }

    if (sources.length === 0 && !hasInstallerKeyword) {
        return "";
    }

    if (!product && sources.length > 0) {
        const firstLog = logs.find(l => l.name === sources[0]);
        if (firstLog) {
            product = inferProductFromLogName(sources[0], firstLog.content || "");
        }
    }
    if (!product) product = "SOTI installer";

    if (!sqlTarget) {
        for (const log of logs) {
            sqlTarget = extractSqlTarget(log.content || "");
            if (sqlTarget) break;
        }
    }
    if (!machine) {
        for (const log of logs) {
            machine = extractMachineName(log.content || "");
            if (machine) break;
        }
    }
    if (!returnCode && hasRollback1603) {
        returnCode = "1603";
    }

    // Detect an Azure SQL target even when the connection string uses ":" not "=" (which
    // extractSqlTarget misses). Azure SQL forbids "ALTER DATABASE ... SET RECOVERY SIMPLE" — a very
    // common SOTI XSight install failure — so flagging it lets the model name the real cause.
    let azureHost = "";
    for (const log of logs) {
        const m = (log.content || "").match(/([A-Za-z0-9._-]+\.database\.windows\.net(?:,\d+)?)/i);
        if (m) { azureHost = m[1]; break; }
    }
    if (azureHost && !sqlTarget) sqlTarget = azureHost;
    const azureSql = /\.database\.windows\.net\b/i.test(sqlTarget || "") || !!azureHost;
    const sorted = events
        .filter(e => e.score >= 30)
        .sort((a, b) => a.sortTime - b.sortTime || a.lineNum - b.lineNum);

    if (sorted.length === 0) return "";

    let report = `\n\n=== INSTALLER EVIDENCE (setup/MSI log — line-anchored facts only; AI derives root cause) ===\n`;
    report += `Product/context hint: ${product}${returnCode ? ` | Return code in log: ${returnCode}` : ""}\n`;
    report += `Log source(s): ${sources.join(', ')}\n`;
    if (firstTimestamp) report += `Install/log start: ${firstTimestamp}\n`;
    if (lastTimestamp) report += `Install/log end: ${lastTimestamp}\n`;
    const env = [];
    if (machine) env.push(`Server: ${machine}`);
    if (sqlTarget) env.push(`SQL target: ${sqlTarget}`);
    if (azureSql) env.push(`SQL platform: AZURE SQL DATABASE (note: Azure SQL does NOT support "ALTER DATABASE ... SET RECOVERY SIMPLE" — if a migration script runs that, it fails here)`);
    if (env.length > 0) report += `Environment facts: ${env.join('; ')}\n`;

    // PRIMARY ROOT-CAUSE ANCHOR — leads the evidence so it survives context trimming.
    // Prefer the DETERMINISTIC MSI cause (exact CustomAction before the first "Return value 3");
    // only fall back to the highest-score event when there is no Return-value-3 / 1603 chain.
    let detCause = null;
    for (const name of sources) {
        const dl = lineMap.get(name) || [];
        const r = findMsiRootCause(dl);
        if (r && r.causeIdx >= 0) { detCause = { ...r, file: name, lines: dl }; break; }
        if (r && !detCause) detCause = { ...r, file: name, lines: dl };
    }
    const haveDet = !!(detCause && detCause.causeIdx >= 0);
    if (haveDet) {
        const win = installerEvidenceWindow(detCause.lines, detCause.causeIdx, lean ? 14 : 22, 4);
        // Find the real WHY by scanning up to ~160 lines above the failing action for the most
        // specific database/deployment error MESSAGE. The stack frames immediately above a 1603 are
        // noise — the actionable cause usually sits a little higher (e.g. "ALTER DATABASE ... is not
        // supported" / "transaction log is full" / "Cannot open database"). Priority-ranked so a
        // precise cause beats a generic "...failed". Fully generic across different installer logs.
        const WHY_TIERS = [
            /ALTER DATABASE statement (?:is not supported|failed)|Setting Recovery mode to SIMPLE|SET RECOVERY SIMPLE|not supported (?:in|on) (?:azure|this edition)/i,
            /transaction log for database .* is full|log file .* is full|filegroup .* is full|out of (?:disk )?space|insufficient disk space|no space left/i,
            /Cannot open database .* requested by the login|Login failed for user|password .* (?:has expired|is incorrect)|not associated with a trusted/i,
            /deadlock|Timeout expired|could not (?:open|connect to)|connection (?:refused|reset|was forcibly closed)|network-related or instance-specific|server was not found/i,
            /An error occurred during .* deployment|Upgrade failed due to|database deployment failed|exception has occurred in script|Violation of .* constraint|invalid (?:object|column) name/i,
            /SqlException \(0x[0-9a-f]+\):\s*\S|Number\s+\d{4,5};.*Message:|Error Number:\s*\d{3,5}/i,
        ];
        const whyHits = [];
        for (let tier = 0; tier < WHY_TIERS.length && whyHits.length === 0; tier++) {
            for (let i = detCause.causeIdx - 1; i >= Math.max(0, detCause.causeIdx - 160); i--) {
                const t = (detCause.lines[i] || "").trim();
                if (!t || /Closing MSIHANDLE|Creating MSIHANDLE|^\s*at\s|Note: 1:|PROPERTY CHANGE/i.test(t)) continue;
                if (WHY_TIERS[tier].test(t)) { whyHits.push(`${detCause.file}:Line ${i + 1} — ${t.slice(0, 260)}`); if (whyHits.length >= 3) break; }
            }
        }
        report += `\n--- PRIMARY ROOT CAUSE (deterministic — this is the failing action; the REAL reason is in the WHY lines below, NOT the earlier SQL-login symptom) ---\n`;
        report += `Failing action: CustomAction ${detCause.causeName} returned actual error code 1603\n`;
        report += `Location: ${detCause.file}:Line ${detCause.causeIdx + 1}${detCause.causeTs ? ` @ ${detCause.causeTs}` : ""}\n`;
        if (whyHits.length) {
            report += `WHY it failed (ROOT CAUSE — cite these exact lines; this is the source, not a symptom):\n`;
            whyHits.forEach(h => report += `  • ${h}\n`);
        }
        if (detCause.rv3Idx >= 0) {
            report += `Fatal rollback trigger: ${detCause.rv3Action ? detCause.rv3Action + ' — ' : ''}Return value 3 at ${detCause.file}:Line ${detCause.rv3Idx + 1}${detCause.rv3Ts ? ` @ ${detCause.rv3Ts}` : ""}\n`;
        }
        // KEY FAILURE CHAIN — the exact ordered rows for the triage table, so the model uses the
        // real chain (symptom → root cause → failing action → rollback) instead of medium-signal noise.
        const earliestSymptom = sorted.find(e => e.score >= 80 && (e.lineNum < detCause.causeIdx + 1)
            && /SQL|database|login|cannot open|exception|denied|certificate|connection|migration/i.test(e.text || ""));
        report += `KEY FAILURE CHAIN (use THESE as the triage rows, in this order — do not substitute lower-signal lines):\n`;
        if (earliestSymptom) report += `  1) SYMPTOM (earliest, installer continued past it): ${detCause.file}:Line ${earliestSymptom.lineNum}${earliestSymptom.timestamp ? ` @ ${earliestSymptom.timestamp}` : ""} — ${truncateLogLine(earliestSymptom.text, 180)}\n`;
        if (whyHits.length) report += `  2) ROOT-CAUSE error: ${whyHits[0]}\n`;
        report += `  3) FAILING ACTION: ${detCause.file}:Line ${detCause.causeIdx + 1}${detCause.causeTs ? ` @ ${detCause.causeTs}` : ""} — CustomAction ${detCause.causeName} returned error code 1603\n`;
        if (detCause.rv3Idx >= 0) report += `  4) ROLLBACK: ${detCause.file}:Line ${detCause.rv3Idx + 1}${detCause.rv3Ts ? ` @ ${detCause.rv3Ts}` : ""} — Return value 3 (installation aborts)\n`;
        if (win && !lean) { report += `Full context around the failing action:\n`; report += "```text\n" + win + "\n```\n"; }
    } else {
        const primaryAnchor = [...sorted].sort((a, b) => b.score - a.score || a.sortTime - b.sortTime)[0];
        if (primaryAnchor && primaryAnchor.score >= 100) {
            const aLines = lineMap.get(primaryAnchor.file) || [];
            const aBlock = installerEvidenceWindow(aLines, primaryAnchor.lineNum - 1, 25, 5);
            report += `\n--- PRIMARY ROOT-CAUSE ANCHOR (highest-signal failing action — START HERE; the cause is on or just above this line) ---\n`;
            report += `${primaryAnchor.file}:Line ${primaryAnchor.lineNum}${primaryAnchor.timestamp ? ` @ ${primaryAnchor.timestamp}` : ""} | ${primaryAnchor.classification}\n`;
            if (aBlock) report += "```text\n" + aBlock + "\n```\n";
        }
    }

    // Deduplicate the chronological list by signature so a symptom repeated many times (e.g. the
    // same SQL-login error) takes ONE row — leaving room for the DISTINCT failure stages (login
    // symptom → migration/SQL error → deploy failure → rollback). This timeline is what lets the
    // model build the propagation/domino path and tell the symptom apart from the real cause.
    const chronoSeen = new Map();
    const chronoEvents = [];
    for (const e of sorted) {
        const sigKey = ((typeof normalizeLogSignature === 'function' ? normalizeLogSignature(e.text) : e.text) || e.text).slice(0, 80);
        const prev = chronoSeen.get(sigKey);
        if (prev) { prev.count++; continue; }
        const rec = { e, count: 1 };
        chronoSeen.set(sigKey, rec);
        chronoEvents.push(rec);
    }
    const chronoN = lean ? (haveDet ? 6 : 10) : (haveDet ? 16 : 22);
    const windowN = lean ? 0 : (haveDet ? 2 : 4);
    report += `\n--- CHRONOLOGICAL HIGH-SIGNAL LINES (deduplicated, earliest first — EARLIER errors are usually symptoms; the cause is the deepest error just before "Return value 3") ---\n`;
    report += `Timestamp | Location | Signal tag | Raw log line (xN = repeats)\n`;
    chronoEvents.slice(0, chronoN).forEach(({ e, count }) => {
        report += `${formatInstallerTime(e.timestamp)} | ${e.file}:Line ${e.lineNum} | ${e.classification} | ${truncateLogLine(e.text, 300)}${count > 1 ? ` (x${count})` : ""}\n`;
    });

    if (windowN > 0) {
    report += `\n--- EVIDENCE WINDOWS (highest-score lines with surrounding context) ---\n`;
    const seen = new Set();
    [...sorted]
        .sort((a, b) => b.score - a.score)
        .slice(0, windowN)
        .sort((a, b) => a.sortTime - b.sortTime || a.lineNum - b.lineNum)
        .forEach(e => {
            const key = `${e.file}:${e.lineNum}`;
            if (seen.has(key)) return;
            seen.add(key);
            const lines = lineMap.get(e.file) || [];
            const block = installerEvidenceWindow(lines, e.lineNum - 1, 30, 15);
            if (!block) return;
            report += `\nAnchor (${e.classification}) @ ${e.file}:Line ${e.lineNum}${e.timestamp ? ` (${formatInstallerTime(e.timestamp)})` : ""}:\n`;
            report += "```text\n" + block + "\n```\n";
            const meta = extractSqlErrorMetadata(block);
            if (meta.length > 0) report += `SQL metadata from window: ${meta.join('; ')}.\n`;
            const stack = extractStackOriginSummary(block);
            if (stack) report += "Stack excerpt:\n```text\n" + stack + "\n```\n";
        });
    }

    report += `\nAI instructions: Format your response as a strict Markdown table, then a ROOT CAUSE and FIX. `;
    if (haveDet) {
        report += `The PRIMARY ROOT CAUSE above is authoritative and already identified for you: the failing action is CustomAction ${detCause.causeName} (the 1603 that was NOT "translated to success"). Your ROOT CAUSE line MUST name CustomAction ${detCause.causeName} and cite its exact line and timestamp. Explain WHY using only the lines shown above it. Do NOT name any other action, and NEVER blame SQL "Cannot open database"/"Login failed"/database-enumeration lines — those are pre-create enumeration noise here. Do NOT invent CustomAction names or 1603 codes that are not in the evidence above.\n`;
    } else {
        report += `CRITICAL MSI RULE: The true root cause is almost ALWAYS the CustomAction, script execution, or error immediately preceding "Return value 3" or "Closing MSIHANDLE". Do NOT randomly blame early SQL/login lines unless they are directly above the fatal Return value 3 rollback trigger! Follow the specific MSI rules in the PRODUCT-SPECIFIC LOG SIGNATURES section if available.\n`;
    }
    report += `=== END INSTALLER EVIDENCE ===`;
    return report;
}

// HAR (HTTP Archive) network-capture detection + analysis. A .har is JSON, so the line-based log
// intelligence can't read it — this parses the JSON and surfaces the failing HTTP transactions
// (4xx/5xx, 3xx redirects, OAuth/SSO error codes, rate-limiting), plus a host/issuer mismatch
// check that pinpoints redirect-loop / wrong-FQDN problems. Output is a compact, line-anchored
// evidence block the model turns into the forensic report.
function isHarContent(fileName, content) {
    if (/\.har$/i.test(fileName || "")) return true;
    const head = (content || "").slice(0, 4000);
    return /"log"\s*:/.test(head) && /"entries"\s*:/.test(head) && /"request"\s*:/.test(head);
}

function buildHarAnalysis(content, fileName = "capture.har") {
    let har;
    try { har = JSON.parse(content); } catch (e) { return ""; }
    const entries = (har && har.log && har.log.entries) || [];
    if (!entries.length) return "";

    const hostCounts = {};
    const timeline = [];
    const decode = s => { try { return decodeURIComponent(String(s || "").replace(/\+/g, ' ')); } catch (e) { return String(s || ""); } };
    const hostOf = u => { try { return new URL(u).host; } catch (e) { return ""; } };
    const pathOf = u => { try { return new URL(u).pathname + (new URL(u).search || ""); } catch (e) { return u; } };

    for (const e of entries) {
        const req = e.request || {}, res = e.response || {};
        const url = req.url || "";
        const status = res.status || 0;
        const method = req.method || "";
        const ts = String(e.startedDateTime || "").replace('T', ' ').replace(/Z$/, '').slice(0, 23);
        const host = hostOf(url);
        if (host) hostCounts[host] = (hostCounts[host] || 0) + 1;

        // OAuth/SSO error codes carried in the POST body (or query) params
        let errInfo = "";
        const params = (req.postData && Array.isArray(req.postData.params)) ? req.postData.params : (req.queryString || []);
        if (Array.isArray(params)) {
            const ec = params.find(p => /error_code|^error$/i.test(p.name));
            const es = params.find(p => /error_(string|description|message|detail)/i.test(p.name));
            if (ec || es) errInfo = `${ec ? ec.value : ""}${es ? ` — "${decode(es.value)}"` : ""}`.trim();
        }
        // error text in the response body
        const resText = (res.content && res.content.text) || "";
        const resErr = /error|too many|denied|unauthor|forbidden|not found|invalid/i.test(resText) ? resText.replace(/\s+/g, ' ').slice(0, 180) : "";
        // redirect target (Location header or redirectURL)
        let redirect = res.redirectURL || "";
        if (!redirect) { const loc = (res.headers || []).find(h => /^location$/i.test(h.name)); redirect = loc ? loc.value : ""; }
        // issuer / FQDN hints inside the request (referer, origin, body)
        const referer = ((req.headers || []).find(h => /^referer$/i.test(h.name)) || {}).value || "";

        const isErr = status >= 400 || !!errInfo || !!resErr;
        const isRedir = status >= 300 && status < 400;
        timeline.push({ ts, method, status, statusText: res.statusText || "", host, path: pathOf(url), errInfo, resErr, redirect, referer, isErr, isRedir });
    }

    const interesting = timeline.filter(t => t.isErr || t.isRedir || /oauth|sso|saml|auth|logon|login|token|idp/i.test(t.path));
    if (interesting.length === 0 && timeline.length === 0) return "";

    let report = `\n\n=== HAR NETWORK CAPTURE ANALYSIS (${fileName}) — line-anchored HTTP facts; AI derives root cause ===\n`;
    const hosts = Object.keys(hostCounts);
    report += `Hosts contacted: ${hosts.map(h => `${h} (${hostCounts[h]})`).join(', ') || 'none parsed'}\n`;
    report += `Total transactions: ${timeline.length}; with errors/redirects: ${timeline.filter(t => t.isErr || t.isRedir).length}\n`;
    report += `\nNotable HTTP transactions (chronological):\n`;
    (interesting.length ? interesting : timeline).slice(0, 25).forEach((t, i) => {
        const extra = [t.errInfo ? `ERROR ${t.errInfo}` : "", t.resErr ? `body: ${t.resErr}` : "", t.redirect ? `redirect → ${t.redirect}` : ""].filter(Boolean).join(' | ');
        report += `${i + 1}. ${t.ts} | ${t.method} ${t.host}${t.path} → ${t.status} ${t.statusText}${extra ? ` | ${extra}` : ""}\n`;
    });

    // Key signals + FQDN/issuer mismatch detection
    const ssoFail = interesting.find(t => /invalid_client|sso.*(?:not|entity)|entity.*not.*found|relying party|unknown client/i.test(`${t.errInfo} ${t.resErr}`));
    const rate429 = interesting.find(t => t.status === 429 || /too many requests/i.test(t.resErr));
    const authFlow = interesting.find(t => /oauth|sso|saml|logon|login|token|idp/i.test(t.path));
    // mismatch: an internal-looking FQDN (.local / private IP) appears anywhere alongside the public host
    const blob = JSON.stringify(har).slice(0, 200000);
    const internalFqdn = (blob.match(/https?:\/\/([a-z0-9.\-]+\.local)\b/i) || [])[1] || (blob.match(/https?:\/\/([a-z0-9\-]+\.[a-z0-9.\-]*local)\b/i) || [])[1] || "";
    const signals = [];
    if (ssoFail) signals.push(`SSO/client-config error: ${ssoFail.errInfo || ssoFail.resErr}`);
    if (rate429) signals.push(`HTTP 429 Too Many Requests — the auth/redirect flow is looping and getting rate-limited`);
    if (authFlow) signals.push(`failure is in the OAuth/SSO flow (${authFlow.path})`);
    if (internalFqdn && hosts.some(h => !/\.local$/i.test(h))) {
        signals.push(`FQDN MISMATCH: an internal FQDN "${internalFqdn}" appears while the browser uses public host(s) "${hosts.filter(h => !/local/i.test(h)).join(', ')}" — a wrong issuer/redirect URL (internal vs external) is the classic cause of an SSO redirect loop`);
    }
    if (signals.length) report += `\nKey signals: ${signals.join('; ')}.\n`;
    report += `=== END HAR NETWORK CAPTURE ANALYSIS ===`;
    return report;
}

function isExceptionContinuationLine(line) {
    return isStackTraceLine(line)
        || /^\s*(---\s*End|Inner Exception|--->|HResult=|Source=|StackTrace:|Error Number:|Number:|Class:|State:|Procedure:|Server:|ClientConnectionId:|Data Source=|Initial Catalog=|TargetSite=|HelpLink=|SQLState=|ErrorCode=|NativeError=|Message=|Detail=|Reason=)/i.test(line)
        || /^\s+/.test(line)
        || /^\s*$/.test(line);
}

async function extractExceptionBlocksFromLog(log) {
    await precomputeLogIntel(log);
    const name = log.name || "Unknown log";
    const lines = log.lines || (log.content ? log.content.split('\n') : []);
    const { intelCache, timestampCache } = log.precomputedIntel;
    const blocks = [];
    const consumed = new Set();
    // Safety cap: data-export CSVs (an "exception"/"error" column on every row) can make almost
    // every line "start a block", producing tens of thousands of heavy block objects — minutes of
    // CPU and hundreds of MB. We only ever rank/use the top ~25, so stop after a generous cap.
    const MAX_BLOCKS = 800;

    for (let i = 0; i < lines.length; i++) {
        if (i % 2000 === 0 && i > 0) {
            await yieldIfNeeded();
        }
        if (blocks.length >= MAX_BLOCKS) break;
        if (consumed.has(i)) continue;
        const line = lines[i];
        const intel = intelCache[i];
        const startsBlock = intel.hasException
            || intel.categories.includes('SQL/Database')
            || (intel.categories.includes('Installer/MSI') && hasRealFailureSignal(line))
            || intel.keywordHits.some(hit => hit.score >= 30)
            || /\b(Caused by:|Inner Exception|--->|Traceback \(most recent call last\))\b/i.test(line);
        if (!startsBlock) continue;

        const start = i;
        const blockLines = [line];
        consumed.add(i);

        for (let j = i + 1; j < Math.min(lines.length, start + 160); j++) {
            const next = lines[j];
            const nextIntel = intelCache[j];
            const looksLikeNewEvent = timestampCache[j] && nextIntel.isForensic && !nextIntel.hasStackFrame && !/^\s/.test(next);
            if (looksLikeNewEvent && blockLines.length > 1) break;
            if (nextIntel.hasStackFrame || nextIntel.hasException || nextIntel.categories.includes('SQL/Database') || isExceptionContinuationLine(next)) {
                blockLines.push(next);
                consumed.add(j);
                continue;
            }
            if (blockLines.length < 4) {
                blockLines.push(next);
                consumed.add(j);
                continue;
            }
            break;
        }

        const blockText = blockLines.join('\n');
        const classes = extractExceptionClasses(blockText);
        const frames = extractStackFrames(blockText);
        const sql = diagnoseSqlIssue(blockText);
        const categories = new Set(intel.categories);
        if (sql) categories.add('SQL/Database');
        if (classes.length > 0) categories.add('Exception');

        blocks.push({
            file: name,
            startLine: start + 1,
            endLine: start + blockLines.length,
            timestamp: timestampCache[start],
            sortTime: parseLogTimestampForSort(timestampCache[start]),
            categories: Array.from(categories),
            exceptionChain: classes,
            outerException: classes[0] || "",
            innermostException: classes[classes.length - 1] || "",
            message: line.trim(),
            throwingFrame: frames[0] || "",
            originatingFrame: frames[frames.length - 1] || "",
            sql,
            score: scoreRootCauseCandidate({
                lineNum: start + 1,
                text: blockText,
                categories: Array.from(categories),
                hasException: classes.length > 0,
                keywordHits: getKeywordHits(blockText)
            }) + (sql ? 30 : 0) + (classes.length > 1 ? 18 : 0),
            excerpt: blockLines.slice(0, 18).join('\n')
        });
    }

    return blocks;
}

function truncateLogLine(line, max = 320) {
    if (!line) return "";
    return line.length > max ? `${line.slice(0, max)}...` : line;
}

function createSignalSummary() {
    return {
        keywordMap: new Map(),
        exceptionMap: new Map(),
        severityCounts: {},
        highSignalLines: []
    };
}

function bumpSignalMap(map, key, sample) {
    if (!key) return;
    const existing = map.get(key) || {
        count: 0,
        firstLine: sample.lineNum,
        lastLine: sample.lineNum,
        firstTimestamp: sample.timestamp,
        lastTimestamp: sample.timestamp,
        file: sample.file,
        sample: sample.text
    };
    existing.count++;
    existing.lastLine = sample.lineNum;
    existing.lastTimestamp = sample.timestamp || existing.lastTimestamp;
    if (!existing.firstTimestamp && sample.timestamp) existing.firstTimestamp = sample.timestamp;
    map.set(key, existing);
}

function updateSignalSummary(summary, intel, line, lineNum, fileName = "") {
    if (!summary || !intel || !intel.isForensic) return;
    const sample = {
        file: fileName,
        lineNum,
        timestamp: extractLogTimestamp(line),
        text: truncateLogLine((line || "").trim(), 260)
    };

    if (intel.severityToken) {
        summary.severityCounts[intel.severityToken] = (summary.severityCounts[intel.severityToken] || 0) + 1;
    }
    (intel.keywordHits || []).forEach(hit => bumpSignalMap(summary.keywordMap, hit.label, sample));
    (intel.exceptionClasses || []).forEach(cls => bumpSignalMap(summary.exceptionMap, cls, sample));

    const score = scoreRootCauseCandidate({
        lineNum,
        text: line || "",
        categories: intel.categories,
        hasException: intel.hasException,
        keywordHits: intel.keywordHits
    });
    if (score >= 70 && !intel.hasStackFrame) {
        summary.highSignalLines.push({ ...sample, score, categories: intel.categories });
    }
}

function renderSignalSummary(summary, title = "EXCEPTION / ERROR KEYWORD SWEEP") {
    if (!summary) return "";
    const keywordRows = Array.from(summary.keywordMap.entries())
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .slice(0, 30);
    const exceptionRows = Array.from(summary.exceptionMap.entries())
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .slice(0, 30);
    const severityRows = Object.entries(summary.severityCounts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const highSignalRows = summary.highSignalLines
        .sort((a, b) => b.score - a.score || a.lineNum - b.lineNum)
        .slice(0, 20);

    if (keywordRows.length === 0 && exceptionRows.length === 0 && severityRows.length === 0 && highSignalRows.length === 0) {
        return `\n--- ${title} ---\nNo exception classes, severity tokens, or high-risk error keywords were detected.\n--- END ${title} ---\n`;
    }

    let report = `\n--- ${title} ---\n`;
    report += `Note: In MSI verbose logs, "Note: 1: 1402" (and similar) are internal MSI codes — not exceptions. Real failures appear as SqlException, ALTER DATABASE errors, or Return 1603.\n`;
    if (severityRows.length > 0) {
        report += `Severity tokens: ${severityRows.map(([sev, count]) => `${sev}:${count}`).join(', ')}\n`;
    }
    if (exceptionRows.length > 0) {
        report += `Exception classes:\n`;
        exceptionRows.forEach(([cls, row]) => {
            report += `- ${cls}: ${row.count}x | ${row.file ? `${row.file}:` : ""}Lines ${row.firstLine}-${row.lastLine}${row.firstTimestamp ? ` | First ${row.firstTimestamp}` : ""} | ${row.sample}\n`;
        });
    }
    if (keywordRows.length > 0) {
        report += `High-signal keywords:\n`;
        keywordRows.forEach(([keyword, row]) => {
            report += `- ${keyword}: ${row.count}x | ${row.file ? `${row.file}:` : ""}Lines ${row.firstLine}-${row.lastLine}${row.firstTimestamp ? ` | First ${row.firstTimestamp}` : ""} | ${row.sample}\n`;
        });
    }
    if (highSignalRows.length > 0) {
        report += `Top high-signal lines:\n`;
        highSignalRows.forEach((row, idx) => {
            report += `${idx + 1}. ${row.file ? `${row.file}:` : ""}Line ${row.lineNum}${row.timestamp ? ` @ ${row.timestamp}` : ""} [score ${row.score}; ${row.categories.join(', ') || 'Unclassified'}] ${row.text}\n`;
        });
    }
    report += `--- END ${title} ---\n`;
    return report;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isSupportedLogFileName(name) {
    return /\.(log|txt|xml|json|har|csv|out|err|trace|config)$/i.test(name || "");
}

function normalizeLogText(content) {
    if (!content) return "";
    return String(content).replace(/^\uFEFF/, "").replace(/\u0000/g, "").replace(/\r\n/g, "\n");
}

function decodeLogBytes(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    if (bytes.length >= 2) {
        if (bytes[0] === 0xFF && bytes[1] === 0xFE) return normalizeLogText(new TextDecoder("utf-16le").decode(bytes.slice(2)));
        if (bytes[0] === 0xFE && bytes[1] === 0xFF) return normalizeLogText(new TextDecoder("utf-16be").decode(bytes.slice(2)));
    }
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        return normalizeLogText(new TextDecoder("utf-8").decode(bytes.slice(3)));
    }

    const sample = bytes.slice(0, Math.min(bytes.length, 4000));
    let evenNulls = 0;
    let oddNulls = 0;
    for (let i = 0; i < sample.length; i++) {
        if (sample[i] === 0) {
            if (i % 2 === 0) evenNulls++;
            else oddNulls++;
        }
    }
    if (oddNulls > 20 && oddNulls > evenNulls * 3) return normalizeLogText(new TextDecoder("utf-16le").decode(bytes));
    if (evenNulls > 20 && evenNulls > oddNulls * 3) return normalizeLogText(new TextDecoder("utf-16be").decode(bytes));

    try {
        return normalizeLogText(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
    } catch (e) {
        return normalizeLogText(new TextDecoder("windows-1252").decode(bytes));
    }
}

async function getLogPanelIntel(log) {
    if (!log) return null;
    const cacheKey = `${log.name || ""}:${(log.content || "").length}`;
    if (log.panelIntel && log.panelIntel.cacheKey === cacheKey) return log.panelIntel;

    const content = log.content || "";
    const lines = log.lines || (content ? content.split('\n') : []);
    const categories = {};
    const rootCandidates = [];
    const installerEvents = [];
    const signalSummary = createSignalSummary();
    let firstTimestamp = "";
    let lastTimestamp = "";
    let eventCount = 0;

    await precomputeLogIntel(log);
    const { prefilteredIndices, intelCache, timestampCache, installerEventCache } = log.precomputedIntel;

    // Find first and last timestamps from cached array
    for (let idx = 0; idx < lines.length; idx++) {
        const ts = timestampCache[idx];
        if (ts) {
            if (!firstTimestamp) firstTimestamp = ts;
            lastTimestamp = ts;
        }
    }

    for (let i = 0; i < prefilteredIndices.length; i++) {
        if (i % 2000 === 0 && i > 0) {
            await yieldIfNeeded();
        }
        const idx = prefilteredIndices[i];
        const line = lines[idx];
        const timestamp = timestampCache[idx] || "";
        const intel = intelCache[idx];

        updateSignalSummary(signalSummary, intel, line, idx + 1, log.name || "");
        if (intel.isForensic && !intel.hasStackFrame) {
            eventCount++;
            intel.categories.forEach(cat => { categories[cat] = (categories[cat] || 0) + 1; });
            rootCandidates.push({
                lineNum: idx + 1,
                timestamp,
                text: line.trim(),
                categories: intel.categories,
                keywordHits: intel.keywordHits,
                score: scoreRootCauseCandidate({
                    lineNum: idx + 1,
                    text: line,
                    categories: intel.categories,
                    hasException: intel.hasException,
                    keywordHits: intel.keywordHits
                })
            });
        }

        const installerEvent = installerEventCache[idx];
        if (installerEvent && installerEvent.score >= 30) installerEvents.push(installerEvent);
    }

    rootCandidates.sort((a, b) => b.score - a.score || a.lineNum - b.lineNum);
    installerEvents.sort((a, b) => b.score - a.score || a.lineNum - b.lineNum);

    const topCategory = Object.entries(categories).sort((a, b) => b[1] - a[1])[0];
    const sqlTarget = extractSqlTarget(content);
    const azureSql = /\.database\.windows\.net\b/i.test(sqlTarget || content);
    const alterEvent = installerEvents.find(e => /ALTER DATABASE|RECOVERY SIMPLE/i.test(`${e.classification} ${e.text}`));
    const loginEvent = installerEvents.find(e => /Cannot open database|Login failed/i.test(e.text));
    const fatalInstallerEvent = installerEvents.find(e => /abort|rollback|1603|ALTER DATABASE|SqlException/i.test(`${e.classification} ${e.text}`));
    const topException = Array.from(signalSummary.exceptionMap.entries()).sort((a, b) => b[1].count - a[1].count)[0];

    let verdict = "Ready for forensic AI analysis";
    let confidence = eventCount > 0 ? "Evidence detected" : "No errors detected";
    let focusLine = rootCandidates[0] ? `Line ${rootCandidates[0].lineNum}` : "";

    if (alterEvent || fatalInstallerEvent) {
        const focus = alterEvent || fatalInstallerEvent;
        verdict = `High-signal SQL/installer failure (${focus.classification})`;
        confidence = "Evidence detected — analyse with AI";
        focusLine = `Line ${focus.lineNum}`;
    } else if (loginEvent) {
        verdict = "SQL login/database-access issue detected";
        confidence = "Prerequisite failure detected";
        focusLine = `Line ${loginEvent.lineNum}`;
    } else if (rootCandidates[0]) {
        verdict = `${classifyFailureKind(rootCandidates[0].text, rootCandidates[0].categories)} candidate`;
        confidence = topCategory ? `${topCategory[0]} x${topCategory[1]}` : "Forensic events detected";
    }

    log.panelIntel = {
        cacheKey,
        lineCount: lines.length,
        size: content.length,
        eventCount,
        firstTimestamp,
        lastTimestamp,
        topCategory: topCategory ? `${topCategory[0]} x${topCategory[1]}` : "",
        topException: topException ? `${topException[0]} x${topException[1].count}` : "",
        product: inferProductFromLogName(log.name || "", content),
        sqlTarget,
        azureSql,
        verdict,
        confidence,
        focusLine
    };
    return log.panelIntel;
}

function buildWholeLogSegmentMap(lines, segmentCount = 16) {
    const totalLines = lines.length;
    if (totalLines === 0) return "";
    const actualSegmentCount = Math.max(1, Math.min(segmentCount, totalLines));

    const segments = Array.from({ length: actualSegmentCount }, (_, idx) => ({
        index: idx + 1,
        startLine: Math.floor((idx * totalLines) / actualSegmentCount) + 1,
        endLine: Math.max(Math.floor(((idx + 1) * totalLines) / actualSegmentCount), Math.floor((idx * totalLines) / actualSegmentCount) + 1),
        forensicCount: 0,
        categories: {},
        firstEvent: "",
        lastEvent: ""
    }));

    lines.forEach((line, idx) => {
        if (!FAST_FORENSIC_PREFILTER.test(line)) return;
        const intel = classifyLogLine(line);
        if (!intel.isForensic || intel.hasStackFrame) return;

        const segIdx = Math.min(actualSegmentCount - 1, Math.floor((idx / Math.max(1, totalLines)) * actualSegmentCount));
        const seg = segments[segIdx];
        seg.forensicCount++;
        intel.categories.forEach(cat => {
            seg.categories[cat] = (seg.categories[cat] || 0) + 1;
        });
        const label = `Line ${idx + 1}${extractLogTimestamp(line) ? ` @ ${extractLogTimestamp(line)}` : ""}: ${truncateLogLine(line.trim(), 240)}`;
        if (!seg.firstEvent) seg.firstEvent = label;
        seg.lastEvent = label;
    });

    let report = `\n--- WHOLE-LOG COVERAGE MAP (head/middle/tail segment scan) ---\n`;
    segments.forEach(seg => {
        const cats = Object.entries(seg.categories)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, count]) => `${cat}:${count}`)
            .join(', ');
        report += `Segment ${seg.index}/${actualSegmentCount} | Lines ${seg.startLine}-${seg.endLine} | forensic events: ${seg.forensicCount}${cats ? ` | ${cats}` : ""}\n`;
        if (seg.firstEvent) report += `  First: ${seg.firstEvent}\n`;
        if (seg.lastEvent && seg.lastEvent !== seg.firstEvent) report += `  Last: ${seg.lastEvent}\n`;
    });
    report += `--- END WHOLE-LOG COVERAGE MAP ---\n`;
    return report;
}

function getLineWindow(lines, centerLine, radius = 35) {
    const start = Math.max(1, centerLine - radius);
    const end = Math.min(lines.length, centerLine + radius);
    const text = lines.slice(start - 1, end).join('\n');
    return { start, end, text };
}

async function collectCuratedFailureAnchors(lines, fileName = "", logObj = null) {
    const log = logObj || findLogObject(fileName, "") || { name: fileName, lines };
    await precomputeLogIntel(log);
    const { prefilteredIndices, timestampCache } = log.precomputedIntel;

    const patterns = [
        { tag: "SQL/Azure target", regex: /\b(Microsoft SQL Azure|SQL Azure|database\.windows\.net)\b/i },
        { tag: "SqlException", regex: /\bSystem\.Data\.SqlClient\.SqlException\b/i },
        { tag: "ALTER DATABASE unsupported", regex: /\bALTER DATABASE statement is not supported\b/i },
        { tag: "Recovery mode SIMPLE", regex: /\bSetting Recovery mode to SIMPLE\b/i },
        { tag: "DbUp upgrade failure", regex: /\bUpgrade failed due to an unexpected exception\b/i },
        { tag: "Location Service DB deploy", regex: /\bLocation Service database deployment\b/i },
        { tag: "MSI fatal return", regex: /\bMainEngineThread is returning 1603\b/i },
        { tag: "Cannot open database", regex: /\bCannot open database\b/i }
    ];
    const anchors = [];
    const seen = new Set();
    for (let i = 0; i < prefilteredIndices.length; i++) {
        if (i % 2000 === 0 && i > 0) {
            await yieldIfNeeded();
        }
        // These anchors are a small set of distinct high-value markers; once we have enough (or have
        // scanned plenty of high-signal lines) stop — avoids 8 regexes × tens of thousands of long
        // lines on a huge log. The strongest markers (SqlException, ALTER DATABASE) appear early.
        if (anchors.length >= 24 || i > 14000) break;
        const idx = prefilteredIndices[i];
        const line = (lines[idx] || "").slice(0, 1500);

        for (const pattern of patterns) {
            if (!pattern.regex.test(line)) continue;
            const key = `${pattern.tag}::${normalizeLogSignature(line).slice(0, 140)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            anchors.push({
                tag: pattern.tag,
                lineNum: idx + 1,
                timestamp: timestampCache[idx] || "",
                text: truncateLogLine(line.trim(), 420)
            });
            break;
        }
    }
    return anchors;
}

async function buildCuratedFailureEvidence(content, fileName = "Attached log", precalculatedLines = null) {
    if (!content) return "";
    const lines = precalculatedLines || content.split('\n');
    const log = findLogObject(fileName, content) || { name: fileName, content, lines };
    const anchors = await collectCuratedFailureAnchors(lines, fileName, log);
    if (anchors.length === 0) return "";

    let report = `\n--- CURATED HIGH-VALUE EVIDENCE (read first — whole-file scan) ---\n`;
    report += `Strongest failure-related lines in ${fileName}. MSI internal codes like "Note: 1: 1402" are registry notes, not exceptions. Derive root cause from SqlException text and chronology below.\n`;
    anchors.slice(0, 35).forEach((anchor, idx) => {
        report += `${idx + 1}. [${anchor.tag}] Line ${anchor.lineNum}${anchor.timestamp ? ` @ ${anchor.timestamp}` : ""}\n   ${anchor.text}\n`;
    });

    const alterAnchor = anchors.find(a => a.tag === "ALTER DATABASE unsupported");
    const sqlAnchor = anchors.find(a => a.tag === "SqlException") || alterAnchor;
    const windowCenter = alterAnchor?.lineNum || sqlAnchor?.lineNum;
    if (windowCenter) {
        const win = getLineWindow(lines, windowCenter, 40);
        report += `\nPrimary SQL failure window (Lines ${win.start}-${win.end}):\n\`\`\`text\n${win.text}\n\`\`\`\n`;
    }
    report += `--- END CURATED HIGH-VALUE EVIDENCE ---\n`;
    return report;
}

function isInstallerLogContent(fileName, content) {
    const sample = `${fileName || ""}\n${(content || "").slice(0, 80000)}`;
    return /\b(SetupSOTI|MSI|Windows Installer|CustomAction|Deploy[A-Za-z]*Database|DbUp|DeploymentEngine|PerformUpgrade|Verbose logging started)\b/i.test(sample);
}

// STRICT detector used for ROUTING (forensic vs normal). isInstallerLogContent above is
// deliberately broad for ADDITIVE evidence, but it also matches RUNTIME logs that merely
// mention "CustomAction"/"Deploy..." (e.g. DeploymentServer.log). Routing a runtime log to
// the MSI installer forensic prompt produces a wrong/degenerate answer, so routing requires
// genuine MSI-setup markers: a SetupSOTI/.msi filename, or MSI verbose-log signatures.
function isMsiInstallerLog(fileName, content) {
    const name = (fileName || "").toLowerCase();
    if (/setupsoti|\.msi\b|msiexec|installer/.test(name)) return true;
    const head = (content || "").slice(0, 60000);
    return /Verbose logging started|MSI \([cs]\)|Windows ® Installer|Installation success or error status|Return value 3/i.test(head);
}

function extractNearbyMsiTimestamp(lines, idx) {
    for (let offset = 0; offset <= 4; offset++) {
        const candidates = [idx - offset, idx + offset];
        for (const i of candidates) {
            if (i < 0 || i >= lines.length) continue;
            const ts = extractLogTimestamp(lines[i] || "");
            if (ts) return ts;
        }
    }
    return "";
}

async function extractFailurePhases(lines, logObj = null) {
    const log = logObj || findLogObject("", "") || { lines };
    await precomputeLogIntel(log);
    const { prefilteredIndices } = log.precomputedIntel;

    const phaseDefs = [
        { id: "azure_env", title: "SQL target (Azure / cloud)", regex: /\b(Microsoft SQL Azure|SQL Azure|database\.windows\.net)\b/i, radius: 8 },
        { id: "login", title: "Database login / cannot open database", regex: /\bCannot open database\b/i, radius: 28 },
        { id: "migration", title: "Location Service DB migration starts", regex: /\b(Executing Database Server script|SQL exception has occurred in script)\b/i, radius: 12 },
        { id: "alter_fatal", title: "Fatal SQL: ALTER DATABASE not supported", regex: /\bALTER DATABASE statement is not supported\b/i, radius: 85 },
        { id: "dbup", title: "DbUp upgrade failure", regex: /\bUpgrade failed due to an unexpected exception\b/i, radius: 55 },
        { id: "custom_action", title: "Location Service database deployment failed", regex: /\bLocation Service database deployment\b/i, radius: 35 },
        { id: "rollback", title: "MSI rollback (fatal return)", regex: /\bMainEngineThread is returning 1603\b/i, radius: 15 },
        { id: "return_3", title: "Return value 3 (Fatal Rollback trigger)", regex: /\bReturn value 3\b/i, radius: 25 },
        { id: "msihandle", title: "Closing MSIHANDLE before rollback", regex: /\bClosing MSIHANDLE \(\d+\) of type \d+ for thread\b/i, radius: 25 },
        { id: "custom_action_1603", title: "CustomAction failed with 1603", regex: /\bCustomAction .* returned actual error code 1603\b/i, radius: 25 }
    ];
    const phases = [];
    const seen = new Set();
    for (let i = 0; i < prefilteredIndices.length; i++) {
        if (i % 2000 === 0 && i > 0) {
            await yieldIfNeeded();
        }
        const idx = prefilteredIndices[i];
        const line = lines[idx] || "";

        for (const def of phaseDefs) {
            if (!def.regex.test(line)) continue;
            if (seen.has(def.id)) continue;
            seen.add(def.id);
            phases.push({
                id: def.id,
                title: def.title,
                lineNum: idx + 1,
                timestamp: extractNearbyMsiTimestamp(lines, idx),
                window: getLineWindow(lines, idx + 1, def.radius)
            });
        }
    }
    return phases.sort((a, b) => a.lineNum - b.lineNum);
}

async function collectDistinctSqlFacts(lines, logObj = null) {
    const log = logObj || findLogObject("", "") || { lines };
    await precomputeLogIntel(log);
    const { prefilteredIndices } = log.precomputedIntel;

    const facts = [];
    const seen = new Set();
    for (let i = 0; i < prefilteredIndices.length; i++) {
        if (i % 2000 === 0 && i > 0) {
            await yieldIfNeeded();
        }
        const idx = prefilteredIndices[i];
        const line = lines[idx];
        const text = (line || "").trim();
        if (!/\b(SqlException|ALTER DATABASE|Cannot open database|Login failed|Error Number:|Setting Recovery mode)\b/i.test(text)) continue;
        if (isMsiNoiseLine(text) && !/\b(SqlException|ALTER DATABASE|Cannot open database)\b/i.test(text)) continue;
        const key = text.replace(/\d{4}-\d{2}-\d{2}/g, "").replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.:]\d+)?\b/g, "").slice(0, 180);
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({
            lineNum: idx + 1,
            timestamp: extractNearbyMsiTimestamp(lines, idx),
            text: truncateLogLine(text, 360)
        });
    }
    return facts.slice(0, 25);
}

async function buildPrecisionLogBrief(content, fileName = "Attached log", precalculatedLines = null) {
    if (!content) return "";
    const lines = precalculatedLines || content.split('\n');
    const log = findLogObject(fileName, content) || { name: fileName, content, lines };
    await precomputeLogIntel(log);
    const { prefilteredIndices } = log.precomputedIntel;
    
    const product = inferProductFromLogName(fileName, content) || "SOTI installer";
    const sqlTarget = extractSqlTarget(content);
    const machine = extractMachineName(content);
    const azureSql = /\.database\.windows\.net\b/i.test(sqlTarget || content);
    
    let azureIdx = -1;
    for (let i = 0; i < prefilteredIndices.length; i++) {
        const idx = prefilteredIndices[i];
        if (/\bMicrosoft SQL Azure|SQL Azure\b/i.test(lines[idx] || "")) {
            azureIdx = idx;
            break;
        }
    }
    
    const returnMatch = (content || "").match(/\bMainEngineThread is returning\s+(1603|\d{3,5})\b/i);
    const returnCode = returnMatch ? returnMatch[1] : "";
    const base = extractInstallerBaseDate(content);
    const phases = await extractFailurePhases(lines, log);
    const sqlFacts = await collectDistinctSqlFacts(lines, log);

    if (phases.length === 0 && sqlFacts.length === 0) return "";

    let md = `\n\n=== PRECISION LOG BRIEF (AUTHORITATIVE — cite these line numbers) ===\n`;
    md += `File: \`${fileName}\` | ${lines.length} lines scanned\n`;
    md += `Product: ${product}\n`;
    if (base.date) md += `Install date: ${base.date}${base.startTime ? ` ${base.startTime}` : ""}\n`;
    md += `Environment facts:\n`;
    if (machine) md += `- Server: ${machine}\n`;
    if (sqlTarget) md += `- SQL endpoint: ${sqlTarget}\n`;
    if (azureSql) md += `- Azure SQL Database: yes (.database.windows.net in log)\n`;
    if (azureIdx >= 0) md += `- Azure SQL line ${azureIdx + 1}: ${truncateLogLine(lines[azureIdx].trim(), 220)}\n`;
    if (returnCode) md += `- MSI return code: ${returnCode}${returnCode === "1603" ? " (fatal install abort)" : ""}\n`;

    if (phases.length > 0) {
        md += `\n--- CHRONOLOGICAL FAILURE PHASES (deduplicated; full raw context per phase) ---\n`;
        phases.forEach((phase, idx) => {
            md += `\n#### Phase ${idx + 1}: ${phase.title}\n`;
            md += `Anchor: Line ${phase.lineNum}${phase.timestamp ? ` @ ${phase.timestamp}` : ""} | Context Lines ${phase.window.start}-${phase.window.end}\n`;
            md += "```text\n" + phase.window.text + "\n```\n";
        });
    }

    if (sqlFacts.length > 0) {
        md += `\n--- DISTINCT SQL / DATABASE FACTS (one row per unique message) ---\n`;
        sqlFacts.forEach((fact, idx) => {
            md += `${idx + 1}. Line ${fact.lineNum}${fact.timestamp ? ` @ ${fact.timestamp}` : ""}: ${fact.text}\n`;
        });
    }

    md += `\nMandatory analysis rules:\n`;
    md += `- Use ONLY lines quoted above. MSI "Note: 1: 1402" is NOT an exception.\n`;
    md += `- Do NOT output a generic "keyword sweep inventory" table. Cite SqlException messages and line numbers.\n`;
    md += `- If Azure SQL and ALTER DATABASE / SET RECOVERY SIMPLE both appear, explain the failure from those cited lines.\n`;
    md += `- "Cannot open database" before migration may be prerequisite; the aborting failure is usually migration/custom-action then 1603.\n`;
    md += `=== END PRECISION LOG BRIEF ===\n`;
    return md;
}

function isLogForensicsRequest(text) {
    return /\b(forensic|root\s*cause|analy[sz]e\s+(?:the\s+)?logs?|log\s+analysis|investigate\s+(?:the\s+)?logs?)\b/i.test(text || "");
}

// Does the user actually want a LOG ANALYSIS, or are they asking a normal question?
// When logs are attached we must NOT force the forensic report format onto every message —
// "what's the case number?" / "summarize this case" deserve a direct, conversational answer.
function wantsLogAnalysis(text, silent) {
    const t = (text || "").trim().toLowerCase();
    if (!t) return true;                          // empty → default to analysis
    if (silent && t === 'analyse') return true;   // the "Analyse Now" button
    // Clear case/metadata questions → conversational, never a log report.
    if (/\bcase\s*(number|no\.?|#|id|info|summary|details?|notes?)\b/.test(t)) return false;
    if (/\bsummar(y|ise|ize)\b/.test(t) && /\bcase\b/.test(t)) return false;
    if (/\bwhat do you see\b/.test(t)) return false;
    // Explicit analysis intent.
    return /\b(analy[sz]e|analysis|root\s*cause|diagnos\w*|investigat\w*|troubleshoot\w*|forensic|what'?s\s+wrong|what\s+happened|why\s+(is|did|does|are|was|were)|find\s+the\s+(issue|problem|error|cause|root)|the\s+(error|issue|problem|failure|exception|crash))\b/.test(t);
}

// A conversational FOLLOW-UP about the assistant's PREVIOUS answer — e.g. "why do you think
// that's the root cause?", "how did you conclude that?", "are you sure?", "explain that",
// "what makes you say the SQL error is the cause?". These probe reasoning that was already
// given, so they must be answered conversationally from the analysis in chat history — NOT
// re-trigger a brand-new forensic log report. The literal words "root cause" appear in many
// such questions, which is exactly why the plain forensic/analysis detectors misfire on them.
function isAnalysisFollowUp(text) {
    const t = (text || '').trim().toLowerCase();
    if (!t) return false;
    // "why/how/what ... you/your ... <reasoning verb>" — probing the assistant's own conclusion.
    if (/\b(why|how|what|whats|where|when)\b/.test(t) && /\byour?\b/.test(t) &&
        /\b(think|thought|say|said|sure|certain|confident|believe|conclu\w+|determin\w+|decid\w+|figure\w*|know|knew|mean|meant|reason\w*|assum\w+|claim\w*|stat(e|ed|ing)|pick\w*|chose|choose|arrive\w*|base\w*|got|get)\b/.test(t)) return true;
    if (/\bare\s+you\s+(sure|certain|positive|serious|confident)\b/.test(t)) return true;
    if (/\bhow\s+(sure|certain|confident)\s+are\s+you\b/.test(t)) return true;
    if (/\bwhy\s+(is|are|was|were)\s+(that|this|it|those|these)\b/.test(t)) return true;   // "why is that the root cause"
    if (/^(and\s+)?(why|how|how so|how come)\s*[?.!]*$/.test(t)) return true;               // bare "why?" / "how so?"
    if (/^(explain|elaborate|clarify|justify|expand|go on|continue|tell me more|more detail|say more)\b/.test(t)) return true;
    if (/\b(can|could|would|will|please)\s+you\s+(explain|elaborate|clarify|justify|expand|walk)\b/.test(t)) return true;
    if (/\bon\s+what\s+(basis|grounds|evidence)\b/.test(t)) return true;
    if (/\bwalk\s+me\s+through\b/.test(t)) return true;
    if (/\b(prove\s+it|says?\s+who|how\s+do\s+you\s+figure)\b/.test(t)) return true;
    return false;
}

function shouldUseFocusedLogPipeline(logs) {
    if (!logs || logs.length === 0) return false;
    return logs.some(log => {
        const content = log.content || "";
        const lineCount = log.lines ? log.lines.length : (content.match(/\n/g) || []).length;
        if (lineCount < 3000 || !isInstallerLogContent(log.name, content)) return false;
        return /\b(SqlException|ALTER DATABASE statement is not supported|Cannot open database|Login failed|Upgrade failed due to an unexpected exception|Location Service database deployment|MainEngineThread is returning 1603)\b/i.test(content.slice(0, 500000));
    });
}

function extractSqlErrorNumber(text) {
    const m = (text || "").match(/\bError Number:\s*(-?\d+)/i) || (text || "").match(/\bNumber\s+(\d+);/i);
    return m ? m[1] : "";
}

function buildDeterministicForensicReport(logs) {
    if (!logs || logs.length === 0) return "";
    const sections = [];

    for (const log of logs) {
        const fileName = log.name || "Attached log";
        const content = log.content || "";
        const lines = log.lines || (content ? content.split('\n') : []);
        const phases = extractFailurePhases(lines);
        const sqlFacts = collectDistinctSqlFacts(lines);
        if (phases.length === 0 && sqlFacts.length === 0) continue;

        const product = inferProductFromLogName(fileName, content) || "SOTI installer";
        const sqlTarget = extractSqlTarget(content);
        const machine = extractMachineName(content);
        const azureSql = /\.database\.windows\.net\b/i.test(sqlTarget || content);
        const base = extractInstallerBaseDate(content);
        const returnMatch = content.match(/\bMainEngineThread is returning\s+(1603|\d{3,5})\b/i);
        const returnCode = returnMatch ? returnMatch[1] : "";
        const alterPhase = phases.find(p => p.id === "alter_fatal");
        const loginPhase = phases.find(p => p.id === "login");
        const migrationPhase = phases.find(p => p.id === "migration");
        const dbupPhase = phases.find(p => p.id === "dbup");
        const deployPhase = phases.find(p => p.id === "custom_action");
        const rollbackPhase = phases.find(p => p.id === "rollback");
        const azurePhase = phases.find(p => p.id === "azure_env");

        let md = `## Forensic Analysis: ${product} Installation Failure\n\n`;
        md += `**Log source:** \`${fileName}\` (${lines.length} lines)\n`;
        if (base.date) md += `**Install start:** ${base.date}${base.startTime ? ` ${base.startTime}` : ""}\n`;
        if (rollbackPhase || returnCode) {
            md += `**Install end / return:** ${returnCode || "1603"}${returnCode === "1603" ? " (fatal error — installation rolled back)" : ""}\n`;
        }
        md += `\n### Environment\n`;
        if (machine) md += `- Server: ${machine}\n`;
        if (sqlTarget) md += `- SQL target: \`${sqlTarget}\`\n`;
        if (azureSql) md += `- **Azure SQL Database** detected in log (host contains \`.database.windows.net\`)\n`;
        if (azurePhase) md += `- Evidence: Line ${azurePhase.lineNum} — ${truncateLogLine(azurePhase.window.text.split('\n')[0], 200)}\n`;

        md += `\n### Chronological triage\n\n`;
        md += `| Time | Line | Event |\n|---|---|---|\n`;
        phases.forEach(phase => {
            const sample = truncateLogLine(phase.window.text.split('\n').find(l => /\b(SqlException|ALTER DATABASE|Cannot open|Upgrade failed|Location Service|returning 1603|SQL Azure)\b/i.test(l)) || phase.window.text.split('\n')[0], 220);
            md += `| ${formatInstallerTime(phase.timestamp) || "—"} | ${phase.lineNum} | ${phase.title}: ${sample} |\n`;
        });

        md += `\n### Propagation path\n\n`;
        const chain = [];
        phases.forEach(phase => {
            chain.push(`**Line ${phase.lineNum}**${phase.timestamp ? ` (${formatInstallerTime(phase.timestamp)})` : ""}: ${phase.title}`);
        });
        md += chain.join("\n → ") + "\n";

        md += `\n### Root cause vs symptom\n\n`;
        md += `| Evidence | Role |\n|---|---|\n`;
        if (loginPhase) {
            md += `| Line ${loginPhase.lineNum}: Cannot open database / login failed | **Symptom / prerequisite** — installer continued after this in the log |\n`;
        }
        if (migrationPhase) {
            md += `| Line ${migrationPhase.lineNum}: migration script execution | Context — database deployment started |\n`;
        }
        if (alterPhase) {
            const errNum = extractSqlErrorNumber(alterPhase.window.text);
            md += `| Line ${alterPhase.lineNum}: \`ALTER DATABASE statement is not supported\`${errNum ? ` (SQL error ${errNum})` : ""} | **Root cause (aborting)** — migration SQL failed |\n`;
        }
        if (dbupPhase) {
            md += `| Line ${dbupPhase.lineNum}: DbUp upgrade failure | **Fatal propagation** — upgrade engine aborted |\n`;
        }
        if (deployPhase) {
            md += `| Line ${deployPhase.lineNum}: Location Service database deployment error | **Fatal custom action** |\n`;
        }
        if (rollbackPhase || returnCode) {
            md += `| Return ${returnCode || "1603"} / MSI rollback | **FATAL TRIGGER** - Check the CustomAction immediately preceding this |\n`;
        }

        md += `\n### Root cause verdict\n\n`;
        if (alterPhase) {
            const msg = sqlFacts.find(f => /ALTER DATABASE/i.test(f.text))?.text || "ALTER DATABASE statement is not supported";
            md += `> **ROOT CAUSE:** \`System.Data.SqlClient.SqlException\` at **Line ${alterPhase.lineNum}** — ${truncateLogLine(msg.replace(/^.*SqlException[^:]*:\s*/i, ""), 200)}\n\n`;
            if (azureSql) {
                md += `The log shows the database target is **Azure SQL Database**. The migration script runs \`SET RECOVERY SIMPLE\` / \`ALTER DATABASE\` logic that **Azure SQL does not support** (see Lines ${alterPhase.lineNum}–${(alterPhase.window.end)}). DbUp and the Location Service deployment custom action then fail, and the installer returns **${returnCode || "1603"}**.\n`;
            } else {
                md += `The Location Service database migration hit an unsupported \`ALTER DATABASE\` operation (Lines ${alterPhase.window.start}–${alterPhase.window.end}). The deployment custom action could not complete, and the installer aborted.\n`;
            }
        } else if (deployPhase || dbupPhase) {
            const p = deployPhase || dbupPhase;
            md += `> **ROOT CAUSE:** Database deployment failure at **Line ${p.lineNum}** — see phase excerpt in evidence below.\n`;
        } else if (loginPhase) {
            md += `> **ROOT CAUSE:** SQL login/database access failure at **Line ${loginPhase.lineNum}** — \`Cannot open database\` / login failed for the target database.\n`;
        } else {
            md += `> **ROOT CAUSE:** See highest-signal phase at Line ${phases[phases.length - 1]?.lineNum || "?"} — validate excerpts below.\n`;
        }

        if (loginPhase && alterPhase) {
            md += `\n**Note:** The login error at Line ${loginPhase.lineNum} occurred **before** migration failed, but later MSI actions continued; treat it as a **separate prerequisite** (missing DB or permissions) unless the log shows setup stopped there.\n`;
        }

        md += `\n### Recommendations\n\n`;
        if (alterPhase && azureSql) {
            md += `1. Deploy Location Service database to **supported SQL Server** (on-premises or VM), not Azure SQL, **or** use a XSight build whose migration script skips / conditionalizes \`ALTER DATABASE … SET RECOVERY SIMPLE\` for Azure.\n`;
        } else if (alterPhase) {
            md += `1. Review the migration script at the path cited in the log; remove or guard unsupported \`ALTER DATABASE\` statements for your SQL edition.\n`;
        }
        if (loginPhase) {
            const loginLine = loginPhase.window.text.match(/Cannot open database\s+"([^"]+)"/i);
            const userLine = loginPhase.window.text.match(/Login failed for user\s+'([^']+)'/i);
            md += `2. Ensure database ${loginLine ? `"${loginLine[1]}"` : "(target)"} exists and login ${userLine ? `'${userLine[1]}'` : ""} has **db_owner** (or required) rights if the installer expects an existing DB.\n`;
        }
        md += `3. Re-run setup after SQL target is corrected; collect a fresh verbose MSI log if failure persists.\n`;

        md += `\n### Evidence excerpts (parser-selected)\n\n`;
        phases.forEach(phase => {
            md += `**${phase.title}** — Lines ${phase.window.start}-${phase.window.end}\n\`\`\`text\n${phase.window.text}\n\`\`\`\n\n`;
        });

        sections.push(md);
    }

    return sections.join("\n\n---\n\n");
}

const LOG_PATTERN_CHECKS = [
    { label: 'Azure SQL endpoint', regex: /\.database\.windows\.net\b/gi },
    { label: 'SqlException', regex: /\bSystem\.Data\.SqlClient\.SqlException\b/gi },
    { label: 'ALTER DATABASE not supported', regex: /\bALTER DATABASE statement is not supported\b/gi },
    { label: 'SET RECOVERY SIMPLE', regex: /\bSetting Recovery mode to SIMPLE\b/gi },
    { label: 'Cannot open database', regex: /\bCannot open database\b/gi },
    { label: 'Login failed', regex: /\bLogin failed\b/gi },
    { label: 'Location Service DB deployment failed', regex: /\bLocation Service database deployment\b/gi },
    { label: 'DbUp upgrade failed', regex: /\bUpgrade failed due to an unexpected exception\b/gi },
    { label: 'MSI return 1603', regex: /\bMainEngineThread is returning 1603\b/gi },
    { label: 'MSI Return value 3', regex: /\bReturn value 3\b/gi },
    { label: 'CustomAction failure', regex: /\bCustomAction\b.*\b(returned actual error code|failed)\b/gi },
    { label: 'FQDN / URI validation error', regex: /\bFQDN\b.*\b(incorrect|invalid|expected)\b|\bvalid URI string is expected\b/gi },
    { label: 'Certificate / TLS issue', regex: /\b(certificate|TLS|SSL|handshake|X509)\b.*\b(failed|error|expired|invalid|rejected)\b/gi },
    { label: 'Connection refused / timeout', regex: /\b(connection refused|timed out|timeout expired|ECONNREFUSED|ETIMEDOUT)\b/gi }
];

async function buildLogPatternProfile(logs) {
    if (!logs || logs.length === 0) return "";
    let report = `\n\n=== LOG PATTERN & KEYWORD PROFILE ===\n`;
    report += `Whole-file scan using signal rules, keyword patterns, and normalized failure signatures (not line-by-line narration).\n`;

    for (const log of logs) {
        const fileName = log.name || "Attached log";
        const content = log.content || "";
        const lines = log.lines || (content ? content.split('\n') : []);
        const categoryCounts = {};
        const signatureMap = new Map();
        const keywordTotals = {};
        const exceptionTypes = new Set();
        const patternCounts = {};
        LOG_PATTERN_CHECKS.forEach(c => patternCounts[c.label] = 0);
        let returnCode = "";

        await precomputeLogIntel(log);
        const { prefilteredIndices, intelCache, signatureCache } = log.precomputedIntel;

        for (let i = 0; i < prefilteredIndices.length; i++) {
            if (i % 2000 === 0 && i > 0) {
                await yieldIfNeeded();
            }
            const idx = prefilteredIndices[i];
            const line = lines[idx];

            for (const check of LOG_PATTERN_CHECKS) {
                const hits = line.match(check.regex);
                if (hits) patternCounts[check.label] += hits.length;
            }
            if (!returnCode) {
                const rc = line.match(/\bMainEngineThread is returning\s+(1603|\d{3,5})\b/i);
                if (rc) returnCode = rc[1];
            }

            const intel = intelCache[idx];
            intel.categories.forEach(cat => { categoryCounts[cat] = (categoryCounts[cat] || 0) + 1; });
            intel.keywordHits.forEach(hit => {
                keywordTotals[hit.label] = (keywordTotals[hit.label] || 0) + 1;
            });
            intel.exceptionClasses.forEach(ex => exceptionTypes.add(ex));
            if (!intel.isForensic || intel.hasStackFrame) continue;
            
            const sig = signatureCache[idx];
            if (!sig || sig.length < 14) continue;
            
            const existing = signatureMap.get(sig) || { count: 0, categories: new Set(), sample: truncateLogLine(line.trim(), 200) };
            existing.count++;
            intel.categories.forEach(c => existing.categories.add(c));
            signatureMap.set(sig, existing);
        }

        report += `\n## ${fileName} (${lines.length} lines)\n`;
        report += `Product/context: ${inferProductFromLogName(fileName, content) || "Unknown"}\n`;
        const sqlTarget = extractSqlTarget(content);
        if (sqlTarget) report += `SQL target pattern: ${sqlTarget}\n`;
        const machine = extractMachineName(content);
        if (machine) report += `Server/host pattern: ${machine}\n`;
        if (returnCode) report += `MSI return code pattern: ${returnCode}\n`;

        report += `\n### Pattern detection\n`;
        LOG_PATTERN_CHECKS.forEach(check => {
            const count = patternCounts[check.label];
            report += count > 0
                ? `- ${check.label}: **detected** (${count} match(es))\n`
                : `- ${check.label}: not detected\n`;
        });

        const cats = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);
        if (cats.length) {
            report += `\n### Signal category counts\n`;
            cats.forEach(([cat, n]) => { report += `- ${cat}: ${n}\n`; });
        }

        const kws = Object.entries(keywordTotals).sort((a, b) => b[1] - a[1]);
        if (kws.length) {
            report += `\n### Keyword hit totals\n`;
            kws.slice(0, 12).forEach(([label, n]) => { report += `- ${label}: ${n}\n`; });
        }

        if (exceptionTypes.size) {
            report += `\n### Exception types\n`;
            [...exceptionTypes].slice(0, 15).forEach(ex => { report += `- ${ex}\n`; });
        }

        const topSigs = [...signatureMap.entries()]
            .map(([sig, d]) => ({ sig, ...d, categories: [...d.categories] }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 18);
        if (topSigs.length) {
            report += `\n### Top failure signatures (normalized)\n`;
            topSigs.forEach((s, i) => {
                report += `${i + 1}. [×${s.count}] ${s.sig}\n`;
                report += `   Categories: ${s.categories.join(', ') || '—'} | Sample: ${s.sample}\n`;
            });
        }
    }

    report += `\n### Pattern-combination hints (for AI)\n`;
    report += `- Azure SQL + ALTER DATABASE + RECOVERY SIMPLE → migration script incompatible with Azure SQL.\n`;
    report += `- Cannot open database / login failed → permissions or missing DB (often prerequisite).\n`;
    report += `- Location Service deployment + SqlException → XSight DB migration failure.\n`;
    report += `- MSI 1603 or Return value 3 indicates a FATAL CustomAction failure.\n`;
    report += `- Ignore MSI noise: MSIHANDLE, System Restore, Note: 1: 1402, unless no SQL patterns exist.\n`;
    report += `=== END LOG PATTERN & KEYWORD PROFILE ===\n`;
    return report;
}

async function buildInstallerPatternSummary(logs) {
    if (!logs || logs.length === 0) return "";
    let combinedHeader = "";
    let returnCode = "";
    const patternCounts = {};
    LOG_PATTERN_CHECKS.forEach(c => patternCounts[c.label] = 0);

    for (const log of logs) {
        const content = log.content || "";
        combinedHeader += content.slice(0, 100000) + "\n";
        const lines = log.lines || (content ? content.split('\n') : []);
        await precomputeLogIntel(log);
        const { prefilteredIndices } = log.precomputedIntel;

        for (let i = 0; i < prefilteredIndices.length; i++) {
            if (i % 2000 === 0 && i > 0) await yieldIfNeeded();
            const idx = prefilteredIndices[i];
            const line = lines[idx];

            for (const check of LOG_PATTERN_CHECKS) {
                const hits = line.match(check.regex);
                if (hits) patternCounts[check.label] += hits.length;
            }
            if (!returnCode) {
                const rc = line.match(/\bMainEngineThread is returning\s+(1603|\d{3,5})\b/i);
                if (rc) returnCode = rc[1];
            }
        }
    }

    if (!/\b(SetupSOTI|MSI|Windows Installer|CustomAction|Return 1603|Deploy[A-Za-z]*Database|DbUp)\b/i.test(combinedHeader)) return "";

    const product = logs.map(l => inferProductFromLogName(l.name || "", l.content || "")).find(Boolean) || "SOTI installer";
    const sqlTarget = extractSqlTarget(combinedHeader);
    const azureSql = /\.database\.windows\.net\b/i.test(sqlTarget || combinedHeader);

    let report = `\n\n=== INSTALLER PATTERN SUMMARY ===\n`;
    report += `Product: ${product}${returnCode ? ` | MSI return: ${returnCode}` : ""}\n`;
    if (sqlTarget) report += `SQL target: ${sqlTarget}${azureSql ? " (Azure SQL)" : ""}\n`;

    const detected = LOG_PATTERN_CHECKS
        .map(c => ({ label: c.label, count: patternCounts[c.label] }))
        .filter(x => x.count > 0)
        .sort((a, b) => b.count - a.count);

    report += `\nActive installer failure patterns:\n`;
    detected.forEach(p => { report += `- ${p.label} (${p.count}×)\n`; });

    if (azureSql && detected.some(p => /ALTER DATABASE/i.test(p.label))) {
        report += `\nLikely root-cause pattern: Azure SQL host + unsupported ALTER DATABASE / RECOVERY SIMPLE during Location Service migration.\n`;
    } else if (detected.some(p => /SqlException|ALTER DATABASE/i.test(p.label))) {
        report += `\nLikely root-cause pattern: SQL migration/deployment failure during installer custom action.\n`;
    }
    report += `=== END INSTALLER PATTERN SUMMARY ===\n`;
    return report;
}

async function buildMandatoryForensicChecklist(logs) {
    if (!logs || logs.length === 0) return "";
    const lines = [];
    for (const log of logs) {
        const fileName = log.name || "Attached log";
        const content = log.content || "";
        const fileLines = log.lines || (content ? content.split('\n') : []);
        await precomputeLogIntel(log);
        
        const phases = await extractFailurePhases(fileLines, log);
        const sqlTarget = extractSqlTarget(content);
        const returnMatch = content.slice(0, 150000).match(/\bMainEngineThread is returning\s+(1603|\d{3,5})\b/i);
        const azureSql = /\.database\.windows\.net\b/i.test(sqlTarget || content);

        const { prefilteredIndices } = log.precomputedIntel;
        const loginLines = [];
        let alterLine = -1;

        for (let i = 0; i < prefilteredIndices.length; i++) {
            const idx = prefilteredIndices[i];
            const l = fileLines[idx] || "";
            if (/\bCannot open database\b/i.test(l) && loginLines.length < 2) {
                loginLines.push({ l, i: idx });
            }
            if (alterLine === -1 && /\bALTER DATABASE statement is not supported\b/i.test(l)) {
                alterLine = idx;
            }
        }

        lines.push(`FILE: ${fileName} — ${fileLines.length} lines scanned`);
        if (sqlTarget) lines.push(`- SQL target: ${sqlTarget}${azureSql ? " (Azure SQL)" : ""}`);
        if (returnMatch) lines.push(`- MSI fatal return: ${returnMatch[1]} at end of install (CRITICAL: find the preceding CustomAction error)`);
        phases.forEach(p => lines.push(`- MUST cite Line ${p.lineNum}: ${p.title}`));
        if (alterLine >= 0) {
            lines.push(`- MUST cite Line ${alterLine + 1}: SqlException — ALTER DATABASE not supported (installer runs SET RECOVERY SIMPLE; unsupported on Azure SQL)`);
        }
        loginLines.forEach(x => {
            const db = (x.l.match(/Cannot open database\s+"([^"]+)"/i) || [])[1];
            lines.push(`- Prerequisite at Line ${x.i + 1}: Cannot open database${db ? ` "${db}"` : ""} / login failed (symptom unless install stopped here)`);
        });
    }

    lines.push("");
    lines.push("REQUIRED: SqlException + ALTER DATABASE + Location Service deployment + Azure SQL host if present in log.");

    return `\n=== MANDATORY FACTS (full-file scan — address every line above) ===\n${lines.join("\n")}\n=== END MANDATORY FACTS ===\n`;
}

// One line per attached file so the model always knows every file that exists,
// even if a file's snippet had to be trimmed to fit the context window.
async function buildFileManifest(logs, lastSentAt = 0) {
    if (!logs || logs.length === 0) return "";
    const rows = [];
    const newFiles = [];
    for (let i = 0; i < logs.length; i++) {
        const log = logs[i];
        const isNew = lastSentAt && log.uploadedAt && log.uploadedAt > lastSentAt;
        if (isNew) newFiles.push(log.name);
        let detail = "";
        try {
            const intel = await getLogPanelIntel(log);
            if (intel) {
                const signals = [intel.topCategory, intel.topException].filter(Boolean).join(', ');
                detail = ` — ${intel.lineCount.toLocaleString()} lines` +
                         (intel.product ? ` | Product: ${intel.product}` : "") +
                         (signals ? ` | Top signals: ${signals}` : " | No error signals detected");
            }
        } catch (e) {
            detail = ` — ${(log.lines || []).length.toLocaleString()} lines`;
        }
        rows.push(`${i + 1}. ${log.name}${detail}${isNew ? '  [NEW — ADDED SINCE LAST MESSAGE]' : ''}`);
    }
    let manifest = "";
    if (newFiles.length > 0) {
        manifest += `\n[NEW FILES ADDED SINCE LAST MESSAGE: ${newFiles.join(', ')} — prioritize acknowledging and analysing these]\n`;
    }
    manifest += `\n=== ATTACHED FILE MANIFEST (${logs.length} file${logs.length === 1 ? '' : 's'}) ===\n` +
                rows.join('\n') +
                `\nRULE: Every file listed above EXISTS and MUST be acknowledged in your analysis. If a file's snippet was truncated, state that instead of ignoring the file.\n` +
                `=== END FILE MANIFEST ===\n`;
    return manifest;
}

// The number of CHARS the model's context window can hold for the prompt (excluding the
// reserved output budget). Single source of truth for sizing the whole prompt.
// On a CPU the PROMPT (prefill) is the dominant cost: ~23 tok/s means every 1,000 prompt
// tokens ≈ 43 s of waiting before the model even starts answering. A 6,000-token prompt is a
// ~4.5-minute prefill — long enough that the browser drops the still-pending fetch ("Failed to
// fetch"). So for small/CPU models we BUDGET the prompt against a much smaller window than the
// model's num_ctx: num_ctx stays at the session size (8K — keeps the model warm and leaves
// generous output room), but we only FILL ~4K tokens of prompt. The Log-Intelligence pre-analysis
// (manifest + incident index) keeps the high-signal evidence even at this smaller size, so the
// answer quality holds while the analysis goes from ~5 minutes to ~2.
const SMALL_PROMPT_BUDGET_CTX = 6144;
async function getPromptCharBudget() {
    if (!LOCAL_AI_MODEL) return Math.floor(650000 * 2.5); // cloud path (legacy generous budget)
    const { hardMax } = await getHardCtxMax(LOCAL_AI_MODEL);
    const small = isSmallLocalModel();
    // 'auto': small/CPU models budget against ~4K (fast prefill); larger models 32K.
    // An explicit Context Size setting is honoured as the target directly.
    const target = (LOCAL_AI_CTX_MAX && LOCAL_AI_CTX_MAX !== 'auto')
        ? hardMax
        : (small ? Math.min(SMALL_PROMPT_BUDGET_CTX, hardMax) : Math.min(32768, hardMax));
    const numPredict = small ? 1024 : 4096;
    const CHARS_PER_TOKEN = 2.5; // measured: gemma tokenizes log text at ~2.55 chars/token
    return Math.floor((target - numPredict - 600) * CHARS_PER_TOKEN);
}

// Char budget left for LOG SNIPPETS after everything else (system prompt, case data,
// manifest/profile/incident, history) is accounted for. This is what stops the case
// info / email chain from pushing the logs out of the context window.
async function computeSnippetBudget(numFiles, overheadChars = 0) {
    if (!LOCAL_AI_MODEL) return 650000;
    const small = isSmallLocalModel();
    const total = await getPromptCharBudget();
    const budget = total - Math.max(0, overheadChars);
    // Floor keeps every file represented even when overhead is large; allocatePerFileBudgets
    // splits evenly if the budget can't meet the floor (the manifest still names them all),
    // and completions.create trims the secondary case/research data — never the logs.
    const floor = (small ? 1000 : 3000) * Math.max(1, numFiles);
    return Math.max(floor, budget);
}

// Compact the case object for the prompt. Large/GPU models get the full case; small/CPU
// models keep the high-value fields but cap the bulky free-text (meeting notes) so the
// actual log evidence still fits the small context window.
// email_chain is intentionally EXCLUDED here — it is the live state of the case, so it is
// surfaced separately as a dedicated, prominent, plain-text [EMAIL CHAIN] section (see
// buildEmailChainSection) instead of being buried and JSON-escaped inside this blob.
function buildCaseContextForPrompt(ci, small) {
    if (!ci) return {};
    if (!small) {
        const { email_chain, ...rest } = ci;
        return rest;
    }
    const out = {};
    for (const k of ['case_number', 'product', 'soti_version', 'platform', 'agent_version', 'case_age_days', 'issue_summary']) {
        if (ci[k]) out[k] = ci[k];
    }
    const mn = ci.meeting_notes;
    if (typeof mn === 'string' && mn.trim()) {
        out.meeting_notes = mn.length > 1500 ? mn.slice(0, 1500) + ' …[trimmed for context budget]' : mn;
    }
    return out;
}

// ============================ EMAIL CHAIN → PROMPT ============================
// A raw Salesforce email-chain scrape is ~70–90% boilerplate: every reply quotes the ENTIRE
// previous email ("From: … Sent: … Subject: …" tails that duplicate messages which already
// have their own feed entries), plus signature icon links, legal disclaimers, Proofpoint
// external-sender banners and tracking-wrapped URLs. Under the small-model context cap that
// noise used to consume the whole email budget and silently truncate the OLDER HALF of the
// correspondence — the model then invented a timeline for messages it never saw. These
// helpers strip ONLY provable boilerplate so the ENTIRE chain (every actual message) fits.

// Name variants used to find the sender's own signature block ("Donaldson, Geoffrey" signs
// as "Geoffrey Donaldson"). Short names are excluded — too likely to appear in real prose.
function senderNameVariants(sender) {
    const s = (sender || '').trim();
    if (!s) return [];
    const v = [s];
    const m = s.match(/^([^,]+),\s*(.+)$/);
    if (m) v.push(`${m[2].trim()} ${m[1].trim()}`);
    return v.filter(x => x.length >= 8);
}

// Strip boilerplate from ONE message body. cutReplyTail is true only when each message is
// its own feed entry (scraper format) — there the quoted "From:… Sent:…" tail duplicates a
// message that already exists elsewhere in the chain, so cutting it loses nothing.
function cleanEmailBody(body, sender, cutReplyTail) {
    let t = String(body || '');
    if (cutReplyTail) {
        const tail = t.search(/(?:^|[\n\s])(?:-{3,}\s*Original Message\s*-{3,}|From:\s?[^\n]{0,160}?\bSent:\s)/i);
        if (tail > 10) t = t.slice(0, tail); // only cut when a real body precedes the tail
    }
    // Proofpoint / mail-scanner banners and external-sender warnings
    t = t.replace(/ZjQcmQRYFpfptBannerStart[\s\S]*?ZjQcmQRYFpfptBannerEnd/gi, ' ');
    t = t.replace(/ZjQcmQRYFpfptBanner(?:Start|End)/gi, ' ');
    t = t.replace(/\*{2,}\s*EXTERNAL EMAIL[^*]{0,300}\*{2,}/gi, ' ');
    t = t.replace(/External Sender\s+This message came from outside (?:our|the) organization\.?\s*(?:Please use caution before acting on the message\.?)?/gi, ' ');
    // Inline images: signature icons (marker followed by a link) are noise; a standalone
    // marker is a real attachment (e.g. a screenshot) and is kept as a short note.
    t = t.replace(/\[Inline image name:[^\]]*\]\s*<https?:\/\/[^>]*>/gi, ' ');
    t = t.replace(/\[Inline image name:\s*([^\]]*)\]/gi, '[image attached: $1]');
    // Link wrappers and tracking-rewritten URLs
    t = t.replace(/<(?:https?|mailto|tel):[^>]*>/gi, ' ');
    t = t.replace(/https?:\/\/urldefense[^\s>]+/gi, ' ');
    // Legal disclaimers and footer link bars
    t = t.replace(/IMPORTANT NOTICE:[\s\S]*?related thereto\.?/gi, ' ');
    t = t.replace(/IMPORTANT NOTICE:\s*This email is bound by SOTI[\s\S]*$/i, ' '); // truncated variant
    t = t.replace(/-\s*CONFIDENTIAL\s*-[\s\S]*?delete this email\.?/gi, ' ');
    t = t.replace(/\bBook\s+a\s+meeting\s+with\s+\w+\b/gi, ' ');
    // (SOTI.net needs the lookbehind so it never matches inside a real URL like pulse.soti.net)
    t = t.replace(/\bCall\s+Us\b|(?<![./\w-])SOTI\.\s?net\b|\bDiscussion\s+Forum\b|\bLog\s+a\s+Case\s+Online\b|\bGet\s+Outlook\s+for\s+iOS\b/gi, ' ');
    t = t.replace(/[ \t]{2,}/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    // Greeting + pleasantry openers carry zero case signal but cost real context space
    // across a long chain ("Hi Tom,I hope you are doing well. ..." ≈ 35 chars × N messages).
    t = t.replace(/^(?:Hi|Hello|Dear)(?:\s+@?[A-Za-z][\w.'-]*(?:\s+[A-Z][\w.'-]*)?)?\s*,\s*/, '');
    t = t.replace(/\b(?:I hope you are doing well\.?|I hope you are well\.?|Hope you are doing (?:good|well)\.?|I hope you are too\.?|Greetings of the day,?)\s*/gi, ' ');
    t = t.replace(/[ \t]{2,}/g, ' ').trim();
    // Signature block: everything from the sender's OWN full name onward — but only when what
    // follows the name actually looks like a signature (title/contact details) or the name
    // sits at the very end. Signatures always follow the real content, never precede it, so
    // the LAST occurrence is used (the name can legitimately appear mid-body, e.g. in a
    // "Book time with <name>" line).
    for (const name of senderNameVariants(sender)) {
        const idx = t.toLowerCase().lastIndexOf(name.toLowerCase());
        if (idx <= 40) continue;
        const after = t.slice(idx + name.length, idx + name.length + 220);
        const sigLike = /(?:@|\bspecialist\b|\bengineer\b|\bsupport\b|\btechnical\b|\bmanager\b|\bconsultant\b|\banalyst\b|\d{3}[-.\s]?\d{3,4}|\bave\b|\bstreet\b|\bsuite\b|\bblvd\b)/i.test(after);
        if (sigLike || idx >= t.length * 0.75) { t = t.slice(0, idx).trim(); break; }
    }
    // Drop a now-dangling closer ("Warm regards," with the name stripped after it)
    const closerStripped = t.replace(/(?:warm regards|kind regards|best regards|regards|thanks|thank you|sincerely|cheers)[\s,!.]*$/i, '').trim();
    if (closerStripped.length >= 20) t = closerStripped;
    return t.trim();
}

// Split a raw chain into ordered entries {header, sender, body}. Handles the scraper format
// ("[time] [TYPE] Sender:\nbody" joined by ==== separators), the fallback scrape (bodies
// only), and a manually pasted Outlook-style thread (split at each "From:… Sent:…" header,
// so older quoted messages become entries instead of being cut away).
function parseEmailChainEntries(raw) {
    const HEADER_RE = /^\s*\[([^\][]{4,80})\]\s*(\[[A-Z][A-Z ]{2,20}\]\s*)?([^:\n]{1,80}):\s?/;
    const parts = raw.split(/\n?={20,}\n?/).map(p => p.trim()).filter(Boolean);
    if (parts.length === 1 && !HEADER_RE.test(parts[0])) {
        // Single pasted blob: split into messages at quoted-reply headers (Outlook style,
        // newest first — same order as the scraper) instead of treating them as one body.
        const pieces = parts[0].split(/(?=(?:^|\n)From:\s?[^\n]{0,160}?\bSent:\s)/).map(p => p.trim()).filter(Boolean);
        if (pieces.length > 1) {
            return pieces.map(p => {
                const m = p.match(/^From:\s?([^\n<]{1,80}?)\s*(?:<|\bSent:|\n|$)/);
                const sm = p.match(/\bSent:\s?([^\n]{4,60}?)(?=\s+To:|\s+Subject:|\n|$)/);
                return { time: sm ? sm[1].trim() : '', type: '', sender: m ? m[1].trim() : '', body: p };
            });
        }
    }
    return parts.map(p => {
        const m = p.match(HEADER_RE);
        if (!m) return { time: '', type: '', sender: '', body: p };
        return {
            time: m[1].trim(),
            type: (m[2] || '').trim(),
            sender: m[3].trim(),
            body: p.slice(m[0].length)
        };
    });
}

// The email correspondence is the LIVE state of the case and must drive "what's next" /
// "current status" answers. It is scraped NEWEST-FIRST (the first entry is the most recent
// message). Every entry is cleaned of boilerplate and numbered ("Message i of N") with
// explicit NEWEST/OLDEST tags, so the WHOLE chain fits the prompt and ordering questions
// ("what was the first email?") are unambiguous. If a cleaned chain still exceeds the cap,
// the OLDEST entries are compacted to one-line gists — never silently dropped.
function buildEmailChainSection(ci, small) {
    const raw = ((ci && ci.email_chain) || '').trim();
    if (!raw) return '';
    const cap = small ? 6000 : 16000;
    const scraperFormat = /={20,}/.test(raw) || /^\s*\[[^\][]{4,80}\]\s*(\[[A-Z][A-Z ]{2,20}\]\s*)?[^:\n]{1,80}:/.test(raw);
    const entries = parseEmailChainEntries(raw)
        .map(e => ({ ...e, body: cleanEmailBody(e.body, e.sender, scraperFormat) }))
        .filter(e => e.body || e.sender || e.time);
    const n = entries.length;
    if (!n) return '';
    const posTag = (i) => i === 0 ? ' (NEWEST — the most recent message; the CURRENT state of the case)'
        : i === n - 1 ? ' (OLDEST — the FIRST message/email of the case)' : '';
    // Labeled metadata in every marker ("Sent:"/"From:") so the model can cite each
    // message's OWN date and author and never confuses them with the current date. Markers
    // are kept LEAN ("of N" only on the first/last) — on a 20+ message chain the marker
    // overhead alone is what used to force lossy compaction of complete messages.
    const marker = (e, i) => `Message ${i + 1}${(i === 0 || i === n - 1) ? ` of ${n}` : ''}${posTag(i)}` +
        `${e.time ? ` | Sent: ${e.time}` : ''}${e.sender ? ` | From: ${e.sender}` : ''}${e.type ? ` | ${e.type}` : ''}:`;
    // Compacted gist: never lose URLs or key identifiers to the cut — matched against the
    // FULL text (the cut can land mid-URL, leaving an unmatchable fragment in the tail),
    // then any reference not fully inside the kept head is appended.
    const gistOf = (body, max) => {
        const flat = body.replace(/\s+/g, ' ').trim();
        if (flat.length <= max) return flat;
        const head = flat.slice(0, max);
        const keep = ((flat.match(/https?:\/\/[^\s<>()]+/g) || []).concat(
            flat.match(/\b(?:Registration Code|Instance ID|Serial(?:\s+Numbers?)?|Case(?:\s+numbers?)?|Error(?:\s+codes?)?)\s*:?\s*[A-Za-z0-9][A-Za-z0-9-]{3,}/gi) || []
        )).filter(k => !head.includes(k));
        return head + '…' + (keep.length ? ` [also: ${keep.slice(0, 3).join(' | ')}]` : '');
    };
    const lines = entries.map((e, i) => `${marker(e, i)}\n${e.body}`);
    let total = lines.reduce((a, l) => a + l.length + 2, 0);
    // Compact OLDEST-first (keep the two newest whole) until the chain fits the cap.
    for (let i = n - 1; i >= 2 && total > cap; i--) {
        const compact = `${marker(entries[i], i)} ${gistOf(entries[i].body, 160)}`;
        // The preserved-references append can make a "gist" LONGER than the original
        // (short body, long URL) — only take the swap when it actually shrinks the line.
        if (compact.length >= lines[i].length) continue;
        total -= (lines[i].length - compact.length);
        lines[i] = compact;
    }
    let chain = lines.join('\n\n');
    if (chain.length > cap) {
        // Even when the cap forces a cut, the model is told exactly how many older messages
        // were dropped and where the case began — it never mistakes the cut for the start.
        const oldest = entries[n - 1];
        const noteFor = (kept) => `\n\n…[context cap reached — the ${kept} NEWEST messages are shown above; ${n - kept} older ones are omitted. The case began with Message ${n}${oldest.time ? ` sent ${oldest.time}` : ''}${oldest.sender ? ` from ${oldest.sender}` : ''}.]`;
        const body = chain.slice(0, Math.max(0, cap - noteFor(n).length - 8)).trimEnd();
        chain = body + noteFor((body.match(/(?:^|\n)Message \d+/g) || []).length);
    }
    return `[EMAIL CHAIN — the live support correspondence for this case: ${n} message${n === 1 ? '' : 's'}, ordered NEWEST FIRST. "Message 1 of ${n}" is the MOST RECENT message and reflects the CURRENT state of the case; "Message ${n} of ${n}" is the OLDEST — the very first message/email of the case. Boilerplate (signatures, legal disclaimers, quoted duplicates of earlier emails) has been stripped; every actual message in the case is present below, each tagged with its OWN "Sent:" date and "From:" author. The "Message i of N" numbers are INTERNAL markers for YOUR orientation only — NEVER write "Message 5" or "(Message 5)" in your answer; refer to a message naturally by its author and Sent date instead (e.g. "in his email of 6 July 2026, Geoffrey reported…"). This is the source of truth for the current status and for what to do next; it SUPERSEDES [ISSUE SUMMARY], which is only the ORIGINAL reported problem and may already be resolved or moved past by later emails.]\n${chain}`;
}

// Fair-share allocation: small files take only what they need and donate the surplus
// to larger files. Every file is guaranteed a minimum slice so none ever vanishes.
function allocatePerFileBudgets(logs, totalBudget, minPerFile = 4000) {
    const budgets = new Map();
    const n = logs.length;
    if (!n) return budgets;
    // If the budget can't give every file the minimum, split it evenly — the FILE
    // MANIFEST + incident index still ensure every file is acknowledged and summarized.
    if (totalBudget < n * minPerFile) {
        const even = Math.max(800, Math.floor(totalBudget / n));
        for (const l of logs) budgets.set(l, even);
        return budgets;
    }
    let pool = totalBudget;
    const share = Math.floor(pool / n);
    const large = [];
    for (const l of logs) {
        const need = (l.content || "").length + 200; // +200 head/tail markers slack
        if (need <= share) {
            budgets.set(l, need);
            pool -= need;
        } else {
            large.push(l);
        }
    }
    const totalNeed = large.reduce((a, l) => a + (l.content || "").length, 0) || 1;
    for (const l of large) {
        budgets.set(l, Math.max(minPerFile, Math.floor(pool * ((l.content || "").length / totalNeed))));
    }
    return budgets;
}

async function buildLogAnalysisContext(logs, lastSentAt = 0, externalOverhead = 0) {
    if (!logs || logs.length === 0) return "";
    // Header (manifest + profile + incident) is always included; snippets are budgeted
    // against everything else so the logs never get pushed out of the context window.
    let header = `\n\n[LOG ANALYSIS DATA — ${logs.length} file(s)]\n`;
    header += await buildFileManifest(logs, lastSentAt);
    header += await buildLogPatternProfile(logs);
    header += await buildCrossLogIncidentIndex(logs, { patternMode: false });
    const snippetBudget = await computeSnippetBudget(logs.length, externalOverhead + header.length);
    const budgets = allocatePerFileBudgets(logs, snippetBudget, isSmallLocalModel() ? 1500 : 4000);
    let ctx = header;
    for (const log of logs) {
        const content = log.content || "";
        const name = log.name || "Attached log";
        const limit = budgets.get(log) || 10000;
        ctx += `\n=== FILE: ${name} ===\n${await getSmartLogSnippet(content, limit, name, log.lines)}\n=== END FILE ===\n`;
    }
    return ctx;
}

function getLogForensicsSystemPrompt() {
    return `${TIER3_IDENTITY}

You are operating in FORENSIC REPORT mode for an MSI/setup installer log. Your goal is a highly accurate, definitive Forensic Installation Failure Report that names the EXACT failing action.

THE MSI ROOT-CAUSE METHOD (follow in this order — this is how an expert reads an MSI log):
1. Find the FIRST "Action ended ...: <Action>. Return value 3." — "Return value 3" = that action FAILED and triggered the rollback. (Return value 1 = success; Return value 2 = user cancel.)
2. Just above it, find the line "CustomAction <Name> returned actual error code 1603". That named CustomAction is THE ROOT CAUSE. Read the 5–30 lines ABOVE it to explain WHY it failed.
3. "MainEngineThread is returning 1603" is only the final summary exit code — never cite it as the root cause.

WHAT IS NOISE — you MUST ignore it as the root cause:
- A 1603 that says "but will be translated to success due to continue marking" is NON-FATAL (e.g. CheckConnectionString, WixRemoveFoldersEx). It did NOT fail the install. Never blame it.
- SQL lines such as "Cannot open database ... requested by the login", "Login failed", "EnumerateDatabaseNames" during install are usually pre-create ENUMERATION noise. Do NOT name SQL/authentication as root cause when a non-translated CustomAction 1603 precedes the rollback.
- "Closing MSIHANDLE", "Note: 1: 2265", "User/Machine policy value", and post-failure actions (XSFatalErrorDlg, CopyInstallationLog, OpenInstallFolder) are symptoms/cleanup, never the cause.

OUTPUT — a Markdown table plus a verdict:
| Signal | Meaning |
| --- | --- |
| (rows: the failing CustomAction + its 1603, the "Return value 3" line with its action and timestamp, and the key lines above showing WHY it failed) |

Then: **ROOT CAUSE:** the exact CustomAction name, its file:line and timestamp, and the precise reason from the lines above it. **FIX:** the specific remediation for that action. Quote exact names, line numbers and timestamps from the INSTALLER EVIDENCE — never invent them, and never write placeholders. Begin directly with the table — NEVER open with "Based on" or any preamble.`;
}

// Installer-forensic prompt for small/CPU-bound models. The evidence already contains the
// environment, the deterministic failing action + the WHY (root-cause) lines, and a deduplicated
// timeline — so the model reasons over a compact, high-signal brief and produces the full forensic
// report format (triage → propagation → symptom-vs-cause → recommendation) the user expects.
function getCompactInstallerForensicPrompt() {
    return `${TIER3_IDENTITY}

You are writing a Forensic Installation Failure Report for a SOTI MSI/setup log. Everything you need is
in the evidence below: the environment, a "PRIMARY ROOT CAUSE" block (the failing CustomAction + the
"WHY it failed" lines = the real cause), and a deduplicated CHRONOLOGICAL timeline. Derive the report
ONLY from that evidence.

HOW TO REASON (critical):
- The ROOT CAUSE is the deepest error in the "WHY it failed" lines — the error the failing CustomAction
  hit just before "Return value 3" (e.g. "ALTER DATABASE ... is not supported", "transaction log is full",
  a failing migration script, a constraint violation).
- The EARLIEST errors in the timeline (especially "Cannot open database ... login failed") are usually
  SYMPTOMS the installer logged but continued past — NEVER report a symptom as the root cause.
- If the environment says AZURE SQL DATABASE and the failure is "ALTER DATABASE / SET RECOVERY", the cause
  is that Azure SQL does not support that statement; recommend a supported SQL Server or a patched script.

OUTPUT FORMAT — use these exact headings. Cite ONLY real file:Line and timestamps copied from the evidence
(never invent, never write placeholders like "Line N"/"{n}"). Begin directly with the "## 🔍" heading, no preamble:

## 🔍 Forensic Analysis: <product + version> Installation Failure
**Log Source:** <file> | **Install:** <start ts> → <end ts> (Return <code>)
**Environment:** <server; SQL target; note Azure SQL if flagged>

### 1. Chronological Triage
| Timestamp | Location | Event |
| --- | --- | --- |
(4–6 rows from the CHRONOLOGICAL evidence: the first SQL/validation symptom, the migration/SQL error, the failing CustomAction's 1603, and the "Return value 3" rollback — each with its real file:Line.)

### 2. Propagation Path (domino effect)
A short numbered chain: earliest symptom → deeper error → the WHY/root-cause error → failing CustomAction → rollback (Return <code>).

### 3. Root Cause — Symptom vs. Source
| Finding | Classification |
| --- | --- |
(Mark the early SQL-login / FQDN / validation lines as **Symptom**; mark the WHY error as **ROOT CAUSE**.)

**Root Cause:** one precise sentence naming the failing CustomAction and the WHY error (with file:Line).
**Recommendation:** the specific fix for that error (supported SQL Server / patched migration script / free the transaction log / grant db_owner / etc.).`;
}

function validateForensicAIResponse(text, logs) {
    if (!text || !logs || logs.length === 0) return true;
    
    let hasAlter = false;
    let hasSql = false;
    let hasAzure = false;
    
    for (const l of logs) {
        const content = l.content || "";
        if (!hasAlter && /\bALTER DATABASE statement is not supported\b/i.test(content)) {
            hasAlter = true;
        }
        if (!hasSql && /\bSqlException\b/i.test(content)) {
            hasSql = true;
        }
        if (!hasAzure && /\.database\.windows\.net\b/i.test(content)) {
            hasAzure = true;
        }
        if (hasAlter && hasSql && hasAzure) break;
    }
    const resp = text || "";

    const badPatterns = [
        /\bMSIHANDLE\b/i,
        /\bSystem Restore sequence\b/i,
        /\b(insufficient|not enough)\s+disk\s+space\b/i,
        /\bReturn value 3\b.*\b(root cause|caused the failure|primary cause)\b/i,
        /\bSQL exception:\s*none\b/i,
        /\bno\s+SQL\s+exception\b/i,
        /\bPre-Parsed Evidence Summary\b/i,
        /\bPR\s*[123]\s*:/i
    ];
    if (badPatterns.some(rx => rx.test(resp))) return false;
    if ((hasAlter || hasSql) && !/\b(ALTER DATABASE|SqlException|5008|Recovery mode to SIMPLE|Location Service database)\b/i.test(resp)) return false;
    if (hasAzure && hasAlter && !/\.database\.windows\.net|Azure SQL/i.test(resp)) return false;
    return true;
}

function buildFocusedRawCoverage(content, lines, focusLineNums) {
    const headSize = 8000;
    const tailSize = 25000;
    let coverage = `\n\n[FOCUSED RAW LOG CONTEXT]\n`;
    coverage += `Full file is ${lines.length} lines. Head/tail plus raw windows on SQL failure lines only (not generic MSI chatter).\n`;
    coverage += `\n[LOG HEAD - first ${headSize} chars]\n${content.slice(0, headSize)}\n`;

    const unique = [...new Set(focusLineNums.filter(n => n > 0))].sort((a, b) => a - b);
    if (unique.length > 0) {
        coverage += `\n[FAILURE-ANCHORED RAW WINDOWS]\n`;
        unique.slice(0, 14).forEach((line, idx) => {
            const centerText = lines[line - 1] || "";
            const radius = /\b(ALTER DATABASE|SqlException|Upgrade failed|Location Service database deployment)\b/i.test(centerText) ? 70 : 40;
            const win = getLineWindow(lines, line, radius);
            coverage += `\n--- Window ${idx + 1}: Lines ${win.start}-${win.end} (center ${line}) ---\n${win.text}\n`;
        });
    }

    coverage += `\n[LOG TAIL - last ${tailSize} chars]\n${content.slice(-tailSize)}\n`;
    return coverage;
}

async function buildRawLogCoverage(content, lines, rankedRootCandidates, parsedBlocks, logObj = null) {
    const totalLines = lines.length;
    const headSize = 30000;
    const tailSize = 100000;

    if (content.length <= (headSize + tailSize)) {
        return `\n\n[FULL LOG CONTENT]\n${content}`;
    }

    let coverage = `\n\n[RAW LOG COVERAGE NOTE]\nThe full file is too large to place verbatim in the model context. The extension already scanned every line above; the raw context below intentionally includes HEAD, MIDDLE, TAIL, and incident-centered windows so the AI can verify evidence across the entire file.\n`;
    coverage += `\n[LOG HEAD - first ${headSize} chars]\n${content.slice(0, headSize)}\n`;

    const middleCenters = [0.25, 0.50, 0.75]
        .map(p => Math.max(1, Math.min(totalLines, Math.floor(totalLines * p))))
        .filter((line, idx, arr) => arr.indexOf(line) === idx);

    coverage += `\n[LOG MIDDLE SAMPLES - evenly spaced raw windows]\n`;
    middleCenters.forEach((center, idx) => {
        const win = getLineWindow(lines, center, 45);
        coverage += `\n--- MIDDLE SAMPLE ${idx + 1}: Lines ${win.start}-${win.end} ---\n${win.text}\n`;
    });

    const focusLines = [];
    const log = logObj || findLogObject("", content) || { lines };
    const anchors = await collectCuratedFailureAnchors(lines, "", log);
    anchors.forEach(a => focusLines.push(a.lineNum));
    
    rankedRootCandidates.slice(0, 8).forEach(c => focusLines.push(c.lineNum));
    parsedBlocks.slice(0, 8).forEach(b => focusLines.push(b.startLine));
    const uniqueFocusLines = focusLines
        .filter(Boolean)
        .sort((a, b) => a - b)
        .filter((line, idx, arr) => idx === 0 || Math.abs(line - arr[idx - 1]) > 80)
        .slice(0, 10);

    if (uniqueFocusLines.length > 0) {
        coverage += `\n[INCIDENT-CENTERED RAW WINDOWS - strongest forensic locations]\n`;
        uniqueFocusLines.forEach((line, idx) => {
            const win = getLineWindow(lines, line, 45);
            coverage += `\n--- INCIDENT WINDOW ${idx + 1}: Lines ${win.start}-${win.end} (center Line ${line}) ---\n${win.text}\n`;
        });
    }

    coverage += `\n[LOG TAIL - last ${tailSize} chars]\n${content.slice(-tailSize)}`;
    return coverage;
}

async function buildCrossLogIncidentIndex(logs, options = {}) {
    if (!logs || logs.length === 0) return "";
    const patternMode = options.patternMode !== false;

    const allEvents = [];
    const exceptionBlocks = [];
    const signatureMap = new Map();
    const categoryCounts = {};
    const signalSummary = createSignalSummary();
    const installerReport = await buildInstallerFailureAnalysis(logs);
    let totalLines = 0;
    let totalChars = 0;

    for (const log of logs) {
        const name = log.name || "Unknown log";
        const content = log.content || "";
        const lines = log.lines || (content ? content.split('\n') : []);
        totalLines += lines.length;
        totalChars += content.length;
        exceptionBlocks.push(...await extractExceptionBlocksFromLog(log));

        await precomputeLogIntel(log);
        const { prefilteredIndices, intelCache, timestampCache, signatureCache } = log.precomputedIntel;

        // Safety cap (per log): a data-export CSV can have 100k+ "forensic" rows; we only use the
        // earliest ~35 + top ~15 by score, so cap how many events we build to keep memory/CPU bounded.
        const MAX_EVENTS_PER_LOG = 6000;
        let logEventCount = 0;
        for (let i = 0; i < prefilteredIndices.length; i++) {
            if (i % 2000 === 0 && i > 0) {
                await yieldIfNeeded();
            }
            if (logEventCount >= MAX_EVENTS_PER_LOG) break;
            const idx = prefilteredIndices[i];
            const line = lines[idx];
            const intel = intelCache[idx];
            const timestamp = timestampCache[idx] || "";

            updateSignalSummary(signalSummary, intel, line, idx + 1, name);
            if (!intel.isForensic || intel.hasStackFrame) continue;

            const lineNum = idx + 1;
            const event = {
                file: name,
                lineNum,
                timestamp,
                sortTime: parseLogTimestampForSort(timestamp),
                text: line.trim(),
                categories: intel.categories,
                hasException: intel.hasException,
                severityToken: intel.severityToken,
                exceptionClasses: intel.exceptionClasses,
                keywordHits: intel.keywordHits,
                score: scoreRootCauseCandidate({
                    lineNum,
                    text: line,
                    categories: intel.categories,
                    hasException: intel.hasException,
                    keywordHits: intel.keywordHits
                })
            };

            allEvents.push(event);
            logEventCount++;
            intel.categories.forEach(cat => {
                categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
            });

            const sigKey = signatureCache[idx];
            if (sigKey && sigKey.length > 8) {
                const sig = `${name}::${sigKey}`;
                if (sig.length > name.length + 10) {
                const existing = signatureMap.get(sig) || {
                    file: name,
                    count: 0,
                    firstLine: lineNum,
                    lastLine: lineNum,
                    firstTimestamp: timestamp,
                    lastTimestamp: timestamp,
                    categories: new Set(),
                    sample: line.trim()
                };
                existing.count++;
                existing.lastLine = lineNum;
                existing.lastTimestamp = timestamp || existing.lastTimestamp;
                intel.categories.forEach(cat => existing.categories.add(cat));
                signatureMap.set(sig, existing);
            }
        }
    }
}

    const byTime = [...allEvents].sort((a, b) => {
        if (a.sortTime !== b.sortTime) return a.sortTime - b.sortTime;
        if (a.file !== b.file) return a.file.localeCompare(b.file);
        return a.lineNum - b.lineNum;
    });
    const byScore = [...allEvents].sort((a, b) => b.score - a.score || a.sortTime - b.sortTime || a.lineNum - b.lineNum);
    const earliest = byTime.slice(0, 35);
    const topRootCandidates = byScore.slice(0, 15);
    const sqlEvents = allEvents.filter(e => e.categories.includes('SQL/Database'))
        .sort((a, b) => b.score - a.score || a.sortTime - b.sortTime)
        .slice(0, 20);
    const rankedExceptionBlocks = [...exceptionBlocks]
        .sort((a, b) => b.score - a.score || a.sortTime - b.sortTime || a.startLine - b.startLine)
        .slice(0, 25);
    const sqlExceptionBlocks = exceptionBlocks
        .filter(b => b.sql)
        .sort((a, b) => b.score - a.score || a.sortTime - b.sortTime)
        .slice(0, 25);
    const largeInstallerLogs = logs.filter(l => {
        const n = l.lines ? l.lines.length : (l.content || "").split('\n').length;
        return n >= 5000 && isInstallerLogContent(l.name, l.content);
    });
    const topBlock = rankedExceptionBlocks[0] || null;
    const topSqlBlock = [...exceptionBlocks]
        .filter(b => b.sql && /\b(SqlException|ALTER DATABASE|Cannot open database|Upgrade failed)\b/i.test(`${b.message}\n${b.excerpt || ""}`))
        .sort((a, b) => b.score - a.score)[0];
    const topEvent = topRootCandidates[0] || null;
    // buildDominoAnalysis runs an ~O(n²) architect-root/propagation search, so feed it only the
    // highest-signal candidates. On a big/noisy log (tens of thousands of events) passing everything
    // was minutes of CPU (the multi-file/large-log "hang"); the top few hundred by score still
    // contain the real root and its downstream chain.
    const dominoEvents = allEvents.length > 400
        ? [...allEvents].sort((a, b) => b.score - a.score).slice(0, 400)
        : allEvents;
    const dominoBlocks = exceptionBlocks.length > 200
        ? [...exceptionBlocks].sort((a, b) => b.score - a.score).slice(0, 200)
        : exceptionBlocks;
    const domino = buildDominoAnalysis(dominoEvents, dominoBlocks);
    const preferSqlBlock = largeInstallerLogs.length === logs.length && topSqlBlock;
    const deterministicRoot = preferSqlBlock ? {
            source: "parsed SQL/installer block",
            file: topSqlBlock.file,
            line: `${topSqlBlock.startLine}-${topSqlBlock.endLine}`,
            timestamp: topSqlBlock.timestamp,
            score: topSqlBlock.score,
            categories: topSqlBlock.categories,
            text: topSqlBlock.message,
            innermost: topSqlBlock.innermostException,
            sql: topSqlBlock.sql,
            component: detectComponent(topSqlBlock.file, topSqlBlock.excerpt || topSqlBlock.message, topSqlBlock.categories),
            failureKind: classifyFailureKind(topSqlBlock.excerpt || topSqlBlock.message, topSqlBlock.categories, topSqlBlock.sql)
        }
        : domino.root ? {
            source: `causal ${domino.root.source}`,
            file: domino.root.file,
            line: domino.root.endLine && domino.root.endLine !== domino.root.line ? `${domino.root.line}-${domino.root.endLine}` : String(domino.root.line),
            timestamp: domino.root.timestamp,
            score: domino.root.causalScore,
            categories: domino.root.categories,
            text: domino.root.text,
            innermost: domino.root.innermostException || "",
            sql: domino.root.sql,
            component: domino.root.component,
            failureKind: domino.root.failureKind
        }
        : topBlock && (!topEvent || topBlock.score >= topEvent.score)
        ? {
            source: "parsed exception block",
            file: topBlock.file,
            line: `${topBlock.startLine}-${topBlock.endLine}`,
            timestamp: topBlock.timestamp,
            score: topBlock.score,
            categories: topBlock.categories,
            text: topBlock.message,
            innermost: topBlock.innermostException,
            sql: topBlock.sql,
            component: detectComponent(topBlock.file, topBlock.excerpt || topBlock.message, topBlock.categories),
            failureKind: classifyFailureKind(topBlock.excerpt || topBlock.message, topBlock.categories, topBlock.sql)
        }
        : topEvent ? {
            source: "forensic event",
            file: topEvent.file,
            line: String(topEvent.lineNum),
            timestamp: topEvent.timestamp,
            score: topEvent.score,
            categories: topEvent.categories,
            text: topEvent.text,
            innermost: "",
            sql: null,
            component: detectComponent(topEvent.file, topEvent.text, topEvent.categories),
            failureKind: classifyFailureKind(topEvent.text, topEvent.categories, null)
        } : null;
    const distinctFailures = Array.from(signatureMap.values())
        .map(x => ({ ...x, categories: Array.from(x.categories) }))
        .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file) || a.firstLine - b.firstLine)
        .slice(0, 35);

    let report = `\n\n=== CROSS-LOG INCIDENT INDEX (ALL ATTACHED LOGS) ===\n`;
    report += `Whole-dataset scan complete: ${logs.length} file(s), ${totalLines} total lines, ${totalChars} total characters inspected before AI analysis.\n`;

    if (allEvents.length === 0) {
        report += `No forensic events were detected across the uploaded logs.\n`;
        report += `=== END CROSS-LOG INCIDENT INDEX ===`;
        return report;
    }

    report += `Detected ${allEvents.length} forensic event(s) across all logs.\n`;
    report += `Parsed ${exceptionBlocks.length} exception/SQL block(s) with stack/inner-exception intelligence.\n`;

    const cats = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);
    if (cats.length > 0) {
        report += `\n--- CROSS-LOG CATEGORY BREAKDOWN ---\n`;
        cats.forEach(([cat, count]) => {
            report += `${cat}: ${count}\n`;
        });
    }

    if (patternMode && largeInstallerLogs.length === logs.length && logs.length > 0) {
        report += `\n[Note: Large MSI/installer log(s) — analysis uses pattern/keyword profile (see LOG PATTERN & KEYWORD PROFILE). Line-by-line sweep omitted.]\n`;
        report += buildInstallerPatternSummary(logs);
        if (installerReport) report += installerReport;
    } else {
        report += renderSignalSummary(signalSummary, "CROSS-LOG EXCEPTION / ERROR KEYWORD SWEEP");
        if (installerReport) report += installerReport;
    }

    if (domino.report) {
        report += domino.report;
    }

    if (deterministicRoot && !patternMode) {
        report += `\n--- DETERMINISTIC ROOT-CAUSE HYPOTHESIS (must validate, not blindly accept) ---\n`;
        report += `Source: ${deterministicRoot.source}\n`;
        report += `Location: ${deterministicRoot.file}:Line ${deterministicRoot.line}${deterministicRoot.timestamp ? ` @ ${deterministicRoot.timestamp}` : ""}\n`;
        report += `Score: ${deterministicRoot.score}; Component: ${deterministicRoot.component || "Unknown Component"}; Failure kind: ${deterministicRoot.failureKind || "Forensic event"}; Categories: ${deterministicRoot.categories.join(', ') || 'Unclassified'}\n`;
        if (deterministicRoot.innermost) report += `Innermost exception: ${deterministicRoot.innermost}\n`;
        if (deterministicRoot.sql) report += `SQL diagnosis: ${deterministicRoot.sql.type}\n`;
        report += `Evidence: ${deterministicRoot.text}\n`;
        report += `Instruction: final answer must either confirm this as root cause with evidence or explicitly explain why an earlier/stronger event supersedes it.\n`;
    } else if (deterministicRoot && patternMode) {
        report += `\n--- STRONGEST ROOT-CAUSE PATTERN (keyword-derived) ---\n`;
        report += `Location: ${deterministicRoot.file}:Line ${deterministicRoot.line}${deterministicRoot.timestamp ? `  (time ${deterministicRoot.timestamp})` : ""}\n`;
        report += `Component: ${deterministicRoot.component || "Unknown"}; Failure kind: ${deterministicRoot.failureKind || "Forensic event"}; Categories: ${deterministicRoot.categories.join(', ') || 'Unclassified'}\n`;
        if (deterministicRoot.innermost) report += `Innermost exception: ${deterministicRoot.innermost}\n`;
        if (deterministicRoot.sql) report += `SQL diagnosis: ${deterministicRoot.sql.type}\n`;
        report += `Evidence sample: ${truncateLogLine(deterministicRoot.text, 320)}\n`;
    }

    if (!patternMode) {
        report += `\n--- PRIMARY ROOT-CAUSE CANDIDATES ACROSS ALL LOGS ---\n`;
        topRootCandidates.forEach((event, idx) => {
            report += `${idx + 1}. ${event.file}:Line ${event.lineNum}${event.timestamp ? ` @ ${event.timestamp}` : ""} [score ${event.score}; ${event.categories.join(', ') || 'Unclassified'}] ${event.text}\n`;
        });
    } else if (topRootCandidates.length > 0) {
        report += `\n--- TOP FAILURE EVENTS (cite as filename:Line N — text) ---\n`;
        topRootCandidates.slice(0, 8).forEach((event, idx) => {
            report += `${idx + 1}. ${event.file}:Line ${event.lineNum} — ${truncateLogLine(event.text, 280)}${event.timestamp ? `  (time ${event.timestamp})` : ""}\n`;
        });
    }

    if (rankedExceptionBlocks.length > 0) {
        report += `\n--- EXCEPTION CHAIN INTELLIGENCE (parsed blocks, ranked) ---\n`;
        rankedExceptionBlocks.slice(0, patternMode ? 10 : 25).forEach((block, idx) => {
            if (patternMode) {
                report += `${idx + 1}. ${block.file}:Lines ${block.startLine}-${block.endLine} — ${block.innermostException || block.outerException || "Exception"} — ${truncateLogLine(block.message, 240)}${block.timestamp ? `  (time ${block.timestamp})` : ""}\n`;
            } else {
                report += `${idx + 1}. ${block.file}:Lines ${block.startLine}-${block.endLine}${block.timestamp ? ` @ ${block.timestamp}` : ""} [score ${block.score}; ${block.categories.join(', ') || 'Unclassified'}]\n`;
                report += `   Outer: ${block.outerException || "Not detected"} | Innermost: ${block.innermostException || "Not detected"}\n`;
                report += `   Message: ${block.message}\n`;
                if (block.throwingFrame) report += `   Throwing frame: ${block.throwingFrame}\n`;
                if (block.originatingFrame) report += `   Originating frame: ${block.originatingFrame}\n`;
                if (block.sql) {
                    report += `   SQL diagnosis: ${block.sql.type}`;
                    const details = [];
                    if (block.sql.number) details.push(`Number ${block.sql.number}`);
                    if (block.sql.severity) details.push(`Severity ${block.sql.severity}`);
                    if (block.sql.state) details.push(`State ${block.sql.state}`);
                    if (block.sql.server) details.push(`Server ${block.sql.server}`);
                    if (block.sql.database) details.push(`Database ${block.sql.database}`);
                    if (block.sql.procedure) details.push(`Procedure ${block.sql.procedure}`);
                    if (block.sql.line) details.push(`SQL line ${block.sql.line}`);
                    if (details.length > 0) report += ` (${details.join('; ')})`;
                    report += `\n`;
                }
            }
        });
    }

    if (sqlEvents.length > 0 || sqlExceptionBlocks.length > 0) {
        report += `\n--- SQL/DATABASE PATTERNS (mandatory for final answer) ---\n`;
        sqlExceptionBlocks.slice(0, patternMode ? 8 : 25).forEach((block, idx) => {
            report += patternMode
                ? `${idx + 1}. ${block.file}:Lines ${block.startLine}-${block.endLine} — [${block.sql?.type || "SQL"}] ${truncateLogLine(block.message, 280)}${block.timestamp ? `  (time ${block.timestamp})` : ""}\n`
                : `Block ${idx + 1}. ${block.file}:Lines ${block.startLine}-${block.endLine}${block.timestamp ? ` @ ${block.timestamp}` : ""} [${block.sql.type}; score ${block.score}] ${block.message}\n`;
        });
        if (!patternMode) {
            sqlEvents.forEach((event, idx) => {
                report += `Event ${idx + 1}. ${event.file}:Line ${event.lineNum}${event.timestamp ? ` @ ${event.timestamp}` : ""} [score ${event.score}] ${event.text}\n`;
            });
        }
    } else {
        report += `\n--- SQL/DATABASE PATTERNS ---\nNo SQL/database exception signatures were detected across the uploaded logs.\n`;
    }

    {
        const timelineEvents = largeInstallerLogs.length === logs.length
            ? earliest.filter(e => /\b(SqlException|ALTER DATABASE|Cannot open database|Login failed|Upgrade failed|Location Service database|returning 1603)\b/i.test(e.text))
            : earliest;
        report += `\n--- EARLIEST FORENSIC EVENTS (MASTER TIMELINE START — cite as filename:Line N) ---\n`;
        timelineEvents.slice(0, patternMode ? 8 : 20).forEach(event => {
            report += `${event.file}:Line ${event.lineNum} — ${event.text}${event.timestamp ? `  (time ${event.timestamp})` : ""}\n`;
        });
    }

    report += `\n--- MOST REPEATED DISTINCT FAILURES (normalized signatures) ---\n`;
    distinctFailures.slice(0, patternMode ? 15 : 35).forEach(sig => {
        report += patternMode
            ? `- ${sig.count}× | ${sig.categories.join(', ') || 'Unclassified'} | ${truncateLogLine(sig.sample, 240)}\n`
            : `- ${sig.count}x | ${sig.file}:Lines ${sig.firstLine}-${sig.lastLine}${sig.firstTimestamp ? ` | First ${sig.firstTimestamp}` : ""}${sig.lastTimestamp && sig.lastTimestamp !== sig.firstTimestamp ? ` | Last ${sig.lastTimestamp}` : ""} | ${sig.categories.join(', ') || 'Unclassified'} | ${sig.sample}\n`;
    });

    report += patternMode
        ? `\nAI instruction: use pattern profile + signatures above. Explain root cause from **pattern combinations**, not line-by-line narration.\n`
        : `\nAI instruction: use this cross-log index as the master incident map. The CAUSAL DOMINO ANALYSIS is the preferred propagation path because it is scored using SOTI architecture dependencies, timestamp proximity, exception depth, and downstream-symptom penalties. Validate the chosen root against the earliest timeline, SQL section, and parsed exception chains before stating root cause.\n`;
    report += `=== END CROSS-LOG INCIDENT INDEX ===`;
    return report;
}

async function getSmartLogSnippet(content, limit = 300000, fileName = "Attached log", precalculatedLines = null, logObj = null) {
    if (!content) return "";
    const lines = precalculatedLines || content.split('\n');
    const totalLines = lines.length;

    const log = logObj || findLogObject(fileName, content) || { name: fileName, content, lines };
    await precomputeLogIntel(log);
    const { prefilteredIndices, intelCache, timestampCache, signatureCache } = log.precomputedIntel;

    // Large MSI/installer logs: pattern/keyword profile only (no line-by-line context).
    // The installer FAILURE ANALYSIS leads (it carries the deterministic root-cause anchor),
    // so if anything is trimmed the failing CustomAction always survives.
    if (totalLines >= 5000 && isInstallerLogContent(fileName, content)) {
        let focused = await buildInstallerFailureAnalysis([{ name: fileName, content, lines }]);
        focused += await buildInstallerPatternSummary([{ name: fileName, content, lines }]);
        focused += await buildLogPatternProfile([{ name: fileName, content, lines }]);
        // On small/CPU models the deterministic anchor already pinpoints the failing action,
        // so a few KB of evidence is plenty. Hard-cap well below the raw budget: a smaller
        // prompt means far less CPU prefill — the difference between a ~1-minute and a
        // ~5-minute analysis on a no-GPU machine (and it stops the long request from dying).
        const hardCap = isSmallLocalModel() ? Math.min(limit, 5200) : limit;
        if (focused.length > hardCap) {
            focused = `${focused.slice(0, hardCap)}\n\n[TRUNCATED: primary root-cause anchor preserved above]\n`;
        }
        return focused;
    }

    const parsedBlocks = await extractExceptionBlocksFromLog(log);
    const installerReport = await buildInstallerFailureAnalysis([log]);
    const curatedEvidence = await buildCuratedFailureEvidence(content, fileName, lines);

    const forensicEntries = [];
    const seenLineNums = new Set();
    const errorTypeCounts = {};
    const signatureMap = new Map();
    const rootCandidates = [];
    const signalSummary = createSignalSummary();
    let firstErrorLine = null;
    let lastErrorLine = null;

    let inException = false;
    let exceptionLinesCount = 0;

    let i = 0;
    let prefilterIdx = 0;

    while (i < totalLines) {
        if (i % 2000 === 0 && i > 0) {
            await yieldIfNeeded();
        }
        // Bound the deep scan on huge, error-dense logs: the output is budget-limited to a few KB
        // anyway, and the cross-log incident index already supplies the high-signal map. Without
        // this, a 60k+ line runtime log runs scoreRootCauseCandidate tens of thousands of times.
        if (forensicEntries.length > 4000) break;

        if (!inException) {
            // Jump to the next prefiltered index >= i
            while (prefilterIdx < prefilteredIndices.length && prefilteredIndices[prefilterIdx] < i) {
                prefilterIdx++;
            }
            if (prefilterIdx >= prefilteredIndices.length) {
                // No more prefiltered lines and not in an exception, we are done
                break;
            }
            i = prefilteredIndices[prefilterIdx];
        }

        const line = lines[i];
        const intel = intelCache[i];
        const isForensic = intel.isForensic;
        const timestamp = timestampCache[i] || "";
        const trimmed = line.trim();
        updateSignalSummary(signalSummary, intel, line, i + 1, fileName);

        // Track error type for summary
        if (isForensic && !intel.hasStackFrame) {
            intel.categories.forEach(cat => { errorTypeCounts[cat] = (errorTypeCounts[cat] || 0) + 1; });
            if (firstErrorLine === null) firstErrorLine = i + 1;
            lastErrorLine = i + 1;

            const sig = signatureCache[i];
            if (sig && sig.length > 8) {
                const existing = signatureMap.get(sig) || {
                    signature: sig,
                    count: 0,
                    firstLine: i + 1,
                    lastLine: i + 1,
                    firstTimestamp: timestamp,
                    lastTimestamp: timestamp,
                    categories: new Set(),
                    sample: line.trim()
                };
                existing.count++;
                existing.lastLine = i + 1;
                existing.lastTimestamp = timestamp || existing.lastTimestamp;
                intel.categories.forEach(c => existing.categories.add(c));
                signatureMap.set(sig, existing);
            }

            rootCandidates.push({
                lineNum: i + 1,
                timestamp: timestamp,
                sortTime: parseLogTimestampForSort(timestamp),
                text: line.trim(),
                categories: intel.categories,
                hasException: intel.hasException,
                severityToken: intel.severityToken,
                exceptionClasses: intel.exceptionClasses,
                keywordHits: intel.keywordHits,
                score: scoreRootCauseCandidate({
                    lineNum: i + 1,
                    text: line,
                    categories: intel.categories,
                    hasException: intel.hasException,
                    keywordHits: intel.keywordHits
                })
            });
        }

        // === EXCEPTION CHAIN TRACKER ===
        if (inException) {
            if (intel.hasStackFrame || trimmed === "" || (exceptionLinesCount < 8) || intel.hasException) {
                if (!seenLineNums.has(i + 1)) {
                    forensicEntries.push({ lineNum: i + 1, text: line, isError: true });
                    seenLineNums.add(i + 1);
                }
                exceptionLinesCount++;
                if (exceptionLinesCount > 140) {
                    inException = false;
                }
            } else {
                inException = false;
            }
        }

        if (!inException && (intel.hasException || intel.categories.includes('SQL/Database') || intel.categories.includes('Certificate/TLS') || intel.categories.includes('Memory/Thread') || intel.categories.includes('Installer/MSI') || intel.keywordHits.some(hit => hit.score >= 30) || intel.hasStackFrame || (i < totalLines - 1 && isStackTraceLine(lines[i + 1])))) {
            inException = true;
            exceptionLinesCount = 1;
            if (!seenLineNums.has(i + 1)) {
                forensicEntries.push({ lineNum: i + 1, text: line, isError: true });
                seenLineNums.add(i + 1);
            }
        } else if (!inException) {
            if (isForensic) {
                const start = Math.max(0, i - 5);
                const end = Math.min(totalLines - 1, i + 5);
                for (let j = start; j <= end; j++) {
                    if (!seenLineNums.has(j + 1)) {
                        forensicEntries.push({ lineNum: j + 1, text: lines[j], isError: (j === i) });
                        seenLineNums.add(j + 1);
                    }
                }
            }
        }

        i++;
    }

    forensicEntries.sort((a, b) => a.lineNum - b.lineNum);

    const compressedEntries = [];
    let repeatCount = 0;
    let lastErrorSig = "";

    const getErrorSignature = (text) => {
        return text.replace(/\d{4}[-\/]\d{2}[-\/]\d{2}[\sT]\d{2}:\d{2}:\d{2}[\.\d]*/g, "")
                   .replace(/0x[0-9a-fA-F]+/g, "")
                   .replace(/\d+/g, "")
                   .trim();
    };

    for (let i = 0; i < forensicEntries.length; i++) {
        const entry = forensicEntries[i];
        if (entry.isError) {
            const sig = getErrorSignature(entry.text);
            if (sig === lastErrorSig && sig.length > 10) {
                repeatCount++;
                if (repeatCount <= 3) {
                    compressedEntries.push(entry);
                }
                continue;
            } else {
                if (repeatCount > 3) {
                    compressedEntries.push({
                        lineNum: entry.lineNum - 1,
                        text: `... [Suppressed ${repeatCount - 3} consecutive identical occurrences of this error] ...`,
                        isError: false
                    });
                }
                repeatCount = 0;
                lastErrorSig = sig;
            }
        } else {
            if (repeatCount > 3) {
                compressedEntries.push({
                    lineNum: entry.lineNum - 1,
                    text: `... [Suppressed ${repeatCount - 3} consecutive identical occurrences of this error] ...`,
                    isError: false
                });
            }
            repeatCount = 0;
            lastErrorSig = "";
        }
        compressedEntries.push(entry);
    }
    if (repeatCount > 3) {
        compressedEntries.push({
            lineNum: forensicEntries[forensicEntries.length - 1].lineNum,
            text: `... [Suppressed ${repeatCount - 3} consecutive identical occurrences of this error] ...`,
            isError: false
        });
    }

    const topSignatures = Array.from(signatureMap.values())
        .map(x => ({ ...x, categories: Array.from(x.categories) }))
        .sort((a, b) => b.count - a.count || a.firstLine - b.firstLine)
        .slice(0, 25);

    const rankedRootCandidates = rootCandidates
        .sort((a, b) => b.score - a.score || a.lineNum - b.lineNum)
        .slice(0, 12);
    const fileDomino = buildDominoAnalysis(
        rootCandidates.map(event => ({ ...event, file: fileName })),
        parsedBlocks
    );

    // === BUILD FORENSIC REPORT WITH INTELLIGENCE SUMMARY ===
    let forensicReport = "";
    if (compressedEntries.length > 0) {
        forensicReport = `\n\n=== FORENSIC INCIDENT REPORT (WHOLE-FILE SCAN) ===\n`;
        forensicReport += `Whole-log scan complete: inspected every line (${totalLines} lines, ${content.length} characters). Found ${forensicEntries.length} forensic entries (${compressedEntries.length} after adjacency compression).\n`;
        if (firstErrorLine && lastErrorLine) {
            forensicReport += `Error window: Line ${firstErrorLine} through Line ${lastErrorLine}.\n`;
        }
        if (curatedEvidence) {
            forensicReport += curatedEvidence;
        }
        // Intelligence Summary
        const cats = Object.entries(errorTypeCounts).sort((a, b) => b[1] - a[1]);
        if (cats.length > 0) {
            forensicReport += `\n--- ERROR CATEGORY BREAKDOWN ---\n`;
            cats.forEach(([cat, count]) => {
                forensicReport += `  ${cat}: ${count} occurrence(s)\n`;
            });
            forensicReport += `--- END BREAKDOWN ---\n`;
        }

        forensicReport += renderSignalSummary(signalSummary, "FILE EXCEPTION / ERROR KEYWORD SWEEP");

        forensicReport += buildWholeLogSegmentMap(lines, 16);

        if (installerReport) {
            forensicReport += installerReport;
        }

        if (rankedRootCandidates.length > 0) {
            forensicReport += `\n--- ROOT-CAUSE CANDIDATE RANKING (computed from the whole log) ---\n`;
            rankedRootCandidates.forEach((event, idx) => {
                forensicReport += `${idx + 1}. Line ${event.lineNum}${event.timestamp ? ` @ ${event.timestamp}` : ""} [score ${event.score}; ${event.categories.join(', ') || 'Unclassified'}] ${event.text}\n`;
            });
            forensicReport += `Guidance: the AI must validate the top candidate against chronology and downstream symptoms before declaring root cause.\n`;
            forensicReport += `--- END ROOT-CAUSE CANDIDATES ---\n`;
        }

        if (fileDomino.report) {
            forensicReport += `\n--- FILE-LEVEL CAUSAL / DOMINO MODEL ---\n`;
            forensicReport += fileDomino.report.replace(/--- CAUSAL DOMINO ANALYSIS \(deterministic chronology \+ component model\) ---\n/, "");
            forensicReport += `--- END FILE-LEVEL CAUSAL / DOMINO MODEL ---\n`;
        }

        if (parsedBlocks.length > 0) {
            const rankedBlocks = [...parsedBlocks]
                .sort((a, b) => b.score - a.score || a.startLine - b.startLine)
                .slice(0, 20);
            forensicReport += `\n--- PARSED EXCEPTION / SQL BLOCKS (innermost-cause intelligence) ---\n`;
            rankedBlocks.forEach((block, idx) => {
                forensicReport += `${idx + 1}. Lines ${block.startLine}-${block.endLine}${block.timestamp ? ` @ ${block.timestamp}` : ""} [score ${block.score}; ${block.categories.join(', ') || 'Unclassified'}]\n`;
                forensicReport += `   Outer: ${block.outerException || "Not detected"} | Innermost: ${block.innermostException || "Not detected"}\n`;
                forensicReport += `   Message: ${block.message}\n`;
                if (block.throwingFrame) forensicReport += `   Throwing frame: ${block.throwingFrame}\n`;
                if (block.originatingFrame) forensicReport += `   Originating frame: ${block.originatingFrame}\n`;
                if (block.sql) {
                    const details = [];
                    if (block.sql.number) details.push(`Number ${block.sql.number}`);
                    if (block.sql.severity) details.push(`Severity ${block.sql.severity}`);
                    if (block.sql.state) details.push(`State ${block.sql.state}`);
                    if (block.sql.server) details.push(`Server ${block.sql.server}`);
                    if (block.sql.database) details.push(`Database ${block.sql.database}`);
                    if (block.sql.procedure) details.push(`Procedure ${block.sql.procedure}`);
                    if (block.sql.line) details.push(`SQL line ${block.sql.line}`);
                    forensicReport += `   SQL diagnosis: ${block.sql.type}${details.length ? ` (${details.join('; ')})` : ""}\n`;
                }
            });
            forensicReport += `--- END PARSED EXCEPTION / SQL BLOCKS ---\n`;
        }

        if (topSignatures.length > 0) {
            forensicReport += `\n--- DISTINCT FAILURE SIGNATURES (deduplicated across the whole log) ---\n`;
            topSignatures.slice(0, 15).forEach(sig => {
                forensicReport += `- ${sig.count}x | Lines ${sig.firstLine}-${sig.lastLine}${sig.firstTimestamp ? ` | First ${sig.firstTimestamp}` : ""}${sig.lastTimestamp && sig.lastTimestamp !== sig.firstTimestamp ? ` | Last ${sig.lastTimestamp}` : ""} | ${sig.categories.join(', ') || 'Unclassified'} | ${sig.sample}\n`;
            });
            forensicReport += `--- END DISTINCT FAILURE SIGNATURES ---\n`;
        }

        const precisionBrief = await buildPrecisionLogBrief(content, fileName, lines);
        if (precisionBrief) {
            forensicReport += precisionBrief;
        } else {
            forensicReport += `\n--- CHRONOLOGICAL FORENSIC TIMELINE (top ${Math.min(compressedEntries.length, 120)} lines) ---\n`;
            let lastLineNum = -10;
            compressedEntries.slice(0, 120).forEach(entry => {
                if (entry.lineNum - lastLineNum > 1) {
                    forensicReport += `\n[Line ${entry.lineNum}]\n`;
                }
                forensicReport += `${entry.text}\n`;
                lastLineNum = entry.lineNum;
            });
            if (compressedEntries.length > 120) {
                forensicReport += `\n... [${compressedEntries.length - 120} additional forensic lines omitted — use ROOT-CAUSE CANDIDATES and PARSED EXCEPTION blocks above]\n`;
            }
            forensicReport += `--- END CHRONOLOGICAL FORENSIC TIMELINE ---`;
        }
        forensicReport += `\n=== END FORENSIC INCIDENT REPORT ===`;
    } else {
        forensicReport = `\n\n[FORENSIC WHOLE-FILE SCAN COMPLETE: inspected every line (${totalLines} lines, ${content.length} characters). No exceptions, warnings, or error-level entries detected in this log file.]`;
        forensicReport += buildWholeLogSegmentMap(lines, 16);
    }

    const headSize = 30000;
    const tailSize = 100000;
    if (forensicReport.length > limit) {
        const keepHead = Math.floor(limit * 0.65);
        const keepTail = Math.floor(limit * 0.30);
        forensicReport = `${forensicReport.slice(0, keepHead)}\n\n[FORENSIC REPORT TRUNCATED FOR MODEL CONTEXT: root-cause ranking, parsed exception blocks, segment map, and distinct signatures above are whole-file summaries; middle timeline entries omitted only after deterministic whole-file analysis.]\n\n${forensicReport.slice(-keepTail)}`;
    }
    
    // If the file is small enough, just return the whole thing plus the report
    if (content.length <= (headSize + tailSize)) {
        return `${forensicReport}\n\n[FULL LOG CONTENT]\n${content}`;
    }

    // Place the forensic report at the TOP so it is never truncated by local AI context limits.
    return `${forensicReport}${await buildRawLogCoverage(content, lines, rankedRootCandidates, parsedBlocks, log)}`;
}

function hideToast() {
    const el = $('toast');
    if (el) el.className = 'toast';
}

function updateFieldValidation(id) {
    const el = $(id);
    if (!el) return;
    
    let val = el.value ? el.value.trim() : "";
    const template = 'Time of the meeting:\n\nSummary:\n\nTroubleshooting steps:\n\nNext steps:';
    // Consider as empty if truly empty OR if it's the meeting notes and matches the template exactly
    let isEmpty = !val || val === "" || (id === 'meetingNotes' && val === template);
    
    if (isEmpty) {
        el.classList.add('empty');
        el.classList.remove('filled');
    } else {
        el.classList.add('filled');
        el.classList.remove('empty');
    }
}

function updateAllValidations() {
    [
        'caseNum', 'scrubAccount', 'scrubCustomer', 'product', 'sotiVer',
        'agentVer', 'caseAge', 'platform', 'enviro', 'dsCfg', 'affDev',
        'issueSummary', 'meetingNotes', 'emailChain',
        'jiraExpected', 'jiraImpact', 'jiraRepro'
    ].forEach(updateFieldValidation);
}

// --- PII VAULT ---
const SCRUB_MAPS = {
    support: new Map(),  // email -> "Support_N"
    customer: new Map(), // email -> "Customer_N"
    names: new Map(),    // name -> "Support_N" or "Customer_N"
    supCount: 0,
    custCount: 0
};


// Shared Tier-3 identity used by every prompt mode — the AI's core persona.
const TIER3_IDENTITY = `You are the SOTI Tier-3 AI Analyser — a senior escalation engineer for the entire SOTI ONE Suite with expert-level command of SOTI MobiControl (UEM: Management/Deployment Server architecture, SQL backend, device enrollment, profiles, packages, agents for Android/iOS/Windows/macOS/Linux/Zebra), SOTI Connect (IoT & printer management, MQTT broker, device rules), SOTI XSight (advanced diagnostics, live remote support, operational intelligence dashboards), and SOTI Identity (SSO/IdP, SAML, user management). You analyse with forensic precision, cite exact evidence, and never guess.`;

function getLeanQAPrompt(isSmall = false) {
    if (isSmall) {
        return `${TIER3_IDENTITY} Use the provided LIVE DATA to answer.

RULES:
1. ALWAYS answer directly using ONLY the facts present in [RELEASE NOTES], [LATEST MOBICONTROL VERSION], [LATEST ANDROID AGENT VERSION], [PULSE SEARCH], and [DOCS SEARCH]. Do not invent, hallucinate, or extrapolate details.
2. NEVER say "check the website", "visit Pulse", or "click here". Do NOT output links or tell the user to go elsewhere. Just print the facts.
3. Keep answers extremely short and direct (1-2 sentences). Do not add conversational fluff.
4. For release notes, you MUST prioritize and list the resolved issues from the [RELEASE NOTES] section exactly as written. In SOTI context, "Release notes" primarily refers to "Resolved Issues" (the fixes). You must copy the MCMR codes and descriptions word-for-word. NEVER mix fixes from [SOTI PULSE CONSOLE DATA] with [SOTI PULSE AGENT DATA]; if the user asked about MobiControl, only list CONSOLE DATA. If they asked about Android Agent, only list AGENT DATA. NEVER invent, guess, or hallucinate additional issues. If the user asks for more issues than are present in your data, explicitly state that only the provided issues are available in the current context. If there are no resolved issues for the requested product, state that none were found.
5. ZERO HALLUCINATION FOR GUIDES: If the user asks for step-by-step instructions or configuration steps, you MUST construct them ONLY using the EXACT TEXT provided in the [OFFLINE PULSE KNOWLEDGE MATCHES], [DEEP RESEARCH], or [DOCS SEARCH] sections. You are STRICTLY FORBIDDEN from inventing steps. If a step involves the device, you must cite the exact SOTI procedure (e.g., entering afw#mobicontrol). DO NOT invent generic Android Developer steps (like USB Debugging, Developer Options, or ADB) unless explicitly stated in the SOTI text. If these sections do not contain the specific steps, you MUST reply "I could not find a SOTI guide for this specific task in my current context." DO NOT guess or use generic Android/IT knowledge to invent steps. DO NOT combine unrelated sections.
6. NEVER write meta-commentary about your sources or context. The following phrases are STRICTLY FORBIDDEN: "Based on the provided documentation", "Based on the provided information", "the retrieved knowledge base", "the provided context", "consult the full SOTI documentation", "contact SOTI support", "was not explicitly detailed", "you may need to consult". State the facts directly as established SOTI knowledge, with no preamble.
7. CURRENT STATE & "WHAT'S NEXT": For any question about the case status or what to do next, read [EMAIL CHAIN] from the TOP (it is ordered NEWEST FIRST) and answer from the most recent messages. [EMAIL CHAIN] OVERRIDES [ISSUE SUMMARY], which is only the original problem and may already be resolved. If the latest emails show the issue is fixed / the customer confirmed success / a meeting was cancelled, do NOT suggest old troubleshooting or a meeting — instead answer the newest open question, or confirm the fix and offer to close the case.`;
    }
    return `${TIER3_IDENTITY}

CRITICAL: You have been given LIVE DATA in this prompt. USE IT. The sections [LATEST MOBICONTROL VERSION], [LATEST ANDROID AGENT VERSION], [LATEST IDENTITY VERSION], [RELEASE NOTES], [PULSE SEARCH], [DOCS SEARCH], and [DEEP RESEARCH] contain REAL, UP-TO-DATE information fetched from SOTI Pulse and SOTI Docs right now. You MUST use this data to answer questions. Do not rely on memorized or generic IT knowledge when live sections contain the answer.

RULES YOU MUST FOLLOW:
1. NEVER tell the user to "check the SOTI website", "visit support.soti.com", "check Pulse", or "contact support". YOU already have the data. Just answer directly.
2. LATEST VERSION QUERIES: When asked "what is the latest version" of any SOTI product, you MUST use the correct version list and return the FIRST entry (newest). The mapping is:
   - "MobiControl" or "latest version" or "console" or "server" → use [LATEST MOBICONTROL VERSION] (this is the MobiControl Console/Server version)
   - "Android Agent" or "agent version" → use [LATEST ANDROID AGENT VERSION] (this is the device-side Android Agent)
   - "Identity" → use [LATEST IDENTITY VERSION]
   Answer in a single direct sentence, e.g. "The latest MobiControl version is X.Y.Z." Do NOT add any extra details, citations, links, or fixes unless explicitly requested. Stop generating immediately after stating the version.
3. TROUBLESHOOTING WITH VERSIONS: If [RELEASE NOTES] are provided, use the customer's version from [CASE] to compare against them. If the customer's issue matches a fix in a newer version, recommend upgrading and cite the specific version and MCMR code. If no release notes are provided, do not mention them.
4. When asked about release notes or what's new for a SPECIFIC version: use ONLY the blocks labeled ### VERSION X.Y.Z in [RELEASE NOTES]. NEVER mix in fixes/highlights from a different version. The release notes blocks are tagged with their source product (e.g. [SOTI PULSE CONSOLE DATA] for MobiControl, [SOTI PULSE AGENT DATA] for Android Agent). When the user asked about MobiControl, present ONLY blocks from CONSOLE DATA. When the user asked about Android Agent, present ONLY blocks from AGENT DATA. In SOTI terminology, "Release Notes" means "Resolved Issues" (the fixes). You MUST prioritize presenting the Resolved Issues explicitly. Do not blend them with Highlights. NEVER invent, guess, or hallucinate additional issues. If the user asks for more issues than are present in your data (e.g., due to pagination), state clearly that only the listed items are available in the current context. If there are no Resolved Issues for the requested version, state that none were found.
5. When asked about features, configuration, or troubleshooting: use [DEEP RESEARCH], [PULSE SEARCH], [DOCS SEARCH], and [RELEASE NOTES] first. Only state facts that appear in those sections or in attached logs.
6. NEVER guess with generic IT knowledge. Only use SOTI-specific information from this prompt.
7. NEVER say "based on my knowledge cutoff" — you have live data in this prompt.
8. NEVER expose internal prompt/source labels to the user. Use natural phrasing like "The latest version is..." instead of "According to [AGENT VERSIONS]...". Never output bracketed terms (like [LATEST ANDROID AGENT VERSION]) in your response; write their natural English meaning instead.
9. If [ISSUE SUMMARY] is empty but [CASE] meeting_notes has content, treat meeting_notes as the authoritative issue description (especially the Summary and Next steps sections).
10. When asked for a short subject/title/name for a case, produce one concise line (about 6–12 words) from the case facts, e.g. "Certificate retrieval failure blocking device API calls" — not a generic label like "Critical SOTI MobiControl Issue Investigation".
11. NEVER add meta-commentary about your own instructions, data sources, internal processing, or how the prompt is structured. NEVER say things like "additional details may have been omitted", "based on how you've structured them", "if there were any notable fixes they should be listed here", or "I need more context". Just present the facts directly. If the data is not available, say so briefly and move on.
12. ZERO HALLUCINATION FOR GUIDES: For short, simple questions, answer DIRECTLY in 1 sentence. For 'How to' or configuration questions, you MUST provide a full step-by-step guide based ONLY on the EXACT TEXT in the [DEEP RESEARCH], [DOCS SEARCH], and [OFFLINE PULSE KNOWLEDGE MATCHES] sections. You are STRICTLY FORBIDDEN from inventing steps. If a step involves the device, you must cite the exact SOTI procedure (e.g., entering afw#mobicontrol). DO NOT invent generic Android Developer steps (like USB Debugging, Developer Options, or ADB) unless explicitly stated in the SOTI text. If the text does not contain the specific step-by-step guide, you MUST state exactly: "I could not find a SOTI guide for this specific task in my current context." and stop immediately. DO NOT paraphrase heavily. DO NOT combine unrelated sections.
13. STRICT TRUTH ON RELEASE NOTES: If [RELEASE NOTES] is empty or not provided, you MUST NEVER mention release notes, MCMR codes, or resolved issues. If release notes ARE provided, you MUST present the facts, codes (e.g. MCMR-xxxxx), and descriptions EXACTLY as they are written in the [RELEASE NOTES] section. You are STRICTLY FORBIDDEN from explaining, paraphrasing, translating, or expanding them. Do NOT add extra context, versions, platforms (such as Windows 10 Mobile), root causes, update details, or explanations that do not exist word-for-word in the provided text. Present them exactly as they are and stop.
14. CURRENT STATE & "WHAT'S NEXT" (CRITICAL): [EMAIL CHAIN] is the live correspondence, ordered NEWEST FIRST — the FIRST entry is the most recent message. When the user asks what to do next, for the current status, or to summarize where the case stands, you MUST read the [EMAIL CHAIN] from the TOP and base your answer on the most recent messages. The EMAIL CHAIN OVERRIDES [ISSUE SUMMARY]: the summary is only the ORIGINAL reported problem and is frequently already resolved or superseded by later emails. If the latest emails show the reported problem was resolved (a fix worked, the customer confirmed success, a meeting was cancelled) or the conversation has moved to a new topic, you MUST reflect that: do NOT re-recommend old troubleshooting, and do NOT propose scheduling a meeting for a problem the chain shows is already solved. Instead address the newest OPEN item — answer the customer's most recent question, or if nothing is open, confirm the resolution and offer to close the case. NEVER produce next-steps the email chain has already moved past.


VERSIONING (always apply):
- MobiControl Console/Server and Android Agent are SEPARATE products with SEPARATE version numbers, but BOTH can have the same middle digit (e.g. both can be 202X.1.x). You CANNOT distinguish them by version number format alone.
- Determine which product the user is asking about from the PRODUCT NAME in their query, NOT the version number:
  * "MobiControl" / "MC" / "console" / "server" / "latest version" (without specifying agent) → MobiControl Console/Server → use [LATEST MOBICONTROL VERSION]
  * "Android Agent" / "agent" / "device agent" / "SOTI agent" / "AEA" → Android Agent → use [LATEST ANDROID AGENT VERSION]
  * "Identity" → SOTI Identity → use [LATEST IDENTITY VERSION]
- These version numbers will be DIFFERENT. Do NOT mix them up or pick the higher number — use the correct list for the product being asked about.
- Web Console is hosted inside SOTI Management Service (NEVER mention IIS or a separate web hosting service)
- Core topology: Management Service <-> SQL <-> Deployment Server <-> Device Agent | Ports: 5494, 13131, 2197, 443

### CONVERSATIONAL UX GUIDANCE (PROACTIVE MENTORING):
- **Formatting**: ALWAYS use proper Markdown formatting. Place section headers (like 'Summary:', 'Troubleshooting Steps:', 'Next Steps:') on their own new lines. Use bullet points for steps and ensure there is a blank line between paragraphs to maximize readability.
- **Strive for Extreme Brevity**: Keep answers as short as possible. Do NOT write conversational preambles (like "Here is the information you requested..." or "Here are the highlights...") or conversational postambles (like "If you have any other questions, let me know...", "Hope this helps...", or "Remember to stay up-to-date..."). Start directly with the answer or bullet points, and stop immediately.
- **Troubleshooting Case Constraint**: You are strictly forbidden from asking for logs, asking for Salesforce sync, or displaying the Transparency Brief unless the user is explicitly starting a troubleshooting/investigation case (e.g., describing an active error/problem and asking you to troubleshoot). For general version checks, definitions, port checks, or release notes queries, output ONLY the direct facts or notes and NOTHING else.
- **Transparency Brief**: ONLY at the start of a troubleshooting case analysis, briefly list:
    1. **WHAT I HAVE**: (e.g., Case Summary, Agent Version).
    2. **WHAT IS MISSING**: (e.g., Server Logs, SOTI Version).
    3. **STATUS**: (Ready / Partial / Awaiting Context).
    4. **NEXT STEP**: (The one best action the user should take).`;
}

function getLeanLogPrompt() {
    return `${TIER3_IDENTITY}

You are operating in LOG FORENSICS mode. Your SOLE mission is to find the EXACT root cause from the log data. You NEVER guess, generalize, or skip evidence.

PRIORITY ORDER (mandatory):
1. **=== LOG PATTERN & KEYWORD PROFILE ===** — PRIMARY source. Use pattern detection, category counts, and failure signatures.
2. **=== CROSS-LOG INCIDENT INDEX ===** — category breakdown, installer pattern summary, top pattern samples.
3. Raw log snippets — only if needed to verify a pattern message.

YOU MUST START WITH LOG PATTERN & KEYWORD PROFILE, then CROSS-LOG INCIDENT INDEX. Do NOT produce line-by-line timelines.

FORBIDDEN OUTPUT PATTERNS:
- Do NOT invent a "keyword sweep inventory" listing MSI codes like "Exception: 1402" (MSI Note: 1: 1402 is NOT an exception).
- Do NOT say "SQL exception: none visible" when SqlException or ALTER DATABASE lines exist in the brief.
- Do NOT classify FATAL/CRITICAL from MSI Note codes or random line numbers.
If INSTALLER EVIDENCE is present, it lists line-anchored high-signal installer lines and raw context windows only — not a pre-written root cause. You must derive propagation path, symptom-vs-source, and conclusion from chronology and the full log snippets. Do not copy parser section headings as your verdict, and do not replace an earlier causal event with later post-failure UI/log-copy actions such as fatal dialogs or CopyInstallationLog.
If CURATED HIGH-VALUE EVIDENCE or SQL/DATABASE EVENTS sections exist, you MUST read them first. In MSI verbose logs, "Note: 1: 1402" is an MSI internal code — never list it as an exception. Real SQL failures appear as System.Data.SqlClient.SqlException, "ALTER DATABASE statement is not supported", "Setting Recovery mode to SIMPLE", and often target Azure SQL (.database.windows.net). Connect Azure SQL limitations to unsupported ALTER DATABASE when the log shows both.
For large MSI logs the keyword sweep may be omitted intentionally. When PRECISION LOG BRIEF exists, ignore generic sweep tables and use Phase blocks + SQL facts only.
HALLUCINATION BLOCKLIST: Never claim missing dependencies, corrupted registry entries, implicit deadlocks, network disconnects, timeout code 4214, log-path-change causality, reboot actions, or HRESULT/Win32 root causes unless the attached raw log lines explicitly show those exact facts.
TIMESTAMP PRECISION: Preserve milliseconds whenever present. MSI timestamps like \`19:13:57:009\` must be normalized and shown as \`19:13:57.009\` in every timeline, propagation path, root-cause verdict, and evidence citation.
STRICT FAILURE-SIGNAL LADDER: prioritize FATAL/CRITICAL/PANIC/SEVERE, then exception chains with innermost causes, then SQL/certificate/authentication/permission failures, then ERROR/non-zero return codes, then WARN. INFO lines are context only unless they directly identify the failing operation. Lines saying "0 errors", "no errors", or "completed successfully" are not failures.
EVERY exception class listed in the sweep or PARSED EXCEPTION / SQL BLOCKS must be mentioned exactly once in the Exception Deep Dive or explicitly dismissed as downstream/noise with evidence.
YOU MUST USE THE WHOLE-LOG COVERAGE MAP to confirm whether the failure is concentrated in head, middle, tail, or a specific segment. Do not say the middle of the log is clean unless the segment map supports it.
YOU MUST SCAN THE ENTIRE FORENSIC INCIDENT REPORT LINE BY LINE. DO NOT SKIP ANY DISTINCT FAILURE SIGNATURE.
The ROOT-CAUSE CANDIDATE RANKING is a forensic hint, not a verdict. Validate it by chronology, inner exception chains, and downstream symptoms before declaring root cause.
The DETERMINISTIC ROOT-CAUSE HYPOTHESIS is the machine parser's strongest candidate. You MUST either confirm it with cited evidence or reject it with a stronger earlier causal event.
The CAUSAL DOMINO ANALYSIS is mandatory evidence. It is the "Log Whisperer" layer: it lines up every event on one master timeline, scores causal edges using SOTI architecture dependencies, and separates the first domino from distracting downstream noise. Never call a later DS/Agent/Web failure the root cause if an earlier SQL/Identity/MS/certificate/auth failure explains it.
Installer logs require different judgement: the earliest error may be non-fatal validation, while the real root cause is usually the first deployment/custom-action failure that causes rollback/1603 — but you must prove that from cited lines, not assume it.

YOU MUST OUTPUT THIS EXACT STRUCTURE:

## LOG ANALYSIS REPORT

If this is a setup/MSI/install log, title the report:
## Forensic Analysis: [SOTI Product Version] Installation Failure
Then include:
- Log Source
- Install Start / Install End / Return Code
- Environment, server, SQL target, Azure SQL detection if visible
- Chronological Triage table with Timestamp, Log Line, Classification, Event
- Timestamps with milliseconds when available, for example \`19:13:57.009\`
- Propagation Path
- Root Cause vs Symptom table
- Conclusion
- Recommendations
Do NOT output the generic ENVIRONMENT SNAPSHOT / EXCEPTION DEEP DIVE format before the installer report. For installer logs, the installer forensic report is the main answer.

### 1. ENVIRONMENT SNAPSHOT
Extract from [LOG HEAD]:
- SOTI product & version detected
- OS / .NET / SQL Server version if visible
- Service name and startup mode
- Any config warnings or deprecation notices at startup

### 2. CHRONOLOGICAL ERROR TIMELINE
List EVERY distinct error, warning, SQL issue, exception chain, service failure, certificate/TLS issue, auth issue, and network issue from the CROSS-LOG INCIDENT INDEX and FORENSIC INCIDENT REPORT in strict chronological order across ALL files.
Format per entry:
> **[filename:Line XXXX]** [TIMESTAMP] — \`ExceptionClass\`: message summary
> *Context: what operation was in progress*

DO NOT SKIP or summarize distinct failure signatures. If a repeated failure appears many times, cite the first line, last line, and occurrence count.
Highlight: service restarts, connection drops, authentication failures, certificate errors.

### 3. EXCEPTION DEEP DIVE
For EACH distinct exception type found:

#### Exception: [Full.Namespace.ExceptionClass]
- **Message**: exact error message
- **Inner Exception Chain**: trace the FULL chain: Outer → Inner → Innermost. The INNERMOST exception is the true cause.
- **Parser Verdict**: compare your conclusion against the parsed innermost exception from PARSED EXCEPTION / SQL BLOCKS.
- **Stack Trace Origin**: read the stack trace BOTTOM-UP.
  - **Originating Frame** (bottom): the SOTI method that started the operation
  - **Throwing Frame** (top): where the exception was thrown
  - Quote both frames exactly.
- **Occurrences**: how many times, first/last line numbers and timestamps
- **SQL-Specific Analysis** (if SqlException/Deadlock/Timeout):
  - Error Number & Severity if present
  - Was it a login failure, schema issue, timeout, deadlock, or connection pool exhaustion?
  - Which database/server/query if visible?
  - Whether this SQL event is causal or only a downstream symptom
- **Certificate/TLS Analysis** (if cert-related):
  - Which certificate failed? Expired? Untrusted chain? Name mismatch?
  - Which component was performing the TLS handshake?
- **HTTP/Network Analysis** (if HTTP error or SocketException):
  - Status code & target URL if visible
  - Was it outbound (SOTI → external) or inbound (client → SOTI)?

### 4. THE PROPAGATION PATH (DOMINO EFFECT)
Draw the EXACT causal chain from root cause to user-visible symptom:
\`\`\`
[ROOT CAUSE: exact exception @ Line X, Timestamp] 
  → [DOWNSTREAM FAILURE 1: what broke next @ Line Y, Timestamp]
  → [DOWNSTREAM FAILURE 2: cascading impact @ Line Z, Timestamp]
  → [USER-VISIBLE SYMPTOM: what the user sees]
\`\`\`
Every link in the chain MUST cite a specific line number and timestamp from the FORENSIC INCIDENT REPORT.
Every timestamp in the chain MUST include milliseconds when the source log contains them.
You MUST reconcile this section against the CAUSAL DOMINO ANALYSIS and FILE-LEVEL CAUSAL / DOMINO MODEL. If your chain differs from the deterministic chain, explain exactly why using line-level evidence.
For each arrow, explain WHY it is causal, not merely nearby in time. Example: SQL timeout blocks MS data access -> MS/API operation fails -> DS connection drops -> Agent enrollment/check-in fails.

### 5. ROOT CAUSE VERDICT
State in ONE sentence:
> **ROOT CAUSE**: [ExceptionClass] at Line [X] ([TIMESTAMP]) — [exact reason]. This caused [downstream effect chain].

This must be backed by direct evidence. If insufficient evidence exists, say: "Insufficient log evidence to determine root cause — additional logs needed: [specify which]." NEVER fabricate a root cause.

### 6. CONCRETE MITIGATION & FIX
Provide SOTI-specific resolution steps. Be surgical:
- Exact Windows service names to restart
- Exact registry paths or config file paths to modify
- Exact SQL commands if database-related
- Exact port numbers to check (MS-DS: 5494, Signal: 13131, APNS: 2197, Web: 443)
- Exact SOTI Console navigation paths for settings changes
- If an upgrade fixes it, cite the exact version and MCMR code

CRITICAL RULES:
- The Web Console is hosted INSIDE the SOTI Management Service. NEVER mention IIS or Apache.
- Read stack traces BOTTOM-UP. The bottom frame is the origin.
- The INNERMOST exception in a nested chain (after ---> or Inner Exception) is the TRUE root cause.
- A SqlException, Timeout, or Deadlock is ALWAYS a high-priority root cause candidate.
- Certificate errors and authentication failures are ALWAYS high-priority — they block entire subsystems.
- Distinguish CAUSAL errors (the origin) from SYMPTOMATIC errors (downstream noise). Only the FIRST chronological error in a cascade is the root cause.
- If the same error repeats 100+ times, it is likely a loop caused by a persistent upstream failure. Find that upstream failure.
- If the log contains SQL exceptions, you MUST explicitly include a SQL diagnosis even if SQL is not the final root cause.
- NEVER say "multiple issues were found" without ranking them. ALWAYS identify THE primary root cause.

### CONVERSATIONAL UX GUIDANCE (PROACTIVE MENTORING):
- **Direct Accountability**: You are responsible for ensuring you have enough data to be accurate.
- **Missing Salesforce Data**: If the case details under [CASE] (like case_number or issue_summary) are empty, politely state: "I don't yet have your Salesforce case context. Please use the 'Sync from Salesforce' button so I can tailor my analysis to your specific environment."
- **Missing Logs**: If no logs are attached, state: "I'm ready to help, but uploading logs (MS.log, DS.log, Device logs) would allow me to perform a much deeper forensic analysis."
- **Transparency Brief**: At the start of an analysis, briefly list:
    1. **WHAT I HAVE**: (e.g., Case Summary, Agent Version).
    2. **WHAT IS MISSING**: (e.g., Server Logs, SOTI Version).
    3. **STATUS**: (Ready / Partial / Awaiting Context).
    4. **NEXT STEP**: (The one best action the user should take).`;
}

// Compact log-analysis prompt for small / CPU-bound models (gemma4:2b, e2b, e4b...).
// The full getLeanLogPrompt is ~13KB (~3700 tokens) — on a 6 tok/s CPU that is minutes
// of prefill before a single token appears, which reads as a "blank" response. This
// trimmed version keeps the Tier-3 identity and the non-negotiable forensic rules but
// asks for a focused, concise report so the model starts answering quickly.
function getCompactLogPrompt() {
    return `${TIER3_IDENTITY}

You are in LOG ANALYSIS mode for SOTI runtime logs (Management Service, Deployment Server, Agent,
Location Service, Identity) and/or HAR network captures. Find the EXACT root cause from the evidence
below and present a full forensic report. Never invent errors that are not in the data.

EVIDENCE, in order of authority:
1. === HAR NETWORK CAPTURE ANALYSIS === (if present) — real HTTP transactions: 4xx/5xx, redirects, OAuth/SSO error codes, FQDN mismatch.
2. === CROSS-LOG INCIDENT INDEX === (incl. CAUSAL DOMINO ANALYSIS) and === LOG PATTERN & KEYWORD PROFILE === — the line-anchored incident map.
3. Raw snippets (=== FILE: ... ===) — to confirm exact lines.

HOW TO REASON:
- Read exception chains to the INNERMOST exception. Separate the EARLIEST causal error from downstream SYMPTOMS — only the first error in a cascade is the root cause.
- CORRELATE WITH THE CASE: if a [REPORTED ISSUE]/[ISSUE SUMMARY]/[CASE] describes a specific symptom (redirect / wrong URL / FQDN, SSO or login failure, slowness, enrollment, certificate), PRIORITIZE the evidence that matches that symptom over an unrelated high-severity error elsewhere. A "redirect to the wrong/internal FQDN" symptom points to SSO issuer / redirect-URL config — e.g. "No SSO entity found ... request issuer: <internal .local FQDN>", invalid_client_configuration, HTTP 429 — NOT an unrelated SQL constraint or device-unmap error.
- A wrong/internal issuer or redirect URL (an internal *.local FQDN where the external host is expected) is the classic cause of an SSO redirect loop and HTTP 429 (Too Many Requests).
- SqlException / Timeout / Deadlock / Login failed / certificate / auth failures are high-priority candidates ONLY when they fit the reported symptom.
- The Web Console runs INSIDE the SOTI Management Service — never mention IIS.
- If evidence is genuinely insufficient, say so and name the log you need. NEVER fabricate.

CITATIONS: use exactly "filename:Line <number> — <exact text>", copied from the evidence sections. NEVER write a placeholder ("Line N", "@ Timestamp", "ExceptionClass") or invent a line/timestamp/message. A full date-time (e.g. "2026-06-05 11:52:05.101") in parentheses at the END is optional; never put a time where the line number goes.

OUTPUT — use these exact headings; begin directly with "## 🔍" (no "Based on" preamble):

## 🔍 Forensic Analysis: <product/area> — <one-line problem>
**Logs reviewed:** <comma-separated files> | **Window:** <first ts> → <last ts>
**Environment:** <servers/hosts/SQL/identity facts you can cite, incl. any FQDN mismatch>

### 1. Chronological Triage
| Timestamp | Location | Event |
| --- | --- | --- |
(4–6 rows from the evidence, earliest first: the first real error, the key failures, and the user-visible symptom — each with a real file:Line.)

### 2. Propagation Path (domino effect)
A short numbered chain: earliest causal error → downstream effects → user-visible symptom.

### 3. Root Cause — Symptom vs. Source
| Finding | Classification |
| --- | --- |
(Mark downstream/cosmetic items as **Symptom**; mark the true cause as **ROOT CAUSE**.)

**Root Cause:** one precise sentence naming the real cause (with file:Line and the exact message).
**Recommendation:** the specific SOTI fix (the setting/URL/issuer to correct, service to restart, SQL action, or version + MCMR if a release-notes section names one).`;
}

// Conversational prompt used when logs are attached but the user asked a normal question
// (e.g. "what's the case number?", "summarize this case") rather than a log analysis.
// It answers the actual question instead of forcing the forensic report format.
function getConversationalPrompt() {
    return `${TIER3_IDENTITY}

Answer the user's question directly and conversationally. You have the case details ([CASE], [ISSUE SUMMARY]) and a manifest/summary of the attached logs available.

RULES:
- Answer the ACTUAL question asked. Do NOT output a "Log Analysis" report, headed sections, or a root-cause verdict UNLESS the user explicitly asks you to analyse the logs or find the root cause.
- FOLLOW-UP / "why" questions ("why do you think that's the root cause?", "how did you conclude that?", "are you sure?", "explain that"): the user is asking you to JUSTIFY the answer you ALREADY gave earlier in this conversation. Answer conversationally in a few sentences — restate your reasoning and cite the specific evidence (the exact error message, file:line, timestamp, and why it is the cause rather than a downstream symptom) that led to it. Do NOT regenerate a full forensic report, tables, or headed sections, and do NOT switch to a different root cause than the one you already gave.
- Case questions (case number, product, version, status, "summarize the case", "what's in the case info") → answer from [CASE] and [ISSUE SUMMARY].
- Status / "what do I do next" questions → read [EMAIL CHAIN] from the TOP (it is ordered NEWEST FIRST) and answer from the most recent messages. [EMAIL CHAIN] OVERRIDES [ISSUE SUMMARY]: the summary is only the original problem and may already be resolved or superseded. If the latest emails show the issue is fixed or the conversation moved on, reflect that — do NOT re-recommend old troubleshooting or a meeting for an already-solved problem; address the newest open item or confirm the fix and offer to close.
- Be concise, clear and helpful, in plain prose.
- Never say "insufficient evidence" for something the case info or logs clearly contain. Only say you lack data if the specific thing asked truly isn't present.
- If a deeper log investigation would help, briefly offer to run a full analysis (or tell the user to click "Analyse Now").`;
}

// --- RESEARCH ENGINE ---
const sotiFetchCache = new Map();
async function sotiFetch(url, timeout = 5000) {
    const now = Date.now();
    if (sotiFetchCache.has(url)) {
        const cached = sotiFetchCache.get(url);
        if (now - cached.timestamp < 15 * 60 * 1000) {
            console.log('[CACHE HIT] sotiFetch:', url);
            return cached.text;
        }
        sotiFetchCache.delete(url);
    }

    let fetchedText = null;

    // FIRST-PARTY / LOCAL ONLY: fetch directly from the target, which is always a first-party
    // SOTI site (pulse.soti.net) the extension has host permission for. NO third-party CORS
    // proxies — if this direct fetch fails, the caller falls back to the bundled OFFLINE
    // knowledge base (PulseKB / knowledge/*.md) rather than leaking the requested URL to an
    // external proxy service. Keeps the app fully self-contained and private.
    try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), timeout);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(tid);
        if (res.ok) {
            const text = await res.text();
            if (text && text.length > 500) {
                fetchedText = text;
            }
        }
    } catch (e) { console.warn('Direct Pulse fetch failed; falling back to the offline knowledge base.', e); }

    if (fetchedText) {
        sotiFetchCache.set(url, { text: fetchedText, timestamp: now });
    }
    return fetchedText;
}

async function fetchReleaseNotes(type, version) {
    const catalog = type === 'identity' ? [] : await discoverPulseReleaseNoteCatalog('soti-mobicontrol');
    const sources = type === 'identity'
        ? [{ url: `${PULSE_ORIGIN}/support/soti-identity/release-notes/`, type: 'Identity' }]
        : selectReleaseNoteSources(`${type} ${version}`, '', null, catalog);
    const preferred = sources.find(s => s.type.toLowerCase().includes(type)) || sources[0];
    if (!preferred) return null;
    const html = await sotiFetch(preferred.url, 12000);
    if (!html) return null;
    const blocks = extractPulseReleaseNoteBlocks(html).filter(b => b.version === version || b.version.startsWith(version));
    if (blocks.length) {
        return `[RAW ${preferred.type.toUpperCase()} ${version} NOTES]:\n` + blocks.map(b => `### ${b.version} - ${b.type}\n${b.text}`).join('\n\n').slice(0, 4000);
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const text = doc.body.textContent;
    const regex = new RegExp(`(?:v|Version)?\\s*${version.replace('.', '\\.')}[\\s\\S]{1,1000}?(?=\\bv?\\s*\\d+\\.\\d+|$)`, 'i');
    const match = text.match(regex);
    return match ? `[RAW ${preferred.type.toUpperCase()} ${version} NOTES]:\n${match[0].trim().slice(0, 1500)}` : null;
}

function cleanPulseText(text) {
    return (text || "")
        .replace(/\u2011/g, "-")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function flushPulseNoteBuckets(version, buckets, blocks) {
    if (!version) return;
    Object.entries(buckets).forEach(([type, values]) => {
        const text = cleanPulseText(values.join("\n"));
        if (text.length > 20) blocks.push({ version, type, text });
    });
}

function classifyPulseSectionHeading(text) {
    const t = cleanPulseText(text).toLowerCase();
    if (/^resolved issues?$/.test(t)) return "Resolved Issues";
    if (/^known issues?$/.test(t)) return "Known Issues";
    if (/release highlights|highlights|what'?s new/.test(t)) return "Highlights";
    return null;
}

function extractPulseReleaseNoteBlocks(html) {
    const doc = new DOMParser().parseFromString(html || "", 'text/html');
    doc.querySelectorAll('script, style, nav, footer, header, svg, path, iframe, link').forEach(el => el.remove());
    const versionHeadingRx = /\b((?:20\d\d|\d{2})\.\d+(?:\.\d+)*)\b/;
    const blocks = [];

    let globalVersion = null;
    const allHeadings = Array.from(doc.querySelectorAll('h1, h2, h3, h4, .text-3xl'));
    for (const h of allHeadings) {
        const m = (h.textContent || "").match(versionHeadingRx);
        if (m) {
            globalVersion = m[1];
            break;
        }
    }

    const layoutItems = Array.from(doc.querySelectorAll('.umb-block-grid__layout-item'));

    if (layoutItems.length > 0) {
        let currentVersion = null;
        let currentType = "Highlights";
        const buckets = { Highlights: [], "Resolved Issues": [], "Known Issues": [] };

        layoutItems.forEach(item => {
            const h1 = item.querySelector('h1, h2, h3, h4, .text-3xl, .text-2xl, .text-xl, p > strong');
            if (h1 && (h1.textContent || "").trim().length < 60 && versionHeadingRx.test(h1.textContent || "")) {
                flushPulseNoteBuckets(currentVersion || globalVersion, buckets, blocks);
                currentVersion = ((h1.textContent || "").match(versionHeadingRx) || [])[1];
                Object.keys(buckets).forEach(k => { buckets[k] = []; });
                currentType = "Highlights";
                return;
            }
            
            const sectionHeader = item.querySelector('h1, h2, h3, h4, .text-3xl, .text-2xl, .text-xl, p > strong');
            if (sectionHeader) {
                const section = classifyPulseSectionHeading(sectionHeader.textContent || "");
                if (section) {
                    currentType = section;
                    return;
                }
            }
            
            const activeVersion = currentVersion || globalVersion;
            if (!activeVersion) return;

            const tables = item.querySelectorAll('table');
            if (tables.length > 0) {
                tables.forEach(table => {
                    table.querySelectorAll('tr').forEach(tr => {
                        const cells = tr.querySelectorAll('td');
                        if (cells.length >= 2) {
                            const code = cleanPulseText(cells[0].textContent);
                            const desc = cleanPulseText(cells[1].textContent);
                            if (code && desc) buckets["Resolved Issues"].push(`- ${code}: ${desc}`);
                        } else if (cells.length === 1) {
                            const t = cleanPulseText(cells[0].textContent);
                            if (t) buckets[currentType].push(`- ${t}`);
                        }
                    });
                });
            }

            const rich = item.querySelector('.umbBlockGridRichTextBlock, .contents');
            if (rich) {
                const parts = [];
                rich.querySelectorAll('p, li, h3, h4').forEach(el => {
                    if (el.closest('table')) return;
                    const t = cleanPulseText(el.textContent || "");
                    if (t && t.length > 2) parts.push(`- ${t}`);
                });
                if (!parts.length) {
                    const t = cleanPulseText(rich.textContent || "");
                    if (t.length > 20) parts.push(t);
                }
                if (parts.length) buckets[currentType].push(parts.join("\n"));
            }
        });
        flushPulseNoteBuckets(currentVersion || globalVersion, buckets, blocks);
        if (blocks.length > 0) return blocks;
    }

    const headings = Array.from(doc.querySelectorAll('h1, h2, h3, h4'))
        .filter(h => versionHeadingRx.test(h.textContent || ""));
    headings.forEach((heading, idx) => {
        const ver = ((heading.textContent || "").match(versionHeadingRx) || [])[1];
        if (!ver) return;
        const nextHeading = headings[idx + 1] || null;
        const sectionNodes = [];
        let node = heading.nextElementSibling;
        while (node && node !== nextHeading) {
            if (/^H[1-4]$/i.test(node.tagName || "") && versionHeadingRx.test(node.textContent || "")) break;
            sectionNodes.push(node);
            node = node.nextElementSibling;
        }
        const sectionHtml = sectionNodes.map(n => n.outerHTML || n.textContent || "").join("\n");
        const sectionDoc = new DOMParser().parseFromString(`<div>${sectionHtml}</div>`, 'text/html');
        let currentType = "Highlights";
        const buckets = { Highlights: [], "Resolved Issues": [], "Known Issues": [] };
        Array.from(sectionDoc.body.querySelector('div')?.children || sectionDoc.body.children).forEach(child => {
            const section = classifyPulseSectionHeading(child.textContent || "");
            if (section) { currentType = section; return; }
            let text = "";
            child.querySelectorAll && child.querySelectorAll('p, li, td, th').forEach(el => {
                const t = cleanPulseText(el.textContent || "");
                if (t && !/^resolved issues?$|^known issues?$/i.test(t)) text += `- ${t}\n`;
            });
            if (!text) text = cleanPulseText(child.textContent || "");
            if (text && !/^resolved issues?$|^known issues?$/i.test(text)) buckets[currentType].push(text);
        });
        flushPulseNoteBuckets(ver, buckets, blocks);
    });
    return blocks;
}

async function readPulseCatalogCache(supportSlug) {
    const key = `pulse_catalog_${supportSlug}`;
    try {
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            const data = await chrome.storage.local.get(key);
            const entry = data[key];
            if (entry?.entries?.length && (Date.now() - (entry.ts || 0)) < 86400000) return entry.entries;
        } else {
            const raw = localStorage.getItem(key);
            if (raw) {
                const entry = JSON.parse(raw);
                if (entry?.entries?.length && (Date.now() - (entry.ts || 0)) < 86400000) return entry.entries;
            }
        }
    } catch (_) { }
    return null;
}

async function writePulseCatalogCache(supportSlug, entries) {
    const key = `pulse_catalog_${supportSlug}`;
    const payload = { entries, ts: Date.now() };
    try {
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            await chrome.storage.local.set({ [key]: payload });
        } else {
            localStorage.setItem(key, JSON.stringify(payload));
        }
    } catch (_) { }
}

async function discoverPulseReleaseNoteCatalog(supportSlug = 'soti-mobicontrol') {
    if (PULSE_RELEASE_NOTE_CATALOG[supportSlug]?.length) return PULSE_RELEASE_NOTE_CATALOG[supportSlug];
    const cached = await readPulseCatalogCache(supportSlug);
    if (cached?.length) {
        PULSE_RELEASE_NOTE_CATALOG[supportSlug] = cached;
        return cached;
    }
    const entries = [];
    const indexUrl = `${PULSE_ORIGIN}/support/${supportSlug}/product-notes/`;
    const html = await sotiFetch(indexUrl, 12000);
    if (html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('a[href*="/product-notes/"]').forEach(a => {
            let href = (a.getAttribute('href') || '').split('?')[0];
            if (!href || href.endsWith('/product-notes/') || href.endsWith('/product-notes')) return;
            if (href.startsWith('http')) {
                try { href = new URL(href).pathname; } catch (_) { return; }
            }
            if (!href.startsWith('/support/')) href = `/support/${supportSlug}${href.startsWith('/') ? '' : '/'}${href}`;
            if (!href.includes(`/support/${supportSlug}/product-notes/`)) return;
            const label = cleanPulseText(a.textContent || '') || href.split('/').filter(Boolean).pop();
            if (!entries.some(e => e.path === href)) entries.push({ path: href, label });
        });
    }
    PULSE_RELEASE_NOTE_CATALOG[supportSlug] = entries;
    if (entries.length) await writePulseCatalogCache(supportSlug, entries);
    return entries;
}

function versionToPulseSlug(version) {
    return (version || "").replace(/\./g, "-");
}

/** Read version=… slugs from Pulse sidebar (setQueryParam) — not a fixed version list. */
function discoverPulseVersionParamVariants(html, version) {
    const slug = versionToPulseSlug(version);
    const variants = new Set([slug]);
    if (!html) return [...variants];
    const re = /setQueryParam\s*\(\s*['"]version['"]\s*,\s*['"]([^'"]+)['"]/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const param = m[1];
        if (param === slug || param.startsWith(slug + "~")) variants.add(param);
    }
    return [...variants];
}

function buildPulseVersionFetchUrls(baseUrl, version, pageHtml) {
    const base = (baseUrl || "").replace(/\?.*$/, "");
    if (!version) return [base];
    const params = discoverPulseVersionParamVariants(pageHtml, version);
    return [base, ...params.map(v => `${base}?version=${encodeURIComponent(v)}`)];
}

function isPulseBoilerplateHighlight(text) {
    const t = cleanPulseText(text).toLowerCase();
    if (!t) return true;
    if (/^download the android enterprise device agent/i.test(t)) return true;
    return t.length < 100 && /google play store|agent downloads page/i.test(t);
}

async function fetchPulseReleaseBlocksForVersion(baseUrl, queryVersions) {
    const base = (baseUrl || "").replace(/\?.*$/, "");
    const pageHtml = await sotiFetch(base, 15000);

    if (pageHtml) {
        const extracted = extractVersionsFromDOM(pageHtml);
        if (extracted && extracted.length > 0) {
            if (base.includes('android-agent')) {
                AGENT_VERSIONS = extracted;
            } else if (base.includes('soti-identity')) {
                IDENTITY_VERSIONS = extracted;
            } else if (base.includes('product-notes/release-notes') || base.includes('mobicontrol')) {
                VERSIONS = extracted;
            }
            updateVersionDropdowns();
            try {
                if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.set({ cachedVersions: { VERSIONS, AGENT_VERSIONS, IDENTITY_VERSIONS } });
                } else {
                    localStorage.setItem('soti_ai_cached_versions', JSON.stringify({ VERSIONS, AGENT_VERSIONS, IDENTITY_VERSIONS }));
                }
            } catch (e) {}
        }
    }

    const targets = Array.isArray(queryVersions) ? queryVersions : (queryVersions ? [queryVersions] : []);
    let urls = [base];
    targets.forEach(v => {
        const params = discoverPulseVersionParamVariants(pageHtml, v);
        params.forEach(p => urls.push(`${base}?version=${encodeURIComponent(p)}`));
    });
    urls = [...new Set(urls)];

    let allBlocks = [];
    const fetchPromises = urls.map(async (fetchUrl) => {
        try {
            const html = await sotiFetch(fetchUrl, 15000);
            if (!html) return [];
            return extractPulseReleaseNoteBlocks(html);
        } catch (_) {
            return [];
        }
    });
    const results = await Promise.all(fetchPromises);
    results.forEach(blocks => {
        blocks.forEach(b => {
            const exists = allBlocks.some(a => a.version === b.version && a.type === b.type && a.text === b.text);
            if (!exists) allBlocks.push(b);
        });
    });

    if (allBlocks.length === 0 && pageHtml) {
        allBlocks = extractPulseReleaseNoteBlocks(pageHtml);
    }
    
    allBlocks = allBlocks
        .map(b => (b.type === "Highlights" && isPulseBoilerplateHighlight(b.text) ? { ...b, text: "" } : b))
        .filter(b => cleanPulseText(b.text).length > 15);
                         
    return { blocks: allBlocks, fetchUrl: base };
}

function buildEffectiveIssueSummary(ci) {
    const summary = ((ci && ci.issue_summary) || ($('issueSummary') && $('issueSummary').value) || '').trim();
    if (summary) return summary;
    const notes = ((ci && ci.meeting_notes) || ($('meetingNotes') && $('meetingNotes').value) || '').trim();
    const template = 'Time of the meeting:\n\nSummary:\n\nTroubleshooting steps:\n\nNext steps:';
    if (!notes || notes === template) return '';
    const summaryMatch = notes.match(/Summary:\s*([\s\S]*?)(?=\n\s*(?:Troubleshooting steps|Next steps):|$)/i);
    if (summaryMatch && summaryMatch[1].trim()) return summaryMatch[1].trim();
    return notes.slice(0, 2500);
}

function getCaseResearchContext(query, history, ci) {
    return [
        query || '',
        history || '',
        ci?.issue_summary || '',
        ci?.meeting_notes || '',
        ci?.email_chain || '',
        ci?.product || '',
        ci?.soti_version || '',
        ci?.agent_version || ''
    ].join('\n');
}

function isUsefulPulseResearchLink(href, text) {
    if (!href) return false;
    const u = href.toLowerCase().replace(/\/$/, '');
    const label = (text || '').trim();
    if (!label || /^product support$/i.test(label)) return false;
    if (/\/support\/soti-mobicontrol$/.test(u) || /\/support\/soti-identity$/.test(u)) return false;
    return /product-notes|\/articles\/|\/help\/|\/videos\/|\/faqs\/|certified-devices|android-agent|release-notes/i.test(u);
}

function extractDeepResearchArticle(doc) {
    doc.querySelectorAll('script, style, nav, footer, header, svg, path, iframe, link, form').forEach(el => el.remove());
    const root = doc.querySelector('main, article, .umb-block-grid, [role="main"]') || doc.body;
    if (!root) return '';
    let article = '';
    root.querySelectorAll('h1, h2, h3, h4, p, li, td, strong').forEach(el => {
        const t = (el.innerText || el.textContent || '').trim();
        if (t && t.length > 2) article += t + '\n';
    });
    return article.trim();
}

function isLowQualityResearchArticle(text) {
    const t = (text || '').toLowerCase();
    if (t.length < 120) return true;
    const noise = ['choose login type', 'reset your password', 'verify your email', 'recaptcha', 'privacy policy', 'terms of service', 'soti customers', 'download soti mobicontrol installer'];
    const hits = noise.filter(p => t.includes(p)).length;
    return hits >= 2;
}

function parseRequestedVersions(query, history, ci) {
    const fromQuery = [...new Set((query.match(/\b((?:20\d\d|\d{2})\.\d+(?:\.\d+)*)\b/g) || []))];
    if (fromQuery.length) return fromQuery;
    const caseText = [ci?.meeting_notes, ci?.issue_summary, ci?.email_chain, history].filter(Boolean).join('\n');
    const caseMatches = caseText.match(/\b((?:20\d\d|\d{2})\.\d+(?:\.\d+)*)\b/g) || [];
    const fromCase = [...new Set(caseMatches.reverse())];
    if (fromCase.length) return fromCase;
    const historyMatches = history.match(/\b((?:20\d\d|\d{2})\.\d+(?:\.\d+)*)\b/g) || [];
    const fromHistory = [...new Set(historyMatches.reverse())];
    if (fromHistory.length) return fromHistory.slice(0, 2);
    const combined = `${query} ${history}`.toLowerCase();
    const asksAgent = /\b(android|agent|aea|device agent)\b/.test(combined);
    if (ci) {
        if (asksAgent && ci.agent_version) {
            const m = ci.agent_version.match(/\b((?:20\d\d|\d{2})\.\d+(?:\.\d+)*)\b/);
            if (m) return [m[1]];
        }
        if (ci.soti_version) {
            const m = ci.soti_version.match(/\b((?:20\d\d|\d{2})\.\d+(?:\.\d+)*)\b/);
            if (m) return [m[1]];
        }
    }
    return [];
}

function selectReleaseNoteSources(query, history, ci, catalog) {
    const combined = `${query || ''} ${history || ''} ${ci?.product || ''} ${ci?.soti_version || ''} ${ci?.agent_version || ''}`.toLowerCase();
    const sources = [];
    const addPath = (path, type) => {
        const normalized = path.startsWith('http') ? path : `${PULSE_ORIGIN}${path.startsWith('/') ? path : '/' + path}`;
        if (!sources.some(s => s.url === normalized)) sources.push({ url: normalized, type });
    };

    // Known full fallback paths for each product (used when catalog lookup fails)
    const FALLBACK_PATHS = {
        'release-notes':                '/support/soti-mobicontrol/product-notes/release-notes/',
        'android-agent-release-notes':  '/support/soti-mobicontrol/product-notes/android-agent-release-notes/',
        'ios-agent-release-notes':      '/support/soti-mobicontrol/product-notes/ios-agent-release-notes/',
        'linux-agent-release-notes':    '/support/soti-mobicontrol/product-notes/linux-agent-release-notes/',
        'macos-agent-release-notes':    '/support/soti-mobicontrol/product-notes/macos-agent-release-notes/',
        'soti-surf-release-notes':      '/support/soti-mobicontrol/product-notes/soti-surf-release-notes/',
        'soti-hub-release-notes':       '/support/soti-mobicontrol/product-notes/soti-hub-release-notes/',
        'settings-manager-release-notes':'/support/soti-mobicontrol/product-notes/settings-manager-release-notes/',
        'cloud-link-release-notes':     '/support/soti-mobicontrol/product-notes/cloud-link-release-notes/',
        'android-companion':            '/support/soti-mobicontrol/product-notes/android-companion/',
        'stella':                       '/support/soti-mobicontrol/product-notes/stella/'
    };

    const addByFragment = (fragment, type) => {
        const entry = catalog.find(e => e.path.includes(fragment));
        if (entry) addPath(entry.path, type);
        else if (FALLBACK_PATHS[fragment]) addPath(FALLBACK_PATHS[fragment], type);
        else addPath(`/support/soti-mobicontrol/product-notes/${fragment}/`, type);
    };

    if (/identity/.test(combined) || (ci?.product || '').toLowerCase().includes('identity')) {
        addPath('/support/soti-identity/release-notes/', 'Identity');
        return sources;
    }

    const rules = [
        { rx: /\b(ios|iphone|ipad)\b/, fragment: 'ios-agent-release-notes', type: 'iOS Agent' },
        { rx: /\b(linux)\b/, fragment: 'linux-agent-release-notes', type: 'Linux Agent' },
        { rx: /\b(macos|mac\s*os)\b/, fragment: 'macos-agent-release-notes', type: 'macOS Agent' },
        { rx: /\b(soti\s+surf|surf\s+client)\b/, fragment: 'soti-surf-release-notes', type: 'SOTI Surf' },
        { rx: /\b(soti\s+hub)\b/, fragment: 'soti-hub-release-notes', type: 'SOTI Hub' },
        { rx: /\b(settings\s+manager)\b/, fragment: 'settings-manager-release-notes', type: 'Settings Manager' },
        { rx: /\b(cloud\s*link)\b/, fragment: 'cloud-link-release-notes', type: 'Cloud Link' },
        { rx: /\b(companion)\b/, fragment: 'android-companion', type: 'Android Companion' },
        { rx: /\b(stella)\b/, fragment: 'stella', type: 'Stella' },
        { rx: /\b(android|aea|device agent|play store agent)\b/, fragment: 'android-agent-release-notes', type: 'Agent' },
        { rx: /\b(console|server|management service|mc\s+version|soti\s+version|mobicontrol)\b/, fragment: 'release-notes', type: 'Console' }
    ];
    rules.forEach(rule => {
        if (rule.rx.test(combined)) addByFragment(rule.fragment, rule.type);
    });

    // Only add baseline if no product-specific sources were matched to avoid mixing release notes
    if (sources.length === 0) {
        addByFragment('release-notes', 'Console');
        addByFragment('android-agent-release-notes', 'Agent');
    }

    return sources;
}

// --- OFFLINE PULSE KNOWLEDGE BASE (indexed RAG over the knowledge/*.md corpus) ---
// Multi-product: PulseKnowledge.md is a large MobiControl scrape; Connect_Knowledge.md and
// XSight_Knowledge.md add curated, sourced SOTI Connect / XSight content so those products
// are covered too. All files are indexed ONCE per session (chunk split + lowercase
// precompute), then searched instantly on every query.
const PulseKB = {
    chunks: null,        // [{ text, lower, firstLine, product }]
    indexing: null,      // memoized in-flight promise

    // The corpus files to index, with a default product slug applied to every article in the
    // file (the per-article title/Source detection can still override the default to '').
    KB_FILES: [
        { path: 'knowledge/PulseKnowledge.md', product: '' },
        { path: 'knowledge/Connect_Knowledge.md', product: 'connect' },
        { path: 'knowledge/XSight_Knowledge.md', product: 'xsight' }
    ],

    // Parse one corpus string into tagged article chunks and append to `out`.
    _ingest(raw, defaultProduct, out) {
        if (!raw) return;
        const parts = raw.split('\n# '); // fast native chunking (vs regex on a 24MB string)
        for (let i = 0; i < parts.length; i++) {
            const text = parts[i].startsWith('#') ? parts[i] : '# ' + parts[i];
            if (text.length < 30) continue;
            const lower = text.toLowerCase();
            const title = lower.split('\n', 1)[0] || '';
            // Tag each article with its product. PulseKnowledge.md is scraped almost entirely
            // from MobiControl docs, so the Source URL is a poor discriminator — the TITLE is
            // the real signal (e.g. "# SOTI Connect ..."). Title first, then Source URL, then
            // the file's default product. This lets a "SOTI Connect" question surface Connect
            // articles instead of MobiControl ones that merely share a word like "enroll".
            let product = '';
            if (/\bxsight\b/.test(title)) product = 'xsight';
            else if (/\bsoti connect\b/.test(title)) product = 'connect';
            else if (/\bsoti identity\b/.test(title)) product = 'identity';
            else {
                const srcMatch = lower.slice(0, 400).match(/source:[^\n]*soti-(mobicontrol|connect|xsight|identity|assist|snap)/);
                product = srcMatch ? srcMatch[1] : (defaultProduct || '');
            }
            out.push({ text, lower, firstLine: title, product });
        }
    },

    async ensureIndex() {
        if (this.chunks) return this.chunks;
        if (this.indexing) return this.indexing;
        this.indexing = (async () => {
            const t0 = performance.now();
            const chunks = [];
            for (const file of this.KB_FILES) {
                let raw = '';
                try {
                    const url = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
                        ? chrome.runtime.getURL(file.path) : file.path;
                    const res = await fetch(url, { cache: 'no-store' });
                    if (res.ok) raw = await res.text();
                } catch (e) { console.warn('PulseKB: failed to load', file.path, e); }
                // Fallback to synced storage for the main MobiControl corpus only.
                if (!raw && file.path.includes('PulseKnowledge')) {
                    try {
                        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                            const d = await chrome.storage.local.get('pulseKnowledgeData');
                            raw = d.pulseKnowledgeData || '';
                        } else {
                            raw = localStorage.getItem('soti_pulse_knowledge') || '';
                        }
                    } catch (e) { console.warn('PulseKB: storage fallback failed', e); }
                }
                this._ingest(raw, file.product, chunks);
                raw = null; // release (PulseKnowledge.md is ~24MB)
            }
            this.chunks = chunks;
            if (!chunks.length) console.log('PulseKB: no offline knowledge found. Sync via Settings.');
            else console.log(`PulseKB: indexed ${chunks.length} articles from ${this.KB_FILES.length} file(s) in ${Math.round(performance.now() - t0)}ms`);
            return this.chunks;
        })();
        return this.indexing;
    },

    // Score + retrieve top article excerpts. Same proven scorer as before, plus
    // product-name and log-signature bonuses for log-analysis mode.
    search(queryLower, kws, opts = {}) {
        const { product = '', productHints = [], signatureTerms = [], maxArticles = 15, maxChars = 24000, perChunkCap = 6000 } = opts;
        if (!this.chunks || this.chunks.length === 0 || !kws || kws.length === 0) return [];
        const target = (product || '').toLowerCase();          // target product SLUG (e.g. "connect")
        const prodLower = productHints.map(p => (p || '').toLowerCase()).filter(Boolean);
        const sigLower = signatureTerms.map(s => (s || '').toLowerCase()).filter(s => s.length > 2);
        const cleanQuery = queryLower.replace(/[^a-z0-9#\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const wantsEnrol = /\b(enrol|enroll|provision|work\s*managed|fully\s*managed|android)\b/.test(queryLower);
        const scored = [];
        for (const chunk of this.chunks) {
            const { text, lower, firstLine } = chunk;
            let score = 0;
            let uniqueHits = 0;
            let matchedAny = false;
            for (const k of kws) {
                if (lower.includes(k)) {
                    matchedAny = true;
                    score += 1;
                    uniqueHits++;
                    let regex;
                    try { regex = new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'ig'); } catch (e) {}
                    const matches = regex ? lower.match(regex) : null;
                    if (matches && matches.length > 0) score += 1 + Math.min(matches.length, 5);
                    if (firstLine.includes(k)) score += 5; // title match bonus
                }
            }
            if (!matchedAny) continue;
            score += (uniqueHits * uniqueHits * 3); // reward matching several distinct keywords
            // Soft product relevance (NOT a hard filter — the KB is mostly MobiControl, so a
            // hard gate would wipe out everything for a Connect/XSight question). Strongly
            // favour articles whose product matches; lightly penalise a DIFFERENT explicit
            // product so an XSight page can't answer a Connect question.
            if (target) {
                if (chunk.product === target) score += 40;
                else if (chunk.product && ['xsight', 'connect', 'identity'].includes(chunk.product)) score -= 20;
            }
            for (const p of prodLower) {
                if (firstLine.includes(p)) score += 8;
                else if (lower.includes(p)) score += 4;
            }
            for (const s of sigLower) { if (lower.includes(s)) score += 4; }
            // High-value enrollment token: afw#mobicontrol is THE work-managed enrolment string.
            if (wantsEnrol && lower.includes('afw#')) score += 20;
            if (score >= 5) {
                const cleanChunk = lower.replace(/[^a-z0-9#\s]/g, ' ').replace(/\s+/g, ' ');
                if (cleanQuery.length > 6 && cleanChunk.includes(cleanQuery)) score += 50; // exact phrase
                else {
                    if (cleanChunk.includes('work managed') && cleanQuery.includes('work managed')) score += 30;
                    if (cleanChunk.includes('android enterprise') && cleanQuery.includes('android enterprise')) score += 20;
                }
                if (lower.length > 2000) score -= Math.floor((lower.length - 2000) / 500) * 2; // bloat penalty
                if (/\b(how|step|guide|procedure|enrol)\b/.test(queryLower) && /\b(procedure|steps?|instructions?|about this task)\b/.test(lower)) score += 25;
            }
            if (score > 0) scored.push({ text, lower, score });
        }
        scored.sort((a, b) => b.score - a.score);
        const out = [];
        let budget = maxChars;
        for (let i = 0; i < Math.min(scored.length, maxArticles); i++) {
            const c = PulseKB._excerpt(scored[i].text, scored[i].lower, kws, perChunkCap);
            if (c.length < 30) continue;
            if (budget - c.length < 0 && out.length >= Math.min(3, maxArticles)) break;
            out.push(c);
            budget -= c.length;
        }
        return out;
    },

    // Trim a long article to `cap` chars but ALWAYS keep the title and a window around the
    // first relevant keyword (or the afw# enrolment token) — so the answer-bearing text
    // survives instead of being cut off by a blind head-truncation.
    _excerpt(text, lower, kws, cap) {
        text = text.trim();
        if (text.length <= cap) return text;
        const nl = text.indexOf('\n');
        const title = nl > 0 ? text.slice(0, nl + 1) : '';
        let pos = -1;
        const consider = i => { if (i >= 0 && (pos < 0 || i < pos)) pos = i; };
        for (const k of kws) consider(lower.indexOf(k, title.length));
        consider(lower.indexOf('afw#', title.length));
        if (pos < 0) return text.slice(0, cap) + '\n…[truncated]';
        const start = Math.max(title.length, pos - 700);
        const body = text.slice(start, start + Math.max(200, cap - title.length));
        return title + (start > title.length ? '…' : '') + body + (start + body.length < text.length ? '…' : '');
    }
};

async function searchPulseAndDocs(query, msgs, ci) {
    try {
        PULSE_SEARCH_RESULTS = ""; DOCS_SEARCH_RESULTS = ""; RESEARCHED_ARTICLE_CONTENT = ""; RELEASE_NOTES_CONTENT = "";
        const qLower = query.toLowerCase();
        const history = (msgs || []).map(m => m.content.toLowerCase()).join(' ');
        const caseBlob = getCaseResearchContext(query, history, ci);
        
        const asksIdentity = qLower.includes('identity') || (ci && ci.product === 'SOTI Identity');
        
        const isListingAll = /\b(list\s*all|show\s*all|all\s*release\s*notes|resolved\s*issues|all\s*issues|full\s*list|all\s*of\s*them|all\s*them|list\s*them)\b/i.test(qLower) ||
                             /\b(list\s*all|show\s*all|all\s*release\s*notes|resolved\s*issues|all\s*issues|full\s*list|all\s*of\s*them|all\s*them|list\s*them)\b/i.test(history);
        
        const asksReleaseNotes = isListingAll || 
                                 /\b(release\s*notes?|product\s*notes?|what'?s\s+new|whats\s+new|changelog|release\s*highlights?|resolved\s*issues?|known\s*issues?|fixed\s+in|fixed\s+since)\b/i.test(qLower) ||
                                 /\b(mcmr[\s-]*\d+)\b/i.test(qLower);

        const isTroubleshoot = /\b(how\s+do|how\s+to|error|fail|broken|issue|troubleshoot|cannot|unable|configure|setup|install|database|sql|port|certificate|ca|disconnect|offline|enroll|license|sync|crash|freeze|slow|bug)\b/i.test(qLower) || 
                               (qLower.split(/\s+/).length > 6 && !asksReleaseNotes);
        
        // Only fetch release notes if explicitly requested or if investigating a hard error/bug where a known issue might exist
        const shouldFetchReleaseNotes = asksReleaseNotes || /\b(error|fail|broken|crash|bug|issue)\b/i.test(qLower);
        const shouldDoWebSearch = isTroubleshoot || asksReleaseNotes;

        let charBudget = 0;
        if (isListingAll) charBudget = 40000;
        else if (asksReleaseNotes) charBudget = 20000;
        else if (isTroubleshoot) charBudget = 10000;

        if (shouldFetchReleaseNotes && charBudget > 0) {
            let notes = [];
            const catalog = asksIdentity
                ? []
                : await discoverPulseReleaseNoteCatalog('soti-mobicontrol');
            const pulseSources = asksIdentity
                ? [{ url: `${PULSE_ORIGIN}/support/soti-identity/release-notes/`, type: 'Identity' }]
                : selectReleaseNoteSources(query, history, ci, catalog);

            for (const { url, type } of pulseSources) {
                toast(`Fetching ${type} notes from Pulse...`, 'i');
                
                const queryVersionsEarly = parseRequestedVersions(query, history, ci);
                const pulseLoad = await fetchPulseReleaseBlocksForVersion(url, queryVersionsEarly);
                const blocks = pulseLoad.blocks;
                const resolvedUrl = pulseLoad.fetchUrl;
                if (blocks.length) {
                    // Score each version block by keyword overlap & requested versions
                    const stopWords = new Set(['what', 'where', 'how', 'when', 'there', 'is', 'are', 'was', 'were', 'the', 'and', 'with', 'some', 'having', 'issues', 'this', 'that', 'they', 'their', 'them', 'from', 'into', 'your', 'will', 'would', 'could', 'should', 'about', 'doing', 'it', 'for']);
                    const queryWords = query.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w));
                    
                    const queryVersions = parseRequestedVersions(query, history, ci);
                    const primaryVersion = queryVersions[0] || null;
                    const queryYears = query.match(/\b(20\d\d)\b/g) || [];
                    
                    // Release Notes generic query fallback — use live Pulse version lists (no static version table)
                    if (queryVersions.length === 0 && asksReleaseNotes) {
                        const pageVersions = [...new Set(blocks.map(b => b.version))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
                        if (pageVersions.length > 0) queryVersions.push(pageVersions[0]);
                        else if (type === 'Agent' && AGENT_VERSIONS.length > 0) queryVersions.push(AGENT_VERSIONS[0]);
                        else if (type === 'Identity' && IDENTITY_VERSIONS.length > 0) queryVersions.push(IDENTITY_VERSIONS[0]);
                        else if (VERSIONS.length > 0) queryVersions.push(VERSIONS[0]);
                    }
                    
                    const scoredBlocks = blocks.map(b => {
                        let score = 0;
                        const bTextLower = b.text.toLowerCase();
                        
                        if (primaryVersion) {
                            if (b.version === primaryVersion) score += 500;
                            else score -= 800;
                        }
                        for (const qv of queryVersions) {
                            if (b.version === qv) score += 200;
                            else if (b.version.startsWith(qv)) score += 100;
                        }
                        
                        // Year Boost
                        for (const qy of queryYears) {
                            if (b.version.startsWith(qy)) {
                                score += 50;
                            }
                        }
                        
                        // Keyword Overlap
                        for (const word of queryWords) {
                            if (bTextLower.includes(word)) {
                                score += 10;
                                const occurrences = (bTextLower.split(word).length - 1);
                                score += Math.min(occurrences, 5);
                            }
                        }
                        
                        // Intent-based type boost
                        const hasFixKeywords = /\b(fix|fixed|bug|mcmr|resolve|resolved|issue|error|exception|crash|prevent|correct|correctly|release\s*notes?|changelog|list|show|all|more|them)\b/i.test(qLower) || 
                                               /\b(fix|fixed|bug|mcmr|resolve|resolved|issue|error|exception|crash|prevent|correct|correctly|release\s*notes?|changelog|list|show|all|more|them)\b/i.test(history);
                        
                        const hasHighlightKeywords = /\b(feature|highlight|improvement|whatsnew|what's\s+new)\b/i.test(qLower) ||
                                                     /\b(feature|highlight|improvement|whatsnew|what's\s+new)\b/i.test(history);
                                                     
                        if (hasHighlightKeywords && b.type === 'Highlights') {
                            score += 1000;
                        } else if (hasFixKeywords && b.type === 'Resolved Issues') {
                            score += 1000; // Prioritize resolved issues over highlights
                        } else if (asksReleaseNotes && b.type === 'Resolved Issues') {
                            score += 800; // Prioritize resolved issues for any release notes search by default
                        }
                        
                        return { block: b, score: score };
                    });
                    
                    // Score tie-breaking
                    scoredBlocks.sort((a, b) => {
                        if (b.score !== a.score) return b.score - a.score;
                        const vComp = b.block.version.localeCompare(a.block.version, undefined, { numeric: true });
                        if (vComp !== 0) return vComp;
                        if (a.block.type === 'Resolved Issues' && b.block.type === 'Highlights') return -1;
                        if (a.block.type === 'Highlights' && b.block.type === 'Resolved Issues') return 1;
                        return 0;
                    });
                    
                    const activeCase = typeof cases !== 'undefined' ? cases.find(x => x.id === activeCaseId) : null;
                    const hasLogs = (activeCase && activeCase.logs && activeCase.logs.length > 0) || history.includes('[diagnostic data') || history.includes('=== file:');

                    // Adjust local budget if logs are present
                    let localBudget = charBudget;
                    if (hasLogs) localBudget = Math.min(localBudget, 12000);
                    
                    let clean = "";
                    let includedCount = 0;
                    const highestScore = scoredBlocks[0]?.score || 0;
                    const strictVersionFilter = !!primaryVersion;
                    
                    if (primaryVersion) {
                        clean += `\n[USER REQUESTED VERSION: ${primaryVersion}]\n`;
                    }
                    
                    const includedVersions = new Set();
                    for (const sb of scoredBlocks) {
                        if (strictVersionFilter && sb.block.version !== primaryVersion) continue;
                        if (sb.score < 0) continue;
                        
                        // Limit to top 3 versions if no specific version is requested, to keep local inference fast.
                        if (!strictVersionFilter) {
                            if (!includedVersions.has(sb.block.version) && includedVersions.size >= 3) {
                                continue;
                            }
                        }
                        
                        // Skip irrelevant older blocks if we have high-scoring ones
                        if (!strictVersionFilter && sb.score === 0 && includedCount >= 2 && highestScore > 0) {
                            continue;
                        }
                        
                        const formatBlock = `\n### VERSION ${sb.block.version} - ${sb.block.type.toUpperCase()}:\n${sb.block.text}\n`;
                        if (clean.length + formatBlock.length <= localBudget) {
                            clean += formatBlock;
                            includedVersions.add(sb.block.version);
                            includedCount++;
                        } else {
                            if (sb.score >= 100 && clean.length < (localBudget * 0.4)) {
                                const remaining = localBudget - clean.length;
                                clean += `\n### VERSION ${sb.block.version} - ${sb.block.type.toUpperCase()} (TRUNCATED):\n${sb.block.text.slice(0, remaining - 100)}\n`;
                                includedVersions.add(sb.block.version);
                                includedCount++;
                            }
                            break;
                        }
                    }
                    
                    if (clean.length > 200) {
                        notes.push(`[SOTI PULSE ${type.toUpperCase()} DATA]\nOfficial source: ${resolvedUrl}\n${clean}`);
                        toast(`✓ ${type} RAG Context Loaded`, 's');
                    }
                }
            }
            
            if (notes.length > 0) {
                RELEASE_NOTES_CONTENT = notes.join('\n\n---\n\n');
            } else if (asksReleaseNotes) {
                toast('Autonomous Research failed', 'w');
                RELEASE_NOTES_CONTENT = "ERROR: Failed to fetch release notes from SOTI Pulse (network error or page not found).";
            }
        }
            
        if (shouldDoWebSearch) {
            const stopWords = new Set(['what', 'where', 'how', 'when', 'there', 'is', 'are', 'was', 'were', 'the', 'and', 'with', 'some', 'having', 'issues', 'this', 'that', 'they', 'their', 'them', 'from', 'into', 'your', 'will', 'would', 'could', 'should', 'about', 'some', 'doing', 'doing', 'it', 'for', 'give', 'short', 'subject', 'name', 'meeting', 'notes', 'critical', 'investigation', 'soti']);
            const combinedLower = caseBlob.toLowerCase();
            // ONLY use the current query for keywords to prevent history from poisoning the search results
            let keywordParts = qLower.split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w));
            const seenKw = new Set();
            keywordParts = keywordParts.filter(w => { if (seenKw.has(w)) return false; seenKw.add(w); return true; });

            // Detect which SOTI product the QUESTION is about (query first, then case info), and
            // retrieve only that product's articles. This stops a "SOTI Connect" question from
            // pulling MobiControl content, and vice-versa.
            let targetProduct = '';
            if (/\bx[\s-]?sight\b/i.test(qLower)) targetProduct = 'xsight';
            else if (/\bconnect\b/i.test(qLower)) targetProduct = 'connect';
            else if (/\bidentity\b/i.test(qLower)) targetProduct = 'identity';
            else if (/\b(mobicontrol|mobi\s?control|deployment\s+server|management\s+service)\b/i.test(qLower)) targetProduct = 'mobicontrol';
            else if (ci && ci.product) {
                const p = String(ci.product).toLowerCase();
                if (p.includes('xsight')) targetProduct = 'xsight';
                else if (p.includes('connect')) targetProduct = 'connect';
                else if (p.includes('identity')) targetProduct = 'identity';
                else if (p.includes('mobicontrol')) targetProduct = 'mobicontrol';
            }
            // Only nudge MobiControl-specific terms when the question is actually MobiControl
            // (or unspecified) — never when it explicitly names Connect/XSight/Identity.
            if ((targetProduct === 'mobicontrol' || targetProduct === '')) {
                if (/\b(enroll|enrolment|enrollment|afw#|android\s+enterprise|work\s+managed)\b/i.test(qLower) && !keywordParts.includes('enrollment')) keywordParts.unshift('enrollment');
            }
            if (/\bcertificate|cert\b/i.test(qLower) && !keywordParts.includes('certificate')) keywordParts.unshift('certificate');
            const keywords = keywordParts.slice(0, 6).join('%20');

            if (keywords) {
                const kws = keywordParts.filter(kw => kw.length > 2);
                await PulseKB.ensureIndex();
                // Strict character limit prevents LLM context truncation — truncation
                // causes the LLM to lose the system prompt and hallucinate!
                const relevantChunks = PulseKB.search(qLower, kws, {
                    product: targetProduct,
                    productHints: ci && ci.product ? [ci.product] : [],
                    maxArticles: 15,
                    maxChars: 24000
                });
                if (relevantChunks.length > 0) {
                    RESEARCHED_ARTICLE_CONTENT = "[OFFLINE PULSE KNOWLEDGE MATCHES]:\n\n" + relevantChunks.join('\n\n---\n\n');
                    DOCS_SEARCH_RESULTS = "Data retrieved from local Pulse Knowledge Base.";
                }
            }
        }
    } catch (e) { console.warn('Research failed', e); }
}

function extractVersionsFromDOM(html) {
    if (!html) return [];
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, nav, footer, svg, path, iframe, link').forEach(el => el.remove());
    const versions = new Set();
    const vRx = /\b((?:20\d\d|\d{2})\.\d+(?:\.\d+)*)\b/;
    doc.querySelectorAll('h1.release-note-h1, h1[class*="release-note"], h4').forEach(el => {
        const match = (el.textContent || '').match(vRx);
        if (match) versions.add(match[1]);
    });
    doc.querySelectorAll('[onclick*="setQueryParam"]').forEach(el => {
        const match = (el.textContent || '').match(vRx);
        if (match) versions.add(match[1]);
    });
    if (versions.size === 0) {
        const bodyText = doc.body ? doc.body.textContent : '';
        (bodyText.match(/\b((?:20\d\d|\d{2})\.\d+(?:\.\d+)*)\b/g) || []).forEach(v => versions.add(v));
    }
    return [...versions].sort((x, y) => y.localeCompare(x, undefined, { numeric: true }));
}

async function fetchLatestSOTIVersions() {
    const mcCatalog = await discoverPulseReleaseNoteCatalog('soti-mobicontrol');
    const consolePath = mcCatalog.find(e => e.path.includes('product-notes/release-notes'))?.path
        || '/support/soti-mobicontrol/product-notes/release-notes/';
    const agentPath = mcCatalog.find(e => e.path.includes('android-agent-release-notes'))?.path
        || '/support/soti-mobicontrol/product-notes/android-agent-release-notes/';

    const [consoleHtml, agentHtml, identityHtml] = await Promise.all([
        sotiFetch(`${PULSE_ORIGIN}${consolePath}`, 15000),
        sotiFetch(`${PULSE_ORIGIN}${agentPath}`, 15000),
        sotiFetch(`${PULSE_ORIGIN}/support/soti-identity/release-notes/`, 15000)
    ]);

    if (consoleHtml) {
        const consoleVers = extractVersionsFromDOM(consoleHtml);
        if (consoleVers && consoleVers.length > 0) VERSIONS = consoleVers;
    }
    if (agentHtml) {
        const agentVers = extractVersionsFromDOM(agentHtml);
        if (agentVers && agentVers.length > 0) AGENT_VERSIONS = agentVers;
    }
    if (identityHtml) {
        const identityVers = extractVersionsFromDOM(identityHtml);
        if (identityVers && identityVers.length > 0) IDENTITY_VERSIONS = identityVers;
    }
    
    updateVersionDropdowns();

    // Cache the successfully loaded versions to storage to prevent startup race conditions
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            await chrome.storage.local.set({ cachedVersions: { VERSIONS, AGENT_VERSIONS, IDENTITY_VERSIONS } });
        } else {
            localStorage.setItem('soti_ai_cached_versions', JSON.stringify({ VERSIONS, AGENT_VERSIONS, IDENTITY_VERSIONS }));
        }
    } catch (e) {
        console.error('Failed to cache versions:', e);
    }
}

// The 2026.0 GA build is written two ways across SOTI: MobiControl/Connect/SNAP list it as
// "2026.0.0"; SOTI XSight and Salesforce use "2026.0". Map one format to the other.
function equivalentSotiVersion(v) {
    if (v === '2026.0.0') return '2026.0';
    if (v === '2026.0') return '2026.0.0';
    return '';
}

// Select `desired` in a version <select>, falling back to its format-equivalent (above) when
// the exact string isn't an option for the currently selected product. Used both when
// rebuilding the dropdowns and when applying a value pushed programmatically (Salesforce sync).
function applyVersionSelection(selectId, desired) {
    if (!desired) return;
    const el = $(selectId);
    if (!el) return;
    const opts = Array.from(el.options || []).map(o => o.value);
    if (opts.includes(desired)) { el.value = desired; return; }
    const alt = equivalentSotiVersion(desired);
    if (alt && opts.includes(alt)) el.value = alt;
}

function updateVersionDropdowns() {
    const prod = $('product').value;
    let sotiOpts = VERSIONS;
    let agentOpts = AGENT_VERSIONS;

    if (prod === 'SOTI Identity') {
        sotiOpts = IDENTITY_VERSIONS;
        agentOpts = []; // Identity doesn't have an 'Agent' version in this context
    } else if (prod === 'SOTI XSight') {
        // SOTI XSight must show the 2-part "2026.0" so the value matches what
        // "Sync from Salesforce" pushes for XSight. The MobiControl release-notes scrape
        // (reused here) lists the GA build as "2026.0.0", so fold that entry down to
        // "2026.0" and dedup. VERSIONS itself is left untouched.
        sotiOpts = [...new Set(sotiOpts.map(v => v === '2026.0.0' ? '2026.0' : v))];
    } else {
        // Every other product (MobiControl, Connect, SNAP) uses the full release-notes
        // format: the 2026.0 GA build must read "2026.0.0". Fold any 2-part "2026.0" up to
        // "2026.0.0" and dedup, so it's correct even if the scrape or cache holds the short
        // form. VERSIONS itself is left untouched.
        sotiOpts = [...new Set(sotiOpts.map(v => v === '2026.0' ? '2026.0.0' : v))];
    }

    // Preserve the current selections across the rebuild. The live Pulse fetch calls this a
    // few seconds after load (and again when release blocks arrive); without re-applying the
    // value, that async rebuild silently wipes the restored/selected version — which looked
    // like "I have to keep reloading before the SOTI Version sticks". Re-apply if still a
    // valid option; if the product changed so the old value no longer applies, it clears.
    const prevSoti = $('sotiVer').value;
    const prevAgent = $('agentVer').value;

    $('sotiVer').innerHTML = '<option value="">— Select —</option>' + sotiOpts.map(v => `<option value="${v}">${v}</option>`).join('');
    // Re-apply the prior selection, mapping the 2026.0 GA build across formats when the
    // product changed (e.g. "2026.0.0" -> "2026.0" when you pick XSight) so it updates in
    // real time instead of blanking out.
    applyVersionSelection('sotiVer', prevSoti);

    if (agentOpts.length > 0) {
        $('agentVer').innerHTML = '<option value="">— Select —</option>' + agentOpts.map(v => `<option value="${v}">${v}</option>`).join('');
        applyVersionSelection('agentVer', prevAgent);
    } else {
        $('agentVer').innerHTML = '<option value="">N/A</option>';
    }
}

// NOTE: do NOT assign $('product').onchange here — the BOOT section's generic field-wiring
// loop (search "el.onchange = onFieldCommit") runs later and would silently overwrite it.
// That loop is where the product-change → updateVersionDropdowns() rebuild lives.

// --- AI ENGINE (LOCAL — OLLAMA) ---
let LOCAL_AI_URL = 'http://127.0.0.1:11434';
let LOCAL_AI_MODEL = '';
let LOCAL_AI_MODELS = [];
let LOCAL_AI_CTX_MAX = 'auto'; // user cap for num_ctx: 'auto' or a number (as string)
const MODEL_CTX_CACHE = new Map(); // model name → native context_length from /api/show

// Probe Ollama for the model's true context window (e.g. gemma e2b/e4b = 131072).
// Cached in memory + chrome.storage so the probe runs once per model.
async function getModelContextLength(model) {
    const FALLBACK = 16384; // legacy behaviour if /api/show is unavailable
    if (!model) return FALLBACK;
    if (MODEL_CTX_CACHE.has(model)) return MODEL_CTX_CACHE.get(model);
    try {
        const baseUrl = LOCAL_AI_URL.replace(/\/$/, '');
        const res = await fetch(`${baseUrl}/api/show`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model })
        });
        if (res.ok) {
            const info = await res.json();
            const mi = info.model_info || {};
            // Key is architecture-prefixed (e.g. "gemma3.context_length") — match by suffix
            const key = Object.keys(mi).find(k => k.endsWith('.context_length'));
            const len = key ? parseInt(mi[key], 10) : 0;
            if (len && len >= 2048) {
                MODEL_CTX_CACHE.set(model, len);
                try {
                    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                        const stored = await chrome.storage.local.get('modelCtxCache');
                        const cache = stored.modelCtxCache || {};
                        cache[model] = len;
                        await chrome.storage.local.set({ modelCtxCache: cache });
                    }
                } catch (e) { /* cache persistence is best-effort */ }
                return len;
            }
        }
    } catch (e) {
        console.warn('[Ollama] /api/show failed for', model, e);
    }
    MODEL_CTX_CACHE.set(model, FALLBACK);
    return FALLBACK;
}

// Resolve the effective num_ctx ceiling: min(model's native window, user setting; 'auto' → 65536)
async function getHardCtxMax(model) {
    const modelMax = await getModelContextLength(model);
    const userCap = (LOCAL_AI_CTX_MAX && LOCAL_AI_CTX_MAX !== 'auto') ? (parseInt(LOCAL_AI_CTX_MAX, 10) || 65536) : 65536;
    return { modelMax, userCap, hardMax: Math.max(2048, Math.min(modelMax, userCap)) };
}

// Small / CPU-bound models (2b, e2b, e4b, 7b…). On CPU these are slow per token, so
// they get compact prompts and small contexts for fast, reliable analysis.
function isSmallLocalModel() {
    return !!(LOCAL_AI_MODEL && /(0\.5b|1\.5b|1b|2b|3b|4b|mini|3\.2|7b|8b|9b|e2b|e4b)/i.test(LOCAL_AI_MODEL));
}

// The SINGLE num_ctx used for every request to a given model. Ollama re-allocates the KV
// cache (≈ a full model reload — many seconds on a CPU) whenever num_ctx changes between
// requests, so we keep it CONSTANT for the whole session: the model loads once and stays
// warm. num_predict still varies per task (it does NOT trigger a reload).
async function getSessionCtx(model) {
    const { hardMax } = await getHardCtxMax(model);
    const small = /(0\.5b|1\.5b|1b|2b|3b|4b|mini|3\.2|7b|8b|9b|e2b|e4b)/i.test(model || '');
    if (LOCAL_AI_CTX_MAX && LOCAL_AI_CTX_MAX !== 'auto') return hardMax;
    return small ? Math.min(8192, hardMax) : Math.min(32768, hardMax);
}

// Preload the model at the session num_ctx so the user's FIRST query is already warm
// (avoids paying the model-load cost on the first real request). Best-effort, non-blocking.
async function warmUpModel() {
    if (!LOCAL_AI_MODEL) return;
    try {
        const sessionCtx = await getSessionCtx(LOCAL_AI_MODEL);
        const isThinking = /gemma4|gemma-4|gemma3|gemma-3|e2b|e4b|qwq|r1|think|reason/i.test(LOCAL_AI_MODEL);
        await fetch(`${LOCAL_AI_URL.replace(/\/$/, '')}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: LOCAL_AI_MODEL,
                messages: [{ role: 'user', content: 'ok' }],
                stream: false,
                keep_alive: -1,
                ...(isThinking ? { think: false } : {}),
                options: { num_ctx: sessionCtx, num_predict: 1, temperature: 0 }
            })
        });
        console.log('[Ollama] Model warmed up and pinned at num_ctx', sessionCtx);
    } catch (e) { /* non-fatal — first real request will just load it then */ }
}

async function loadLocalAISettings() {
    try {
        let data = {};
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            data = await chrome.storage.local.get(['localAiUrl', 'localAiModel', 'localAiCtx', 'modelCtxCache', 'pulseSyncUrl', 'pulseLastSync']);
        } else {
            const s = localStorage.getItem('soti_local_ai');
            if (s) data = JSON.parse(s);
        }
        LOCAL_AI_URL = data.localAiUrl || 'http://127.0.0.1:11434';
        LOCAL_AI_MODEL = data.localAiModel || '';
        LOCAL_AI_CTX_MAX = data.localAiCtx || 'auto';
        // Hydrate the per-model context-length cache (avoids re-probing /api/show)
        if (data.modelCtxCache && typeof data.modelCtxCache === 'object') {
            for (const [m, len] of Object.entries(data.modelCtxCache)) {
                if (len && len >= 2048) MODEL_CTX_CACHE.set(m, len);
            }
        }
        
        // Add defaults for Pulse Sync
        window.PULSE_SYNC_URL = data.pulseSyncUrl || 'https://pulse.soti.net/support/soti-mobicontrol';
        
        // Upgrade from an old local default to the current first-party Pulse source.
        if (window.PULSE_SYNC_URL === 'knowledge/PulseKnowledge.md') {
            window.PULSE_SYNC_URL = 'https://pulse.soti.net/support/soti-mobicontrol';
        }
        
        window.PULSE_LAST_SYNC = data.pulseLastSync || null;

        // Auto-detect and select the first available model if none is set
        if (!LOCAL_AI_MODEL) {
            const models = await fetchOllamaModels(LOCAL_AI_URL);
            if (models.length > 0) {
                LOCAL_AI_MODEL = pickPreferredOllamaModel(models);
                await saveLocalAISettings();
            }
        }
    } catch (e) { console.warn('Failed to load local AI settings', e); }
}

async function saveLocalAISettings() {
    try {
        const d = {
            localAiUrl: LOCAL_AI_URL,
            localAiModel: LOCAL_AI_MODEL,
            localAiCtx: LOCAL_AI_CTX_MAX,
            pulseSyncUrl: window.PULSE_SYNC_URL,
            pulseLastSync: window.PULSE_LAST_SYNC
        };
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            await chrome.storage.local.set(d);
        } else {
            localStorage.setItem('soti_local_ai', JSON.stringify(d));
        }
    } catch (e) { console.warn('Failed to save local AI settings', e); }
}

function sortOllamaModels(models) {
    return [...models].sort((a, b) => {
        const score = m => {
            if (/qwen2\.5/i.test(m)) return 0;
            if (/qwen3\.5/i.test(m)) return 1;
            if (/qwen/i.test(m)) return 2;
            if (/llama3\.1/i.test(m)) return 3;
            if (/phi4/i.test(m)) return 4;
            if (/llama3\.2/i.test(m)) return 5;
            return 6;
        };
        const aScore = score(a);
        const bScore = score(b);
        if (aScore !== bScore) return aScore - bScore;
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });
}

function pickPreferredOllamaModel(models) {
    const sorted = sortOllamaModels(models);
    return sorted.find(m => /llama3\.1/i.test(m)) || sorted.find(m => /qwen2\.5/i.test(m)) || sorted.find(m => /qwen3\.5/i.test(m)) || sorted.find(m => /qwen/i.test(m)) || sorted[0] || '';
}

function getOllamaProbeUrls(baseUrl) {
    const raw = (baseUrl || LOCAL_AI_URL || 'http://127.0.0.1:11434').trim().replace(/\/$/, '');
    const urls = new Set();
    urls.add(raw);
    try {
        const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
        const host = u.hostname || '127.0.0.1';
        const port = u.port || '11434';
        urls.add(`http://127.0.0.1:${port}`);
        urls.add(`http://localhost:${port}`);
        if (host !== '127.0.0.1') urls.add(`http://${host}:${port}`);
    } catch (e) {
        urls.add('http://127.0.0.1:11434');
        urls.add('http://localhost:11434');
    }
    return [...urls];
}

async function probeOllama(baseUrl) {
    const errors = [];
    for (const base of getOllamaProbeUrls(baseUrl)) {
        try {
            const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(12000) });
            if (!res.ok) {
                errors.push(`${base}/api/tags → HTTP ${res.status}`);
                continue;
            }
            const data = await res.json();
            const models = sortOllamaModels((data.models || []).map(m => m.name).filter(Boolean));
            return { ok: true, models, workingUrl: base, errors };
        } catch (e) {
            errors.push(`${base}/api/tags → ${e.message || e}`);
        }
    }
    return { ok: false, models: [], workingUrl: '', errors };
}

async function fetchOllamaModels(baseUrl) {
    const probe = await probeOllama(baseUrl);
    if (probe.ok && probe.workingUrl && probe.workingUrl !== (baseUrl || LOCAL_AI_URL).replace(/\/$/, '')) {
        LOCAL_AI_URL = probe.workingUrl;
        await saveLocalAISettings();
    }
    if (!probe.ok) {
        console.warn('Ollama not reachable', probe.errors);
        if (isStandalonePage() && probe.errors.some(e => /failed to fetch|network|cors/i.test(e))) {
            console.warn('[Standalone] Serve this folder over http://127.0.0.1 (not file://) and set OLLAMA_ORIGINS if needed.');
        }
        return [];
    }
    return probe.models;
}

function updateLocalAIBadge() {
    const pill = $('pulseHealth');
    const statusTxt = $('statusTxt');
    const dot = $('dot');
    const chatIn = $('chatIn');
    
    if (!pill) return;
    pill.style.display = 'flex';
    
    if (LOCAL_AI_MODEL) {
        let cleanName = LOCAL_AI_MODEL.replace(/:latest$/i, '');
        dot.style.background = '#22c55e';
        dot.classList.add('on');
        statusTxt.style.display = 'none';
        pill.title = `Connected — ${cleanName}`;
        if (chatIn) chatIn.placeholder = `Ask AI anything...`;
    } else {
        dot.style.background = 'var(--warn)';
        dot.classList.remove('on');
        statusTxt.style.display = 'none';
        pill.title = 'No Ollama model selected';
        if (chatIn) chatIn.placeholder = `Ask AI anything...`;
    }
}

// Ollama-powered AI engine (streaming, OpenAI-compatible endpoint)
const OllamaAI = {
    completions: {
        create: async (req) => {
            const model = LOCAL_AI_MODEL || req.model;
            if (!model) throw new Error('No model selected. Open Settings (⚙) and pick an Ollama model.');

            // Flatten any multimodal content — local models are text-only
            const messages = req.messages.map(m => {
                if (Array.isArray(m.content)) {
                    let text = m.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
                    const hasImg = m.content.some(c => c.type === 'image_url');
                    if (hasImg) text = `[USER ATTACHED AN IMAGE WHICH YOU SAW IN A PREVIOUS TURN]\n${text}`;
                    return { ...m, content: text };
                }
                return m;
            });

            const baseUrl = LOCAL_AI_URL.replace(/\/$/, '');
            
            const lastMessage = messages[messages.length - 1]?.content || "";
            const isListingAll = /\b(list\s*all|show\s*all|all\s*release\s*notes|resolved\s*issues|all\s*issues|full\s*list|all\s*of\s*them|all\s*them|list\s*them)\b/i.test(lastMessage) ||
                                 /\b(release\s*notes?|changelog)\b/i.test(lastMessage);
            const hasLogs = messages.some(m => m.content && (m.content.includes('[DIAGNOSTIC DATA') || m.content.includes('=== FILE:')));
            
            // Detect thinking/reasoning models — Gemma 4 e2b/e4b, QwQ, DeepSeek-R1, etc. (substring match to support GGUF/custom names)
            const isThinkingModelReq = /gemma4|gemma-4|gemma3|gemma-3|e2b|e4b|qwq|r1|think|reason/i.test(model || '');

            // For thinking models, append instructions to avoid thinking tags if think: false is passed.
            if (isThinkingModelReq && messages[0] && messages[0].role === 'system') {
                messages[0].content += "\n\nIMPORTANT: You must NOT output any <think> tags or internal reasoning process. Output the final answer directly.";
            }

            // Model-aware context sizing: use the model's true window (gemma e2b/e4b = 131072)
            // capped by the user's Context Size setting ('auto' → up to 64K).
            const { modelMax, hardMax } = await getHardCtxMax(model);
            // Small models (2b/e2b/e4b/7b…) are usually CPU-bound on this hardware — every extra
            // 1000 tokens of context costs real seconds of prefill. Keep contexts modest for speed
            // unless the user explicitly raises Context Size. The FILE MANIFEST guarantees the
            // model still knows about every attached file even when snippets are compressed.
            const isSmall = /(0\.5b|1\.5b|1b|2b|3b|4b|mini|3\.2|7b|8b|9b|e2b|e4b)/i.test(model || '');
            // FIXED context size for the whole session — never varies per request, so Ollama
            // keeps the model loaded and warm instead of reloading it every turn (huge on CPU).
            const ctxCeiling = await getSessionCtx(model);
            // Keep generation bounded so a 6 tok/s CPU finishes in minutes, not tens of minutes.
            const numPredict = isListingAll
                ? (isSmall ? 2048 : 8192)
                : (hasLogs ? (isSmall ? 1280 : (isThinkingModelReq ? 4096 : 2048)) : (isSmall ? 1024 : (isThinkingModelReq ? 1536 : 800)));

            const CHARS_PER_TOKEN = 2.5; // measured: gemma tokenizes log text at ~2.55 chars/token (conservative → num_ctx stays generous, prompt never overflows)
            let totalChars = messages.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0);

            // If the payload exceeds the context ceiling: drop only the OLDEST history (the most
            // recent turns are protected for conversational memory), then trim the SYSTEM prompt
            // from its END. The system prompt is ordered [rules][logs][case/research], so
            // end-trimming sacrifices the secondary case/research data — never the logs, never the
            // file manifest, and never the recent conversation.
            // CRITICAL: the prompt MUST fit num_ctx with room left for the answer, otherwise
            // Ollama truncates the prompt to fill the window and the model can only emit ~1
            // token before hitting the limit (the "Based"/"It" single-word bug). maxAllowedChars
            // already reserves numPredict tokens for the response.
            // For small/CPU models in 'auto' mode we cap the PROMPT against a smaller window than
            // num_ctx (prefill cost scales with prompt tokens, not num_ctx) so the analysis stays
            // fast and the still-pending fetch completes before the browser drops it. num_ctx is
            // unchanged, so the model is NOT reloaded and there is ample room for the answer.
            const budgetCtx = (isSmall && (!LOCAL_AI_CTX_MAX || LOCAL_AI_CTX_MAX === 'auto'))
                ? Math.min(SMALL_PROMPT_BUDGET_CTX, ctxCeiling)
                : ctxCeiling;
            const maxAllowedChars = Math.floor((budgetCtx - numPredict - 600) * CHARS_PER_TOKEN);
            if (totalChars > maxAllowedChars) {
                // 1. Drop OLDER history first, but PROTECT the most recent turns so the model always
                //    keeps short-term memory / context flow (it can answer "what did I just say?" and
                //    build on the last few exchanges). Anything that still doesn't fit is taken out of
                //    the bulky system prompt (persona + case info + email chain + RAG) by the end-trim
                //    pass below — NOT by wiping the conversation. Without this guard a filled-in Case
                //    Info / email chain fills the whole small-model budget, every prior turn was
                //    dropped, and the AI behaved as if each message were the first one in the chat.
                const RECENT_TURNS_PROTECTED = 8; // keep ~4 user+assistant exchanges verbatim
                let droppable = messages.length - 1 - RECENT_TURNS_PROTECTED; // never touch system[0] or the last N
                while (totalChars > maxAllowedChars && droppable > 0) {
                    const dropped = messages.splice(1, 1)[0];
                    totalChars -= (dropped.content ? dropped.content.length : 0);
                    droppable--;
                    console.warn('[Ollama Request] Dropped an older history message to fit context budget');
                }
                // 2. Trim the LARGEST remaining message from its END until the prompt fits. This
                //    covers BOTH the system prompt (normal mode: logs live there) AND the final
                //    user message (forensic mode: the log evidence lives there). Each message's
                //    leading portion — rules / file manifest / primary root-cause anchor — is kept.
                let guard = 0;
                // Messages already cut to their keep-floor are skipped on later passes, so the
                // loop moves on to the next-largest message (e.g. a long history turn) instead of
                // stalling on one at-floor message and leaving everything else untrimmed.
                const atFloor = new Set();
                while (totalChars > maxAllowedChars && guard++ < 24) {
                    let bigIdx = -1, bigLen = 0;
                    for (let i = 0; i < messages.length; i++) {
                        if (atFloor.has(i)) continue;
                        const L = messages[i].content ? messages[i].content.length : 0;
                        if (L > bigLen) { bigLen = L; bigIdx = i; }
                    }
                    if (bigIdx < 0) break; // every message is at its floor — send as-is
                    const m = messages[bigIdx];
                    const content = m.content || '';
                    const over = totalChars - maxAllowedChars;
                    // Preserve the start: rules, file manifest, and the primary root-cause anchor
                    // (which sits just before the "CHRONOLOGICAL" section in installer evidence).
                    const manifestEnd = content.indexOf('=== END FILE MANIFEST ===');
                    const chronoIdx = content.indexOf('--- CHRONOLOGICAL HIGH-SIGNAL');
                    let minKeep = 1500;
                    if (manifestEnd >= 0) minKeep = Math.min(manifestEnd + 30, 7000);
                    if (chronoIdx >= 0) minKeep = Math.min(Math.max(minKeep, chronoIdx), 9000);
                    const newLen = Math.max(minKeep, content.length - over - 150);
                    // A cut the appended notice would cancel out frees no space — floor reached.
                    if (newLen >= content.length - 200) { atFloor.add(bigIdx); continue; }
                    m.content = content.slice(0, newLen) + "\n\n[Evidence trimmed to fit the context window — the manifest and primary findings above are complete.]";
                    totalChars = messages.reduce((acc, x) => acc + (x.content ? x.content.length : 0), 0);
                    console.warn(`[Ollama Request] Trimmed message #${bigIdx} to ${newLen} chars to fit context`);
                }
            }

            let estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
            // num_ctx is FIXED at the session size (no grow-to-fit) so the model never reloads
            // between turns. The prompt has already been trimmed to fit maxAllowedChars above.
            let numCtx = ctxCeiling;

            console.log(`[Ollama Request] Model: ${model}, Chars: ${totalChars}, Est Tokens: ${estimatedTokens}, set num_ctx: ${numCtx} (fixed), num_predict: ${numPredict}, modelMax: ${modelMax}, hardMax: ${hardMax}`);

            const doOllamaFetch = (ctx) => fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: req.signal || null,  // AbortController signal for per-case cancellation
                body: JSON.stringify({
                    model,
                    messages,
                    stream: true,
                    keep_alive: -1, // Keep model loaded indefinitely for instant subsequent responses
                    ...(isThinkingModelReq ? { think: false } : {}), // Disable internal thinking phase so output goes to content
                    options: {
                        num_ctx: ctx,
                        temperature: 0.0,
                        repeat_penalty: 1.1,
                        top_p: 0.9,
                        num_predict: numPredict // Use standard calculated budget, -1 can cause instant aborts
                    }
                })
            });

            // The fetch can reject with a bare TypeError "Failed to fetch" when the connection
            // never completes — Ollama not running, or a long CPU prefill whose pending request
            // got dropped. Catch it, retry once after a short pause, then surface a CLEAR,
            // actionable message instead of the cryptic raw "Failed to fetch".
            let res;
            try {
                res = await doOllamaFetch(numCtx);
            } catch (netErr) {
                if (netErr && netErr.name === 'AbortError') throw netErr; // user cancelled — propagate quietly
                console.warn('[Ollama Request] fetch failed, retrying once...', netErr);
                await new Promise(r => setTimeout(r, 800));
                try {
                    res = await doOllamaFetch(numCtx);
                } catch (netErr2) {
                    if (netErr2 && netErr2.name === 'AbortError') throw netErr2;
                    throw new Error(`Couldn't reach the local AI at ${baseUrl}. Make sure Ollama is running (try \`ollama serve\`) and that the model "${model}" is installed. If the log is very large, the analysis can take a while on a CPU — try again, lower Context Size in Settings (⚙), or remove very large files.`);
                }
            }
            if (!res.ok) {
                const err = await res.text();
                // GPU/RAM exhaustion: retry once with a halved context window
                if (/memory|oom|cudamalloc|allocate|vram/i.test(err) && numCtx > 8192) {
                    numCtx = Math.max(8192, Math.floor(numCtx / 2 / 1024) * 1024);
                    console.warn(`[Ollama Request] OOM detected — retrying with num_ctx: ${numCtx}`);
                    try { toast('GPU memory tight — retried with a smaller context. Consider lowering Context Size in Settings (⚙).', 'w', 6000); } catch (e) {}
                    res = await doOllamaFetch(numCtx);
                }
                if (!res.ok) {
                    const err2 = res.bodyUsed ? err : await res.text();
                    throw new Error(`Ollama error ${res.status}: ${err2}`);
                }
            }
            return res.body.getReader();
        }
    }
};

// --- SELF-LEARNING (retrieval-based) ---
// The model itself can't be retrained on-device, but every analysis the user
// confirms (👍) or corrects (👎) is stored as a compact "insight" and re-injected
// into future prompts whose logs/questions match — so the analyser genuinely gets
// smarter with every verified case.
const INSIGHT_STOPWORDS = new Set(['what', 'where', 'how', 'when', 'there', 'is', 'are', 'was', 'were', 'the', 'and', 'with', 'some', 'having', 'issues', 'this', 'that', 'they', 'their', 'them', 'from', 'into', 'your', 'will', 'would', 'could', 'should', 'about', 'doing', 'it', 'for', 'logs', 'log', 'analyse', 'analyze', 'please', 'case']);

// GDPR storage limitation: learned insights hold case-derived text (root cause / fix /
// correction / case name), so — like cases — they must not accumulate indefinitely. Purge any
// older than the retention window on load and persist the purge so the data is actually deleted
// from disk, not just hidden. (Cases use a 30-day inactivity window; insights are longer-lived
// aggregated learning, so they get a longer, still-bounded 90-day window.)
const INSIGHT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

async function loadLearnedInsights() {
    try {
        let insights = [];
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            const d = await chrome.storage.local.get('learnedInsights');
            insights = Array.isArray(d.learnedInsights) ? d.learnedInsights : [];
        } else {
            insights = JSON.parse(localStorage.getItem('soti_learned_insights') || '[]');
        }
        const now = Date.now();
        const kept = insights.filter(i => i && (now - (i.ts || now)) < INSIGHT_RETENTION_MS);
        if (kept.length !== insights.length) {
            console.warn(`[Security] Data retention: purged ${insights.length - kept.length} learned insight(s) older than 90 days.`);
            await persistLearnedInsights(kept);
        }
        return kept;
    } catch (e) { return []; }
}

async function persistLearnedInsights(insights) {
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            await chrome.storage.local.set({ learnedInsights: insights });
        } else {
            localStorage.setItem('soti_learned_insights', JSON.stringify(insights));
        }
    } catch (e) { console.warn('Failed to persist learned insights', e); }
}

function collectLogSignatureTerms(logs) {
    const sigs = [];
    for (const l of (logs || []).slice(0, 8)) {
        const intel = l && l.panelIntel;
        if (intel) {
            if (intel.topException) sigs.push(intel.topException.split(' x')[0]);
            if (intel.topCategory) sigs.push(intel.topCategory.split(' x')[0]);
        }
    }
    return [...new Set(sigs.filter(Boolean))];
}

async function saveLearnedInsight(c, question, answerText, verdict, correction = '') {
    try {
        const keywords = [...new Set((question || '').toLowerCase().split(/\W+/)
            .filter(w => w.length > 3 && !INSIGHT_STOPWORDS.has(w)))].slice(0, 12);
        const signatures = collectLogSignatureTerms(c && c.logs).slice(0, 8);
        let product = (c && c.ci && c.ci.product) || '';
        if (!product && c && Array.isArray(c.logs)) {
            const withProduct = c.logs.find(l => l.panelIntel && l.panelIntel.product);
            if (withProduct) product = withProduct.panelIntel.product;
        }
        const rcMatch = (answerText || '').match(/ROOT\s*CAUSE[^:\n]*[:\-]\s*([\s\S]{10,400}?)(?:\n\n|\n#+|\n\*\*|$)/i);
        const fixMatch = (answerText || '').match(/(?:MITIGATION|RESOLUTION|RECOMMENDED\s+FIX|FIX)[^:\n]*[:\-]\s*([\s\S]{10,400}?)(?:\n\n|\n#+|$)/i);
        const insight = {
            id: 'ins_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            ts: Date.now(),
            product,
            caseName: (c && c.name) || '',
            keywords,
            signatures,
            rootCause: (rcMatch ? rcMatch[1] : (answerText || '').slice(0, 300)).replace(/\s+/g, ' ').trim().slice(0, 400),
            resolution: (fixMatch ? fixMatch[1] : '').replace(/\s+/g, ' ').trim().slice(0, 400),
            verdict,
            correction: (correction || '').replace(/\s+/g, ' ').trim().slice(0, 400)
        };
        const insights = await loadLearnedInsights();
        insights.push(insight);
        while (insights.length > 200) {
            const idx = insights.findIndex(i => i.verdict === 'confirmed');
            insights.splice(idx >= 0 ? idx : 0, 1);
        }
        await persistLearnedInsights(insights);
        console.log(`[Learning] Saved ${verdict} insight (${insights.length} total):`, insight.rootCause.slice(0, 80));
        return true;
    } catch (e) { console.warn('saveLearnedInsight failed', e); return false; }
}

// Find past human-verified insights relevant to the current question + log signatures.
async function matchLearnedInsights(txt, logs) {
    try {
        const insights = await loadLearnedInsights();
        if (!insights.length) return '';
        const qTerms = new Set((txt || '').toLowerCase().split(/\W+/).filter(w => w.length > 3 && !INSIGHT_STOPWORDS.has(w)));
        const sigTerms = new Set(collectLogSignatureTerms(logs).map(s => s.toLowerCase()));
        const scored = insights.map(i => {
            let overlap = 0;
            for (const k of (i.keywords || [])) if (qTerms.has(k)) overlap++;
            for (const s of (i.signatures || [])) if (sigTerms.has((s || '').toLowerCase())) overlap += 2;
            return { i, overlap };
        }).filter(x => x.overlap >= 2)
          .sort((a, b) => b.overlap - a.overlap || b.i.ts - a.i.ts)
          .slice(0, 2);
        if (!scored.length) return '';
        const lines = scored.map(({ i }) => {
            if (i.verdict === 'corrected' && i.correction) {
                return `- (${i.product || 'SOTI'}) In a similar past case the AI wrongly concluded: "${i.rootCause.slice(0, 200)}". The human-confirmed cause was: "${i.correction}".`;
            }
            return `- (${i.product || 'SOTI'}) Confirmed root cause in a similar past case: "${i.rootCause.slice(0, 300)}"${i.resolution ? ` | Confirmed fix: "${i.resolution.slice(0, 200)}"` : ''}`;
        });
        return `[LEARNED FROM PAST CONFIRMED CASES — human-verified hints from earlier analyses. Verify against the current logs before relying on them.]\n${lines.join('\n')}`;
    } catch (e) { return ''; }
}

// 👍/👎 buttons under substantial assistant answers — the entry point of the learning loop.
// Takes the assistant message object so the verdict is recorded on it (msg.fbState) and
// persisted via saveState(); switchCase re-runs this on every render, so a rated answer
// keeps showing its confirmation and an unrated one keeps its buttons across tab switches.
function attachFeedbackUI(bubbleEl, c, msg) {
    try {
        if (!bubbleEl || !msg) return;
        const answerText = msg.content || '';
        const question = msg.fbQuestion || '';
        if (answerText.length < 400 && !/root\s*cause/i.test(answerText)) return;
        const row = document.createElement('div');
        row.className = 'fb-row';
        const done = (text) => { row.innerHTML = `<span class="fb-done">${text}</span>`; };

        // Already rated (earlier render or a previous session) — show the confirmation, not buttons.
        if (msg.fbState) {
            done(msg.fbDone || (msg.fbState === 'corrected'
                ? '✓ Correction learned — the AI will use this in similar future cases'
                : '✓ Learned — this analysis will inform similar future cases'));
            bubbleEl.appendChild(row);
            return;
        }

        const record = (state, text) => { msg.fbState = state; msg.fbDone = text; try { saveState(); } catch (e) {} };
        row.innerHTML = `<span class="fb-hint">Was this analysis correct?</span>` +
            `<button class="fb-btn" data-v="up" title="Correct — remember this analysis for similar future cases">👍</button>` +
            `<button class="fb-btn" data-v="down" title="Wrong — teach the AI the real cause">👎</button>`;
        row.querySelector('[data-v="up"]').onclick = async () => {
            const ok = await saveLearnedInsight(c, question, answerText, 'confirmed');
            const text = ok ? '✓ Learned — this analysis will inform similar future cases' : 'Could not save feedback';
            if (ok) record('confirmed', text);
            done(text);
        };
        row.querySelector('[data-v="down"]').onclick = () => {
            row.innerHTML = `<input class="fb-input" type="text" placeholder="What was the real root cause / fix?" maxlength="400">` +
                `<button class="fb-btn fb-save">Teach AI</button>`;
            const inp = row.querySelector('.fb-input');
            inp.focus();
            const submit = async () => {
                const correction = inp.value.trim();
                if (!correction) { inp.placeholder = 'Please describe the real cause first...'; return; }
                const ok = await saveLearnedInsight(c, question, answerText, 'corrected', correction);
                const text = ok ? '✓ Correction learned — the AI will use this in similar future cases' : 'Could not save feedback';
                if (ok) record('corrected', text);
                done(text);
            };
            row.querySelector('.fb-save').onclick = submit;
            inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
        };
        bubbleEl.appendChild(row);
    } catch (e) { console.warn('attachFeedbackUI failed', e); }
}

// Make a model-safe copy of chat history: strip any log dumps that older versions
// stored inside messages (they crowd out newly added logs), and cap each message
// so ten long answers can't eat the whole context window. Never mutates c.msgs.
function sanitizeHistoryForModel(msgs, capChars = 4000) {
    return (msgs || []).map(m => {
        let content = m.content || '';
        if (content.includes('=== FILE:')) {
            content = content.replace(/=== FILE:[\s\S]*?=== END[^\n]*\n?/g, '[log snippet from an earlier message removed — current log data is provided fresh]\n');
        }
        if (content.includes('[LOG ANALYSIS DATA') || content.includes('[DIAGNOSTIC DATA')) {
            content = content.replace(/\[(?:LOG ANALYSIS DATA|DIAGNOSTIC DATA)[^\]]*\]/g, '[earlier log data removed]');
        }
        if (content.length > capChars) {
            content = content.slice(0, capChars) + '\n…[earlier message trimmed]';
        }
        return { role: m.role, content };
    });
}

async function send(overrideText = null, silent = false) {
    const c = cases.find(x => x.id === activeCaseId);
    if (!c) {
        toast('No active case selected', 'e');
        return;
    }
    // Per-case busy guard — allows other cases to stream simultaneously
    if (busyMap.get(c.id)) return;
    
    // Give browser time to paint UI (e.g. progress animations) before locking up
    await new Promise(r => setTimeout(r, 50));
    
    let txt = "";
    if (typeof overrideText === 'string') {
        txt = overrideText;
    } else {
        txt = $('chatIn').value.trim();
    }

    if (!txt && c.logs.length === 0 && c.imgs.length === 0) return;
    busyMap.set(c.id, true);
    $('btnSend').disabled = true;
    
    if (typeof overrideText !== 'string') {
        $('chatIn').value = ''; 
        $('chatIn').style.height = '';
    }
    if ($('welcome')) $('welcome').style.display = 'none';

    // Wait for any log files still being read/extracted (ZIPs can take a while) —
    // sending early would silently exclude them from the AI's context.
    if (pendingLogUploads.get(c.id) > 0) {
        toast('Waiting for log files to finish processing...', 'w');
        await new Promise(resolve => {
            const check = setInterval(() => {
                if (!(pendingLogUploads.get(c.id) > 0)) {
                    clearInterval(check);
                    resolve();
                }
            }, 300);
            setTimeout(() => { clearInterval(check); resolve(); }, 30000); // 30s max wait
        });
    }

    // Wait for any images still being OCR-processed
    if (c.imgs && c.imgs.some(img => img.processing)) {
        toast('Waiting for image OCR to finish...', 'w');
        await new Promise(resolve => {
            const check = setInterval(() => {
                if (!c.imgs.some(img => img.processing)) {
                    clearInterval(check);
                    resolve();
                }
            }, 300);
            setTimeout(() => { clearInterval(check); resolve(); }, 15000); // 15s max wait
        });
    }

    // OCR Context from Images
    let imgContext = "";
    if (c.imgs && c.imgs.length > 0) {
        console.log('[SEND] Images found:', c.imgs.length);
        c.imgs.forEach((img, idx) => {
            console.log(`[SEND] Image ${idx}: name=${img.name}, textLen=${img.text ? img.text.length : 0}, processing=${img.processing}, text=${img.text ? img.text.substring(0,50) : 'EMPTY'}`);
        });
        imgContext = "\n\n[SCRAPPED TEXT FROM ATTACHED IMAGES]";
        c.imgs.forEach(img => {
            if (img.text) {
                imgContext += `\n\n=== SOURCE IMAGE: ${img.name} ===\n${img.text}\n=== END IMAGE ===`;
            }
        });
        console.log('[SEND] imgContext length:', imgContext.length);
    }

    const ci = {
        case_number: $('caseNum').value, 
        soti_version: $('sotiVer').value, 
        platform: $('platform').value,
        agent_version: $('agentVer').value,
        case_age_days: $('caseAge').value,
        account_scrub: $('scrubAccount').value,
        meeting_notes: $('meetingNotes').value,
        product: $('product').value,
        issue_summary: $('issueSummary').value,
        email_chain: $('emailChain').value
    };

    // Rich Preview Injection
    const ocrPreview = c.imgs && c.imgs.length > 0 ? c.imgs.filter(i => i.text && !i.processing && !i.text.includes('Failed')).map(i => i.text).join('\n---\n') : '';
    let displayTxt = txt;
    if (c.imgs && c.imgs.length > 0) {
        const imgHtml = c.imgs.map(i => `<img src="${i.data}" style="max-width:200px; max-height:100px; border-radius:4px; margin-bottom:8px; display:block; border:1px solid #e2e8f0;">`).join('');
        if (ocrPreview) {
            displayTxt = `${imgHtml}${txt}\n\n*${c.imgs.length} Image(s) Attached — OCR Extracted Text:*\n\n\`\`\`text\n${ocrPreview.slice(0, 500)}${ocrPreview.length > 500 ? '...' : ''}\n\`\`\``;
        } else {
            displayTxt = `${imgHtml}${txt}`;
        }
    }

    _chatStick = true; // a new turn always starts pinned to the bottom; the user can scroll up while it streams
    ensureChatScrollListener();
    addMsg('user', displayTxt, false, silent);
    const aib = addMsg('assistant', '<div class="thinking-dot"></div>', false);
    // Register the live streaming element so tab switches can re-attach it to the DOM
    streamingElements.set(c.id, aib);
    
    const isGreeting = /^(hi|hello|hey|greetings|morning|afternoon|evening|yo|sup)\b/i.test(txt.trim()) && txt.trim().split(/\s+/).length < 3;
    const hasLogs = c.logs.length > 0;
    // A conversational follow-up about a PREVIOUS answer ("why do you think that's the root
    // cause?", "how did you conclude that?", "are you sure?") must NOT re-trigger a fresh
    // forensic report — the phrase "root cause" in such questions otherwise trips the analysis
    // detectors and (on small models) even misroutes to the MSI installer prompt. Route it
    // conversationally so the model explains its prior reasoning from history. Gated on a real
    // prior answer existing, and never on the "Analyse Now" button (silent).
    const hasPriorAnswer = c.msgs.some(m => m.role === 'assistant' && (m.content || '').length > 150);
    const isAnalysisFollowUpTurn = hasLogs && hasPriorAnswer && !silent && isAnalysisFollowUp(txt);
    // Logs attached, but does THIS message want an analysis, or a normal/case answer?
    const analysisRun = hasLogs && !isAnalysisFollowUpTurn && (isLogForensicsRequest(txt) || wantsLogAnalysis(txt, silent));
    // MSI/setup installer logs MUST use the strict forensic methodology (find the CustomAction
    // that returned 1603 / triggered "Return value 3", ignore SQL/enumeration noise). Route them
    // to the forensic path even when triggered by the plain "Analyse Now" button. Use the STRICT
    // detector so RUNTIME logs (DeploymentServer.log etc.) are NOT misrouted to the MSI prompt.
    const hasInstallerLog = hasLogs && c.logs.some(l => isMsiInstallerLog(l.name || "", l.content || ""));
    const forensicRun = analysisRun && (isLogForensicsRequest(txt) || hasInstallerLog);
    // Version / release-notes / product question → wants live research (even with logs attached).
    const needsDeepPulse = /\b(release\s*notes?|product\s*notes?|mobicontrol|version|latest|mcmr|what'?s\s+new|changelog)\b/i.test(txt);

    let supportingRefSection = "";
    let knownFixesSection = "";
    if (!isGreeting && !forensicRun) {
        if (!hasLogs || needsDeepPulse) {
            // Q&A mode (or explicit release-notes request): full online + offline research
            const researchMs = needsDeepPulse ? 20000 : 10000;
            try {
                await Promise.race([
                    searchPulseAndDocs(txt, c.msgs, ci),
                    new Promise(r => setTimeout(r, researchMs))
                ]);
            } catch (e) { console.warn('Research timed out'); }
        } else if (!isSmallLocalModel()) {
            // Logs attached (larger models only): small, clearly-labelled offline KB lookup —
            // supports the analysis with official docs but never distracts from the logs.
            // Skipped for small/CPU models: it's explicitly "background, ignore for the answer"
            // text that just burns prefill time and crowds the log evidence out of the window.
            try {
                await PulseKB.ensureIndex();
                const sigTerms = [];
                const prodHints = [];
                for (const l of c.logs.slice(0, 6)) {
                    const intel = l.panelIntel;
                    if (intel) {
                        if (intel.product) prodHints.push(intel.product);
                        if (intel.topException) sigTerms.push(intel.topException.split(' x')[0]);
                        if (intel.topCategory) sigTerms.push(intel.topCategory.split(' x')[0]);
                    }
                }
                const stop = new Set(['what', 'where', 'how', 'when', 'there', 'is', 'are', 'was', 'were', 'the', 'and', 'with', 'some', 'having', 'issues', 'this', 'that', 'they', 'their', 'them', 'from', 'into', 'your', 'will', 'would', 'could', 'should', 'about', 'doing', 'it', 'for', 'logs', 'log', 'analyse', 'analyze']);
                const kws = [...new Set(
                    txt.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stop.has(w))
                        .concat(sigTerms.map(s => s.toLowerCase()).filter(s => s.length > 3))
                )].slice(0, 10);
                const refs = PulseKB.search(txt.toLowerCase(), kws, {
                    productHints: prodHints,
                    signatureTerms: sigTerms,
                    maxArticles: 2,
                    maxChars: 3000,
                    perChunkCap: 1500
                });
                if (refs.length > 0) {
                    supportingRefSection = `[SUPPORTING REFERENCE — internal KB excerpts for background only. Your analysis MUST be driven by the attached LOGS; NEVER summarize these articles as the answer.]\n${refs.join('\n---\n')}`;
                }
            } catch (e) { console.warn('KB reference lookup failed', e); }
        }
    }

    // During ANY log analysis (forensic or normal, all models), look up official
    // release-notes / resolved-issues offline that may match the detected error, so the
    // model can cite an exact fix version + MCMR if a newer release resolves the issue.
    // Skipped for small-model installer-forensic runs: the deterministic cause is an
    // environment/database issue (not a product bug a newer build fixes), so the release-notes
    // lookup is just ~1.4KB of extra prefill that slows the already CPU-bound analysis.
    const leanInstaller = forensicRun && isSmallLocalModel() && hasInstallerLog;
    if (analysisRun && !leanInstaller) {
        try {
            await PulseKB.ensureIndex();
            const sigTerms = collectLogSignatureTerms(c.logs);
            if (sigTerms.length) {
                const pj = ((ci && ci.product) || (c.logs.find(l => l.panelIntel && l.panelIntel.product)?.panelIntel?.product) || '').toLowerCase();
                let prodSlug = '';
                if (pj.includes('xsight')) prodSlug = 'xsight';
                else if (pj.includes('connect')) prodSlug = 'connect';
                else if (pj.includes('identity')) prodSlug = 'identity';
                else if (pj.includes('mobicontrol')) prodSlug = 'mobicontrol';
                const fixKws = [...new Set(sigTerms.map(s => s.toLowerCase()).filter(s => s.length > 3).concat(['resolved', 'fixed', 'release']))].slice(0, 8);
                const fixes = PulseKB.search((sigTerms.join(' ') + ' resolved fixed release notes').toLowerCase(), fixKws, {
                    product: prodSlug, maxArticles: 1, maxChars: 1400, perChunkCap: 1400
                });
                if (fixes.length) {
                    knownFixesSection = `[RELEASE NOTES / KNOWN FIXES — official SOTI references that may relate to this error. If one names a newer version that fixes THIS exact issue, cite the exact version and MCMR code verbatim and recommend upgrading; otherwise ignore this section.]\n${fixes[0]}`;
                }
            }
        } catch (e) { console.warn('Known-fixes lookup failed', e); }
    }

    try {
        let sysPrompt = "";
        let modelMessages = [];
        let userMsgForModel = txt;
        
        if (isGreeting) {
            sysPrompt = "You are the SOTI Tier-3 AI Analyser, a senior escalation engineer for the SOTI ONE Suite (MobiControl, SOTI Connect, SOTI XSight). Respond politely to the user's greeting, ask how you can help, and keep your response to exactly one short sentence. Do NOT ask for logs, Salesforce sync, or cases. Stop generating immediately.";
            userMsgForModel = txt;
            
            if (c.msgs.length > 0 && c.msgs[c.msgs.length - 1].role === 'user') {
                c.msgs[c.msgs.length - 1].content = userMsgForModel;
                c.msgs[c.msgs.length - 1].hidden = silent;
            } else {
                c.msgs.push({ role: 'user', content: userMsgForModel, hidden: silent });
            }
            modelMessages = [{ role: 'system', content: sysPrompt }, ...c.msgs.slice(-5)];
        } else {
            const summaryText = buildEffectiveIssueSummary(ci) || 'NO SUMMARY PROVIDED';
            const isSmallModel = isSmallLocalModel();

            // 1) CORE SYSTEM PROMPT (rules) + product-specific knowledge.
            // - analysisRun: forensic / compact log-analysis prompt.
            // - logs attached but a normal/case question: conversational prompt (answers the
            //   actual question instead of forcing a forensic report).
            // - no logs: standard Q&A prompt.
            // Small / CPU-bound models get the compact log prompt — the full 13KB prompt is
            // minutes of prefill on a 6 tok/s CPU and is the main cause of "blank" responses.
            let corePrompt;
            if (analysisRun) {
                corePrompt = forensicRun
                    ? (isSmallModel ? getCompactInstallerForensicPrompt() : getLogForensicsSystemPrompt())
                    : (isSmallModel ? getCompactLogPrompt() : getLeanLogPrompt());
            } else if (hasLogs && !needsDeepPulse) {
                corePrompt = getConversationalPrompt();
            } else {
                corePrompt = getLeanQAPrompt(isSmallModel);
            }

            // Detect ALL products present across the attached logs — filename heuristics
            // plus a content scan (first 5,000 chars), so mixed-product cases get every
            // relevant knowledge file injected, not just the first match.
            const detectedProducts = new Set();
            if (ci && ci.product) {
                const p = String(ci.product).toLowerCase();
                if (p.includes('xsight')) detectedProducts.add('SOTI XSight');
                else if (p.includes('connect')) detectedProducts.add('SOTI Connect');
                else if (p.includes('mobicontrol')) detectedProducts.add('MobiControl');
            }
            if (hasLogs) {
                for (const log of c.logs) {
                    const ln = (log.name || "").toLowerCase();
                    const head = (log.content || "").slice(0, 5000);
                    const inferred = ((log.panelIntel && log.panelIntel.product) || inferProductFromLogName(log.name || "", head) || "").toLowerCase();
                    if (ln.includes('setupsotixsight') || ln.includes('xsight') || inferred.includes('xsight')) {
                        detectedProducts.add('SOTI XSight');
                    } else if (ln.includes('connect') || inferred.includes('connect') || /\bSOTI\s+Connect\b/i.test(head) || (/\bMQTT\b/i.test(head) && /\bSOTI\b/i.test(head))) {
                        detectedProducts.add('SOTI Connect');
                    } else if (ln.includes('mobicontrol') || ln.includes('adb.log') || /\b(ms|ds|dse)\b/i.test(log.name) || /^(ms|ds|dse)/i.test(log.name) || inferred.includes('mobicontrol')) {
                        detectedProducts.add('MobiControl');
                    }
                }
            }

            // Skip the product-signature injection for small-model installer-forensic runs: the
            // compact forensic prompt already carries the MSI rule and the evidence carries the
            // deterministic cause, so the extra ~1KB of signatures is pure prefill cost (slower).
            // Kept SEPARATE from corePrompt: in the analysis prompt the signatures go AFTER the
            // log evidence, so the emergency end-trim keep-floor (which preserves the prompt's
            // start through the file manifest) protects rules + evidence, not rules + signatures.
            let productSignatures = "";
            if (analysisRun && detectedProducts.size > 0 && !(forensicRun && isSmallModel)) {
                const map = {
                    "MobiControl": "MobiControl.md",
                    "SOTI XSight": "XSight.md",
                    "SOTI Connect": "Connect.md"
                };
                // Small/CPU models: inject only the PRIMARY product's signatures to save prefill.
                const prodList = isSmallModel ? [...detectedProducts].slice(0, 1) : [...detectedProducts];
                for (const prod of prodList) {
                    if (!map[prod]) continue;
                    try {
                        const url = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
                            ? chrome.runtime.getURL('knowledge/' + map[prod])
                            : 'knowledge/' + map[prod];
                        const res = await fetch(url);
                        if (res.ok) {
                            let kb = await res.text();
                            // Cap for small/CPU models so the curated signatures (front of the
                            // file) fit without starving the actual log evidence of context.
                            if (isSmallModel && kb.length > 2800) kb = kb.slice(0, 2800) + '\n…[signatures trimmed]';
                            productSignatures += `\n\n### PRODUCT-SPECIFIC LOG SIGNATURES — ${prod}:\n` + kb;
                        }
                    } catch (e) {
                        console.warn("Could not load knowledge for " + prod, e);
                    }
                }
            }

            // 2) LIVE DATA / CASE CONTEXT (case info, research, learned insights).
            let liveDataSection = "";
            const liveDataLines = [];
            liveDataLines.push(`[ISSUE SUMMARY (original reported problem — may be superseded by the EMAIL CHAIN below)]: ${summaryText}`);
            const emailChainSection = buildEmailChainSection(ci, isSmallModel);
            let emailChainIdx = -1;
            if (emailChainSection) { emailChainIdx = liveDataLines.length; liveDataLines.push(emailChainSection); }
            // Month spelled out ("8 July 2026") — a numeric 08/07/2026 is ambiguous
            // (DD/MM vs MM/DD) and the model has misread it as August 7.
            liveDataLines.push(`[CURRENT DATE & TIME — right now, NOT the date of any email]: ${new Date().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
            liveDataLines.push(`[CASE]: ${JSON.stringify(buildCaseContextForPrompt(ci, isSmallModel), null, 2)}`);

            if (VERSIONS.length > 0) {
                liveDataLines.push(`[LATEST MOBICONTROL VERSION]: ${VERSIONS[0]}`);
                liveDataLines.push(`[ALL MOBICONTROL VERSIONS]: ${VERSIONS.join(', ')}`);
            }
            if (AGENT_VERSIONS.length > 0) {
                liveDataLines.push(`[LATEST ANDROID AGENT VERSION]: ${AGENT_VERSIONS[0]}`);
                liveDataLines.push(`[ALL ANDROID AGENT VERSIONS]: ${AGENT_VERSIONS.join(', ')}`);
            }
            if (IDENTITY_VERSIONS.length > 0) {
                liveDataLines.push(`[LATEST IDENTITY VERSION]: ${IDENTITY_VERSIONS[0]}`);
                liveDataLines.push(`[ALL IDENTITY VERSIONS]: ${IDENTITY_VERSIONS.join(', ')}`);
            }
            if (RELEASE_NOTES_CONTENT && RELEASE_NOTES_CONTENT.trim()) {
                liveDataLines.push(`[RELEASE NOTES]:\n${RELEASE_NOTES_CONTENT}`);
            }
            if (PULSE_SEARCH_RESULTS && PULSE_SEARCH_RESULTS.trim()) {
                liveDataLines.push(`[PULSE SEARCH]:\n${PULSE_SEARCH_RESULTS}`);
            }
            if (DOCS_SEARCH_RESULTS && DOCS_SEARCH_RESULTS.trim()) {
                liveDataLines.push(`[DOCS SEARCH]:\n${DOCS_SEARCH_RESULTS}`);
            }
            if (RESEARCHED_ARTICLE_CONTENT && RESEARCHED_ARTICLE_CONTENT.trim()) {
                liveDataLines.push(`[DEEP RESEARCH]:\n${RESEARCHED_ARTICLE_CONTENT}`);
            }
            if (supportingRefSection) {
                liveDataLines.push(supportingRefSection);
            }
            if (knownFixesSection) {
                liveDataLines.push(knownFixesSection);
            }
            const learnedSection = await matchLearnedInsights(txt, hasLogs ? c.logs : []);
            if (learnedSection) {
                liveDataLines.push(learnedSection);
            }
            if (hasLogs) {
                liveDataLines.push(`[CRITICAL INSTRUCTION: You MUST read and retain the [CASE] and [ISSUE SUMMARY] information in this prompt. Even when analyzing logs, you must cross-reference the logs with the user's reported case notes, and you MUST answer any direct questions the user asks about the case info. If the user asks for a summary of the case, you MUST summarize ONLY the [CASE], [ISSUE SUMMARY], and the attached logs. NEVER summarize [DEEP RESEARCH], [DOCS SEARCH], or [SUPPORTING REFERENCE] as the case summary, as those are external articles, not the case itself.]`);
            }
            liveDataSection = liveDataLines.join('\n');

            // 3) LOG CONTEXT.
            // - analysisRun: full evidence (manifest + profile + incident + budgeted snippets),
            //   sized against everything else so it ALWAYS fits the context window.
            // - logs attached but a normal/case question: lightweight manifest only — fast, and
            //   enough to reference the files without a slow full-snippet prefill on CPU.
            let logContext = "";
            if (analysisRun) {
                const historyChars = c.msgs.slice(-10).reduce((a, m) => a + Math.min((m.content || '').length, 4000), 0);
                // Logs are the PRIMARY payload of an analysis run. Budget the case/research data
                // (email chain etc.) as a bounded RESERVATION rather than its full size — a large
                // synced email chain otherwise consumes the whole snippet budget AND pushes the
                // evidence past the end-trim keep-floor in completions.create, so the model got an
                // evidence-free prompt and answered "Window: N/A / no error lines provided".
                const promptBudget = await getPromptCharBudget();
                const liveDataReserve = Math.min(liveDataSection.length, Math.max(1200, Math.floor(promptBudget * 0.18)));
                const fixedOverhead = corePrompt.length + productSignatures.length + (imgContext || '').length + historyChars + (txt || '').length + 1500;
                const externalOverhead = fixedOverhead + liveDataReserve;
                if (forensicRun) {
                    if (isSmallModel && hasInstallerLog) {
                        // LEAN installer-forensic context for CPU-bound models: the deterministic
                        // root-cause analysis ONLY — no pattern profile / cross-log incident index.
                        // Keeps the prompt small (so prefill is fast and the request finishes before
                        // the browser drops it) AND strips the SQL-enumeration noise that misled the
                        // model into the wrong answer. The deterministic anchor leads, so the failing
                        // CustomAction is never trimmed away.
                        const leanManifest = await buildFileManifest(c.logs, c.lastSentAt || 0);
                        let leanEvidence = await buildInstallerFailureAnalysis(c.logs, { lean: true });
                        // Environment + deterministic cause + WHY + the deduped timeline lead this
                        // report, so a hard cap keeps the prompt bounded (fast prefill) while keeping
                        // enough for the full triage → propagation → symptom-vs-cause report.
                        if (leanEvidence.length > 6800) leanEvidence = leanEvidence.slice(0, 6800) + "\n[…older lines trimmed; root cause + timeline above are complete]\n";
                        logContext = `\n\n[INSTALLER LOG ANALYSIS]` + leanManifest + leanEvidence;
                    } else {
                        logContext = await buildLogAnalysisContext(c.logs, c.lastSentAt || 0, externalOverhead);
                    }
                } else {
                    let header = `\n\n[DIAGNOSTIC DATA — ${c.logs.length} LOG FILE(S) ATTACHED]`;
                    // Lead with the reported symptom (protected from end-trim) so the model correlates
                    // the evidence with what the customer actually reported, instead of grabbing an
                    // unrelated high-severity error.
                    if (summaryText && summaryText !== 'NO SUMMARY PROVIDED') {
                        header += `\n[REPORTED ISSUE / CASE SYMPTOM — correlate the evidence with THIS]: ${summaryText.slice(0, 600)}\n`;
                    }
                    header += await buildFileManifest(c.logs, c.lastSentAt || 0);
                    // HAR network captures are JSON — the line scanner can't read them, so parse them
                    // into HTTP-transaction evidence (4xx/5xx, redirects, OAuth/SSO error codes, FQDN
                    // mismatch) and place it FIRST so it survives trimming and leads the analysis.
                    const harLogs = c.logs.filter(l => isHarContent(l.name || "", l.content || ""));
                    for (const l of harLogs) {
                        try { header += buildHarAnalysis(l.content || "", l.name || "capture.har"); } catch (e) { console.warn('HAR analysis failed', e); }
                    }
                    // The CROSS-LOG INCIDENT INDEX carries the per-line citations (file:Line N @ ts)
                    // the model must quote; the LOG PATTERN PROFILE is just summary counts. On
                    // small/CPU models the prompt is end-trimmed, so put the line-numbered index
                    // FIRST and the summary profile last — that way the citations are never the part
                    // that gets cut (fixes "Line N/A" evidence on large runtime logs).
                    const nonHarLogs = c.logs.filter(l => !isHarContent(l.name || "", l.content || ""));
                    const incidentIndex = await buildCrossLogIncidentIndex(nonHarLogs, { patternMode: true });
                    const patternProfile = await buildLogPatternProfile(nonHarLogs);
                    header += isSmallModel ? (incidentIndex + patternProfile) : (patternProfile + incidentIndex);
                    const snippetBudget = await computeSnippetBudget(Math.max(1, nonHarLogs.length), externalOverhead + header.length);
                    const budgets = allocatePerFileBudgets(nonHarLogs, snippetBudget, isSmallModel ? 1500 : 4000);
                    logContext = header;
                    for (const l of nonHarLogs) {
                        logContext += `\n\n=== FILE: ${l.name} (${l.content.length} chars) ===\n${await getSmartLogSnippet(l.content, budgets.get(l) || 10000, l.name, l.lines)}\n=== END: ${l.name} ===`;
                    }
                }
                // Enforce the reservation now the evidence is sized: the case/research data only
                // gets the room genuinely left over — never the other way round. Trim the email
                // chain first (it is ordered NEWEST FIRST, so the newest messages survive); the
                // reported symptom already leads the log evidence, so the analysis stays anchored.
                const liveRoom = Math.max(liveDataReserve, promptBudget - fixedOverhead - logContext.length);
                if (liveDataSection.length > liveRoom) {
                    if (emailChainIdx >= 0) {
                        const chain = liveDataLines[emailChainIdx];
                        const chainRoom = liveRoom - (liveDataSection.length - chain.length);
                        if (chainRoom < chain.length) {
                            liveDataLines[emailChainIdx] = chainRoom > 400
                                ? chain.slice(0, chainRoom) + "\n[…older emails trimmed for this log analysis — ask a case question to see the full chain]"
                                : "[EMAIL CHAIN omitted for this log analysis to keep the evidence complete — ask a case question to see it]";
                            liveDataSection = liveDataLines.join('\n');
                        }
                    }
                    if (liveDataSection.length > liveRoom + 600) {
                        liveDataSection = liveDataSection.slice(0, Math.max(800, liveRoom)) + "\n[…case data trimmed to keep the log evidence complete]";
                    }
                }
            } else if (hasLogs) {
                logContext = `\n\n[ATTACHED LOGS — reference only; the user asked a question, not for a full analysis]`
                    + await buildFileManifest(c.logs, c.lastSentAt || 0);
            }

            // 4) ASSEMBLE.
            // - Forensic: logs travel in the user message; system = rules + learned + images.
            // - Analysis with logs: rules + LOGS first (strongly attended, protected from
            //   end-trim), then images, then case/research data.
            // - Otherwise (conversational / Q&A): case + research data first (the answer
            //   source), then rules, then the lightweight log manifest.
            sysPrompt = forensicRun && hasLogs
                ? `${corePrompt}${productSignatures}${learnedSection ? '\n\n' + learnedSection : ''}${knownFixesSection ? '\n\n' + knownFixesSection : ''}

${imgContext}`
                : analysisRun
                    ? `${corePrompt}

${logContext}${productSignatures}

${imgContext}

${liveDataSection}`
                    : `${liveDataSection}

${corePrompt}

${logContext}

${imgContext}`;

            // Store ONLY the clean user text in history — never log dumps. Keeping history
            // light is what lets newly added logs always fit the context on later sends.
            userMsgForModel = txt + (imgContext && !(forensicRun && hasLogs) ? `\n\n(Extracted Image Data via OCR):\n${imgContext}` : "");

            if (c.msgs.length > 0 && c.msgs[c.msgs.length - 1].role === 'user') {
                c.msgs[c.msgs.length - 1].content = userMsgForModel;
                c.msgs[c.msgs.length - 1].hidden = silent;
            } else {
                c.msgs.push({ role: 'user', content: userMsgForModel, hidden: silent });
            }

            const history = sanitizeHistoryForModel(c.msgs.slice(-10));
            if (forensicRun && hasLogs && history.length > 0) {
                // Forensic mode: the log payload travels in the FINAL user message only
                // (ephemeral — rebuilt fresh each send, never persisted to history).
                history[history.length - 1] = { role: 'user', content: `${logContext}\n\n${txt}` };
            }
            modelMessages = [{ role: 'system', content: sysPrompt }, ...history];
        }

        const selectedModel = LOCAL_AI_MODEL || null;

        // Create a per-case AbortController so navigating away or switching cases
        // does NOT cancel the ongoing stream — only an explicit stop would.
        const controller = new AbortController();
        streamControllers.set(c.id, controller);

        const reader = await OllamaAI.completions.create({
            model: selectedModel,
            messages: modelMessages,
            stream: true,
            signal: controller.signal
        });

        let resp = '';
        let thinkingResp = ''; // Accumulate thinking/reasoning content separately
        let isThinking = false; // Track whether we're in the thinking phase
        const decoder = new TextDecoder();
        let lastRender = 0;
        let pendingRender = false;
        let sseBuffer = ''; // Buffer for incomplete SSE chunks across reads

        // Detect if this is a thinking/reasoning model (Gemma 4, QwQ, etc.) (substring match to support GGUF/custom names)
        const isThinkingModel = /gemma4|gemma-4|gemma3|gemma-3|e2b|e4b|qwq|r1|think|reason/i.test(LOCAL_AI_MODEL || '');

        const renderUpdate = () => {
            if (!pendingRender) return;
            // Show thinking indicator if model is still in thinking phase (native reasoning field or incomplete tags in content)
            const hasIncompleteThink = (resp.includes('<think>') && !resp.includes('</think>')) ||
                                       (resp.includes('<|think|>') && !resp.includes('<|/think|>'));
            let displayContent = sanitizeAssistantResponse(resp);
            if ((isThinking || hasIncompleteThink) && !displayContent.trim()) {
                displayContent = '<div class="thinking-dot"></div>';
            }
            aib.innerHTML = md(displayContent);
            // Only follow the stream while the user is parked at the bottom — if they scrolled
            // up to read, leave them be (fixes the "can't scroll up, keeps jumping down" glitch).
            chatScrollToBottomIfSticky();
            pendingRender = false;
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            // Buffer NDJSON data across chunk boundaries to handle split lines
            sseBuffer += chunk;
            const lines = sseBuffer.split('\n');
            // Keep the last (possibly incomplete) line in the buffer
            sseBuffer = lines.pop() || '';
            
            for (const line of lines) {
                const data = line.trim();
                if (!data) continue;
                try {
                    const json = JSON.parse(data);
                    
                    const message = json.message || {};
                    
                    // Extract content token — native field
                    const contentTok = message.content || '';
                    
                    // Extract reasoning/thinking token — native field for Ollama reasoning models
                    const reasoningTok = message.reasoning || message.reasoning_content || message.thinking || '';
                    
                    if (reasoningTok) {
                        // Model is in thinking phase — accumulate but don't display
                        isThinking = true;
                        thinkingResp += reasoningTok;
                        pendingRender = true;
                        const now = performance.now();
                        if (now - lastRender > 300) { // Slower render during thinking
                            renderUpdate();
                            lastRender = now;
                        }
                    }
                    
                    if (contentTok) {
                        // Real content arrived — model has finished thinking
                        if (isThinking) {
                            isThinking = false;
                            console.log(`[Ollama] Thinking phase complete (${thinkingResp.length} chars). Streaming answer...`);
                        }
                        resp += contentTok;
                        pendingRender = true;
                        
                        const now = performance.now();
                        if (now - lastRender > 100) { // Render at most once every 100ms
                            renderUpdate();
                            lastRender = now;
                        }
                    }
                } catch (e) { }
            }
        }
        
        // If a thinking model never produced content tokens (all output was in reasoning field),
        // fall back to using the thinking output as the response
        if (!resp.trim() && thinkingResp.trim()) {
            console.warn('[Ollama] No content tokens received — using reasoning output as response. Model:', LOCAL_AI_MODEL);
            resp = thinkingResp;
        }

        // NEVER-BLANK SAFETY NET: an empty bubble is the failure the user reported.
        // Recover from stray reasoning tags, then the raw reasoning field, then show a
        // clear, actionable message instead of nothing.
        let finalAnswer = sanitizeAssistantResponse(resp);
        if (!finalAnswer.trim()) {
            const recovered = ((resp || '') + ' ' + (thinkingResp || ''))
                .replace(/<\/?\|?think\|?>/gi, '').trim();
            finalAnswer = sanitizeAssistantResponse(recovered);
        }
        if (!finalAnswer.trim()) {
            console.warn('[Ollama] Empty response after recovery. resp len:', resp.length, 'thinking len:', thinkingResp.length);
            finalAnswer = "⚠️ The model returned an empty response. On a CPU-only setup a large analysis can exhaust the model's output budget before it finishes.\n\n**Try this:**\n- Lower **Context Size** in Settings (⚙) to 8K\n- Attach fewer / smaller logs, or remove very large files\n- Switch to a smaller, faster model (e.g. `gemma4:2b`)\n\nThen click **Analyse Now** again.";
        }

        // Force the final paint (renderUpdate is a no-op when pendingRender is false, which
        // would otherwise leave the recovered/fallback text unrendered).
        pendingRender = true;
        resp = finalAnswer; // so renderUpdate shows the recovered text, not the raw stream
        renderUpdate();

        const assistantMsg = { role: 'assistant', content: finalAnswer, fbQuestion: txt };
        c.msgs.push(assistantMsg);
        c.lastSentAt = Date.now(); // logs uploaded after this moment get flagged as NEW next send
        saveState();
        attachFeedbackUI(aib, c, assistantMsg); // 👍/👎 self-learning loop (survives tab switches)
    } catch (e) { 
        if (e.name !== 'AbortError') {
            aib.innerHTML = `<span style="color:var(--red)">${e.message}</span>`;
        }
    }
    finally { 
        busyMap.set(c.id, false);
        streamControllers.delete(c.id);
        streamingElements.delete(c.id); // Clean up the live element reference
        $('btnSend').disabled = false;
        // Clear images after sending so they don't hang around for the next prompt
        if (c && c.imgs) {
            c.imgs = [];
            renderImgs();
            saveState();
        }
    }
}

// Sticky auto-scroll: the chat follows new tokens ONLY while the user is at the bottom.
// As soon as they scroll up, _chatStick goes false and auto-scroll stops, so they can read
// without being yanked back down. It re-engages when they scroll back to the bottom.
let _chatStick = true;
function ensureChatScrollListener() {
    const chat = $('chatMsgs');
    if (!chat || chat._stickBound) return;
    chat._stickBound = true;
    chat.addEventListener('scroll', () => {
        _chatStick = (chat.scrollHeight - chat.scrollTop - chat.clientHeight) < 140;
    }, { passive: true });
}
function chatScrollToBottomIfSticky() {
    if (!_chatStick) return;
    const chat = $('chatMsgs');
    if (chat) chat.scrollTop = chat.scrollHeight;
}

function addMsg(role, content, push = true, hidden = false) {
    if (push && activeCaseId) {
        const c = cases.find(x => x.id === activeCaseId);
        if (c) c.msgs.push({ role, content, hidden });
    }
    if (hidden) return null;
    const w = document.createElement('div'); w.className = `msg ${role}`;
    const b = document.createElement('div'); b.className = 'mb'; b.innerHTML = md(content);
    w.appendChild(b);
    const chat = $('chatMsgs');
    ensureChatScrollListener();
    chat.appendChild(w);
    chatScrollToBottomIfSticky();
    return b;
}

function exportSession() {
    if (!activeCaseId) return;
    const c = cases.find(x => x.id === activeCaseId);
    let txt = `SOTI AI ANALYSER - SESSION EXPORT\n`;
    txt += `Generated: ${new Date().toLocaleString()}\n`;
    txt += `------------------------------------------\n\n`;
    txt += `CASE INFORMATION:\n`;
    txt += `Case Number: ${$('caseNum').value || 'N/A'}\n`;
    txt += `Account: ${$('scrubAccount').value || 'N/A'}\n`;
    txt += `Customer: ${$('scrubCustomer').value || 'N/A'}\n`;
    txt += `SOTI Version: ${$('sotiVer').value || 'N/A'}\n`;
    txt += `Platform: ${$('platform').value || 'N/A'}\n\n`;
    txt += `MEETING NOTES:\n${$('meetingNotes').value || 'N/A'}\n\n`;
    txt += `------------------------------------------\n`;
    txt += `CHAT HISTORY:\n\n`;
    
    c.msgs.forEach(m => {
        if (m.hidden) return;
        const role = m.role === 'user' ? 'USER' : 'SOTI AI';
        txt += `[${role}]:\n${m.content}\n\n`;
    });

    const blob = new Blob([txt], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SOTI_AI_Session_${$('caseNum').value || 'New'}.txt`;
    a.click();
    toast('Session exported as .txt', 's');
}

// --- BOOT ---
$('btnSend').onclick = send;
$('chatIn').oninput = function() { this.style.height = 'auto'; this.style.height = (this.scrollHeight) + 'px'; };
$('chatIn').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

[
    'caseNum', 'scrubAccount', 'scrubCustomer', 'product', 'sotiVer',
    'agentVer', 'caseAge', 'platform', 'enviro', 'dsCfg', 'affDev',
    'issueSummary', 'meetingNotes', 'emailChain',
    'jiraExpected', 'jiraImpact', 'jiraRepro', 'jiraPriority'
].forEach(id => {
    const el = $(id);
    if (el) {
        const onFieldInput = () => {
            if (_switching) return; // Don't process field events during tab switch
            syncActiveCaseCiFromForm();
            requestAnimationFrame(() => updateFieldValidation(id));
            if (id === 'caseNum') scheduleRenderTabs();
            if (id === 'caseNum' || id === 'issueSummary') renderLogs();
            scheduleSaveState();
        };
        const onFieldCommit = () => {
            if (_switching) return; // Don't process field events during tab switch
            syncActiveCaseCiFromForm();
            // Product drives the SOTI/Agent Version option lists (and the 2026.0 GA build's
            // format: "2026.0.0" for MobiControl, "2026.0" for XSight). This boot loop
            // OVERWRITES any earlier $('product').onchange, so the rebuild must happen HERE
            // or a live product change never refreshes the version dropdown.
            if (id === 'product') updateVersionDropdowns();
            updateFieldValidation(id);
            if (id === 'caseNum') renderTabs();
            if (id === 'caseNum' || id === 'issueSummary') renderLogs();
            if (_saveStateTimer) clearTimeout(_saveStateTimer);
            saveState();
        };
        el.oninput = onFieldInput;
        el.onchange = onFieldCommit;
        el.onblur = onFieldCommit;
    }
});

$('btnSyncSF').onclick = async () => {
    if (!isChromeExtension()) {
        toast('Salesforce sync requires the Chrome extension', 'w');
        return;
    }
    toast('Syncing from Salesforce...', 'i');
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;
        let data = null;
        try {
            data = await chrome.tabs.sendMessage(tab.id, { action: "GET_SALESFORCE_DATA" });
        } catch (e) {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
            await new Promise(r => setTimeout(r, 500));
            data = await chrome.tabs.sendMessage(tab.id, { action: "GET_SALESFORCE_DATA" });
        }
        if (data && (data.caseNumber || data.accountName || data.subject || data.description || data.currentVersion || data.product || data.licenseType || data.caseAge)) {
            if (data.caseNumber) $('caseNum').value = data.caseNumber;
            if (data.accountName) $('scrubAccount').value = data.accountName;
            if (data.contactName) $('scrubCustomer').value = data.contactName;
            
            let summary = '';
            if (data.subject) summary += data.subject;
            if (data.description) summary += (summary ? '\n\n' : '') + data.description;
            
            if (summary) {
                $('issueSummary').value = summary;
            }
            if (data.product) {
                const options = Array.from($('product').options).map(o => o.text);
                const match = options.find(o => o.toLowerCase().includes(data.product.toLowerCase()));
                if (match) $('product').value = match;
            }
            // A programmatic product change doesn't fire 'onchange', so rebuild the SOTI
            // Version list for the synced product, then apply the synced version — mapping
            // "2026.0" <-> "2026.0.0" to the format that product uses. Without this the field
            // only refreshes when the panel is reopened.
            updateVersionDropdowns();
            if (data.currentVersion) applyVersionSelection('sotiVer', data.currentVersion);
            if (data.licenseType) {
                const lt = data.licenseType.toLowerCase();
                if (lt.includes('cloud')) $('dsCfg').value = 'Cloud';
                 if (lt.includes('subscription')) $('dsCfg').value = 'On-Prem';
            }
            if (data.caseAge) $('caseAge').value = data.caseAge;
            if (data.emailChain) $('emailChain').value = data.emailChain;

            saveState();
            renderTabs();
            renderLogs();
            toast(`Synced Case ${data.caseNumber || 'data'}`, 's');
            updateAllValidations();
        }
    } catch (err) { toast('Sync failed', 'e'); }
};

$('toggleL').onclick = () => { 
    const b = $('bodyL'); 
    const h = b.style.display === 'none';
    b.style.display = h ? '' : 'none'; 
    $('iconL').textContent = h ? '▼' : '▶';
    $('panelL').classList.toggle('collapsed', !h);
};

$('toggleR').onclick = () => { 
    const b = $('bodyR'); 
    const h = b.style.display === 'none';
    b.style.display = h ? '' : 'none'; 
    $('iconR').textContent = h ? '▼' : '▶'; 
    $('panelR').classList.toggle('collapsed', !h);
};

// --- LOG HANDLING ---
const renderLogs = () => {
    const list = $('logList');
    const none = $('noFiles');
    if (!list || !none) return;
    const c = cases.find(x => x.id === activeCaseId);
    if (!c) return;
    const hasCaseInfo = c.ci && (c.ci.caseNum || c.ci.issueSummary);
    none.textContent = hasCaseInfo ? 'Upload logs if available for deeper analysis.' : 'No files uploaded yet.';
    none.style.display = c.logs.length > 0 ? 'none' : 'block';
    const frag = document.createDocumentFragment();
    // ZIP uploads are stored as one log entry per inner file (the AI analyses each),
    // but the panel shows a single row per ZIP so the list mirrors what was attached.
    const rows = [];
    const zipRows = new Map();
    c.logs.forEach((f, i) => {
        if (f.sourceZip) {
            let row = zipRows.get(f.sourceZip);
            if (!row) {
                row = { name: f.sourceZip, isZip: true, indices: [], inner: [] };
                zipRows.set(f.sourceZip, row);
                rows.push(row);
            }
            row.indices.push(i);
            row.inner.push(f.name.startsWith(f.sourceZip + '/') ? f.name.slice(f.sourceZip.length + 1) : f.name);
        } else {
            rows.push({ name: f.name, isZip: false, indices: [i], inner: [] });
        }
    });
    rows.forEach(row => {
        const label = row.isZip
            ? `${row.name} (${row.indices.length} file${row.indices.length === 1 ? '' : 's'})`
            : row.name;
        const tooltip = row.isZip ? `${row.name}\n${row.inner.join('\n')}` : row.name;
        const item = document.createElement('div');
        item.className = 'log-item';
        item.title = tooltip;
        item.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
            <span class="log-name" title="${escapeHtml(tooltip)}">${escapeHtml(label)}</span>
            <button class="log-del">×</button>`;

        item.querySelector('.log-del').addEventListener('click', () => removeLog(row.indices));
        frag.appendChild(item);
    });
    list.innerHTML = '';
    list.appendChild(frag);

    const btn = $('btnAnalyse');
    if (btn) btn.style.display = c.logs.length > 0 ? 'block' : 'none';

    const guide = $('logGuide');
    if (guide) guide.style.display = c.logs.length > 0 ? 'none' : 'block';
};

const removeLog = (indices) => {
    const c = cases.find(x => x.id === activeCaseId);
    if (c) {
        const sorted = (Array.isArray(indices) ? indices : [indices]).slice().sort((a, b) => b - a);
        sorted.forEach(i => c.logs.splice(i, 1));
    }
    renderLogs();
    saveState();
};

async function inflateZipDeflate(bytes) {
    if (typeof DecompressionStream === "undefined") {
        throw new Error("ZIP deflate is not supported by this browser");
    }

    const formats = ["deflate-raw", "deflate"];
    let lastError = null;
    for (const format of formats) {
        try {
            const stream = new DecompressionStream(format);
            const writer = stream.writable.getWriter();
            const readPromise = new Response(stream.readable).arrayBuffer();
            await writer.write(bytes);
            await writer.close();
            return new Uint8Array(await readPromise);
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError || new Error("Unable to inflate ZIP entry");
}

function findZipEndOfCentralDirectory(bytes) {
    const min = Math.max(0, bytes.length - 0xFFFF - 22);
    for (let i = bytes.length - 22; i >= min; i--) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x4B && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
            return i;
        }
    }
    return -1;
}

async function extractZipLogEntries(file) {
    if (typeof JSZip !== "undefined") {
        const zip = await JSZip.loadAsync(file);
        const entries = [];
        const names = Object.keys(zip.files).sort();
        for (const name of names) {
            const entry = zip.files[name];
            if (entry.dir || !isSupportedLogFileName(name)) continue;
            const bytes = await entry.async("uint8array");
            await new Promise(r => setTimeout(r, 0));
            entries.push({
                name: `${file.name}/${name}`,
                content: decodeLogBytes(bytes),
                sourceZip: file.name,
                size: bytes.length
            });
        }
        return entries;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findZipEndOfCentralDirectory(bytes);
    if (eocd < 0) throw new Error("Invalid ZIP file");

    const entryCount = view.getUint16(eocd + 10, true);
    const centralDirOffset = view.getUint32(eocd + 16, true);
    const entries = [];
    const decoder = new TextDecoder("utf-8");
    let ptr = centralDirOffset;

    for (let i = 0; i < entryCount && ptr + 46 <= bytes.length; i++) {
        if (view.getUint32(ptr, true) !== 0x02014B50) break;

        const flags = view.getUint16(ptr + 8, true);
        const method = view.getUint16(ptr + 10, true);
        const compressedSize = view.getUint32(ptr + 20, true);
        const uncompressedSize = view.getUint32(ptr + 24, true);
        const nameLen = view.getUint16(ptr + 28, true);
        const extraLen = view.getUint16(ptr + 30, true);
        const commentLen = view.getUint16(ptr + 32, true);
        const localOffset = view.getUint32(ptr + 42, true);
        const nameBytes = bytes.slice(ptr + 46, ptr + 46 + nameLen);
        const rawName = decoder.decode(nameBytes).replace(/\\/g, "/");
        ptr += 46 + nameLen + extraLen + commentLen;

        if (!rawName || rawName.endsWith("/") || !isSupportedLogFileName(rawName)) continue;
        if (flags & 1) continue;
        if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034B50) continue;

        const localNameLen = view.getUint16(localOffset + 26, true);
        const localExtraLen = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const dataEnd = dataStart + compressedSize;
        if (dataStart < 0 || dataEnd > bytes.length) continue;

        let data = bytes.slice(dataStart, dataEnd);
        if (method === 8) {
            data = await inflateZipDeflate(data);
        } else if (method !== 0) {
            throw new Error(`Unsupported ZIP compression method ${method} in ${rawName}`);
        }

        await new Promise(r => setTimeout(r, 0));

        entries.push({
            name: `${file.name}/${rawName}`,
            content: decodeLogBytes(data),
            sourceZip: file.name,
            size: uncompressedSize || data.length
        });
    }

    return entries;
}

async function readLogUpload(file) {
    if (/\.zip$/i.test(file.name)) {
        return extractZipLogEntries(file);
    }

    const buffer = await file.arrayBuffer();
    return [{
        name: file.name,
        content: decodeLogBytes(buffer),
        size: file.size
    }];
}

// Tracks in-flight log uploads per case so send() never fires while files
// (especially ZIPs) are still being read — the AI would miss them otherwise.
const pendingLogUploads = new Map();

const handleFiles = async (files) => {
    const c = cases.find(x => x.id === activeCaseId);
    if (!c) return;

    const uploads = Array.from(files || []);
    if (uploads.length === 0) return;

    pendingLogUploads.set(c.id, (pendingLogUploads.get(c.id) || 0) + 1);
    toast('Uploading logs...', 'i', 0);
    const added = [];
    const skipped = [];

    try {
        for (const f of uploads) {
            try {
                const entries = await readLogUpload(f);
                if (!entries.length) {
                    skipped.push(`${f.name}: no supported log files found`);
                    continue;
                }

                for (const entry of entries) {
                    const content = normalizeLogText(entry.content || "");
                    const lines = content ? content.split('\n') : [];
                    const log = {
                        name: entry.name,
                        content: content,
                        lines: lines,
                        sourceZip: entry.sourceZip || "",
                        uploadedAt: Date.now()
                    };
                    await getLogPanelIntel(log);
                    c.logs.push(log);
                }
                // ZIPs land as one attachment in the chat note, not one line per inner file
                if (entries[0].sourceZip) {
                    added.push(`${f.name} (${entries.length} log file${entries.length === 1 ? '' : 's'})`);
                } else {
                    added.push(entries[0].name);
                }
            } catch (e) {
                skipped.push(`${f.name}: ${e.message || e}`);
            }
        }
    } finally {
        pendingLogUploads.set(c.id, Math.max(0, (pendingLogUploads.get(c.id) || 1) - 1));
    }

    renderLogs();
    saveState();

    if (added.length > 0) {
        toast('Logs uploaded', 's', 2500);
        // Visible note in the chat — also lands in history so the model knows files arrived
        addMsg('assistant', `📎 **${added.length} attachment${added.length === 1 ? '' : 's'}:** ${added.join(', ')}${skipped.length ? `\n\n⚠ Skipped: ${skipped.join('; ')}` : ''}`, true);
        if ($('panelR') && $('panelR').classList.contains('collapsed') && typeof $('toggleR').onclick === 'function') {
            $('toggleR').onclick();
        }
    } else {
        hideToast();
        if (skipped.length > 0) toast(`Upload skipped: ${skipped[0]}`, 'w', 4000);
    }
};

$('dz').onclick = () => $('fileIn').click();
$('btnAttach').onclick = () => $('fileIn').click();
['panelL', 'panelR', 'dz', 'chatMsgs', 'chatIn', 'btnAttach', 'btnImgAttach'].forEach(id => {
    const el = $(id);
    if (!el) return;
    let counter = 0;
    el.ondragover = e => { e.preventDefault(); e.stopPropagation(); };
    el.ondragenter = e => { 
        e.preventDefault(); 
        e.stopPropagation();
        counter++;
        el.classList.add('drag-active'); 
    };
    el.ondragleave = e => { 
        e.preventDefault(); 
        e.stopPropagation();
        counter--;
        if (counter === 0) el.classList.remove('drag-active'); 
    };
    el.ondrop = async e => {
        e.preventDefault();
        e.stopPropagation();
        counter = 0;
        el.classList.remove('drag-active');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const files = e.dataTransfer.files;
            const imgs = [], logs = [];
            for (const f of files) {
                if (f.type.startsWith('image/')) imgs.push(f);
                else logs.push(f);
            }
            if (imgs.length > 0 && typeof handleImages === 'function') handleImages(imgs);
            if (logs.length > 0) await handleFiles(logs);
        }
    };
});
$('fileIn').onchange = async e => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const imgs = [], logs = [];
    for (const f of files) {
        if (f.type.startsWith('image/')) imgs.push(f);
        else logs.push(f);
    }
    if (imgs.length > 0 && typeof handleImages === 'function') handleImages(imgs);
    if (logs.length > 0) await handleFiles(logs);
    e.target.value = '';
};


// --- IMAGE HANDLING ---
async function handleImages(files) {
    console.log('handleImages triggered', files);
    const c = cases.find(x => x.id === activeCaseId);
    if (!c) return;

    for (const f of files) {
        const r = new FileReader();
        r.onload = async ev => {
            let data = ev.target.result;



            const imgObj = { name: f.name, data: data, text: '', processing: true };
            if (!c.imgs) c.imgs = [];
            c.imgs.push(imgObj);
            renderImgs();
            saveState();

            // Run OCR (Tesseract v5) — 100% LOCAL, ALWAYS. The engine, worker, WASM cores and
            // language data are ALL loaded from the extension's own bundled lib/ folder. No CDN,
            // no external site, ever — in standalone mode the same local lib/ files are used via
            // relative paths (they sit next to SOTI_AI_Analyser.html). Chrome's MV3 CSP
            // (script-src/worker-src 'self') additionally hard-blocks any remote script/worker.
            try {
                const Lib = typeof Tesseract !== 'undefined' ? Tesseract : window.Tesseract;
                const isExt = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
                console.log('[OCR] Environment:', isExt ? 'Chrome Extension' : 'Standalone', '— local lib/ only');

                // Paths must be ABSOLUTE: the worker resolves relative corePath/langPath against
                // its own directory (already lib/), which would double up to lib/lib/.
                const localUrl = p => isExt ? chrome.runtime.getURL(p) : new URL(p, location.href).href;
                const workerOpts = {
                    workerPath: localUrl('lib/worker.min.js'),
                    corePath: localUrl('lib/'),
                    langPath: localUrl('lib/'),
                    workerBlobURL: false
                };
                console.log('[OCR] Worker options:', JSON.stringify(workerOpts));
                
                const worker = await Lib.createWorker('eng', 1, workerOpts);
                await worker.setParameters({ tessedit_pageseg_mode: '11' });
                const result = await worker.recognize(data);

                console.log('[OCR] Raw text length:', result.data.text.length);
                console.log('[OCR] Raw text preview:', result.data.text.substring(0, 200));

                // Clean text - only strip truly unprintable chars, keep everything else
                let cleanText = result.data.text
                    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
                    .replace(/ {3,}/g, '  ')
                    .replace(/\n{4,}/g, '\n\n\n')
                    .trim();

                // Set text IMMEDIATELY - re-find imgObj in current cases array to avoid detached reference
                const liveCase = cases.find(x => x.id === activeCaseId);
                const liveImg = liveCase && liveCase.imgs ? liveCase.imgs.find(i => i.name === f.name && i.processing) : null;
                const target = liveImg || imgObj; // fallback to closure ref
                target.text = cleanText || "[OCR Engine found no readable text]";
                target.processing = false;
                console.log('[OCR] Text assigned to LIVE img:', target.text.substring(0, 50));
                toast(`Text extracted successfully`, 's');

                await worker.terminate();
            } catch (e) {
                console.error('OCR failed', e);
                const liveCase2 = cases.find(x => x.id === activeCaseId);
                const liveImg2 = liveCase2 && liveCase2.imgs ? liveCase2.imgs.find(i => i.name === f.name && i.processing) : null;
                const target2 = liveImg2 || imgObj;
                target2.text = `[OCR failed: ${e.message || e}]`;
                target2.processing = false;
            } finally {
                renderImgs();
                saveState();
            }
        };
        r.readAsDataURL(f);
    }
}

const renderImgs = () => {
    const strip = $('imgPreview');
    if (!strip) return;
    const c = cases.find(x => x.id === activeCaseId);
    if (!c || !c.imgs || c.imgs.length === 0) {
        strip.style.display = 'none';
        return;
    }

    strip.style.display = 'flex';
    const frag = document.createDocumentFragment();
    c.imgs.forEach((img, i) => {
        const thumb = document.createElement('div');
        thumb.className = 'img-thumb' + (img.processing ? ' processing' : '');
        thumb.style.backgroundImage = `url(${img.data})`;
        

        if (img.text) {
            const tag = document.createElement('div');
            tag.className = 'img-ocr-tag';
            tag.textContent = 'OCR';
            thumb.appendChild(tag);
        }

        const del = document.createElement('div');
        del.className = 'img-del';
        del.textContent = '×';
        del.onclick = (e) => {
            e.stopPropagation();
            removeImg(i);
        };

        thumb.appendChild(del);
        frag.appendChild(thumb);
    });
    strip.innerHTML = '';
    strip.appendChild(frag);
};

const removeImg = (i) => {
    const c = cases.find(x => x.id === activeCaseId);
    if (c) c.imgs.splice(i, 1);
    renderImgs();
    saveState();
};

$('btnImgAttach').onclick = () => $('imgFileIn').click();
$('imgFileIn').onchange = e => handleImages(e.target.files);



$('btnAnalyse').onclick = async () => {
    const c = cases.find(x => x.id === activeCaseId);
    if (!c || !c.logs || c.logs.length === 0) {
        toast('No logs attached to analyse', 'e');
        return;
    }

    // Update Progress Indicator
    const pWrap = $('progWrap');
    const pLbl = $('progLbl');
    const pFill = $('progFill');
    if (pWrap && pLbl && pFill) {
        pLbl.textContent = "Analysing logs...";
        pWrap.style.display = 'flex';
        pFill.style.transform = '';
        pFill.style.animation = 'progress-slide 2s infinite ease-in-out';
        pFill.style.background = 'linear-gradient(90deg, var(--blue), var(--blue2))';
        pFill.style.width = '30%';
    }

    // Collapse the logs panel
    const b = $('bodyR');
    b.style.display = 'none';
    $('iconR').textContent = '▶';
    $('panelR').classList.add('collapsed');

    // Yield control to let the browser paint the "Analysing logs..." progress indicator
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50)));

    // Send "Analyse" as a silent chat message - this triggers the
    // standard send() flow but hides the user prompt from the UI.
    await send('Analyse', true);

    // Mark as completed
    if (pLbl && pFill) {
        pLbl.textContent = "Log Analysis Completed";
        pFill.style.animation = 'none';
        pFill.style.transform = 'none';
        pFill.style.width = '100%';
        pFill.style.background = 'var(--green)';
        
        // Hide after 6 seconds to keep UI clean but show result
        setTimeout(() => {
            if (pWrap) pWrap.style.display = 'none';
        }, 6000);
    }

    $('chatIn').focus();
};


$('btnNew').onclick = createNewCase;

// More Options Dropdown Logic
$('btnMore').onclick = (e) => {
    e.stopPropagation();
    const d = $('moreDropdown');
    d.style.display = d.style.display === 'none' ? 'flex' : 'none';
};

if ($('moreDropdown')) {
    $('moreDropdown').onclick = (e) => e.stopPropagation();
}

window.onclick = () => {
    $('moreDropdown').style.display = 'none';
};

$('btnSettings').onclick = () => {
    $('moreDropdown').style.display = 'none';
    openSettingsModal();
};

$('btnExport').onclick = () => {
    $('moreDropdown').style.display = 'none';
    exportSession();
};

$('btnPop').onclick = () => {
    $('moreDropdown').style.display = 'none';
    if (!isChromeExtension()) {
        window.open(window.location.href, '_blank', 'width=480,height=900');
        return;
    }
    chrome.windows.create({
        url: chrome.runtime.getURL('SOTI_AI_Analyser.html'),
        type: 'popup',
        width: 450,
        height: 800
    });
};



// ---------------------------------------------------------------------------
// JIRA "Log Analysis" block — deterministic evidence, never conversational text
// ---------------------------------------------------------------------------
// The Log Analysis section of a JIRA ticket MUST contain the forensic Chronological
// Triage table (| Timestamp | Location | Event |) produced by log analysis — NOT
// whatever the latest assistant turn happened to be (a case summary, an "are you
// sure?" reply). Left to the LLM, the model grabs the most recent "analysis-like"
// text from the chat history and drops it into the code block, which is exactly the
// bug being fixed. These two helpers pull the real triage table out of the last
// forensic report and force it into the generated ticket regardless of the model.

// Pull the DATA rows of the most recent "Chronological Triage" table from the
// conversation. Returns the rows joined by newlines, or null if no forensic report
// with a triage table exists in this case.
function extractForensicTriageForJira(c) {
    if (!c || !Array.isArray(c.msgs)) return null;

    const isTableRow      = (row) => /^\s*\|.*\|\s*$/.test(row);
    const isSeparatorRow  = (row) => /^\s*\|[\s:\-|]+\|?\s*$/.test(row);
    const isTriageHeader   = (row) => /\btimestamp\b/i.test(row) && /\b(event|location)\b/i.test(row);

    for (let i = c.msgs.length - 1; i >= 0; i--) {
        const m = c.msgs[i];
        if (!m || m.role !== 'assistant' || typeof m.content !== 'string') continue;
        const lines = m.content.split('\n');

        // Anchor on the "Chronological Triage" heading; otherwise fall back to any
        // table whose header row is the triage signature (Timestamp + Event/Location).
        let startIdx = -1;
        const headingIdx = lines.findIndex(l => /chronological\s+triage/i.test(l));
        if (headingIdx !== -1) {
            startIdx = headingIdx + 1;
        } else {
            const hdrIdx = lines.findIndex(isTriageHeader);
            if (hdrIdx === -1) continue; // no triage table in this message
            startIdx = hdrIdx;
        }

        // Skip forward to the first table row, then collect the contiguous | block.
        let j = startIdx;
        while (j < lines.length && !isTableRow(lines[j])) j++;
        const rows = [];
        while (j < lines.length && isTableRow(lines[j])) {
            rows.push(lines[j].trim());
            j++;
        }

        // Keep only real data rows: drop the header (Timestamp/Event) and separator (---).
        const dataRows = rows.filter(r => !isSeparatorRow(r) && !isTriageHeader(r));
        if (dataRows.length > 0) return dataRows.join('\n');
    }
    return null;
}

// Overwrite whatever the model produced inside the JIRA "Log Analysis:" code block
// with our verified evidence. This is the guarantee — the model is never trusted to
// preserve this block. `logAnalysisContent` is the deterministic triage/evidence text.
function enforceJiraLogAnalysis(jira, logAnalysisContent) {
    if (!jira || !logAnalysisContent) return jira;
    const block = `Log Analysis:\n{code:java}\n${logAnalysisContent}\n{code}`;

    // Primary: replace "Log Analysis:" plus the immediately following {code...}...{code}
    // block (first closing {code} wins, so a later code block is left untouched).
    const rx = /Log Analysis:\s*\r?\n\{code(?::[a-zA-Z0-9]+)?\}[\s\S]*?\{code\}/;
    if (rx.test(jira)) return jira.replace(rx, block);

    // Fallback: the model dropped the code block. Replace from "Log Analysis:" up to
    // the next section separator / heading so nothing else is disturbed.
    const rx2 = /Log Analysis:[\s\S]*?(?=\r?\n\*-{3,}|\r?\nh1\.|\r?\n\*\{color|$)/;
    if (/Log Analysis:/.test(jira)) return jira.replace(rx2, block + '\n');

    return jira;
}

// Pull the single most salient error keyword out of each Log Analysis row — the token an
// engineer would grep for (an exception class, an error constant, a quoted error value).
// Feeds the JIRA "Keyword for better formatting and visibility" block. Deterministic: one
// keyword per row, de-duplicated, order preserved. Returns "" when nothing matches.
function extractLogAnalysisKeywords(logAnalysisContent) {
    if (!logAnalysisContent) return "";

    // The Event column is everything after the 2nd pipe in a "| ts | loc | event |" row;
    // for non-table lines, use the whole line.
    const eventOf = (line) => {
        const inner = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
        const parts = inner.split('|');
        return (parts.length >= 3 ? parts.slice(2).join('|') : line).trim();
    };

    // First pattern that matches an Event wins (highest signal first).
    const patterns = [
        /\b([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+\.[A-Z][A-Za-z0-9]+)\b/, // java.lang.IllegalStateException
        /"Error"\s*:\s*"([^"]+)"/i,                                     // "Error":"UnspecificError"
        /r#([A-Za-z_][A-Za-z0-9_]{2,})/,                               // Error::Rc(r#OUT_OF_KEYS_PERMANENT_ERROR)
        /\b([A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+)\b/,                      // OUT_OF_KEYS_PERMANENT_ERROR (ALL_CAPS)
        /\b([A-Z][A-Za-z0-9]*(?:Exception|Error|Failure|Fault|Timeout|Denied|Refused))\b/, // IllegalStateException
    ];

    const seen = new Set();
    const keywords = [];
    for (const raw of logAnalysisContent.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const event = eventOf(line);
        for (const rx of patterns) {
            const m = event.match(rx);
            if (m && m[1]) {
                const kw = m[1].trim();
                if (!seen.has(kw)) { seen.add(kw); keywords.push(kw); }
                break; // one keyword per row
            }
        }
    }
    return keywords.join('\n');
}

// Post-generation guards for the two fields the model must never freelance:
//  - the "Keyword for better formatting and visibility" block (forced to the extracted keywords)
//  - the L3/SME "Analysis:" field (forced to TBC — an engineer fills it, not the AI)
function enforceJiraKeywordBlock(jira, keywordContent) {
    if (!jira) return jira;
    const block = `Keyword for better formatting and visibility\n{code:java}\n${keywordContent || ''}\n{code}`;
    const rx = /Keyword for better formatting and visibility\s*\r?\n\{code(?::[a-zA-Z0-9]+)?\}[\s\S]*?\{code\}/;
    if (rx.test(jira)) return jira.replace(rx, block);
    // Block missing — insert it right after the Log Analysis code block.
    const laRx = /(Log Analysis:\s*\r?\n\{code(?::[a-zA-Z0-9]+)?\}[\s\S]*?\{code\})/;
    if (laRx.test(jira)) return jira.replace(laRx, `$1\n\n${block}`);
    return jira;
}

// The trailing L3/SME Engineer section is entirely static (an L3 engineer fills it, not the AI).
// Kept as a single source of truth used by both the template and the reconstruction guard below.
function getJiraL3SmeSection() {
    return `*------------------------------------------------------------------------------------------------------------*
h1. {color:#4c9aff}*L3/SME Engineer*{color}

Name: TBC

Analysis: TBC

Otherwise, why was L3/SME not consulted: TBC`;
}

// Guarantee the L3/SME section exists and its Analysis stays TBC. Small local models sometimes
// DROP this all-TBC section entirely (they were told not to write an analysis there), so if the
// heading is missing we append the canonical section; if it is present we force Analysis to TBC.
function ensureJiraL3Section(jira) {
    if (!jira) return jira;
    if (/L3\/SME Engineer/.test(jira)) {
        // Present — force everything between "Analysis:" and "Otherwise, why..." to TBC, and
        // force the "Otherwise, why..." value to TBC as well so neither field can drift.
        const rx = /(L3\/SME Engineer[\s\S]*?\bAnalysis\s*:)[\s\S]*?(?=\r?\n[ \t]*Otherwise, why was L3\/SME not consulted)/;
        if (rx.test(jira)) jira = jira.replace(rx, '$1 TBC\n');
        jira = jira.replace(/(Otherwise, why was L3\/SME not consulted:)[^\n]*/, '$1 TBC');
        return jira;
    }
    // Missing entirely — append the canonical section (dropping any dangling trailing separator).
    const base = jira.replace(/\s+$/, '').replace(/\n?\*-{3,}\*\s*$/, '').replace(/\s+$/, '');
    return base + '\n\n' + getJiraL3SmeSection() + '\n';
}

// Name the log files actually in play. Prefer the case's uploaded logs; otherwise recover the
// filenames referenced in the forensic evidence (triage rows + report) so the field never shows
// "N/A" when the logs were analysed from pasted content rather than uploaded as files.
function deriveJiraLogNames(c, logAnalysisContent) {
    if (c && Array.isArray(c.logs) && c.logs.length > 0) {
        const names = c.logs.map(l => l && l.name).filter(Boolean);
        if (names.length) return names.join(', ');
    }
    const found = new Set();
    const scan = (text) => {
        if (!text) return;
        const rx = /\b([A-Za-z0-9][A-Za-z0-9_.-]*\.log)\b/g;
        let m;
        while ((m = rx.exec(text)) !== null) found.add(m[1]);
    };
    scan(logAnalysisContent);
    if (c && Array.isArray(c.msgs)) {
        // Newest forensic report that references log files.
        for (let i = c.msgs.length - 1; i >= 0; i--) {
            const mm = c.msgs[i];
            if (mm && mm.role === 'assistant' && /Chronological\s+Triage|\.log\b/i.test(mm.content || '')) {
                scan(mm.content);
                break;
            }
        }
    }
    return found.size > 0 ? [...found].join(', ') : 'N/A';
}

// The official template intentionally drops the Jira-wiki preamble, the Background heading, the
// log-size handling notes, and the "outline the steps" repro placeholder. Strip them if the model
// re-emits them from memory, and turn any leftover "[AI: ...]" placeholder into TBC so a raw
// instruction never ships in the ticket.
function cleanupJiraOutput(jira) {
    if (!jira) return jira;
    return stripEmailChainMarkers(jira)
        .replace(/\*\{color:#de350b\}Requirements for the Jira Filing:[^\n]*\r?\n?/gi, '')
        .replace(/\*\{color:#de350b\}Please fill in all the details\.\{color\}\*[^\n]*\r?\n?/gi, '')
        .replace(/^[ \t]*h1\.\s*\{color:#4c9aff\}\*Background\*\{color\}[ \t]*\r?\n?/gim, '')
        .replace(/^[ \t]*\*\s*If each log file\b[^\n]*\r?\n?/gim, '')
        .replace(/^[ \t]*\*\s*If log file\b[^\n]*\r?\n?/gim, '')
        .replace(/^[ \t]*\*\s*If SFTP is needed\b[^\n]*\r?\n?/gim, '')
        .replace(/[ \t]*PLEASE OUTLINE THE STEPS IN DETAIL[ \t]*/gi, '')
        .replace(/\[AI:[^\]]*\]/g, 'TBC')
        .replace(/^\s+/, '')          // drop leading blank lines left by the removed preamble
        .replace(/\n{3,}/g, '\n\n');  // collapse gaps left by removed lines
}

$('btnJira').onclick = () => {
    $('mJiraReview').style.display = 'flex';
};

$('mJiraReviewClose').onclick = $('btnJiraReviewCancel').onclick = () => {
    $('mJiraReview').style.display = 'none';
};

$('btnGenerateJira').onclick = async () => {
    $('mJiraReview').style.display = 'none';
    $('mGen').style.display = 'flex'; // Show loading modal early
    
    // Yield control to let the browser paint the modal
    await new Promise(resolve => setTimeout(resolve, 10));

    saveState(); // Final save before generating
    
    // Build full context from case info + conversation + logs + review modal
    const expected   = $('jiraExpected').value || 'N/A';
    const impact     = $('jiraImpact').value || 'N/A';
    const priority   = $('jiraPriority').value || 'Medium';
    const repro      = $('jiraRepro').value || 'N/A';
    
    const c          = cases.find(x => x.id === activeCaseId);
    if (!c) {
        $('mGen').style.display = 'none';
        return;
    }
    const caseNum    = $('caseNum').value || 'N/A';
    const account    = $('scrubAccount').value || 'N/A';
    const customer   = $('scrubCustomer').value || 'N/A';
    const sotiVer    = $('sotiVer').value || 'N/A';
    const agentVer   = $('agentVer').value || 'N/A';
    const product    = $('product').value || 'N/A';
    const platform   = $('platform').value || 'N/A';
    const enviro     = $('enviro').value || 'N/A';
    const hosting    = $('dsCfg').value || 'N/A';
    const affDev     = $('affDev').value || 'N/A';
    const issue      = $('issueSummary').value || '';
    const notes      = $('meetingNotes').value || '';
    const chatCtx    = c.msgs.slice(-20).map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n');

    // Gather pre-parsed log facts and build deep log context
    let parsedLogFacts = "";
    let prefilledServerOS = "TBC";
    let prefilledSQLVersion = "TBC";
    let prefilledOSVersionSQL = "TBC";
    let rawSnippets = "";
    if (c.logs.length > 0) {
        parsedLogFacts += "### PRE-PARSED LOG DETAILS:\n";
        for (const log of c.logs) {
            parsedLogFacts += `- Log Name: ${log.name}\n`;
            if (log.panelIntel) {
                parsedLogFacts += `  * Product Context: ${log.panelIntel.product || 'Unknown'}\n`;
                parsedLogFacts += `  * SQL Target Endpoint: ${log.panelIntel.sqlTarget || 'Unknown'}\n`;
                parsedLogFacts += `  * Azure SQL Database: ${log.panelIntel.azureSql ? 'Yes' : 'No'}\n`;
                parsedLogFacts += `  * Status/Verdict: ${log.panelIntel.verdict || 'N/A'}\n`;
                if (log.panelIntel.firstTimestamp) {
                    parsedLogFacts += `  * Log Timeframe: ${log.panelIntel.firstTimestamp} to ${log.panelIntel.lastTimestamp}\n`;
                }
                if (log.panelIntel.sqlTarget) {
                    prefilledSQLVersion = log.panelIntel.sqlTarget;
                    if (log.panelIntel.azureSql) {
                        prefilledSQLVersion = `Azure SQL Database (${log.panelIntel.sqlTarget})`;
                        prefilledOSVersionSQL = "Azure PaaS";
                    }
                }
            }

            await precomputeLogIntel(log);
            const { prefilteredIndices, timestampCache, intelCache } = log.precomputedIntel;
            const lines = log.lines || [];
            
            const phases = await extractFailurePhases(lines, log);
            const sqlFacts = await collectDistinctSqlFacts(lines, log);
            
            if (phases.length > 0 || sqlFacts.length > 0) {
                rawSnippets += `\n--- Failure evidence from ${log.name} ---\n`;
                if (phases.length > 0) {
                    rawSnippets += `Chronological phases:\n`;
                    phases.forEach(p => {
                        rawSnippets += `Line ${p.lineNum} @ ${p.timestamp || 'No Timestamp'}: ${p.title}\n`;
                        if (p.window && p.window.text) {
                            rawSnippets += p.window.text.trim().split('\n').slice(0, 10).map(l => "  " + l).join('\n') + "\n";
                        }
                    });
                }
                if (sqlFacts.length > 0) {
                    rawSnippets += `Unique SQL Messages:\n`;
                    sqlFacts.slice(0, 8).forEach(sf => {
                        rawSnippets += `Line ${sf.lineNum} @ ${sf.timestamp || 'No Timestamp'}: ${sf.text}\n`;
                    });
                }
            } else {
                // Fallback to top candidates
                const candidateLines = [];
                for (let idx = 0; idx < prefilteredIndices.length; idx++) {
                    const lineIdx = prefilteredIndices[idx];
                    const intel = intelCache[lineIdx];
                    if (intel.isForensic && !intel.hasStackFrame) {
                        candidateLines.push({
                            lineNum: lineIdx + 1,
                            text: lines[lineIdx].trim(),
                            timestamp: timestampCache[lineIdx] || ""
                        });
                    }
                }
                if (candidateLines.length > 0) {
                    rawSnippets += `\n--- High-signal events from ${log.name} ---\n`;
                    candidateLines.slice(0, 8).forEach(cl => {
                        rawSnippets += `Line ${cl.lineNum} @ ${cl.timestamp}: ${cl.text}\n`;
                    });
                }
            }
        }
    }
    if (!rawSnippets) {
        rawSnippets = "[No high-signal SQL or MSI logs detected]";
    }

    // The Log Analysis block is deterministic evidence, never model prose. Prefer the
    // Chronological Triage table from the most recent forensic report; fall back to the
    // parsed raw snippets when no forensic analysis has been run in this case.
    const logAnalysisContent = extractForensicTriageForJira(c) || rawSnippets.trim();
    // The "Keyword for better formatting" block is the grep-able error tokens from those rows.
    const keywordContent = extractLogAnalysisKeywords(logAnalysisContent);

    const prefilledAgentVer = agentVer !== 'N/A' ? agentVer : 'TBC';
    const prefilledSotiVer = sotiVer !== 'N/A' ? sotiVer : 'TBC';
    const prefilledPlatform = platform !== 'N/A' ? platform : 'TBC';
    const prefilledLogNames = deriveJiraLogNames(c, logAnalysisContent);

    const JIRA_TEMPLATE = `h3. *Description of Issue:*
 * [AI: Generate a detailed, professional technical description of the issue based on case details, conversation, and notes]

h3. *Expected Behavior:*
 * ${expected !== 'N/A' ? expected : '[AI: Generate expected behavior details]'}

h3. *Known Issues:*
 * Please link known Jira tickets, if any (TBC).

h3. *Detailed Description of Business Impact:*
 * ${impact !== 'N/A' ? impact : '[AI: Generate business impact summary]'}

h3. *Justification of Priority:*
 * [AI: Provide a clear justification for why this is ${priority} priority]

h3. *Number of Devices Affected:*
 * ${affDev !== 'N/A' ? affDev : 'TBC'}

*------------------------------------------------------------------------------------------------------------*
h1. {color:#4c9aff}*Environment:*{color}

Which MC Server Version did it work on before?: TBC

Any recent changes?: TBC

Server Count and Details: TBC

Server OS Version: ${prefilledServerOS}

System Requirements verified?: Yes

SQL Version: ${prefilledSQLVersion}

Server OS Version for SQL server: ${prefilledOSVersionSQL}

*------------------------------------------------------------------------------------------------------------*
h1. {color:#4c9aff}*Device Details*{color}

Affected Platforms (Android/Windows/iOS): ${prefilledPlatform}

Enrollment type (AEDO, COPE, iOS ADE, Windows Modern, Classic etc.): TBC

MobiControl Agent Version: ${prefilledAgentVer}

Plug-in version: N/A

Which agent version did it work on?: TBC

Any Recent changes: TBC

Affected Devices Manufacturer: TBC

Affected Model: TBC

Affected OS Version: TBC

Affected OEM Version: TBC

Browser Used (If applicable): N/A

*------------------------------------------------------------------------------------------------------------*
h1. {color:#4c9aff}*Other SOTI Apps*{color}

SOTI Surf/Settings Manager/HUB version: N/A

*------------------------------------------------------------------------------------------------------------*
h1. {color:#4c9aff}*Troubleshooting Steps:*{color}

*Workarounds Suggested:*
 * [AI: List workarounds attempted or suggested based on context]

*------------------------------------------------------------------------------------------------------------*
h1. {color:#4c9aff}*Issue Reproduction*{color}

Repro Steps: ${repro !== 'N/A' ? repro : 'TBC'}

Is the issue reproducible in-house?: TBC

Repro Environment Details: TBC

Results: TBC

Screenshot and video of the issue: TBC

*------------------------------------------------------------------------------------------------------------*
h1. {color:#4c9aff}*Log Details*{color}

*Detailed Time Stamps and Time zone (device and end-user) of the repro steps:* TBC

DeviceID/Devid: TBC

Name of the log file: ${prefilledLogNames}

Log Analysis:
{code:java}
${logAnalysisContent}
{code}

Keyword for better formatting and visibility
{code:java}
${keywordContent}
{code}

${getJiraL3SmeSection()}`;

    const systemPrompt = `You are a SOTI Tier 3 Support AI. Your task is to refine and fill in the OFFICIAL SOTI JIRA TEMPLATE using the provided Source Data.

### CRITICAL INSTRUCTIONS:
1. Replace all placeholders (like "[AI: ...]") with intelligent, detailed technical text generated from the notes, case summary, conversation history, and repro steps.
2. DO NOT modify or remove the pre-filled values in the template (such as SQL Version, Server OS Version, Agent Version, Name of the log file, or the raw log snippets inside the code block) unless you have more specific information to update them with.
2a. The "Log Analysis:" {code:java} block AND the "Keyword for better formatting and visibility" {code:java} block are VERBATIM pre-filled evidence. Reproduce BOTH exactly as given. NEVER replace the Log Analysis block with a case summary, a chat answer, or prose, and NEVER edit the keyword list.
2b. ALWAYS reproduce the entire "L3/SME Engineer" section (heading, Name, Analysis, and the "Otherwise, why was L3/SME not consulted" line). Leave its "Analysis:" field EXACTLY as "Analysis: TBC" — do NOT write an analysis there and do NOT drop the section; an L3 engineer fills it, not you.
3. For Description of Issue: Write a comprehensive, multi-sentence technical summary of the failure behavior, action, and components.
4. For Justification of Priority: Write a professional justification of why this issue is classified under the selected priority level based on business impact.
5. For Troubleshooting Steps (Workarounds Suggested): List concrete workarounds/investigation steps from the notes and logs. Do NOT write an L3/SME engineering analysis anywhere — that field stays TBC (see 2b).
6. Output the template EXACTLY as structured. Do NOT add a "Requirements for the Jira Filing" line, a "Please fill in all the details" line, a "Background" heading, log-file size/SFTP handling notes, or a "PLEASE OUTLINE THE STEPS IN DETAIL" line — these are intentionally omitted.

### FORMATTING RULES:
- OUTPUT ONLY the completed SOTI JIRA template.
- DO NOT include any preamble, introduction, or concluding remarks.
- PRESERVE ALL MARKUP: Keep {color}, h1., h3., and {code:java} blocks exactly as they are in the template.
- YOUR RESPONSE MUST START WITH: "h3. *Description of Issue:*"`;

    const userPrompt = `### SOURCE DATA FOR ANALYSIS:
- Case Number: ${caseNum}
- Account/Customer: ${account} / ${customer}
- Product: ${product}
- Mc Version: ${sotiVer}
- Agent: ${agentVer}
- Platform/Env: ${platform} (${enviro})
- Expected Behavior: ${expected}
- Business Impact: ${impact}
- Priority: ${priority}
- Repro Steps: ${repro}
- Notes: ${notes}

${parsedLogFacts}

- Conversation History:
${chatCtx}

### OFFICIAL SOTI JIRA TEMPLATE (FILL THIS OUT):
${JIRA_TEMPLATE}`;

    try {
        if (!LOCAL_AI_MODEL) {
            $('mGen').style.display = 'none';
            return toast('No model selected. Open Settings (⚙) and pick an Ollama model.', 'e', 5000);
        }
        const baseUrl = LOCAL_AI_URL.replace(/\/$/, '');
        
        const numPredict = 3072;
        const estimatedTokens = Math.ceil(userPrompt.length / 3.0);
        const neededTokens = estimatedTokens + numPredict + 500;
        const { hardMax: jiraHardMax } = await getHardCtxMax(LOCAL_AI_MODEL);
        const numCtx = Math.max(8192, Math.min(jiraHardMax, Math.ceil(neededTokens / 1024) * 1024));

        console.log(`[Ollama JIRA Request] Model: ${LOCAL_AI_MODEL}, Chars: ${userPrompt.length}, Est Tokens: ${estimatedTokens}, set num_ctx: ${numCtx}`);

        // Detect thinking models — disable internal reasoning for Gemma 4, etc. (substring match to support GGUF/custom names)
        const isThinkingModelJira = /gemma4|gemma-4|gemma3|gemma-3|e2b|e4b|qwq|r1|think|reason/i.test(LOCAL_AI_MODEL || '');

        const res = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: LOCAL_AI_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                stream: false,
                keep_alive: -1,
                ...(isThinkingModelJira ? { think: false } : {}), // Disable thinking phase for Gemma 4 etc.
                options: {
                    num_ctx: numCtx,
                    temperature: 0.0,
                    repeat_penalty: 1.1,
                    top_p: 0.9,
                    num_predict: numPredict // Use standard calculated budget, -1 can cause instant aborts
                }
            })
        });
        if (!res.ok) throw new Error(`Ollama error ${res.status}`);
        const data = await res.json();
        // Handle thinking models (Gemma 4 e2b/e4b, etc.) that put output in reasoning fields
        const message = data.message || {};
        let filled = message.content || '';
        if (!filled.trim()) {
            // Fallback: check reasoning fields used by thinking models
            filled = message.reasoning_content || message.reasoning || message.thinking || '';
            if (filled) console.warn('[Ollama JIRA] Content was empty — using reasoning field. Model:', LOCAL_AI_MODEL);
        }
        // Strip any <think>...</think> blocks from the response
        filled = filled.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').replace(/<\|think\|>[\s\S]*?(?:<\|\/?think\|>|$)/gi, '').trim();
        // Deterministically force the model-owned-but-must-not-freelance fields:
        //  - Log Analysis block back to the verified forensic evidence (stops it being filled
        //    with a case summary / "are you sure?" reply instead of the triage).
        //  - Keyword block to the extracted error tokens.
        //  - L3/SME Analysis back to TBC.
        filled = enforceJiraLogAnalysis(filled, logAnalysisContent);
        filled = enforceJiraKeywordBlock(filled, keywordContent);
        filled = ensureJiraL3Section(filled);
        // Strip any boilerplate the model re-added (preamble, Background heading, log-size notes,
        // "outline the steps") and neutralise leftover [AI: ...] placeholders.
        filled = cleanupJiraOutput(filled);
        $('mGen').style.display = 'none';
        if (!filled) return toast('JIRA generation failed', 'e');
        $('jiraTa').value = filled;
        $('mJira').style.display = 'flex';
        toast('✓ JIRA Report Ready', 's');
    } catch (e) { 
        $('mGen').style.display = 'none';
        console.error('JIRA Generation Error:', e);
        alert('JIRA Generation Failed:\n\n' + e.message);
        toast('JIRA failed: ' + e.message, 'e'); 
    }
};
$('mJiraClose').onclick = $('btnJiraDone').onclick = () => $('mJira').style.display = 'none';
$('btnCopyJira').onclick = () => { $('jiraTa').select(); document.execCommand('copy'); toast('Copied!', 's'); };

loadState();
fetchLatestSOTIVersions();
loadLocalAISettings().then(() => {
    updateLocalAIBadge();
    // Preload the model so the first query is warm (no model-load wait on a slow CPU).
    setTimeout(() => { warmUpModel(); }, 1500);
});
// Warm the offline knowledge-base index in the background so the first
// question never pays the 24MB parse cost.
setTimeout(() => { PulseKB.ensureIndex().catch(() => {}); }, 3000);

// --- SETTINGS MODAL (AI - OLLAMA & PULSE SYNC) ---
async function refreshSettingsModal() {
    const urlInp = $('localAiUrl');
    const modelSel = $('localAiModelSel');
    const statusEl = $('localAiStatus');
    
    // Setup Pulse Sync UI
    if ($('pulseSyncUrl')) $('pulseSyncUrl').value = window.PULSE_SYNC_URL || '';
    if ($('pulseSyncStatus')) {
        $('pulseSyncStatus').textContent = window.PULSE_LAST_SYNC 
            ? `Last synced: ${new Date(window.PULSE_LAST_SYNC).toLocaleString()}` 
            : 'Never synced';
        $('pulseSyncStatus').style.color = window.PULSE_LAST_SYNC ? 'var(--green)' : 'var(--txt2)';
    }

    if (urlInp) urlInp.value = LOCAL_AI_URL;
    if (urlInp && !urlInp.placeholder) urlInp.placeholder = 'http://127.0.0.1:11434';
    if ($('localAiCtxSel')) $('localAiCtxSel').value = LOCAL_AI_CTX_MAX || 'auto';

    if (statusEl) { statusEl.textContent = 'Connecting to Ollama...'; statusEl.style.color = 'var(--txt2)'; }
    const models = await fetchOllamaModels(urlInp ? urlInp.value : LOCAL_AI_URL);
    LOCAL_AI_MODELS = models;
    if (modelSel) {
        if (models.length === 0) {
            modelSel.innerHTML = '<option value="">No models found - is Ollama running?</option>';
            if (statusEl) {
                const tried = getOllamaProbeUrls(urlInp ? urlInp.value : LOCAL_AI_URL).join(', ');
                if (isStandalonePage()) {
                    statusEl.innerHTML = '⚠️ Ollama not reachable from standalone page.<br><span style="font-size:10px">Run <strong>serve_standalone.bat</strong>, open <code>http://127.0.0.1:8765/SOTI_AI_Analyser.html</code> (not file://). Ollama must be running on 127.0.0.1:11434.</span>';
                } else {
                    statusEl.textContent = '⚠️ Ollama not reachable. Tried: ' + tried + ' - use http://127.0.0.1:11434 if browser works on localhost';
                }
                statusEl.style.color = 'var(--warn)';
            }
        } else {
            modelSel.innerHTML = models.map(m => `<option value="${m}" ${m === LOCAL_AI_MODEL ? 'selected' : ''}>${m.replace(/:latest$/i, '')}</option>`).join('');
            if (!LOCAL_AI_MODEL && models.length > 0) LOCAL_AI_MODEL = pickPreferredOllamaModel(models);
            if (statusEl) { statusEl.textContent = `✅ ${models.length} model(s) available`; statusEl.style.color = 'var(--green)'; }
        }
    }
}

async function openSettingsModal() {
    $('mSettings').style.display = 'flex';
    await refreshSettingsModal();
}

$('mSettingsClose').onclick = () => $('mSettings').style.display = 'none';
if ($('btnCancelSettings')) $('btnCancelSettings').onclick = () => $('mSettings').style.display = 'none';

$('localAiUrl').oninput = () => {
    LOCAL_AI_URL = $('localAiUrl').value.trim() || 'http://127.0.0.1:11434';
};

if ($('pulseSyncUrl')) {
    $('pulseSyncUrl').oninput = () => {
        window.PULSE_SYNC_URL = $('pulseSyncUrl').value.trim();
    };
}

function scrapeUrlViaTabTabFallback(url) {
    return new Promise((resolve, reject) => {
        if (!isChromeExtension() || !chrome.tabs || !chrome.scripting) {
            return reject(new Error("Tab crawling is only supported when running as a Chrome Extension."));
        }
        let tabId = null;
        let updateListener = null;
        let timeoutId = null;
        const cleanup = () => {
            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
            if (updateListener && chrome.tabs.onUpdated) { chrome.tabs.onUpdated.removeListener(updateListener); updateListener = null; }
            if (tabId) {
                const currentTabId = tabId;
                tabId = null;
                chrome.tabs.remove(currentTabId, () => {
                    const err = chrome.runtime.lastError;
                });
            }
        };
        timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error("Timeout waiting for SOTI Pulse page to load"));
        }, 25000);
        chrome.tabs.create({ url: url, active: false }, (tab) => {
            if (chrome.runtime.lastError || !tab) {
                cleanup();
                return reject(new Error(chrome.runtime.lastError?.message || "Failed to create background tab"));
            }
            tabId = tab.id;
            updateListener = (updatedTabId, changeInfo) => {
                if (updatedTabId === tabId && changeInfo.status === 'complete') {
                    setTimeout(() => {
                        if (!tabId) return;
                        chrome.scripting.executeScript({
                            target: { tabId: tabId, allFrames: true },
                            func: () => {
                                // 1. Identify the best content container to exclude page boilerplate
                                const containerSelectors = [
                                    'article',
                                    'main',
                                    '#main-content',
                                    '.main-content',
                                    '#content',
                                    '.content',
                                    '.body-content',
                                    '.umb-grid',
                                    '.product-content',
                                    '.help-content'
                                ];
                                
                                let container = null;
                                for (const selector of containerSelectors) {
                                    const found = document.querySelector(selector);
                                    if (found && found.innerText && found.innerText.trim().length > 150) {
                                        container = found;
                                        break;
                                    }
                                }
                                
                                if (!container) {
                                    container = document.body;
                                }
                                
                                // Clone container to modify it safely
                                const clone = container.cloneNode(true);
                                
                                // Find any iframe sources (important for docs.soti.net bypass)
                                const iframeUrls = [];
                                document.querySelectorAll('iframe').forEach(ifr => {
                                    if (ifr.src && (ifr.src.includes('docs.soti.net') || ifr.src.includes('soti.net'))) {
                                        iframeUrls.push(ifr.src);
                                    }
                                });
                                
                                // 2. Strip noise elements from the clone
                                const noiseSelectors = [
                                    'header', 'footer', 'nav', 'script', 'style', 'noscript', 'iframe', 'link', 'svg', 'path',
                                    '.nav', '.menu', '.footer', '.header', '.sidebar', '.top-nav', '.navigation',
                                    '.login-modal', '.login-form', '#login-modal', '#login-form', '.modal',
                                    '.cookie-banner', '.search-box', '.breadcrumbs', '.ad-container', '.promo'
                                ];
                                
                                noiseSelectors.forEach(sel => {
                                    clone.querySelectorAll(sel).forEach(el => el.remove());
                                });
                                
                                const text = clone.innerText || clone.textContent || "";
                                const title = document.title || "";
                                
                                // 3. Get links from the entire page so we don't miss navigation paths
                                const links = Array.from(document.querySelectorAll('a')).map(a => ({
                                    href: a.href,
                                    text: (a.textContent || '').trim()
                                }));
                                
                                return { title, text, links, iframeUrls, url: window.location.href };
                            }
                        }, (results) => {
                            if (chrome.runtime.lastError) {
                                const errMsg = chrome.runtime.lastError.message;
                                cleanup();
                                return reject(new Error(errMsg));
                            }
                            cleanup();
                            if (results && results.length > 0) {
                                let allLinks = [];
                                let allIframeUrls = [];
                                let bestText = "";
                                let bestTitle = "";
                                
                                for (const frameRes of results) {
                                    const data = frameRes.result;
                                    if (!data) continue;
                                    
                                    if (data.links) {
                                        // Map any docs.soti.net links back to pulse.soti.net
                                        const mapped = data.links.map(l => {
                                            if (l.href && l.href.includes('docs.soti.net')) {
                                                return { ...l, href: docsToPulseUrl(l.href) };
                                            }
                                            return l;
                                        });
                                        allLinks.push(...mapped);
                                    }
                                    if (data.iframeUrls) {
                                        allIframeUrls.push(...data.iframeUrls);
                                    }
                                    
                                    // Identify frame content source
                                    const isIframeDoc = data.url && data.url.includes('docs.soti.net');
                                    
                                    if (isIframeDoc) {
                                        // Prefer docs.soti.net iframe content if available
                                        bestText = data.text;
                                        bestTitle = data.title;
                                    } else if (!bestText || data.text.length > bestText.length) {
                                        // Otherwise fallback to frame with longest text
                                        bestText = data.text;
                                        bestTitle = data.title;
                                    }
                                }
                                
                                resolve({ title: bestTitle, text: bestText, links: allLinks, iframeUrls: allIframeUrls });
                            } else {
                                reject(new Error("No response from page content script"));
                            }
                        });
                    }, 5000);
                }
            };
            chrome.tabs.onUpdated.addListener(updateListener);
        });
    });
}

function scrapeUrlViaTab(url) {
    const isDocs = url.includes('docs.soti.net');
    const isRootIndex = url.endsWith('/help/') || url.endsWith('/help') || url.endsWith('/help/index.html') || 
                        url.endsWith('/product-notes') || url.endsWith('/product-notes/') ||
                        url.endsWith('/release-notes') || url.endsWith('/release-notes/') ||
                        url.endsWith('/downloads') || url.endsWith('/downloads/');
    
    // --- DIRECT FETCH for Pulse help pages (bypasses JS rendering) ---
    // Pulse help pages load content dynamically via XHR into an empty <div id="pageContent">.
    // We can fetch the actual help HTML directly from the internal endpoint.
    const pulseHelpMatch = url.match(
        /pulse\.soti\.net\/support\/soti-mobicontrol\/help\/\?V=([\d.]+)(?:&T=\/?(.+))?/i
    );
    if (pulseHelpMatch && !isRootIndex) {
        const helpVersion = pulseHelpMatch[1];
        const helpTopic = pulseHelpMatch[2] || 'start';
        return new Promise((resolve) => {
            // First, discover the timestamp from the shell page (cached after first call)
            _getPulseHelpTimestamp(helpVersion).then(timestamp => {
                if (!timestamp) {
                    console.log('[PULSE DIRECT] No timestamp found, falling back to tab for:', url);
                    resolve(scrapeUrlViaTabTabFallback(url));
                    return;
                }
                const directUrl = `https://pulse.soti.net/help/sotimobicontrol/${helpVersion}-${timestamp}/${helpTopic}.html`;
                fetch(directUrl, { cache: 'no-store' })
                    .then(res => {
                        if (!res.ok) throw new Error('HTTP ' + res.status);
                        return res.text();
                    })
                    .then(html => {
                        const doc = new DOMParser().parseFromString(html, 'text/html');
                        
                        // Strip noise elements
                        const noiseSelectors = [
                            'script', 'style', 'noscript', 'link', 'svg', 'path',
                            '.wh-expand-btn', '.wh-tooltip', '.close-toc-button'
                        ];
                        noiseSelectors.forEach(sel => {
                            doc.querySelectorAll(sel).forEach(el => el.remove());
                        });
                        
                        // Extract the main topic body content
                        const topicBody = doc.querySelector('#wh_topic_body') || 
                                          doc.querySelector('.wh_topic_content') ||
                                          doc.querySelector('main[role="main"]') ||
                                          doc.body;
                        const text = topicBody ? (topicBody.innerText || topicBody.textContent || '') : '';
                        const title = doc.querySelector('#ariaid-title1')?.textContent || 
                                      doc.title || 'SOTI MobiControl Help';
                        
                        // Extract links from TOC and content for crawl discovery
                        const links = Array.from(doc.querySelectorAll('a[href]')).map(a => {
                            let href = a.getAttribute('href') || '';
                            try {
                                // Properly resolve relative links against the fetched URL
                                href = new URL(href, directUrl).href;
                            } catch (_) {
                                // If invalid, fallback
                                if (href.startsWith('/')) {
                                    href = 'https://pulse.soti.net' + href;
                                }
                            }
                            
                            // Map any raw help links to Pulse shell links so they match visited
                            const internalHelpMatch = href.match(/\/help\/sotimobicontrol\/([\d.]+)-[\d]+\/(.+?)(?:\.html)?$/i);
                            if (internalHelpMatch) {
                                href = `https://pulse.soti.net/support/soti-mobicontrol/help/?V=${internalHelpMatch[1]}&T=/${internalHelpMatch[2]}`;
                            }
                            
                            return { href, text: (a.textContent || '').trim() };
                        }).filter(l => l.href && l.href.startsWith('http'));
                        
                        if (text && text.trim().length > 100) {
                            console.log('[PULSE DIRECT SUCCESS] Scraped:', url, '→', directUrl);
                            resolve({ title: title.trim(), text, links, iframeUrls: [] });
                            return;
                        }
                        throw new Error('Content too short from direct fetch');
                    })
                    .catch(err => {
                        console.log('[PULSE DIRECT FAILED] Falling back to tab:', url, err.message || err);
                        resolve(scrapeUrlViaTabTabFallback(url));
                    });
            }).catch(() => {
                resolve(scrapeUrlViaTabTabFallback(url));
            });
        });
    }
    
    if (isDocs && !isRootIndex) {
        return new Promise((resolve) => {
            fetch(url, { cache: 'no-store' })
                .then(res => {
                    if (!res.ok) throw new Error("HTTP " + res.status);
                    return res.text();
                })
                .then(html => {
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    
                    const containerSelectors = [
                        'article',
                        'main',
                        '#main-content',
                        '.main-content',
                        '#content',
                        '.content',
                        '.body-content',
                        '.umb-grid',
                        '.product-content',
                        '.help-content'
                    ];
                    
                    let container = null;
                    for (const selector of containerSelectors) {
                        const found = doc.querySelector(selector);
                        if (found && found.innerText && found.innerText.trim().length > 150) {
                            container = found;
                            break;
                        }
                    }
                    
                    if (!container) container = doc.body;
                    
                    const clone = container.cloneNode(true);
                    
                    const noiseSelectors = [
                        'header', 'footer', 'nav', 'script', 'style', 'noscript', 'iframe', 'link', 'svg', 'path',
                        '.nav', '.menu', '.footer', '.header', '.sidebar', '.top-nav', '.navigation',
                        '.login-modal', '.login-form', '#login-modal', '#login-form', '.modal',
                        '.cookie-banner', '.search-box', '.breadcrumbs'
                    ];
                    
                    noiseSelectors.forEach(sel => {
                        clone.querySelectorAll(sel).forEach(el => el.remove());
                    });
                    
                    const text = clone.innerText || clone.textContent || "";
                    const title = doc.title || "";
                    
                    const links = Array.from(doc.querySelectorAll('a')).map(a => ({
                        href: a.href,
                        text: (a.textContent || '').trim()
                    })).filter(l => l.href && l.href.startsWith('http'));
                    
                    if (text && text.trim().length > 200) {
                        console.log('[FAST PATH SUCCESS] Scraped via fetch:', url);
                        resolve({ title, text, links, iframeUrls: [] });
                        return;
                    }
                    throw new Error("Content too short");
                })
                .catch(err => {
                    console.log('[FAST PATH FAILED] Falling back to tab:', url, err.message || err);
                    resolve(scrapeUrlViaTabTabFallback(url));
                });
        });
    }
    return scrapeUrlViaTabTabFallback(url);
}

function docsToPulseUrl(urlStr) {
    try {
        const u = new URL(urlStr);
        if (u.hostname === 'docs.soti.net') {
            // Case 1: /soti-mobicontrol/v2026.1/help/...
            let match = u.pathname.match(/\/soti-mobicontrol\/v?([^\/]+)\/help\/(.+)$/i);
            if (match) {
                const version = match[1];
                let target = match[2];
                if (target.endsWith('.html')) target = target.slice(0, -5);
                return `https://pulse.soti.net/support/soti-MobiControl/help/?V=${version}&T=${target}`;
            }
            // Case 2: /mc/help/v2026.1/en/...
            match = u.pathname.match(/\/mc\/help\/v?([^\/]+)\/en\/(.+)$/i);
            if (match) {
                const version = match[1];
                let target = match[2];
                if (target.endsWith('.html')) target = target.slice(0, -5);
                return `https://pulse.soti.net/support/soti-MobiControl/help/?V=${version}&T=${target}`;
            }
        }
    } catch (_) {}
    return urlStr;
}

// --- Timestamp cache for direct help content fetching ---
const _pulseTimestampCache = {};
async function _getPulseHelpTimestamp(version) {
    if (_pulseTimestampCache[version]) return _pulseTimestampCache[version];
    try {
        const shellUrl = `https://pulse.soti.net/support/soti-mobicontrol/help/?V=${version}`;
        const resp = await fetch(shellUrl, { cache: 'no-store' });
        const html = await resp.text();
        // Extract timestamp from: const backupVersion = "2026.1-1780417210";
        const tsMatch = html.match(/backupVersion\s*=\s*["'][\d.]+-([\d]+)["']/);
        if (tsMatch) {
            _pulseTimestampCache[version] = tsMatch[1];
            console.log(`[PULSE TIMESTAMP] Discovered timestamp for v${version}: ${tsMatch[1]}`);
            return tsMatch[1];
        }
        // Fallback: try timeStamp variable
        const tsMatch2 = html.match(/var\s+timeStamp\s*=\s*["']([\d]+)["']/);
        if (tsMatch2) {
            _pulseTimestampCache[version] = tsMatch2[1];
            return tsMatch2[1];
        }
    } catch (err) {
        console.warn('[PULSE TIMESTAMP] Failed to discover timestamp for v' + version, err);
    }
    return null;
}

// --- TOC-based seed URL generation for comprehensive help crawling ---
async function fetchPulseHelpTocSeeds(version, updateStatusCallback) {
    try {
        if (updateStatusCallback) updateStatusCallback(`Discovering help pages for v${version} from TOC...`);
        const timestamp = await _getPulseHelpTimestamp(version);
        if (!timestamp) {
            console.warn('[TOC SEEDS] No timestamp found for v' + version);
            return [];
        }
        // Fetch the start page which contains the full Table of Contents
        const tocUrl = `https://pulse.soti.net/help/sotimobicontrol/${version}-${timestamp}/start.html`;
        const tocResp = await fetch(tocUrl, { cache: 'no-store' });
        if (!tocResp.ok) throw new Error('HTTP ' + tocResp.status);
        const tocHtml = await tocResp.text();
        
        const doc = new DOMParser().parseFromString(tocHtml, 'text/html');
        const tocLinks = doc.querySelectorAll('a[href*="/support/soti-MobiControl/help/"], a[href*="/support/soti-mobicontrol/help/"]');
        const seeds = new Set();
        
        tocLinks.forEach(link => {
            let href = link.getAttribute('href');
            if (href) {
                // Convert relative paths to absolute
                if (href.startsWith('/')) {
                    href = 'https://pulse.soti.net' + href;
                }
                // Only include actual help topic URLs (with ?V= parameter)
                if (href.includes('pulse.soti.net') && href.includes('/help/')) {
                    seeds.add(href);
                }
            }
        });
        
        console.log(`[TOC SEEDS] Found ${seeds.size} help pages from TOC for v${version}`);
        if (updateStatusCallback) updateStatusCallback(`Found ${seeds.size} help pages for v${version}`);
        return Array.from(seeds);
    } catch (err) {
        console.warn('[TOC SEEDS] Failed to fetch TOC seeds for v' + version, err);
        return [];
    }
}

async function crawlPulseSupport(seeds, updateStatusCallback) {
    const maxPages = 10000;
    const concurrency = 8;
    const visited = new Set();
    const queue = Array.isArray(seeds) ? [...seeds] : [seeds];
    let compiledMarkdown = "";
    let activeWorkers = 0;
    
    function isPulseSupportUrl(urlStr) {
        try {
            const u = new URL(urlStr);
            return u.hostname === 'pulse.soti.net' && u.pathname.toLowerCase().includes('/support/soti-mobicontrol');
        } catch (_) {
            return false;
        }
    }
    
    function normalizeUrl(urlStr) {
        try {
            const u = new URL(urlStr);
            if (u.hostname === 'pulse.soti.net' || u.hostname === 'docs.soti.net') {
                let res = u.origin.toLowerCase() + u.pathname.toLowerCase() + u.search;
                if (res.endsWith('/')) res = res.slice(0, -1);
                return res;
            }
        } catch (_) {}
        let normalized = urlStr.split('#')[0].split('?')[0];
        if (normalized.endsWith('/')) {
            normalized = normalized.slice(0, -1);
        }
        return normalized;
    }
    
    function getDisplayPath(url) {
        try {
            const u = new URL(url);
            let p = u.pathname + u.search;
            return p.length > 40 ? p.slice(0, 37) + '...' : p;
        } catch (_) {
            return url;
        }
    }
    
    return new Promise((resolve, reject) => {
        const checkAndRun = async () => {
            if (visited.size >= maxPages || (queue.length === 0 && activeWorkers === 0)) {
                if (compiledMarkdown.length < 100) {
                    reject(new Error("Failed to crawl any content from SOTI Pulse."));
                } else {
                    resolve(compiledMarkdown);
                }
                return;
            }
            
            while (activeWorkers < concurrency && queue.length > 0 && visited.size < maxPages) {
                const url = queue.shift();
                const normalized = normalizeUrl(url);
                
                if (visited.has(normalized)) continue;
                visited.add(normalized);
                
                activeWorkers++;
                updateStatusCallback(`Scraping ${visited.size}/${maxPages} (active: ${activeWorkers}): ${getDisplayPath(url)}`);
                
                scrapeUrlViaTab(url).then((pageData) => {
                    activeWorkers--;
                    if (pageData && pageData.text) {
                        const pageTitle = pageData.title || "SOTI Pulse Page";
                        const displayUrl = docsToPulseUrl(url);
                        compiledMarkdown += `\n\n# ${pageTitle}\nSource: ${displayUrl}\n\n`;
                        const cleanText = pageData.text
                            .replace(/\r\n/g, '\n')
                            .replace(/\n{3,}/g, '\n\n')
                            .trim();
                        compiledMarkdown += cleanText;
                        
                        // Add iframe URLs to the crawl queue
                        if (pageData.iframeUrls) {
                            for (const iframeUrl of pageData.iframeUrls) {
                                const mappedIframeUrl = docsToPulseUrl(iframeUrl);
                                const norm = normalizeUrl(mappedIframeUrl);
                                if (isPulseSupportUrl(mappedIframeUrl) && 
                                    !visited.has(norm) && 
                                    !queue.some(q => normalizeUrl(q) === norm)) {
                                    queue.push(mappedIframeUrl);
                                }
                            }
                        }
                        
                        if (pageData.links && visited.size < maxPages) {
                            for (const link of pageData.links) {
                                if (!link.href) continue;
                                const mappedHref = docsToPulseUrl(link.href);
                                const linkNorm = normalizeUrl(mappedHref);
                                if (isPulseSupportUrl(mappedHref) && 
                                    !visited.has(linkNorm) && 
                                    !queue.some(q => normalizeUrl(q) === linkNorm)) {
                                    
                                    if (!/\.(pdf|zip|png|jpg|jpeg|gif|msi|exe|docx|xlsx|pptx)$/i.test(linkNorm)) {
                                        queue.push(mappedHref);
                                    }
                                }
                            }
                        }
                    }
                    setTimeout(checkAndRun, 200);
                }).catch((err) => {
                    activeWorkers--;
                    console.warn(`Scrape failed for ${url}:`, err);
                    compiledMarkdown += `\n\n# Scrape Failed: ${url}\nError: ${err.message || err}\n`;
                    setTimeout(checkAndRun, 200);
                });
            }
        };
        checkAndRun();
    });
}

if ($('btnSyncPulse')) {
    $('btnSyncPulse').onclick = async () => {
        const btn = $('btnSyncPulse');
        const status = $('pulseSyncStatus');
        const rawUrl = window.PULSE_SYNC_URL;
        let url = rawUrl;
        if (rawUrl && rawUrl.startsWith('knowledge/')) {
            url = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) 
                ? chrome.runtime.getURL(rawUrl) 
                : rawUrl;
        }
        
        if (!url) return toast('Please enter a valid URL', 'w');
        
        btn.disabled = true;
        btn.style.opacity = '0.5';
        status.textContent = 'Syncing...';
        status.style.color = 'var(--txt2)';
        
        try {
            // Parse the actual hostname rather than a substring match: url.includes('pulse.soti.net')
            // would also accept a lookalike like "pulse.soti.net.attacker.example". (Chrome's
            // host_permissions independently block non-SOTI origins, but validate here too.)
            let isPulseUrl = false;
            try { isPulseUrl = new URL(url).hostname === 'pulse.soti.net'; } catch (e) { isPulseUrl = false; }
            let text = "";
            
            if (isPulseUrl) {
                let seeds = [url];
                const normalizedBase = url.replace(/\/$/, '').toLowerCase();
                // Smart seed list expander to crawl the entire MobiControl directories comprehensively
                if (normalizedBase === 'https://pulse.soti.net/support/soti-mobicontrol' || 
                    normalizedBase === 'https://pulse.soti.net/support/soti-mobicontrol/help') {
                    seeds = [
                        'https://pulse.soti.net/support/soti-mobicontrol',
                        'https://pulse.soti.net/support/soti-mobicontrol/product-notes',
                        'https://pulse.soti.net/support/soti-mobicontrol/help',
                        'https://pulse.soti.net/support/soti-mobicontrol/downloads',
                        'https://pulse.soti.net/support/soti-mobicontrol/product-notes/release-notes',
                        'https://pulse.soti.net/support/soti-mobicontrol/help/?V=2026.1',
                        'https://pulse.soti.net/support/soti-mobicontrol/help/?V=2026.0',
                        'https://pulse.soti.net/support/soti-mobicontrol/help/?V=2025.0',
                        'https://pulse.soti.net/support/soti-mobicontrol/help/?V=2024.0',
                        'https://pulse.soti.net/support/soti-mobicontrol/help/?V=16.0'
                    ];
                    
                    // Discover ALL help page URLs from the Table of Contents
                    // This is the key fix: the TOC in start.html lists every single help page
                    status.textContent = 'Discovering help pages from Table of Contents...';
                    const versions = ['2026.1', '2026.0', '2025.0'];
                    for (const ver of versions) {
                        try {
                            const tocSeeds = await fetchPulseHelpTocSeeds(ver, (msg) => {
                                status.textContent = msg;
                            });
                            if (tocSeeds.length > 0) {
                                seeds = [...new Set([...seeds, ...tocSeeds])];
                                console.log(`[SYNC] Added ${tocSeeds.length} TOC seeds for v${ver}, total seeds: ${seeds.length}`);
                            }
                        } catch (err) {
                            console.warn(`[SYNC] Failed to get TOC seeds for v${ver}:`, err);
                        }
                    }
                    status.textContent = `Starting crawl with ${seeds.length} seed URLs...`;
                }
                text = await crawlPulseSupport(seeds, (msg) => {
                    status.textContent = msg;
                });
            } else {
                status.textContent = 'Downloading master markdown...';
                const res = await fetch(url, { cache: 'no-store' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                text = await res.text();
            }
            
            if (text.length < 100) throw new Error("Content too small to be valid knowledge base");
            
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                await chrome.storage.local.set({ 'pulseKnowledgeData': text });
            } else {
                localStorage.setItem('soti_pulse_knowledge', text);
            }
            
            window.PULSE_LAST_SYNC = Date.now();
            await saveLocalAISettings();
            
            // Trigger automatic Save As dialog to store the file physically in the folder
            if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.download) {
                try {
                    const blob = new Blob([text], { type: 'text/markdown' });
                    const blobUrl = URL.createObjectURL(blob);
                    chrome.downloads.download({
                        url: blobUrl,
                        filename: 'PulseKnowledge.md',
                        saveAs: true
                    });
                } catch (err) {
                    console.warn('Failed to trigger download', err);
                }
            }
            
            status.textContent = `Success! Synced ${Math.round(text.length / 1024)}KB at ${new Date().toLocaleTimeString()}`;
            status.style.color = 'var(--green)';
            toast('Pulse Knowledge Synced successfully!', 's');
        } catch (e) {
            console.error('Pulse Sync failed', e);
            status.textContent = `Sync Failed: ${e.message}`;
            status.style.color = 'var(--warn)';
            toast('Failed to sync Pulse knowledge', 'e');
        } finally {
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    };
}

$('btnRefreshModels').onclick = async () => {
    LOCAL_AI_URL = $('localAiUrl').value.trim() || 'http://127.0.0.1:11434';
    await refreshSettingsModal();
};

$('localAiModelSel').onchange = () => {
    LOCAL_AI_MODEL = $('localAiModelSel').value;
};

$('btnSaveLocalAI').onclick = async () => {
    LOCAL_AI_URL = $('localAiUrl').value.trim() || 'http://127.0.0.1:11434';
    LOCAL_AI_MODEL = $('localAiModelSel').value || LOCAL_AI_MODEL;
    if ($('localAiCtxSel')) LOCAL_AI_CTX_MAX = $('localAiCtxSel').value || 'auto';
    await saveLocalAISettings();
    updateLocalAIBadge();
    $('mSettings').style.display = 'none';
    toast(`✓ Model set: ${LOCAL_AI_MODEL ? LOCAL_AI_MODEL.replace(/:latest$/i, '') : 'Ollama'}`, 's');
    setTimeout(() => { warmUpModel(); }, 200); // preload the newly-selected model / context size
};

// "Clear all cases & logs now" — privacy panic button. Wipes all stored case/log data and
// learned insights from this device immediately, then resets to one empty case. Keeps the
// Ollama connection settings (URL/model/context) and the offline knowledge base, since
// those aren't customer data.
if ($('btnClearAllData')) {
    $('btnClearAllData').onclick = async () => {
        if (!confirm('Delete ALL cases, attached logs, and learned insights from this device now?\n\nThis cannot be undone. Ollama settings and the offline knowledge base are kept.')) return;
        try {
            // Stop any in-flight streams so they don't re-save data after the wipe.
            for (const ctrl of streamControllers.values()) { try { ctrl.abort(); } catch (e) {} }
            streamControllers.clear();

            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                await chrome.storage.local.remove(['cases', 'activeCaseId', 'learnedInsights']);
            }
            try {
                localStorage.removeItem('soti_ai_state');
                localStorage.removeItem('soti_learned_insights');
                sessionStorage.removeItem('soti_ai_quick_cache');
            } catch (e) {}

            // Reset to a single fresh, empty case.
            cases = [getDefaultCase('Case 1')];
            activeCaseId = cases[0].id;
            await saveState();
            renderTabs();
            switchCase(activeCaseId);

            $('mSettings').style.display = 'none';
            toast('✓ All cases, logs and learned data cleared from this device', 's', 5000);
        } catch (e) {
            console.error('Clear all data failed', e);
            toast('Could not clear data: ' + (e.message || e), 'e', 5000);
        }
    };
}

if ($('btnDownloadLocalAISetup')) {
    $('btnDownloadLocalAISetup').onclick = () => {
        if (isChromeExtension() && chrome.downloads?.download) {
            const url = chrome.runtime.getURL('setup_local_ai.bat');
            chrome.downloads.download({ url, filename: 'SOTI-setup_local_ai.bat', saveAs: false }, () => {
                toast('Installer downloaded — run SOTI-setup_local_ai.bat from Downloads', 's', 8000);
            });
        } else {
            const link = document.createElement('a');
            link.href = 'setup_local_ai.bat';
            link.download = 'SOTI-setup_local_ai.bat';
            link.click();
            toast('Run setup_local_ai.bat from this folder, then reload the page', 's', 8000);
        }
    };
}

// Boot: detect Ollama and warn if no model selected
(async () => {
    await loadLocalAISettings();
    updateLocalAIBadge();
    if (!LOCAL_AI_MODEL) {
        setTimeout(() => {
            toast('⚙ Open Settings to select your Ollama model.', 'w', 7000);
        }, 1500);
    }
})();

// Ensure text is copied as plain text from the chat container
$('chatMsgs').addEventListener('copy', (e) => {
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
        e.clipboardData.setData('text/plain', selection.toString());
        e.preventDefault();
    }
});

// Real-time sync between Sidepanel and Floating Window (extension only)
if (isChromeExtension() && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && (changes.cases || changes.activeCaseId)) {
            // Ignore changes WE wrote (matched by our write token) — this is the deterministic
            // guard that stops the post-analysis reload/render glitch loop. Only reload when the
            // change came from another window (e.g. the floating window) or has no token.
            const incomingToken = changes._stateWriteToken && changes._stateWriteToken.newValue;
            if (incomingToken && incomingToken === _lastWriteToken) return;
            if ([...busyMap.values()].some(Boolean) || _suppressStorageReload) return;
            loadState();
        }
    });
}

function initStandaloneUI() {
    if (!isStandalonePage()) return;
    const help = $('localAiStandaloneHelp');
    if (help) help.style.display = 'block';
    if (location.protocol === 'file:') {
        setTimeout(() => {
            toast('Standalone: run serve_standalone.bat and open http://127.0.0.1:8765/SOTI_AI_Analyser.html (file:// blocks Ollama)', 'w', 12000);
        }, 800);
    }
}

initStandaloneUI();
