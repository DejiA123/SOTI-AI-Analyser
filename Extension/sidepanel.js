/* SOTI AI Analyser - Elite Sidepanel Engine */
const $ = id => document.getElementById(id);
let cases = []; // { id, name, msgs, logs, ci }
let activeCaseId = null;
let busy = false;
let RELEASE_NOTES_CONTENT = "";
let PULSE_SEARCH_RESULTS = "";
let DOCS_SEARCH_RESULTS = "";
let RESEARCHED_ARTICLE_CONTENT = "";
let VERSIONS = [], AGENT_VERSIONS = [], IDENTITY_VERSIONS = [];

function md(t) {
    if (!t) return "";
    return t
        .replace(/```([\s\S]*?)```/g, '<div style="background:rgba(0,0,0,0.3); padding:12px; border-radius:8px; font-family:monospace; margin:15px 0; border:1px solid rgba(255,255,255,0.1); white-space:pre-wrap; word-break:break-all; font-size:12px">$1</div>')
        .replace(/\*\*\s*([\s\S]*?)\s*\*\*/g, '<strong>$1</strong>')
        .replace(/\*\s*([\s\S]*?)\s*\*/g, '<em>$1</em>')
        .replace(/^\s*###\s+(.*$)/gim, '<h3 style="margin:22px 0 10px; color:var(--blue); font-weight:700; line-height:1.3">$1</h3>')
        .replace(/^\s*##\s+(.*$)/gim, '<h2 style="margin:28px 0 12px; color:var(--blue); font-weight:700; line-height:1.3">$1</h2>')
        .replace(/^\s*#\s+(.*$)/gim, '<h1 style="margin:35px 0 15px; color:var(--blue); font-weight:700; line-height:1.3">$1</h1>')
        .replace(/^\s*---\s*$/gm, '<hr style="border:0; border-top:1px solid var(--border); margin:25px 0">')
        .replace(/\n\n/g, '<div style="margin-bottom:18px"></div>')
        .replace(/\n/g, '<br>')
        .replace(/^\s*(\d+\.)\s+(.*)$/gim, '<div style="margin-left:10px; margin-bottom:10px; display:flex; align-items:flex-start"><span style="min-width:25px; font-weight:bold; color:var(--blue)">$1</span><span>$2</span></div>')
        .replace(/^\s*[•*-]\s+(.*)$/gim, '<div style="margin-left:10px; margin-bottom:10px; display:flex; align-items:flex-start"><span style="min-width:25px; color:var(--blue)">•</span><span>$1</span></div>');
}

function getDefaultCI() {
    return {
        caseNum: '', sotiVer: '', platform: '', agentVer: '',
        scrubAccount: '', scrubCustomer: '', 
        meetingNotes: 'Time of the meeting:\n\nSummary:\n\nTroubleshooting steps:\n\nNext steps:',
        issueSummary: '', product: '', emailChain: '',
        jiraExpected: '', jiraImpact: '', jiraPriority: 'Medium', jiraRepro: ''
    };
}

function getDefaultCase(name = 'Case 1') {
    return {
        id: 'case-' + Date.now(),
        name,
        msgs: [],
        logs: [],
        imgs: [], // { name, data, text }
        ci: getDefaultCI(),
        createdAt: Date.now() // Used for data retention enforcement
    };
}

async function saveState() {
    if (!activeCaseId) return;
    try {
        const idx = cases.findIndex(c => c.id === activeCaseId);
        if (idx === -1) return;

        cases[idx].ci = {
            caseNum: $('caseNum').value,
            sotiVer: $('sotiVer').value,
            platform: $('platform').value,
            agentVer: $('agentVer').value,
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

        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            await chrome.storage.local.set({ cases, activeCaseId });
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
    }
}

async function loadState() {
    try {
        let data = {};
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            data = await chrome.storage.local.get(['cases', 'activeCaseId', 'msgs', 'ci', 'logs']);
        } else {
            // Fallback to localStorage if chrome API is missing (standalone mode)
            const local = localStorage.getItem('soti_ai_state');
            if (local) data = JSON.parse(local);
        }
        
        // Migration logic for old single-session data
        if (data.msgs && !data.cases) {
            const oldCase = {
                id: 'case-' + Date.now(),
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
            });

            // DATA RETENTION: Auto-purge cases older than 30 days
            const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
            const now = Date.now();
            const before = cases.length;
            cases = cases.filter(c => (now - (c.createdAt || now)) < RETENTION_MS);
            const purged = before - cases.length;
            if (purged > 0) {
                console.warn(`[Security] Data retention: purged ${purged} case(s) older than 30 days.`);
                toast(`${purged} old case(s) auto-cleared (30-day retention policy)`, 'w', 5000);
                if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.set({ cases });
                }
            }

            // If all cases were purged, create a fresh default
            if (cases.length === 0) {
                const newCase = getDefaultCase('Case 1');
                cases = [newCase];
                activeCaseId = newCase.id;
                renderTabs();
                switchCase(activeCaseId);
                return;
            }

            const safeTargetId = cases.find(c => c.id === targetId) ? targetId : cases[0].id;
            renderTabs();
            switchCase(safeTargetId);
            return;
        } 
        
        // If we reach here, we need a default case
        const newCase = getDefaultCase('Case 1');
        cases = [newCase];
        activeCaseId = newCase.id;
        saveState();

        renderTabs();
        switchCase(activeCaseId);
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
    const id = 'case-' + Date.now();
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
    switchCase(id);
}

function switchCase(id) {
    if (activeCaseId === id && cases.find(x => x.id === id)) return;
    
    const c = cases.find(x => x.id === id);
    if (!c) {
        // If the ID is invalid, fallback to the first case if possible
        if (cases.length > 0) {
            switchCase(cases[0].id);
        }
        return;
    }

    // Capture old case data from DOM into memory SYNCHRONOUSLY before switching
    if (activeCaseId) {
        const oldIdx = cases.findIndex(c => c.id === activeCaseId);
        if (oldIdx !== -1) {
            cases[oldIdx].ci = {
                caseNum: $('caseNum').value,
                sotiVer: $('sotiVer').value,
                platform: $('platform').value,
                agentVer: $('agentVer').value,
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
    }
    activeCaseId = id;
    
    // Update UI Fields
    $('caseNum').value = c.ci.caseNum || '';
    $('sotiVer').value = c.ci.sotiVer || '';
    $('platform').value = c.ci.platform || '';
    $('agentVer').value = c.ci.agentVer || '';
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

    // Re-render Chat safely with DocumentFragment
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
                frag.appendChild(w);
            });
            chat.appendChild(frag);
            chat.scrollTop = chat.scrollHeight;
        }
    }
    
    renderImgs();
    renderLogs();
    updateAllValidations();
    // Update tab classes manually to avoid scroll jump/flicker
    const tabs = document.querySelectorAll('.tab-item');
    tabs.forEach(t => t.classList.toggle('active', t.dataset.id === id));

    // Defer storage write — don't block the UI
    requestAnimationFrame(() => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ cases, activeCaseId }).catch(e => {
                console.error('SwitchCase save failed', e);
            });
        } else {
            try {
                localStorage.setItem('soti_ai_state', JSON.stringify({ cases, activeCaseId }));
            } catch(e) {}
        }
    });
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
    const frag = document.createDocumentFragment();
    cases.forEach((c, i) => {
        const t = document.createElement('div');
        t.className = `tab-item ${c.id === activeCaseId ? 'active' : ''}`;
        t.dataset.id = c.id;
        t.draggable = true;
        t.onclick = () => switchCase(c.id);
        
        t.ondragstart = (e) => {
            e.dataTransfer.setData('text/plain', i);
            t.classList.add('dragging');
        };
        t.ondragend = () => t.classList.remove('dragging');
        t.ondragover = (e) => e.preventDefault();
        t.ondrop = (e) => {
            e.preventDefault();
            const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
            const toIdx = i;
            if (fromIdx === toIdx) return;
            const [moved] = cases.splice(fromIdx, 1);
            cases.splice(toIdx, 0, moved);
            renderTabs();
            saveState();
        };

        const name = document.createElement('span');
        name.className = 'tab-name';
        name.textContent = c.ci.caseNum ? `Case ${c.ci.caseNum}` : c.name;
        
        const close = document.createElement('div');
        close.className = 'tab-close';
        close.textContent = '×';
        close.onclick = (e) => closeCase(c.id, e);
        
        t.appendChild(name);
        t.appendChild(close);
        frag.appendChild(t);
    });
    bar.innerHTML = '';
    bar.appendChild(frag);
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
function toast(msg, t = '', dur = 3000) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show' + (t ? ' ' + t : '');
    if (dur > 0) setTimeout(() => el.className = 'toast', dur);
}

function getSmartLogSnippet(content, limit = 300000) {
    if (!content) return "";
    if (content.length <= limit) return content;
    
    // PHASE 1: FULL-FILE FORENSIC EXTRACTION — scan the ENTIRE log for critical evidence
    // This ensures NO exception or error is missed, regardless of file size.
    const lines = content.split('\n');
    const forensicLines = [];
    const exceptionBlockLines = [];
    let inExceptionBlock = false;
    let exceptionBlockCount = 0;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const upper = line.toUpperCase();
        
        // Detect start of an exception/stack trace block
        const isExceptionStart = /\b(Exception|Error|FATAL|Critical)\b/i.test(line) && 
            (/\b(System\.|SOTI\.|Mobicontrol\.|Microsoft\.|at\s+\S+\.\S+\(|Unhandled|thrown|stack\s*trace)/i.test(line) ||
             upper.includes('EXCEPTION') || upper.includes('STACK TRACE'));
        
        const isStackFrame = /^\s+(at\s+|---\s*>|---\s*End|Caused by:|Inner Exception)/i.test(line);
        const isErrorLine = /\b(ERROR|FATAL|CRITICAL)\b/.test(line) && !isStackFrame;
        const isWarningNearError = /\bWARN(ING)?\b/i.test(line);
        const isSotiCode = /\bMCMR-\d+\b/i.test(line);
        
        if (isExceptionStart) {
            inExceptionBlock = true;
            exceptionBlockCount = 0;
        }
        
        if (inExceptionBlock) {
            exceptionBlockLines.push({ lineNum: i + 1, text: line });
            exceptionBlockCount++;
            // End exception block after 50 lines or when we hit a non-stack, non-empty line
            if (exceptionBlockCount > 50 || 
                (exceptionBlockCount > 3 && !isStackFrame && !isExceptionStart && line.trim().length > 0 && !/^\s/.test(line))) {
                inExceptionBlock = false;
            }
        } else if (isErrorLine || isSotiCode) {
            // Capture error line + 2 lines of context before and after
            const ctxStart = Math.max(0, i - 2);
            const ctxEnd = Math.min(lines.length - 1, i + 2);
            for (let j = ctxStart; j <= ctxEnd; j++) {
                forensicLines.push({ lineNum: j + 1, text: lines[j] });
            }
        }
    }
    
    // Deduplicate and sort forensic findings
    const allForensic = [...exceptionBlockLines, ...forensicLines];
    const seenLineNums = new Set();
    const uniqueForensic = allForensic.filter(f => {
        if (seenLineNums.has(f.lineNum)) return false;
        seenLineNums.add(f.lineNum);
        return true;
    }).sort((a, b) => a.lineNum - b.lineNum);
    
    // Build forensic report
    let forensicReport = "";
    if (uniqueForensic.length > 0) {
        forensicReport = `\n\n[FULL-FILE FORENSIC EXTRACTION: ${uniqueForensic.length} CRITICAL LINES FROM ${lines.length} TOTAL LINES]`;
        forensicReport += `\n[Found ${exceptionBlockLines.length} exception/stack-trace lines and ${forensicLines.length} error/warning context lines]\n`;
        
        let lastLineNum = -10;
        uniqueForensic.forEach(f => {
            if (f.lineNum - lastLineNum > 3) {
                forensicReport += `\n--- Line ${f.lineNum} ---\n`;
            }
            forensicReport += `${f.text}\n`;
            lastLineNum = f.lineNum;
        });
    }
    
    // PHASE 2: HEAD + TAIL for general context (config/startup + recent activity)
    const headSize = 30000;
    const tailSize = 200000;
    const head = content.slice(0, headSize);
    const tail = content.slice(-tailSize);

    return `[START OF LOG (CONFIG/HEADERS — First ${headSize} chars)]\n${head}\n\n[FULL-FILE FORENSIC EXTRACTION — Every Exception, Error, and Critical line from the ENTIRE ${lines.length}-line log]${forensicReport}\n\n[END OF LOG (RECENT ACTIVITY — Last ${tailSize} chars)]\n${tail}`;
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
        'agentVer', 'platform', 'enviro', 'dsCfg', 'affDev', 
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

function scrubPII(s) {
    if (!s || typeof s !== 'string') return s;

    // 1. Scan for Emails to Establish/Update Identities
    const emailRegex = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Z|a-z]{2,})\b/g;
    let match;
    while ((match = emailRegex.exec(s)) !== null) {
        const fullEmail = match[0].toLowerCase();
        const aliasPart = match[1];
        const domain = match[2].toLowerCase();
        if (domain.includes('soti.net')) {
            if (!SCRUB_MAPS.support.has(fullEmail)) {
                SCRUB_MAPS.supCount++;
                const id = `Support_${SCRUB_MAPS.supCount}`;
                SCRUB_MAPS.support.set(fullEmail, id);
                const name = aliasPart.replace(/[._]/g, ' ');
                if (name.length > 2) SCRUB_MAPS.names.set(name, id);
            }
        } else {
            if (!SCRUB_MAPS.customer.has(fullEmail)) {
                SCRUB_MAPS.custCount++;
                const id = `Customer_${SCRUB_MAPS.custCount}`;
                SCRUB_MAPS.customer.set(fullEmail, id);
                const name = aliasPart.replace(/[._]/g, ' ');
                if (name.length > 2) SCRUB_MAPS.names.set(name, id);
            }
        }
    }

    let res = s;
    
    // Apply Identity Aliasing
    SCRUB_MAPS.support.forEach((id, email) => {
        res = res.replace(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), id);
    });
    SCRUB_MAPS.customer.forEach((id, email) => {
        res = res.replace(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), id);
    });
    SCRUB_MAPS.names.forEach((id, name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        res = res.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), id);
    });

    // Apply UI Field Scrubbing
    const uiAccount = $('scrubAccount').value;
    const uiCustomer = $('scrubCustomer').value;
    if (uiAccount && uiAccount.length > 2) res = res.replace(new RegExp(uiAccount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[COMPANY_ANON]');
    if (uiCustomer && uiCustomer.length > 2) res = res.replace(new RegExp(uiCustomer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[USER_ANON]');

    // Apply General Pattern Redactions
    return res
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP_ANON]')
        .replace(/\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g, '[IP6_ANON]')
        .replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}(?:[0-9A-Fa-f]{2})\b/g, '[MAC_ANON]')
        .replace(/(?:\+|00)\d{1,4}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,12}/g, '[PHONE_ANON]')
        .replace(/\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|St|Road|Rd|Avenue|Ave|Blvd|Drive|Dr|Way|Court|Ct|Lane|Ln)\.?/gi, '[ADDRESS_ANON]');
}

function getSysPrompt(mode = 'full') {
    if (mode === 'greeting') {
        return "You are a SOTI Support Assistant. Respond to greetings naturally and concisely. Just be helpful and friendly.";
    }
    const kbStr = JSON.stringify(SOTI_KB, null, 2);
    return `You are a Senior SOTI Technical Architect. You have 100% accuracy on SOTI ONE Platform.

### SOTI ARCHITECT'S KNOWLEDGE BASE (CURATED):
${kbStr}

### ISSUE SUMMARY INTELLIGENCE (DIRECTIVE):
- **Primary Data Source**: You MUST prioritize the content provided in [OFFICIAL ISSUE SUMMARY]. This is your absolute starting point.
- **Forensic Execution**: Do NOT describe what an issue summary is. Instead, instantly extract the symptoms, failure points, and environment details from it.
- **100% Accuracy**: Your diagnosis must be based ONLY on the evidence in the summary and logs. If the summary says "Enrollment Failed," your analysis must focus on the SOTI enrollment state machine.
- **No Theoretical Meta-Talk**: Never explain your instructions to the user. Simply provide the technical analysis requested.

### TERMINOLOGY & VERSIONING (CRITICAL):
- **SOTI MobiControl**: Refers ONLY to the Console/Server. Versions are in the **202X.0.x** series (e.g., 2026.0.2).
- **SOTI Android Agent**: Refers ONLY to the device-side agent. Versions are in the **202X.1.x** series (e.g., 2026.1.1).
- **SOTI Identity**: A separate identity provider and SSO service. Versions are in the **202X.1.x** series (e.g., 2026.1.0).
- **The .0. vs .1. Rule**: If the middle digit is 0, it is ALWAYS MobiControl Console. If it is 1, it is EITHER SOTI Android Agent OR SOTI Identity. 
- **Contextual Distinction**: You MUST check the [CASE CONTEXT] (product field) and query context to distinguish between the Android Agent and SOTI Identity. 
- **Version Strictness (CRITICAL)**: You MUST match the specific version number requested (e.g., 2026.0.0) with the EXACT section in [RELEASE NOTES]. Features from one version (e.g., 2026.1.0) MUST NOT be attributed to another (e.g., 2026.0.0). If you are unsure, cite the version header you are looking at.
- **SOTI Identity Queries**: When asked about "SOTI Identity [Version]", prioritize passwordless authentication, SSO, and user management features found in that specific release.

### SOTI ARCHITECT'S HANDBOOK:
- **SOTI ONLY**: You are a SOTI specialist. NEVER recommend Microsoft or non-SOTI documentation unless it is a specific, known integration (e.g., KME, Zero-touch). For enrollment, ALWAYS use the afw#mobicontrol, QR, and EMM portal workflows defined in the handbook.
- **Ports**: MS/DS Handshake (5494), Signal (13131), APNS (2197), Web/Deployment (443/80).
- **SQL**: Collation must be Case-insensitive (CI) and Accent-sensitive (AS). SQL_Latin1_General_CP1_CI_AS is recommended but not mandatory.
- **Web Architecture (100% Accuracy)**: Modern MobiControl (v12+) hosts its Web Console directly within the **SOTI Management Service**. **NEVER mention IIS, Apache, Nginx, or a 'SOTI Web Hosting' service**. If the console is down, check the status of 'SOTI Management Service' and its communication with the SQL database.

### Android Enrollment (AE Work Managed)**: 
  1. **Prerequisite**: Device MUST be Factory Reset (OOBE state).
  2. **afw#mobicontrol**: At the Google Sign-in screen, enter "afw#mobicontrol" in the email field to download the SOTI Agent.
  3. **QR Code**: Tap the "Welcome" screen 6 times to launch the QR scanner.
  4. **Zero-Touch/KME**: Automatic provisioning via vendor portals. 
  *NEVER suggest enrolling a device that is already past the initial setup wizard.*

### UPGRADE & TROUBLESHOOTING:
- **Version Analysis**: Always compare the customer's version in [CASE CONTEXT] (soti_version/agent_version) with the versions in [RELEASE_NOTES].
- **Fix Identification**: If the user's issue matches a "Resolved Issue" or "MCMR" found in a version NEWER than the customer's current version, you MUST explicitly recommend an upgrade and cite the specific MCMR code.

### DIAGNOSTIC PROTOCOL & LOG INTELLIGENCE (HIGHEST PRIORITY):

#### CORE ANALYSIS METHODOLOGY:
- **Chronological Triage (Master Timeline)**: If multiple logs are provided, you MUST line up all events on a single master timeline to identify which error ACTUALLY started the failure chain. The first error chronologically is your prime suspect — not the loudest one.
- **The Propagation Path (The "Domino Effect")**: Across ALL SOTI products, a failure in one component often cascades to others. You MUST trace the full domino chain (e.g., SQL timeout → MS connection drop → DS handshake failure → Agent enrollment error). Always present this chain explicitly.
- **Evidence-First Mandate**: Logs are your **PRIMARY SOURCE OF TRUTH**. You must analyze them BEFORE applying any other context. Your diagnosis must be anchored to specific log entries.
- **Mandatory Citation**: You MUST cite the **exact filename** and **exact timestamp** for every finding (e.g., "In MS.log at 2026-05-15 10:00:01.342: SqlException - Timeout expired").
- **EXCEPTION-FIRST SCANNING (HIGHEST FORENSIC VALUE)**: Exceptions are the most critical evidence in any SOTI log. You MUST actively hunt for and prioritize these patterns:
  - **Full .NET Exception stack traces**: e.g., "System.NullReferenceException", "System.InvalidOperationException", "System.TimeoutException", "System.Data.SqlClient.SqlException", "System.Net.WebException", "System.IO.IOException", "System.UnauthorizedAccessException", "System.OutOfMemoryException".
  - **SOTI-specific exceptions**: Any exception containing "SOTI.", "Mobicontrol.", "MobiControl.", or product-specific namespaces.
  - **Exception chains**: Look for "Inner Exception", "--->" and "caused by" patterns — the INNERMOST exception is usually the true root cause.
  - **Stack trace reading**: When you find an exception with a stack trace, read it BOTTOM-UP. The bottom frames show the origin call, the top frames show where it surfaced. Identify which SOTI component or method initiated the failing operation.
  - **Recurring exceptions**: If the same exception type repeats across multiple timestamps, note the FIRST occurrence (origin) and the frequency (indicates severity/impact).
  - **Priority order when scanning logs**: (1) Exceptions with full stack traces, (2) ERROR-level entries, (3) WARN entries near error timestamps, (4) INFO entries for context around the failure window.

#### ZERO-GUESS POLICY (CRITICAL):
- **NEVER guess the root cause**. If you cannot find a specific error signature in the logs, say: "No conclusive evidence found in the provided logs for this symptom."
- **An error in a log does NOT automatically mean it is THE cause.** Many errors are symptoms, not causes. You must distinguish between CAUSAL errors (the origin) and SYMPTOMATIC errors (the downstream effect).
- **Correlation ≠ Causation**: Just because an error appears near a failure timestamp does not make it the root cause. Validate by checking: (1) Does the error precede the failure? (2) Is there a known causal relationship in SOTI architecture? (3) Does fixing this error logically resolve the reported symptom?
- **If evidence is insufficient**, explicitly state what additional logs or data you need and WHY. Never fill gaps with assumptions.

#### PRODUCT-SPECIFIC LOG ANALYSIS:

##### 📱 SOTI MobiControl — Log Signatures & What To Look For:
**Log Sources**: MS.log (Management Service), DS.log (Deployment Server), DSE.log (DS Extension), AgentManager.log, Device DDR (Debug Report), HAR (browser network traces), Windows Event Logs.
**Service Architecture**: Management Service (MS) ↔ SQL Database ↔ Deployment Server (DS) ↔ Device Agent.
**Key Error Signatures to Hunt**:
- **SQL/Database**: "SqlException", "Timeout expired", "Deadlock", "Login failed for user", "Cannot open database", "Connection pool exhausted", "Transaction was deadlocked" — indicates DB performance or connectivity issues.
- **MS ↔ DS Communication**: "Handshake failed", "Certificate error", "Port 5494 connection refused", "SSL/TLS error", "The remote certificate is invalid" — indicates broken MS-DS trust or certificate expiry.
- **Enrollment Failures**: "DeviceEnrollmentException", "AFW provisioning failed", "QR code invalid", "EMM token expired", "Device already enrolled", "COPE/COBO provisioning error" — check enrollment mode vs device state.
- **Agent Communication**: "Signal connection lost (port 13131)", "Check-in failed", "Push notification timeout", "APNS certificate expired (port 2197)" — indicates agent-to-server connectivity issues.
- **Profile/Policy Deployment**: "Profile deployment failed", "Policy conflict", "OEMConfig parse error", "Application Run Control violation" — check profile targeting and device compatibility.
- **Certificate Issues**: "Certificate chain incomplete", "Root CA not trusted", "CRL check failed", "SCEP enrollment failed" — check certificate configuration and CA trust chains.
- **Console/Web UI**: "HTTP 500", "HTTP 502 Bad Gateway", "Service Unavailable", "SOTI Management Service stopped" — check MS service status and SQL connectivity. NEVER mention IIS.
- **Upgrade/Migration**: "Schema migration failed", "Version mismatch between MS and DS", "Plugin incompatible" — check upgrade sequence (MS first, then DS).
**Domino Patterns**:
  - SQL Timeout → MS API failure → DS sync failure → Device policy not updated
  - Certificate expiry → MS-DS handshake break → All device check-ins fail
  - DNS resolution failure → Agent cannot reach DS → Enrollment stuck at "Connecting"

##### 🔍 SOTI XSight — Log Signatures & What To Look For:
**Log Sources**: XSight Service logs, Collector logs, Agent telemetry data, Event pipeline logs, Elasticsearch/data store logs.
**Service Architecture**: XSight Collectors → Data Pipeline → XSight Analytics Engine → Dashboard/Alerts.
**Key Error Signatures to Hunt**:
- **Data Collection**: "Collector heartbeat lost", "Telemetry ingestion failed", "Agent reporting gap detected", "SNMP timeout", "WMI access denied" — indicates collector-to-device communication issues.
- **Pipeline/Processing**: "Event queue overflow", "Processing pipeline backlog", "Message deserialization error", "Schema validation failed" — indicates data pipeline congestion or format issues.
- **Storage/Database**: "Elasticsearch cluster red", "Index write blocked", "Disk watermark exceeded", "Shard allocation failed", "MongoDB connection timeout" — indicates storage capacity or connectivity issues.
- **Dashboard/Reporting**: "Report generation timeout", "Widget data source unavailable", "Aggregation query failed", "Dashboard rendering error" — usually downstream of storage issues.
- **Alerts/Rules**: "Alert rule evaluation failed", "Notification delivery failed", "SMTP connection refused", "Webhook timeout" — check alert configuration and notification channel connectivity.
- **Integration**: "MobiControl API connection refused", "SSO token expired", "Cross-product sync failed" — check inter-product integration credentials and network.
**Domino Patterns**:
  - Disk full → Elasticsearch write block → Pipeline backlog → Dashboard shows stale data → Alerts stop firing
  - Collector offline → Data gap → XSight reports inaccurate device health → False "healthy" status
  - Network firewall change → Collector cannot reach devices → Telemetry gaps → Compliance reports incorrect

##### 🔐 SOTI Identity — Log Signatures & What To Look For:
**Log Sources**: Identity Service logs, Authentication logs, Token service logs, Federation/SSO logs, Audit trail logs.
**Service Architecture**: Client App → SOTI Identity (Auth Server) → Identity Store (SQL/LDAP/AD) → Token Issuance → Relying Party (MobiControl/XSight/Connect).
**Key Error Signatures to Hunt**:
- **Authentication Failures**: "Authentication failed for user", "Invalid credentials", "Account locked out", "MFA verification failed", "Passwordless challenge expired", "FIDO2 attestation error" — distinguish between user error vs system misconfiguration.
- **SSO/Federation**: "SAML assertion invalid", "OAuth token expired", "OIDC discovery endpoint unreachable", "Redirect URI mismatch", "IdP metadata stale", "Claims mapping error" — check federation configuration and certificate validity.
- **Token Service**: "Token generation failed", "Refresh token revoked", "JWT signature validation failed", "Token lifetime exceeded", "Audience mismatch" — check token signing certificate and relying party configuration.
- **Directory Integration**: "LDAP bind failed", "Active Directory sync timeout", "User provisioning conflict", "Group membership sync error", "Distinguished Name not found" — check AD/LDAP connectivity and credentials.
- **Certificate/Crypto**: "Signing certificate expired", "Token encryption key rotation failed", "HTTPS certificate chain incomplete" — check Identity server certificate lifecycle.
- **Cross-Product Auth**: "MobiControl SSO handshake failed", "XSight auth redirect loop", "Connect API bearer token rejected" — check relying party trust configuration in Identity.
**Domino Patterns**:
  - Identity signing cert expired → All SSO tokens invalid → MobiControl console login fails → XSight dashboards inaccessible → Connect API calls rejected
  - AD sync failure → New users not provisioned → User cannot authenticate → Appears as "auth failure" but root cause is sync
  - LDAP server unreachable → Identity falls back to cache → Cache expires → Mass authentication failures

##### 🔗 SOTI Connect — Log Signatures & What To Look For:
**Log Sources**: Connect Service logs, Connector/Gateway logs, Device communication logs, API gateway logs, Integration pipeline logs.
**Service Architecture**: IoT Devices → SOTI Connect Gateway/Connector → Connect Service → Data Processing → Dashboard/API → Integration (MobiControl/XSight).
**Key Error Signatures to Hunt**:
- **Device Connectivity**: "Device connection timeout", "MQTT broker unreachable", "Protocol negotiation failed", "TLS handshake error", "Device certificate rejected", "Heartbeat missed" — check network, certificates, and protocol compatibility.
- **Connector/Gateway**: "Connector offline", "Gateway resource exhausted", "Connection pool depleted", "Proxy authentication failed", "Upstream timeout" — check connector health and resource allocation.
- **Data Processing**: "Payload parse error", "Data transformation failed", "Schema mismatch for device type", "Unsupported firmware response", "Command execution timeout" — check device driver/template compatibility.
- **Printer/IoT-Specific**: "SNMP community string mismatch", "Print queue stuck", "Firmware update failed", "Supply level read error", "PJL command rejected" — check device-specific configuration and driver version.
- **API/Integration**: "REST API rate limit exceeded", "Webhook delivery failed", "MobiControl integration credential expired", "Batch operation timeout" — check API configuration and inter-product credentials.
- **Discovery**: "Network scan timeout", "IP range scan incomplete", "Device type not recognized", "Auto-discovery conflict with existing device" — check network scan configuration and device driver availability.
**Domino Patterns**:
  - Connector offline → All managed devices in that segment unreachable → Stale data in dashboard → Alerts for "all devices offline" (but it's the connector, not the devices)
  - Certificate expired on gateway → TLS handshake fails → Devices cannot report → Connect shows "unknown" status
  - Driver template update → Existing devices report schema mismatch → Data processing errors → Dashboard shows partial data

#### CROSS-PRODUCT ANALYSIS:
When logs from multiple SOTI products are present, you MUST check for inter-product dependencies:
- **Identity ↔ All Products**: Authentication/SSO issues in Identity will cascade to ALL other products. Always check Identity logs FIRST if login/auth errors appear in any product.
- **MobiControl ↔ XSight**: XSight relies on MobiControl for device data. If XSight shows stale data, check MobiControl API health first.
- **MobiControl ↔ Connect**: Connect may integrate with MobiControl for unified device management. Check integration credentials and API endpoints.
- **Shared Infrastructure**: All products may share SQL Server, certificates, and network infrastructure. A SQL or DNS issue can affect everything simultaneously.

### CONVERSATIONAL UX GUIDANCE (PROACTIVE MENTORING):
- **Direct Accountability**: You are responsible for ensuring you have enough data to be accurate.
- **Missing Salesforce Data**: If [CASE CONTEXT DATA] fields (like case_number or issue_summary) are empty, politely state: "I don't yet have your Salesforce case context. Please use the 'Sync from Salesforce' button so I can tailor my analysis to your specific environment."
- **Missing Logs**: If [DIAGNOSTIC DATA] is empty or no logs are attached, state: "I'm ready to help, but uploading logs (MS.log, DS.log, Device logs) would allow me to perform a much deeper forensic analysis."
- **Transparency Brief**: At the start of an analysis, briefly list:
    1. **WHAT I HAVE**: (e.g., Case Summary, Agent Version).
    2. **WHAT IS MISSING**: (e.g., Server Logs, SOTI Version).
    3. **STATUS**: (Ready / Partial / Awaiting Context).
    4. **NEXT STEP**: (The one best action the user should take).

### OPERATIONAL MANDATES (SOTI ELITE):
- **STRICT DATA-FIRST POLICY**: The [LATEST...] tags and [ATTACHED LOGS] are the ABSOLUTE TRUTH. If you see specific MCMR codes or version highlights in the context, you MUST report them exactly.
- **ZERO TOLERANCE FOR GENERIC ADVICE**: You are a Senior SOTI Architect. NEVER suggest "Community Forums", "Reddit", "General IT troubleshooting", or manufacturer support unless it is a SOTI-certified partner integration (e.g., Zebra StageNow, Samsung KME). 
- **SOTI-ONLY SOLUTIONS**: Your solutions MUST use SOTI terminology (Application Run Control, Profiles, afw#mobicontrol, OEMConfig, DS/MS services).
- **Navigation Mandate**: Always use modern (v15/v16) navigation paths (e.g., Profiles -> Configurations -> Add). Avoid obsolete terms like "App Policies" when referring to app restrictions.
- **No Hallucinations**: If you don't know the SOTI-specific answer, do not guess with general IT knowledge. Say "No SOTI documentation found" instead.
- **No Meta-Talk**: Do not explain your instructions. Just execute the forensic analysis.`;
}

// --- RESEARCH ENGINE ---
async function sotiFetch(url, timeout = 12000) {
    // Priority 1: Direct Fetch (Uses manifest permissions)
    try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), timeout);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(tid);
        if (res.ok) {
            const text = await res.text();
            if (text && text.length > 500) return text;
        }
    } catch (e) { console.warn('Direct fetch failed, trying proxies...', e); }

    // Priority 2: Proxies
    const rawProxies = [
        `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
    ];
    
    for (const p of rawProxies) {
        try {
            const res = await fetch(p);
            if (res.ok) {
                const text = await res.text();
                if (text && text.length > 500) return text;
            }
        } catch (e) { }
    }
    return null;
}

async function fetchReleaseNotes(type, version) {
    let url = 'https://pulse.soti.net/support/soti-mobicontrol/product-notes/release-notes/';
    if (type === 'agent') url = 'https://pulse.soti.net/support/soti-mobicontrol/product-notes/android-agent-release-notes/';
    if (type === 'identity') url = 'https://pulse.soti.net/support/soti-identity/release-notes/';
    const html = await sotiFetch(url, 12000);
    if (!html) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const text = doc.body.textContent;
    const regex = new RegExp(`(?:v|Version)?\\s*${version.replace('.', '\\.')}[\\s\\S]{1,1000}?(?=\\bv?\\s*\\d+\\.\\d+|$)`, 'i');
    const match = text.match(regex);
    return match ? `[RAW ${type.toUpperCase()} ${version} NOTES]:\n${match[0].trim().slice(0, 1500)}` : null;
}

async function searchPulseAndDocs(query, msgs, ci) {
    try {
        PULSE_SEARCH_RESULTS = ""; DOCS_SEARCH_RESULTS = ""; RESEARCHED_ARTICLE_CONTENT = ""; RELEASE_NOTES_CONTENT = "";
        const qLower = query.toLowerCase();
        const history = (msgs || []).map(m => m.content.toLowerCase()).join(' ');
        
        const asksAgent = qLower.includes('agent') || history.includes('agent');
        const asksConsole = qLower.includes('mobicontrol') || qLower.includes('console') || history.includes('mobicontrol');
        const asksIdentity = qLower.includes('identity') || history.includes('identity') || (ci && ci.product === 'SOTI Identity');
        const asksVersion = qLower.includes('latest') || qLower.includes('version') || qLower.includes('release') || qLower.includes('update') || /\d{4}\.\d\.\d/.test(query);

        if (asksVersion) {
            let notes = [];
            
            const pulseUrls = [];
            if (asksAgent || (!asksAgent && !asksConsole && !asksIdentity)) pulseUrls.push('https://pulse.soti.net/support/soti-mobicontrol/product-notes/android-agent-release-notes/');
            if (asksConsole || (!asksAgent && !asksConsole && !asksIdentity)) pulseUrls.push('https://pulse.soti.net/support/soti-mobicontrol/product-notes/release-notes/');
            if (asksIdentity) pulseUrls.push('https://pulse.soti.net/support/soti-identity/release-notes/');

            for (const url of pulseUrls) {
                let type = 'Console';
                if (url.includes('android-agent')) type = 'Agent';
                if (url.includes('soti-identity')) type = 'Identity';
                toast(`Scraping ${type} Notes...`, 'i');
                
                const html = await sotiFetch(url, 15000);
                if (html) {
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    doc.querySelectorAll('script, style, nav, footer, header, svg, path').forEach(el => el.remove());
                    
                    let clean = "";
                    const bodyText = doc.body.innerText.replace(/\s+/g, ' ');
                    
                    // Version-Specific Extraction
                    const verMatch = query.match(/\b(20\d\d\.\d+(?:\.\d+)?)\b/);
                    if (verMatch) {
                        const targetVer = verMatch[1].replace(/\./g, '\\.');
                        const verRegex = new RegExp(`(?:v|Version)?\\s*${targetVer}[\\s\\S]{1,4000}?(?=\\bv?\\s*\\d+\\.\\d+\\.\\d+|$)`, 'i');
                        const verSection = bodyText.match(verRegex);
                        if (verSection) {
                            clean = `[EXACT VERSION ${verMatch[1]} MATCH]:\n${verSection[0].trim()}`;
                        }
                    }

                    // Fallback to broad search if no exact version match or content is thin
                    if (clean.length < 500) {
                        const blocks = doc.querySelectorAll('h1, h2, h3, h4, table, .product-notes-content, .resolved-issues, .maintenance-release, [id*="Resolved"]');
                        blocks.forEach(el => {
                            const t = el.innerText.replace(/\s+/g, ' ').trim();
                            if (t.length > 5) clean += `\n[${el.tagName || 'SECTION'}]: ${t}\n`;
                        });
                    }

                    if (clean.length < 1000 && !clean.includes('[EXACT VERSION')) {
                        const mcmrs = bodyText.match(/MCMR-\d+/g);
                        if (mcmrs) clean += `\n[FOUND MCMRS]: ${mcmrs.join(', ')}\n\n${bodyText.slice(0, 5000)}`;
                    }

                    if (clean.length > 200) {
                        notes.push(`[SOTI PULSE ${type.toUpperCase()} DATA]:\n${clean.slice(0, 10000)}`);
                        toast(`✓ ${type} Data Ready`, 's');
                    }
                }
            }
            
            if (notes.length > 0) {
                RELEASE_NOTES_CONTENT = notes.join('\n\n---\n\n');
            } else {
                toast('Autonomous Research failed', 'w');
            }
        }
            

        const stopWords = new Set(['what', 'where', 'how', 'when', 'there', 'is', 'are', 'was', 'were', 'the', 'and', 'with', 'some', 'having', 'issues', 'this', 'that', 'they', 'their', 'them', 'from', 'into', 'your', 'will', 'would', 'could', 'should', 'about', 'some', 'doing', 'doing', 'it', 'for']);
        const keywords = query.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w)).slice(-5).join('%20');
        if (!keywords) return;

        const [pHtml, dHtml, iHtml] = await Promise.all([
            sotiFetch(`https://pulse.soti.net/search/?q=${keywords}`, 8000),
            sotiFetch(`https://docs.soti.net/soti-mobicontrol/search/?q=${keywords}`, 8000),
            asksIdentity ? sotiFetch(`https://pulse.soti.net/support/soti-identity/search/?q=${keywords}`, 8000) : Promise.resolve(null)
        ]);

        const deepLinks = [];
        if (pHtml) {
            const doc = new DOMParser().parseFromString(pHtml, 'text/html');
            const items = [...doc.querySelectorAll('a')].filter(a => a.href && a.href.includes('pulse.soti.net/support')).slice(0, 3);
            PULSE_SEARCH_RESULTS = items.map(i => { deepLinks.push(i.href); return `- ${i.textContent.trim()}`; }).join('\n');
        }
        if (dHtml) {
            const doc = new DOMParser().parseFromString(dHtml, 'text/html');
            const items = [...doc.querySelectorAll('a')].filter(a => a.href && a.href.includes('/help/')).slice(0, 3);
            DOCS_SEARCH_RESULTS = items.map(i => { deepLinks.push(i.href); return `- ${i.textContent.trim()}`; }).join('\n');
        }
        if (iHtml) {
            const doc = new DOMParser().parseFromString(iHtml, 'text/html');
            const items = [...doc.querySelectorAll('a')].filter(a => a.href && (a.href.includes('/soti-identity/help/') || a.href.includes('/soti-identity/articles/'))).slice(0, 3);
            DOCS_SEARCH_RESULTS += (DOCS_SEARCH_RESULTS ? '\n' : '') + items.map(i => { deepLinks.push(i.href); return `- ${i.textContent.trim()}`; }).join('\n');
        }

        if (deepLinks.length > 0) {
            const content = await sotiFetch(deepLinks[0], 15000);
            if (content) {
                const doc = new DOMParser().parseFromString(content, 'text/html');
                doc.querySelectorAll('script, style, nav, footer, header').forEach(el => el.remove());
                // Capture more procedurally relevant tags
                let article = "";
                doc.querySelectorAll('h1, h2, h3, h4, p, li, td, strong, span').forEach(el => {
                    article += `${el.innerText.trim()}\n`;
                });
                RESEARCHED_ARTICLE_CONTENT = `[DEEP RESEARCH - ${deepLinks[0]}]:\n${article.slice(0, 7500)}`;
            }
        }
    } catch (e) { console.warn('Research failed', e); }
}

async function fetchLatestSOTIVersions() {
    const [consoleHtml, agentHtml, identityHtml] = await Promise.all([
        sotiFetch('https://pulse.soti.net/support/soti-mobicontrol/product-notes/release-notes/', 15000),
        sotiFetch('https://pulse.soti.net/support/soti-mobicontrol/product-notes/android-agent-release-notes/', 15000),
        sotiFetch('https://pulse.soti.net/support/soti-identity/release-notes/', 15000)
    ]);

    const verRegex = /\b(20\d\d\.\d+(?:\.\d+)?)\b/g;

    if (consoleHtml) {
        VERSIONS = [...new Set(consoleHtml.match(verRegex) || [])].sort((x, y) => y.localeCompare(x, undefined, { numeric: true }));
    }

    if (agentHtml) {
        const agentVerRegex = /\b(20\d\d\.\d+\.\d+)\b/g;
        AGENT_VERSIONS = [...new Set(agentHtml.match(agentVerRegex) || [])].sort((x, y) => y.localeCompare(x, undefined, { numeric: true }));
    }

    if (identityHtml) {
        IDENTITY_VERSIONS = [...new Set(identityHtml.match(verRegex) || [])].sort((x, y) => y.localeCompare(x, undefined, { numeric: true }));
    }
    
    updateVersionDropdowns();
}

function updateVersionDropdowns() {
    const prod = $('product').value;
    let sotiOpts = VERSIONS;
    let agentOpts = AGENT_VERSIONS;

    if (prod === 'SOTI Identity') {
        sotiOpts = IDENTITY_VERSIONS;
        agentOpts = []; // Identity doesn't have an 'Agent' version in this context
    }

    $('sotiVer').innerHTML = '<option value="">— Select —</option>' + sotiOpts.map(v => `<option value="${v}">${v}</option>`).join('');
    
    if (agentOpts.length > 0) {
        $('agentVer').innerHTML = '<option value="">— Select —</option>' + agentOpts.map(v => `<option value="${v}">${v}</option>`).join('');
    } else {
        $('agentVer').innerHTML = '<option value="">N/A</option>';
    }
}

$('product').onchange = () => {
    updateVersionDropdowns();
    saveState();
};

// --- AI ENGINE ---
// API key priority:
//   1. config.js  → window.SOTI_AI_CONFIG.apiKey (admin-distributed, not in source control)
//   2. chrome.storage.local → manually entered via Settings modal (fallback)
//   3. null → user is prompted to configure
async function getApiKey() {
    try {
        // Priority 1: Centrally managed key from config.js (preferred for corporate deployment)
        const configKey = window.SOTI_AI_CONFIG && window.SOTI_AI_CONFIG.apiKey;
        if (configKey && configKey !== 'PASTE_YOUR_OPENROUTER_KEY_HERE' && configKey.length > 10) {
            return configKey;
        }
        // Priority 2: Manually stored key (fallback for dev or if config.js is absent)
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            const data = await chrome.storage.local.get('openrouter_api_key');
            return data.openrouter_api_key || null;
        }
        return localStorage.getItem('openrouter_api_key') || null;
    } catch (e) {
        console.error('Failed to retrieve API key', e);
        return null;
    }
}

async function saveApiKey(key) {
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            await chrome.storage.local.set({ openrouter_api_key: key });
        } else {
            localStorage.setItem('openrouter_api_key', key);
        }
    } catch (e) {
        console.error('Failed to save API key', e);
    }
}

async function clearApiKey() {
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            await chrome.storage.local.remove('openrouter_api_key');
        } else {
            localStorage.removeItem('openrouter_api_key');
        }
    } catch (e) {
        console.error('Failed to clear API key', e);
    }
}

const ELITE_FREE_POOL = ["deepseek/deepseek-v4-flash"];
let BLACKLISTED_MODELS = [];

const OpenRouterAI = {
    completions: {
        create: async (req) => {
            let model = req.model || $('modelSel').value;
            const isVisionModel = model.includes('gemini-3') || model.includes('gemini-2');
            
            // AUTOMATIC FLATTENING: If the target model doesn't support vision, 
            // convert multimodal history into pure text to prevent API errors.
            const messages = req.messages.map(m => {
                if (Array.isArray(m.content)) {
                    if (isVisionModel) return m;
                    // Flatten to text
                    let text = m.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
                    const hasImg = m.content.some(c => c.type === 'image_url');
                    if (hasImg) text = `[USER ATTACHED AN IMAGE WHICH YOU SAW IN A PREVIOUS TURN]\n${text}`;
                    return { ...m, content: text };
                }
                return m;
            });

            const apiKey = await getApiKey();
            if (!apiKey) {
                throw new Error("No API key configured. Please add your OpenRouter API key in Settings (⚙).");
            }
            const modelsToTry = [model, ...ELITE_FREE_POOL.filter(m => m !== model && !BLACKLISTED_MODELS.includes(m))];
            for (const m of modelsToTry) {
                try {
                    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...req, model: m, messages: messages })
                    });
                    if (res.status === 429) { await new Promise(r => setTimeout(r, 1000)); continue; }
                    if (!res.ok) { 
                        const err = await res.text(); 
                        console.error('AI Error:', res.status, err); 
                        BLACKLISTED_MODELS.push(m); 
                        continue; 
                    }
                    return res.body.getReader();
                } catch (e) { continue; }
            }
            throw new Error("All models busy.");
        }
    }
};

async function send(overrideText = null, silent = false) {
    if (busy) return;
    const c = cases.find(x => x.id === activeCaseId);
    if (!c) {
        toast('No active case selected', 'e');
        return;
    }
    
    let txt = "";
    if (typeof overrideText === 'string') {
        txt = overrideText;
    } else {
        txt = $('chatIn').value.trim();
    }

    if (!txt && c.logs.length === 0 && c.imgs.length === 0) return;
    busy = true; 
    $('btnSend').disabled = true; 
    
    if (typeof overrideText !== 'string') {
        $('chatIn').value = ''; 
        $('chatIn').style.height = '';
    }
    if ($('welcome')) $('welcome').style.display = 'none';

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

    addMsg('user', displayTxt, false, silent);
    const aib = addMsg('assistant', '<div class="thinking-dot"></div>', false);
    
    // Background research but don't hang if it's slow
    try {
        await Promise.race([
            searchPulseAndDocs(txt, c.msgs, ci),
            new Promise(r => setTimeout(r, 6000))
        ]);
    } catch (e) { console.warn('Research timed out'); }

    try {
        const isGreeting = /^(hi|hello|hey|greetings|morning|afternoon|evening|yo|sup)\b/i.test(txt) && txt.split(' ').length < 3;
        const promptMode = isGreeting ? 'greeting' : 'full';

        // --- LOG CONTEXT ---
        let logContext = c.logs.length > 0 ? `\n\n[DIAGNOSTIC DATA - ${c.logs.length} FILES ATTACHED]` : "";
        c.logs.forEach(l => {
            logContext += `\n\n=== SOURCE: ${l.name} (Total Size: ${l.content.length} chars) ===\n${getSmartLogSnippet(l.content, 300000)}\n=== END: ${l.name} ===`;
        });

        const summaryText = $('issueSummary').value || 'NO SUMMARY PROVIDED';
        const sysPrompt = scrubPII(`[OFFICIAL ISSUE SUMMARY - AUTHORITATIVE SOURCE]:
${summaryText}

[CURRENT ANALYSIS TIME]: ${new Date().toLocaleString()}

${getSysPrompt(promptMode)}

[IMPORTANT NOTE ON MULTIMODAL IMAGES]:
When the user attaches an image, it is automatically processed using OCR. The extracted text is provided below in the [SCRAPPED TEXT FROM ATTACHED IMAGES] section. YOU CANNOT SEE THE IMAGES DIRECTLY. You must rely entirely on the scraped text provided in that section. Do not ask the user to upload the image or complain that you cannot see it. Just analyze the scraped text.

[LATEST MOBICONTROL CONSOLE VERSIONS]: ${VERSIONS.join(', ')}
[LATEST ANDROID AGENT VERSIONS]: ${AGENT_VERSIONS.join(', ')}
[LATEST SOTI IDENTITY VERSIONS]: ${IDENTITY_VERSIONS.join(', ')}
[RELEASE NOTES]: ${RELEASE_NOTES_CONTENT}
[PULSE SEARCH]: ${PULSE_SEARCH_RESULTS}
[DEEP RESEARCH]: ${RESEARCHED_ARTICLE_CONTENT}

[CASE CONTEXT DATA]:
${JSON.stringify(ci, null, 2)}

[DIAGNOSTIC DATA INTELLIGENCE]:
- For files exceeding 300k characters, you receive THREE sections:
  1. HEAD (first 30k chars): Contains startup config, service initialization, and environment info.
  2. FULL-FILE FORENSIC EXTRACTION: Every single Exception, ERROR, FATAL, CRITICAL, and MCMR line extracted from the ENTIRE log file — nothing skipped. Exception stack traces are captured in full with all inner exceptions. Error lines include ±2 lines of context.
  3. TAIL (last 200k chars): Contains the most recent activity and failures.
- **YOU HAVE SEEN EVERY EXCEPTION AND ERROR IN THE LOG.** The forensic extraction scanned every line. If an exception exists anywhere in the file, it is in your data.
- Focus your analysis on the FORENSIC EXTRACTION section first — it contains the highest-value evidence.
- If you need general context around a specific timestamp (e.g., INFO-level entries), those may only be in the HEAD or TAIL. In that case, ask the user for the log content around that specific timestamp.

${imgContext}

${logContext}`);

        // Pure-Text Payload (Option A)
        const userMsg = scrubPII(txt) + (imgContext ? `\n\n(Extracted Image Data via OCR):\n${imgContext}` : "");
        c.msgs.push({ role: 'user', content: userMsg, hidden: silent });
        
        // Model Selection: OCR handles images client-side, so all payloads are pure text
        const selectedModel = null; // Uses dropdown selection or free model pool

        const reader = await OpenRouterAI.completions.create({
            model: selectedModel,
            messages: [{ role: 'system', content: sysPrompt }, ...c.msgs.slice(-10)],
            stream: true
        });

        let resp = '';
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
            for (const line of lines) {
                const data = line.slice(6);
                if (data === '[DONE]') break;
                try {
                    const json = JSON.parse(data);
                    const tok = json.choices[0]?.delta?.content || '';
                    if (tok) {
                        resp += tok;
                        aib.innerHTML = md(resp);
                        $('chatMsgs').scrollTop = $('chatMsgs').scrollHeight;
                    }
                } catch (e) { }
            }
        }
        c.msgs.push({ role: 'assistant', content: resp });
        saveState();
    } catch (e) { aib.innerHTML = `<span style="color:var(--red)">${e.message}</span>`; }
    finally { 
        busy = false; 
        $('btnSend').disabled = false;
        // Clear images after sending so they don't hang around for the next prompt
        if (c && c.imgs) {
            c.imgs = [];
            renderImgs();
            saveState();
        }
    }
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
    $('chatMsgs').appendChild(w);
    $('chatMsgs').scrollTop = $('chatMsgs').scrollHeight;
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
    'agentVer', 'platform', 'enviro', 'dsCfg', 'affDev', 
    'issueSummary', 'meetingNotes', 'emailChain',
    'jiraExpected', 'jiraImpact', 'jiraRepro', 'jiraPriority'
].forEach(id => {
    const el = $(id);
    if (el) {
        const handler = () => {
            saveState();
            updateFieldValidation(id);
            if (id === 'caseNum') renderTabs();
        };
        el.oninput = handler;
        if (el.tagName === 'SELECT') el.onchange = handler;
    }
});

$('btnSyncSF').onclick = async () => {
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
        if (data && (data.caseNumber || data.accountName || data.subject || data.description || data.currentVersion || data.product || data.licenseType)) {
            if (data.caseNumber) $('caseNum').value = data.caseNumber;
            if (data.accountName) $('scrubAccount').value = data.accountName;
            if (data.contactName) $('scrubCustomer').value = data.contactName;
            
            let summary = '';
            if (data.subject) summary += data.subject;
            if (data.description) summary += (summary ? '\n\n' : '') + data.description;
            
            if (summary) {
                $('issueSummary').value = summary;
            }
            if (data.currentVersion) $('sotiVer').value = data.currentVersion;
            if (data.product) {
                const options = Array.from($('product').options).map(o => o.text);
                const match = options.find(o => o.toLowerCase().includes(data.product.toLowerCase()));
                if (match) $('product').value = match;
            }
            if (data.licenseType) {
                const lt = data.licenseType.toLowerCase();
                if (lt.includes('cloud')) $('dsCfg').value = 'Cloud';
                 if (lt.includes('subscription')) $('dsCfg').value = 'On-Prem';
            }
            if (data.emailChain) $('emailChain').value = data.emailChain;
            
            saveState();
            renderTabs();
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

    none.style.display = c.logs.length > 0 ? 'none' : 'block';
    const frag = document.createDocumentFragment();
    c.logs.forEach((f, i) => {
        const item = document.createElement('div');
        item.className = 'log-item';
        item.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
            <span class="log-name" style="margin-left:8px">${f.name}</span> 
            <button class="log-del" data-index="${i}">×</button>`;
        
        item.querySelector('.log-del').addEventListener('click', () => removeLog(i));
        frag.appendChild(item);
    });
    list.innerHTML = '';
    list.appendChild(frag);

    const btn = $('btnAnalyse');
    if (btn) btn.style.display = c.logs.length > 0 ? 'block' : 'none';

    const guide = $('logGuide');
    if (guide) guide.style.display = c.logs.length > 0 ? 'none' : 'block';
};

const removeLog = (i) => {
    const c = cases.find(x => x.id === activeCaseId);
    if (c) c.logs.splice(i, 1);
    renderLogs();
    saveState();
};

const handleFiles = (files) => {
    const c = cases.find(x => x.id === activeCaseId);
    if (!c) return;

    for (const f of files) {
        const r = new FileReader();
        r.onload = ev => { 
            const rawContent = ev.target.result;
            // SECURITY: Run PII scan to build identity maps, then store only the
            // scrubbed version. Raw customer data is never written to persistent storage.
            const scrubbedContent = scrubPII(rawContent);
            c.logs.push({ name: f.name, content: scrubbedContent }); 
            toast(`${f.name} uploaded (PII scrubbed)`, 's'); 
            renderLogs();
            saveState();
        };
        r.readAsText(f);
    }
};

$('dz').onclick = () => $('fileIn').click();
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
    el.ondrop = e => {
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
            if (logs.length > 0) handleFiles(logs);
        }
    };
});
$('fileIn').onchange = e => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const imgs = [], logs = [];
    for (const f of files) {
        if (f.type.startsWith('image/')) imgs.push(f);
        else logs.push(f);
    }
    if (imgs.length > 0 && typeof handleImages === 'function') handleImages(imgs);
    if (logs.length > 0) handleFiles(logs);
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

            // Run OCR (Tesseract v5)
            try {
                const Lib = typeof Tesseract !== 'undefined' ? Tesseract : window.Tesseract;
                const isExt = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
                console.log('[OCR] Environment:', isExt ? 'Chrome Extension' : 'Standalone');
                
                const workerOpts = isExt ? {
                    workerPath: chrome.runtime.getURL('lib/worker.min.js'),
                    corePath: chrome.runtime.getURL('lib/'),
                    langPath: chrome.runtime.getURL('lib/'),
                    workerBlobURL: false
                } : {
                    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/worker.min.js',
                    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/',
                    langPath: 'https://tessdata.projectnaptha.com/4.0.0/'
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
    const now = new Date().toLocaleString();
    const forensicPrompt = `Please provide a forensic analysis of the attached logs.
(Current Analysis Request Time: ${now})
Focus on:
1. 🏛️ Chronological Triage: Identify the very first failure point in the timeline.
2. 🔄 Propagation Path: Trace the "Domino Effect" across services (e.g., MS -> DS -> Agent).
3. 🎯 Root Cause: Distinguish between symptoms and the actual source of failure.`;

    // Update Progress Indicator
    const pWrap = $('progWrap');
    const pLbl = $('progLbl');
    const pFill = $('progFill');
    if (pWrap && pLbl && pFill) {
        pLbl.textContent = "Analysing logs...";
        pWrap.style.display = 'flex';
        pFill.style.animation = 'progress-slide 2s infinite ease-in-out';
        pFill.style.background = 'linear-gradient(90deg, var(--blue), var(--blue2))';
        pFill.style.width = '30%';
    }

    const b = $('bodyR');
    b.style.display = 'none';
    $('iconR').textContent = '▶';
    $('panelR').classList.add('collapsed');
    
    await send(forensicPrompt, true);

    // Mark as completed
    if (pLbl && pFill) {
        pLbl.textContent = "Log Analysis Completed";
        pFill.style.animation = 'none';
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

window.onclick = () => {
    $('moreDropdown').style.display = 'none';
};

$('btnExport').onclick = () => {
    $('moreDropdown').style.display = 'none';
    exportSession();
};

$('btnPop').onclick = () => {
    $('moreDropdown').style.display = 'none';
    chrome.windows.create({
        url: chrome.runtime.getURL('SOTI_AI_Analyser.html'),
        type: 'popup',
        width: 450,
        height: 800
    });
};



$('btnJira').onclick = () => {
    $('mJiraReview').style.display = 'flex';
};

$('mJiraReviewClose').onclick = $('btnJiraReviewCancel').onclick = () => {
    $('mJiraReview').style.display = 'none';
};

$('btnGenerateJira').onclick = async () => {
    $('mJiraReview').style.display = 'none';
    saveState(); // Final save before generating
    
    // Build full context from case info + conversation + logs + review modal
    const expected   = $('jiraExpected').value || 'N/A';
    const impact     = $('jiraImpact').value || 'N/A';
    const priority   = $('jiraPriority').value || 'Medium';
    const repro      = $('jiraRepro').value || 'N/A';
    
    const c          = cases.find(x => x.id === activeCaseId);
    if (!c) return;
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
    const logCtx     = c.logs.length > 0 
        ? c.logs.map(l => `=== LOG: ${l.name} ===\n${l.content.substring(0, 8000)}`).join('\n\n')
        : 'No logs attached.';

    const JIRA_TEMPLATE = `*{color:#de350b}Requirements for the Jira Filing: [https://wiki.soti.net/index.php?title=Artifacts_Required_for_Jira]{color}*

*{color:#de350b}Please fill in all the details.{color}*
h1. {color:#4c9aff}*Background*{color}
h3. *Description of Issue:*
 * {color:#172b4d}Enter a comprehensive description of the issue which includes the action, components, and behavior.{color}

h3. *Expected Behavior:*
 * Enter the expected outcome of performed actions.

h3. *Known Issues:*
 * Please link known Jira tickets, if any.

h3. *Detailed Description of Business Impact:*
h3. *Justification of Priority:* (Please refer to [https://jira.soti.net/secure/ShowConstantsHelp.jspa?decorator=popup#PriorityLevels] for priority descriptions. It is mandatory that the Jira priority has a valid justification.)
h3. *Number of Devices Affected:*

*------------------------------------------------------------------------------------------------------------*
h1. {color:#4c9aff}*Environment:*{color}

Which MC Server Version did it work on before?

Any recent changes?:

Server Count and Details:

Server OS Version:

System Requirements verified?

SQL Version:

Server OS Version for SQL server:

*------------------------------------------------------------------------------------------------------------*
h1. {color:#4c9aff}*Device Details*{color}

Affected Platforms (Android/Windows/iOS):

Enrollment type (AEDO, COPE, iOS ADE, Windows Modern, Classic etc.):

MobiControl Agent Version:

Plug-in version:

Which agent version did it work on?

Any Recent changes:

Affected Devices Manufacturer:

Affected Model:

Affected OS Version:

Affected OEM Version:

Browser Used (If applicable):

*----------------------------------------------------------------------------------------------*
h1. {color:#4c9aff}*Other SOTI Apps*{color}

SOTI Surf/Settings Manager/HUB version:

*----------------------------------------------------------------------------------------------*
h1. {color:#4c9aff}*Troubleshooting Steps:*{color}

*Workarounds Suggested:*
 * Step1 + Result
 * Step2 + Result
 * So on...

*----------------------------------------------------------------------------------------------*
h1. {color:#4c9aff}*Issue Reproduction*{color}

Repro Steps: PLEASE OUTLINE THE STEPS IN DETAIL
 # Step 1
 # Step 2
 # So on...

Is the issue reproducible in-house?

Repro Environment Details:

Results:

Screenshot and video of the issue:

*----------------------------------------------------------------------------------------------*
h1. {color:#4c9aff}*Log Details*{color}
 * If each log file <15 MB, attach directly to the ticket
 * If log file >15 MB, share log location under S:\\CustomerData
 * If SFTP is needed, please share link and use Password State to share the credentials

*Detailed Time Stamps and Time zone (device and end-user) of the repro steps:*

DeviceID/Devid:

Name of the log file:

Log Analysis:
{code:java}
[INSERT RAW LOG SNIPPETS HERE]
{code}

*----------------------------------------------------------------------------------------------*
h1. {color:#4c9aff}*L3/SME Engineer*{color}

Name:

Analysis:

Otherwise, why was L3/SME not consulted:`;

    const systemPrompt = `You are a SOTI Tier 3 Support AI. Your task is to extract technical details from provided context and populate the OFFICIAL SOTI JIRA TEMPLATE.

### CRITICAL RULES:
1. OUTPUT ONLY THE FILLED JIRA TEMPLATE.
2. DO NOT repeat the "Case Information", "Conversation History", or any other input labels.
3. DO NOT include any preamble, introductory text, or concluding remarks.
4. DO NOT summarize. Use the FULL template structure provided.
5. PRESERVE ALL MARKUP: Keep {color}, h1., h3., and {code:java} blocks exactly as they appear in the template.
6. If a field is unknown, write "N/A" or "TBC" - but NEVER omit the field.
7. For Log Analysis, you MUST extract real technical evidence from the attached logs.
8. The 'Log Analysis' section MUST contain raw log snippets (timestamps + error lines). Do NOT provide a textual explanation or summary in this section; provide only the raw technical evidence inside the code block.

YOUR RESPONSE MUST START WITH: "*{color:#de350b}Requirements for the Jira Filing:"`;

    const userPrompt = scrubPII(`### SOURCE DATA FOR ANALYSIS:
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
- Conversation History:
${chatCtx}
- Attached Logs:
${logCtx}

### OFFICIAL SOTI JIRA TEMPLATE (FILL THIS OUT):
${JIRA_TEMPLATE}`);

    try {
        $('mGen').style.display = 'flex'; // Show loading modal
        const apiKey = await getApiKey();
        if (!apiKey) {
            $('mGen').style.display = 'none';
            return toast('No API key configured. Open Settings (⚙) to add your OpenRouter key.', 'e', 5000);
        }
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: $('modelSel').value || 'openrouter/auto',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 4000
            })
        });
        const data = await res.json();
        const filled = data.choices?.[0]?.message?.content || '';
        $('mGen').style.display = 'none'; // Hide loading modal
        
        if (!filled) {
            return toast('JIRA generation failed', 'e');
        }
        $('jiraTa').value = filled;
        $('mJira').style.display = 'flex';
        toast('✓ JIRA Report Ready', 's');
    } catch (e) { 
        $('mGen').style.display = 'none'; // Hide loading modal
        toast('JIRA failed: ' + e.message, 'e'); 
    }
};
$('mJiraClose').onclick = $('btnJiraDone').onclick = () => $('mJira').style.display = 'none';
$('btnCopyJira').onclick = () => { $('jiraTa').select(); document.execCommand('copy'); toast('Copied!', 's'); };

loadState();
fetchLatestSOTIVersions();

// --- SETTINGS MODAL ---
function isManagedKey() {
    const k = window.SOTI_AI_CONFIG && window.SOTI_AI_CONFIG.apiKey;
    return k && k !== 'PASTE_YOUR_OPENROUTER_KEY_HERE' && k.length > 10;
}

async function refreshApiKeyStatus() {
    const key = await getApiKey();
    const dot = $('apiKeyDot');
    const txt = $('apiKeyStatusTxt');
    const btn = $('btnSettings');
    const input = $('apiKeyInput');
    const saveBtn = $('btnSaveKey');
    const clearBtn = $('btnClearKey');
    const toggleBtn = $('btnToggleKeyVis');
    if (!dot || !txt) return;

    if (isManagedKey()) {
        // Key is coming from config.js — show managed state
        dot.style.background = 'var(--green)';
        txt.textContent = 'Managed by Administrator ✓';
        if (btn) btn.style.color = 'var(--green)';
        if (input) {
            input.value = '••••••••••••••••••••••••' + (window.SOTI_AI_CONFIG.apiKey.slice(-4));
            input.disabled = true;
            input.style.opacity = '0.5';
            input.style.cursor = 'not-allowed';
        }
        if (saveBtn) saveBtn.disabled = true;
        if (clearBtn) clearBtn.disabled = true;
        if (toggleBtn) toggleBtn.disabled = true;
    } else if (key) {
        dot.style.background = 'var(--green)';
        txt.textContent = 'API key configured ✓ (manually set)';
        if (btn) btn.style.color = 'var(--green)';
        if (input) { input.disabled = false; input.style.opacity = ''; input.style.cursor = ''; }
        if (saveBtn) saveBtn.disabled = false;
        if (clearBtn) clearBtn.disabled = false;
        if (toggleBtn) toggleBtn.disabled = false;
    } else {
        dot.style.background = 'var(--red)';
        txt.textContent = 'No API key configured';
        if (btn) btn.style.color = 'var(--red)';
        if (input) { input.disabled = false; input.style.opacity = ''; input.style.cursor = ''; }
        if (saveBtn) saveBtn.disabled = false;
        if (clearBtn) clearBtn.disabled = false;
        if (toggleBtn) toggleBtn.disabled = false;
    }
}

async function openSettingsModal() {
    // Let refreshApiKeyStatus() own all input state.
    // Never set input.value to the raw key here — it would briefly expose it.
    const input = $('apiKeyInput');
    if (input && !isManagedKey()) {
        // For manually-set keys, pre-fill with empty so user can re-enter
        // (we don't show the stored key back — that would be unnecessary exposure)
        const stored = await (async () => {
            try {
                if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                    const d = await chrome.storage.local.get('openrouter_api_key');
                    return d.openrouter_api_key || null;
                }
                return localStorage.getItem('openrouter_api_key') || null;
            } catch { return null; }
        })();
        input.value = stored ? '(key stored — enter new key to replace)' : '';
    }
    await refreshApiKeyStatus();
    $('mSettings').style.display = 'flex';
}

$('btnSettings').onclick = openSettingsModal;
$('mSettingsClose').onclick = $('btnSettingsCancel').onclick = () => {
    $('mSettings').style.display = 'none';
};

$('btnToggleKeyVis').onclick = () => {
    const inp = $('apiKeyInput');
    inp.type = inp.type === 'password' ? 'text' : 'password';
};

$('btnSaveKey').onclick = async () => {
    const val = $('apiKeyInput').value.trim();
    if (!val) {
        toast('Please enter an API key before saving.', 'w');
        return;
    }
    if (!val.startsWith('sk-or-')) {
        toast('Key should start with sk-or-... Are you sure this is an OpenRouter key?', 'w', 4000);
    }
    await saveApiKey(val);
    await refreshApiKeyStatus();
    $('mSettings').style.display = 'none';
    toast('✓ API key saved securely', 's');
};

$('btnClearKey').onclick = async () => {
    await clearApiKey();
    $('apiKeyInput').value = '';
    await refreshApiKeyStatus();
    toast('API key cleared', 'w');
};

// On boot: check if key is configured and warn if not
(async () => {
    await refreshApiKeyStatus();
    const key = await getApiKey();
    if (!key) {
        // Delay slightly so welcome screen is visible first
        setTimeout(() => {
            toast('⚙ No API key set. Open Settings to add your OpenRouter key.', 'w', 6000);
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

// Real-time sync between Sidepanel and Floating Window
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.cases || changes.activeCaseId)) {
        // Only reload if the change came from elsewhere (e.g. another window)
        // This is a bit tricky in sidepanels, but we can check if we are busy
        if (!busy) {
            loadState();
        }
    }
});
