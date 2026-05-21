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
const PULSE_ORIGIN = 'https://pulse.soti.net';
const DOCS_ORIGIN = 'https://docs.soti.net';
let PULSE_RELEASE_NOTE_CATALOG = {};

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

function sanitizeAssistantResponse(text) {
    return (text || "")
        .replace(/\bAccording to\s+(?:available information|\[(?:MC VERSIONS|AGENT VERSIONS|IDENTITY VERSIONS|RELEASE NOTES|PULSE SEARCH|DOCS SEARCH|DEEP RESEARCH|CASE|CASE CONTEXT|RELEASE_NOTES)\])\s*,?\s*/gi, "")
        .replace(/\bbased on\s+\[(?:MC VERSIONS|AGENT VERSIONS|IDENTITY VERSIONS|RELEASE NOTES|PULSE SEARCH|DOCS SEARCH|DEEP RESEARCH|CASE|CASE CONTEXT|RELEASE_NOTES)\]\s*,?\s*/gi, "")
        .replace(/\s*\[(?:MC VERSIONS|AGENT VERSIONS|IDENTITY VERSIONS|RELEASE NOTES|PULSE SEARCH|DOCS SEARCH|DEEP RESEARCH|CASE|CASE CONTEXT|RELEASE_NOTES)\]\s*,?\s*/gi, " ")
        .replace(/\b(?:for more (?:detailed )?information|reference|see)\s*,?\s*(?:at\s*)?\[(?:DEEP RESEARCH|DOCS SEARCH|PULSE SEARCH)\][^\n.]*/gi, "")
        .replace(/\bNo specific highlights[^.]*\./gi, "")
        .replace(/\s{2,}/g, " ")
        .replace(/\n {1,}/g, "\n")
        .trim();
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

let _suppressStorageReload = false;
let _saveStateTimer = null;
let _renderTabsTimer = null;

function buildCaseCiFromForm() {
    return {
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

        _suppressStorageReload = true;
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
    } finally {
        setTimeout(() => { _suppressStorageReload = false; }, 80);
    }
}

async function loadState() {
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

    if (_saveStateTimer) {
        clearTimeout(_saveStateTimer);
        _saveStateTimer = null;
    }
    if (_renderTabsTimer) {
        clearTimeout(_renderTabsTimer);
        _renderTabsTimer = null;
    }
    
    const c = cases.find(x => x.id === id);
    if (!c) {
        // If the ID is invalid, fallback to the first case if possible
        if (cases.length > 0) {
            switchCase(cases[0].id);
        }
        return;
    }

    // Capture old case data from DOM into memory SYNCHRONOUSLY before switching
    if (activeCaseId) syncActiveCaseCiFromForm();
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

const LOG_SIGNAL_RULES = [
    { category: 'SQL/Database', weight: 42, regex: /\b(SqlException|SqlError|System\.Data\.SqlClient|Microsoft\.Data\.SqlClient|java\.sql\.SQLException|SQL Server|ODBC|JDBC|ADO\.NET|Deadlock|deadlocked|victim|Timeout expired|Execution Timeout|Login failed|Cannot open database|ALTER DATABASE statement is not supported|SET RECOVERY SIMPLE|Connection pool|pooled connection|max pool size|connection string|transaction|rollback|schema|collation|stored procedure|sp_|xp_|DBInstall|database\s+(?:unavailable|offline|locked|corrupt|failed|failure|error|timeout|deadlock|inaccessible)|could not (?:open|connect to) database|invalid object name|invalid column name|could not find stored procedure|primary key|foreign key|constraint|duplicate key)\b/i },
    { category: 'Certificate/TLS', weight: 38, regex: /\b(certificate|cert\b|SSL|TLS|handshake failed|X509|trust|chain|CRL|OCSP|SCEP|signing|expired cert|revoked|untrusted|RemoteCertificateNameMismatch|RemoteCertificateChainErrors|AuthenticationException|Schannel|PKIX|certificate verify failed|unable to get local issuer|self-signed|hostname mismatch)\b/i },
    { category: 'HTTP/Network', weight: 30, regex: /\b(HTTP\/|HTTP [45]\d\d|StatusCode|BadRequest|Unauthorized|Forbidden|NotFound|Conflict|TooManyRequests|InternalServerError|BadGateway|ServiceUnavailable|GatewayTimeout|WebException|SocketException|ConnectFailure|ConnectionReset|connection dropped|connection lost|lost connection|DNS|resolve|resolution|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|host not found|No such host|network unreachable|proxy|firewall|port \d+|connection refused|connection reset|timed out connecting|name or service not known)\b/i },
    { category: 'Service Lifecycle', weight: 24, regex: /\b(service start|service stop|starting service|stopping service|service failed|failed to start|failed to stop|restarting|OnStart|OnStop|ServiceBase|hosted service|application pool|recycl|terminated unexpectedly|process exited|crashed|crash dump|service control manager|SCM|watchdog|heartbeat lost)\b/i },
    { category: 'Memory/Thread', weight: 34, regex: /\b(OutOfMemory|StackOverflow|ThreadAbort|thread pool|GC heap|memory pressure|heap size|working set|AccessViolation|deadlock detected|hang detected|blocked thread|thread starvation|CPU spike|high CPU|resource exhausted|insufficient memory)\b/i },
    { category: 'Auth/Permission', weight: 36, regex: /\b(Access denied|Unauthorized|forbidden|permission|credentials|credential|login|logon|authentication failed|authorization failed|token expired|invalid token|bearer|OAuth|SAML|OIDC|LDAP bind|Kerberos|NTLM|impersonat|account locked|principal|claims|MFA|passwordless|FIDO|invalid grant|invalid audience|signature validation failed)\b/i },
    { category: 'Enrollment/Agent', weight: 28, regex: /\b(DeviceEnrollmentException|enrollment failed|enrolment failed|AFW provisioning failed|Android Enterprise|QR code invalid|EMM token expired|Device already enrolled|check-in failed|check in failed|heartbeat missed|profile deployment failed|policy deployment failed|agent crash|agent error|agent failed|device check-in failed|device sync failed|package install failed|OEMConfig|managed Google Play|KME|Zero Touch)\b/i },
    { category: 'Storage/IO', weight: 30, regex: /\b(IOException|DirectoryNotFound|FileNotFound|PathTooLong|disk full|no space|access to the path|sharing violation|write failed|read failed|file locked|permission denied|cannot create file|cannot delete file|corrupt(ed)? file|I\/O error)\b/i },
    { category: 'Installer/MSI', weight: 38, regex: /\b(MSI|Windows Installer|CustomAction|Return value 3|Return 1603|error code 1603|Fatal error|Deploy[A-Za-z]*Database|DbUp|DeploymentEngine|PerformUpgrade|Installation failed|rollback|SetupSOTI|Wix|Burn|InstallValidate|InstallFinalize|Action ended|Action start|MSIEXEC)\b/i },
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
    { label: 'return/error code', score: 18, regex: /\b(?:error|return|exit|result|status)\s*(?:code|value)?\s*[:=]?\s*(?:0x[0-9a-f]+|[1-9]\d{2,5})\b/i },
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

function getKeywordHits(line) {
    if (isNegatedSignalLine(line) && !new RegExp(EXCEPTION_CLASS_PATTERN, 'i').test(line || "")) return [];
    return HIGH_SIGNAL_KEYWORDS
        .filter(rule => rule.regex.test(line || ""))
        .map(rule => ({ label: rule.label, score: rule.score }));
}

function isStackTraceLine(line) {
    return /^\s*(at\s+|---\s*>|---\s*End|Caused by:|Suppressed:|Inner Exception| ---> |--->|Traceback \(most recent call last\):|File ".+?", line \d+|at .+?\(.+?:\d+(?::\d+)?\)|\.\.\. \d+ more)/i.test(line || "");
}

function classifyLogLine(line) {
    const categories = [];
    const add = c => { if (!categories.includes(c)) categories.push(c); };

    const exceptionClasses = extractExceptionClasses(line);
    const hasException = exceptionClasses.length > 0 || /\b(Unhandled exception|Inner Exception|Caused by:|Traceback \(most recent call last\))\b/i.test(line || "");
    const keywordHits = getKeywordHits(line);
    const hasErrorWord = keywordHits.some(hit => hit.label === 'explicit failure' || hit.label === 'fatal/critical' || hit.label === 'return/error code' || hit.label === 'HRESULT/Win32');
    const severityToken = extractSeverityToken(line);
    const hasLogSeverity = /^(FATAL|CRITICAL|PANIC|SEVERE|ERROR|WARN)$/i.test(severityToken) || keywordHits.some(hit => /severity/.test(hit.label));
    const hasStackFrame = isStackTraceLine(line);
    const isSotiCode = /\bMCMR-\d+\b/i.test(line);

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
        isForensic: categories.length > 0 || hasStackFrame || isSotiCode || keywordHits.length > 0
    };
}

function scoreRootCauseCandidate(event) {
    let score = 0;
    if (event.hasException) score += 45;
    (event.categories || []).forEach(category => {
        const rule = LOG_SIGNAL_RULES.find(x => x.category === category);
        if (rule) score += rule.weight;
    });
    (event.keywordHits || getKeywordHits(event.text)).forEach(hit => { score += hit.score; });
    if (/\b(FATAL|CRITICAL|PANIC|SEVERE)\b/i.test(event.text)) score += 35;
    if (/\b(ERROR|ERR)\b/i.test(event.text)) score += 18;
    if (/\b(WARN|WARNING)\b/i.test(event.text)) score += 6;
    if (/\b(timeout|deadlock|login failed|cannot open database|certificate|access denied|connection refused|connection reset|unsupported|not supported|invalid object|schema|return value 3|1603)\b/i.test(event.text)) score += 18;
    if (isNegatedSignalLine(event.text) && !event.hasException) score -= 50;
    score += Math.max(0, 20 - Math.floor(event.lineNum / 5000)); // earlier failures are slightly more suspicious
    return score;
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
    if (categories.includes('SQL/Database') || /\b(sql server|sqlexception|system\.data\.sqlclient|microsoft\.data\.sqlclient|dbinstall)\b/i.test(text || "")) return "SQL Database";
    if (/\b(agent|ddr|device)\b/i.test(file)) return "Device/Agent";
    if (/\b(dse|ds|deployment)\b/i.test(file)) return "Deployment Server";
    if (/\b(ms|management)\b/i.test(file)) return "Management Service";
    if (/\b(identity|sso|auth)\b/i.test(file)) return "SOTI Identity";
    if (/\b(xsight|collector|telemetry)\b/i.test(file)) return "SOTI XSight";
    if (/\b(connect|connector|gateway)\b/i.test(file)) return "SOTI Connect";
    if (/\b(identity|saml|oidc|oauth|ldap|token|federation|sso)\b/i.test(source)) return "SOTI Identity";
    if (/\b(xsight|collector|elastic|telemetry|analytics)\b/i.test(source)) return "SOTI XSight";
    if (/\b(connect service|mqtt|iot|printer|gateway|connector)\b/i.test(source)) return "SOTI Connect";
    if (/\b(dse|ds extension|deployment server|deploymentservice|deployment service|ds\.log|dserver)\b/i.test(source)) return "Deployment Server";
    if (/\b(agent|device agent|ddr|device debug|check-in|check in|heartbeat|enrollment|enrolment)\b/i.test(source)) return "Device/Agent";
    if (/\b(ms\.log|management service|managementservice|mobicontrol\.management|soti management)\b/i.test(source)) return "Management Service";
    if (/\b(web console|console|api)\b/i.test(source)) return "Management Service";
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
        while ((m = p.exec(text || "")) !== null) addCandidate(m[1]);
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
        const m = (text || "").match(p);
        if (m) return m[1].trim();
    }
    return "";
}

function extractMachineName(text) {
    const patterns = [
        /\b(?:ComputerName|MachineName|Server Name|Hostname|Host)\s*[:=]\s*([A-Za-z0-9_.-]+)/i,
        /\bServer\s+`?([A-Z0-9_.-]{4,})`?/i
    ];
    for (const p of patterns) {
        const m = (text || "").match(p);
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
            classification: "First actionable SQL authentication/database-access failure",
            phase: "Validation / previous configuration discovery",
            score: 95
        };
    }
    if (/serviceInstanceDnses|service instance dns|existing service instances/i.test(text) && /\b(failed|error|exception|cannot|unable)\b/i.test(text)) {
        return {
            ...base,
            classification: "Repeated SQL/configuration discovery failure",
            phase: "Validation / previous configuration discovery",
            score: 80
        };
    }
    if (/ALTER DATABASE statement is not supported|SET RECOVERY SIMPLE|Setting Recovery mode to SIMPLE/i.test(text)) {
        return {
            ...base,
            classification: "Fatal SQL migration incompatibility",
            phase: "Database deployment / migration",
            score: 220
        };
    }
    if (/DeploymentEngine.*SQL exception|DbUp|PerformUpgrade|Upgrade failed due to unexpected exception/i.test(text)) {
        return {
            ...base,
            classification: "Fatal database upgrade/deployment failure",
            phase: "DbUp migration execution",
            score: 190
        };
    }
    if (/CustomAction|Deploy[A-Za-z]*Database/i.test(text) && /\b(exception|failed|error|1603|return value 3)\b/i.test(text)) {
        return {
            ...base,
            classification: "Fatal installer custom action failure",
            phase: "MSI custom action",
            score: 180
        };
    }
    if (/Return 1603|returning 1603|error code 1603|Fatal error|Return value 3|Installation failed|rollback/i.test(text)) {
        return {
            ...base,
            classification: "Installer abort / rollback result",
            phase: "MSI rollback",
            score: 130
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

function installerEventToMarkdown(e) {
    const text = e.text || "";
    if (/Cannot open database|Login failed/i.test(text)) {
        const msg = text.match(/(?:SqlException:\s*)?(Cannot open database.+?Login failed[^.]*\.?)/i);
        return `First error: \`${msg ? msg[1] : truncateLogLine(text, 220)}\``;
    }
    if (/serviceInstanceDnses|service instance dns|existing service instances/i.test(text)) {
        return `Repeated SQL/configuration read failure while reading \`serviceInstanceDnses\` or existing service state.`;
    }
    if (/DeploymentEngine.*SQL exception|script .*ALTER DATABASE|InitialMigration/i.test(text)) {
        return `\`${truncateLogLine(text, 260)}\``;
    }
    if (/Upgrade failed due to unexpected exception|PerformUpgrade|DbUp/i.test(text)) {
        return `\`${truncateLogLine(text, 260)}\``;
    }
    if (/CustomAction|Deploy[A-Za-z]*Database/i.test(text)) {
        return `Custom action \`${(text.match(/Deploy[A-Za-z]*Database/i) || ["database deployment"])[0]}\` throws/returns failure - installation aborts.`;
    }
    if (/FQDN.*incorrect|validation.*(?:failed|warning)|could not validate/i.test(text)) {
        return `Validation warning: \`${truncateLogLine(text, 220)}\``;
    }
    if (/Return 1603|error code 1603|Return value 3|rollback/i.test(text)) {
        return `Installer rollback/fatal result: \`${truncateLogLine(text, 220)}\``;
    }
    return `\`${truncateLogLine(text, 260)}\``;
}

function findInstallerLine(lines, regex, startIndex = 0) {
    for (let i = Math.max(0, startIndex); i < lines.length; i++) {
        if (regex.test(lines[i] || "")) return i;
    }
    return -1;
}

function extractNearbyInstallerTimestamp(lines, idx, windowSize = 5) {
    if (!lines || idx < 0) return "";
    const own = extractLogTimestamp(lines[idx] || "");
    if (own) return own;

    for (let offset = 1; offset <= windowSize; offset++) {
        const prev = idx - offset;
        if (prev >= 0) {
            const ts = extractLogTimestamp(lines[prev] || "");
            if (ts) return ts;
        }
    }
    for (let offset = 1; offset <= Math.min(2, windowSize); offset++) {
        const next = idx + offset;
        if (next < lines.length) {
            const ts = extractLogTimestamp(lines[next] || "");
            if (ts) return ts;
        }
    }
    return "";
}

function getInstallerEventBlock(lines, idx, maxLines = 6) {
    if (idx < 0 || idx >= lines.length) return "";
    const block = [lines[idx]];
    for (let j = idx + 1; j < Math.min(lines.length, idx + maxLines); j++) {
        const line = lines[j] || "";
        if (/^MSI \([^)]+\).*\[\d{1,2}:\d{2}:\d{2}/.test(line) && block.length > 1) break;
        if (maxLines <= 8 && /^\s+at\s+/.test(line) && block.length >= 2) break;
        block.push(line);
        if (/Login failed for user|Setting Recovery mode to SIMPLE|Return value 3|returning 1603/i.test(line)) break;
    }
    return block.join("\n").trim();
}

function getInstallerLoginSummary(text) {
    const db = ((text || "").match(/Cannot open database\s+"([^"]+)"/i) || [])[1] || "requested database";
    const user = ((text || "").match(/Login failed for user\s+'([^']+)'/i) || [])[1] || "SQL user";
    return { db, user };
}

function installerOneLine(text, max = 220) {
    return truncateLogLine((text || "").replace(/\s+/g, " ").trim(), max);
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

function buildAuthoritativeInstallerReport(logs) {
    if (!logs || logs.length === 0) return "";

    const contexts = [];
    logs.forEach(log => {
        const name = log.name || "Unknown log";
        const content = log.content || "";
        const likelyInstaller = /\b(SetupSOTI|MSI|Windows Installer|CustomAction|Return 1603|Return value 3|Deploy[A-Za-z]*Database|DbUp|DeploymentEngine|PerformUpgrade|Verbose logging started)\b/i.test(`${name}\n${content}`);
        if (!likelyInstaller) return;

        const lines = content.split('\n');
        const base = extractInstallerBaseDate(content);
        const product = inferProductFromLogName(name, content) || "SOTI installer";
        const sqlTarget = extractSqlTarget(content);
        const machine = extractMachineName(content);
        const azureSql = /\.database\.windows\.net\b/i.test(sqlTarget || content);
        const returnCode = /\b(?:MainEngineThread is returning|Back from server\. Return value:|Return(?:ed)?(?:\s+code)?|error code)\s*[:=]?\s*(1603|\d{3,5})\b/i.test(content)
            ? ((content.match(/\bMainEngineThread is returning\s+(1603|\d{3,5})\b/i) || content.match(/\bBack from server\. Return value:\s*(1603|\d{3,5})\b/i) || content.match(/\b(?:Return(?:ed)?(?:\s+code)?|error code)\s*[:=]?\s*(1603|\d{3,5})\b/i) || [])[1] || "")
            : "";

        const loginIdx = findInstallerLine(lines, /Cannot open database\s+"[^"]+".*requested by the login|Login failed for user/i);
        const dnsIdx = findInstallerLine(lines, /serviceInstanceDnses.*SqlException|serviceInstanceDnses.*Cannot open database/i);
        const fqdnIdx = findInstallerLine(lines, /Location Service FQDN .* is incorrect|GetFqdnValidator Validation Msg/i);
        const scriptExceptionIdx = findInstallerLine(lines, /SQL exception has occurred in script:.*InitialMigration/i);
        const scriptStartIdx = findInstallerLine(lines, /Executing Database Server script .*InitialMigration/i);
        const scriptIdx = scriptExceptionIdx >= 0 ? scriptExceptionIdx : scriptStartIdx;
        const alterIdx = findInstallerLine(lines, /This ALTER DATABASE statement is not supported|Setting Recovery mode to SIMPLE/i, scriptIdx >= 0 ? scriptIdx : 0);
        const upgradeIdx = findInstallerLine(lines, /Upgrade failed due to an unexpected exception|Upgrade failed due to unexpected exception|DbUp\.Engine\.UpgradeEngine\.PerformUpgrade/i, alterIdx >= 0 ? alterIdx : 0);
        const customActionIdx = findInstallerLine(lines, /An error occurred during Location Service database deployment|DeployLocationServiceDatabase\(Session session\)|CustomAction DeployLocationServiceDatabase.*(?:failed|error|1603)/i, alterIdx >= 0 ? alterIdx : 0);
        const abortIdx = findInstallerLine(lines, /MainEngineThread is returning 1603|Back from server\. Return value: 1603|Action ended .*ExecuteAction\. Return value 3/i, customActionIdx >= 0 ? customActionIdx : 0);

        const hasAuthoritativeRoot = alterIdx >= 0 && /ALTER DATABASE|RECOVERY SIMPLE/i.test(getInstallerEventBlock(lines, alterIdx, 5));
        if (!hasAuthoritativeRoot && loginIdx < 0 && customActionIdx < 0 && abortIdx < 0) return;

        contexts.push({
            name,
            lines,
            base,
            product,
            sqlTarget,
            machine,
            azureSql,
            returnCode,
            loginIdx,
            dnsIdx,
            fqdnIdx,
            scriptIdx,
            alterIdx,
            upgradeIdx,
            customActionIdx,
            abortIdx,
            hasAuthoritativeRoot
        });
    });

    if (contexts.length === 0) return "";
    const ctx = contexts.sort((a, b) => (b.hasAuthoritativeRoot ? 1 : 0) - (a.hasAuthoritativeRoot ? 1 : 0))[0];
    const lineAt = idx => idx >= 0 ? ctx.lines[idx] || "" : "";
    const tsAt = idx => formatInstallerTime(extractNearbyInstallerTimestamp(ctx.lines, idx));
    const fullTsAt = idx => combineInstallerDateTime(ctx.base.date, extractNearbyInstallerTimestamp(ctx.lines, idx));
    const start = ctx.base.date && ctx.base.startTime ? `${ctx.base.date} ${ctx.base.startTime}` : fullTsAt(0);
    const endIdx = ctx.abortIdx >= 0 ? ctx.abortIdx : ctx.lines.length - 1;
    const end = fullTsAt(endIdx) || combineInstallerDateTime(ctx.base.date, extractLogTimestamp(lineAt(endIdx)));

    const loginBlock = getInstallerEventBlock(ctx.lines, ctx.loginIdx, 5);
    const dnsBlock = getInstallerEventBlock(ctx.lines, ctx.dnsIdx, 5);
    const fqdnBlock = getInstallerEventBlock(ctx.lines, ctx.fqdnIdx, 3);
    const scriptBlock = getInstallerEventBlock(ctx.lines, ctx.scriptIdx, 8);
    const alterBlock = getInstallerEventBlock(ctx.lines, ctx.alterIdx, 8);
    const upgradeBlock = getInstallerEventBlock(ctx.lines, ctx.upgradeIdx, 18);
    const customActionBlock = getInstallerEventBlock(ctx.lines, ctx.customActionIdx, 18);
    const abortBlock = getInstallerEventBlock(ctx.lines, ctx.abortIdx, 2);
    const login = getInstallerLoginSummary(loginBlock || dnsBlock);
    const fatalSqlDetails = extractSqlErrorMetadata(`${scriptBlock}\n${alterBlock}\n${upgradeBlock}\n${customActionBlock}`);
    const stackSummary = extractStackOriginSummary(`${upgradeBlock}\n${customActionBlock}`);

    const rows = [];
    const addRow = (idx, event) => {
        if (idx >= 0 && event && !rows.some(row => row.idx === idx && row.event === event)) {
            rows.push({ idx, event });
        }
    };

    addRow(ctx.loginIdx, `First SQL access error: \`${installerOneLine(loginBlock, 260)}\``);
    addRow(ctx.dnsIdx, `Repeated SQL/configuration read failure while reading \`serviceInstanceDnses\`: \`${installerOneLine(dnsBlock, 240)}\``);
    addRow(ctx.fqdnIdx, `Validation warning: \`${installerOneLine(fqdnBlock, 220)}\``);
    addRow(ctx.scriptIdx >= 0 ? ctx.scriptIdx : ctx.alterIdx, `Database migration script fails: \`${installerOneLine(scriptBlock || alterBlock, 280)}\``);
    addRow(ctx.alterIdx, `Unsupported SQL operation: \`${installerOneLine(alterBlock, 260)}\``);
    addRow(ctx.upgradeIdx, `DbUp upgrade failure: \`${installerOneLine(upgradeBlock, 260)}\``);
    addRow(ctx.customActionIdx, `Custom action \`DeployLocationServiceDatabase\` throws the same \`SqlException\` and cannot complete.`);
    addRow(ctx.abortIdx, `MSI abort/rollback result: \`${installerOneLine(abortBlock, 220)}\``);

    rows.sort((a, b) => a.idx - b.idx);

    let md = `## Forensic Analysis: ${ctx.product} Installation Failure\n`;
    md += `Log Source: \`${ctx.name}\`\n`;
    if (start) md += `Install Start: ${start}\n`;
    if (end) md += `Install End: ${end}${ctx.returnCode ? ` (Return ${ctx.returnCode}${ctx.returnCode === "1603" ? " - Fatal Error" : ""})` : ""}\n`;
    const env = [];
    if (ctx.machine) env.push(`Server \`${ctx.machine}\``);
    if (ctx.sqlTarget) env.push(`SQL target \`${ctx.sqlTarget}\`${ctx.azureSql ? " (Azure SQL Database)" : ""}`);
    if (env.length > 0) md += `Environment: ${env.join(', ')}\n`;

    md += `\n### 1. Chronological Triage - First Failure Point\n`;
    md += `| Timestamp (HH:MM:SS.mmm) | Log Line | Event |\n`;
    md += `|---|---|---|\n`;
    rows.forEach(row => {
        md += `| ${tsAt(row.idx)} | Line ${row.idx + 1} | ${row.event} |\n`;
    });

    if (ctx.loginIdx >= 0) {
        md += `The first actionable failure is the SQL login/database access failure at ${tsAt(ctx.loginIdx)} (Line ${ctx.loginIdx + 1}), but it does not stop the installer because later deployment actions continue.\n`;
    }
    if (ctx.alterIdx >= 0) {
        md += `The first deployment failure that causes abortion is the unsupported ALTER DATABASE migration error at ${tsAt(ctx.alterIdx)} (Line ${ctx.alterIdx + 1}).\n`;
    } else if (ctx.customActionIdx >= 0) {
        md += `The first deployment failure that causes abortion is the database deployment custom action at ${tsAt(ctx.customActionIdx)} (Line ${ctx.customActionIdx + 1}).\n`;
    }

    md += `\n### 2. Evidence Detail - Raw Log Anchors\n`;
    const evidenceRows = [
        ["SQL access/prerequisite failure", ctx.loginIdx, installerEvidenceWindow(ctx.lines, ctx.loginIdx, 1, 4)],
        ["Repeated Location Service state read failure", ctx.dnsIdx, installerEvidenceWindow(ctx.lines, ctx.dnsIdx, 1, 4)],
        ["Migration script execution/failure", ctx.scriptIdx >= 0 ? ctx.scriptIdx : ctx.alterIdx, installerEvidenceWindow(ctx.lines, ctx.scriptIdx >= 0 ? ctx.scriptIdx : ctx.alterIdx, 2, 8)],
        ["DbUp upgrade failure", ctx.upgradeIdx, installerEvidenceWindow(ctx.lines, ctx.upgradeIdx, 2, 12)],
        ["Custom action failure", ctx.customActionIdx, installerEvidenceWindow(ctx.lines, ctx.customActionIdx, 2, 12)],
        ["MSI rollback/return code", ctx.abortIdx, installerEvidenceWindow(ctx.lines, ctx.abortIdx, 2, 3)]
    ].filter(row => row[1] >= 0 && row[2]);
    evidenceRows.forEach(([title, idx, block]) => {
        md += `\n#### ${title} - Line ${idx + 1}, ${tsAt(idx)}\n`;
        md += "```text\n" + block + "\n```\n";
    });
    if (fatalSqlDetails.length > 0) {
        md += `SQL metadata: ${fatalSqlDetails.join('; ')}.\n`;
    }
    if (stackSummary) {
        md += "Stack origin summary:\n```text\n" + stackSummary + "\n```\n";
    }

    md += `\n### 3. Propagation Path - The Domino Effect\n`;
    const steps = [];
    if (ctx.loginIdx >= 0) steps.push(`${tsAt(ctx.loginIdx)} Line ${ctx.loginIdx + 1}: SQL authentication/database access failure (${login.user} cannot open ${login.db})`);
    if (ctx.dnsIdx >= 0) steps.push(`${tsAt(ctx.dnsIdx)} Line ${ctx.dnsIdx + 1}: Installer validation/configuration discovery cannot read existing Location Service database state (non-fatal; setup continues)`);
    if (ctx.fqdnIdx >= 0) steps.push(`${tsAt(ctx.fqdnIdx)} Line ${ctx.fqdnIdx + 1}: Location Service FQDN validation warning is recorded, but subsequent MSI actions continue`);
    if (ctx.scriptIdx >= 0) steps.push(`${tsAt(ctx.scriptIdx)} Line ${ctx.scriptIdx + 1}: DeployLocationServiceDatabase starts the Location Service database migration script`);
    if (ctx.alterIdx >= 0) steps.push(`${tsAt(ctx.alterIdx)} Line ${ctx.alterIdx + 1}: Migration script attempts unsupported ALTER DATABASE / SET RECOVERY SIMPLE logic`);
    if (ctx.azureSql && ctx.alterIdx >= 0) steps.push(`${tsAt(ctx.alterIdx)} Line ${ctx.alterIdx + 1}: Target is Azure SQL Database; Azure SQL does not allow changing the recovery model with ALTER DATABASE`);
    if (ctx.upgradeIdx >= 0) steps.push(`${tsAt(ctx.upgradeIdx)} Line ${ctx.upgradeIdx + 1}: SqlException propagates through DbUp.Engine.UpgradeEngine.PerformUpgrade()`);
    if (ctx.customActionIdx >= 0) steps.push(`${tsAt(ctx.customActionIdx)} Line ${ctx.customActionIdx + 1}: DeployLocationServiceDatabase custom action fails`);
    if (ctx.abortIdx >= 0) steps.push(`${tsAt(ctx.abortIdx)} Line ${ctx.abortIdx + 1}: MSI rolls back${ctx.returnCode ? ` (Return ${ctx.returnCode})` : ""}`);
    steps.forEach((step, idx) => {
        md += `[${idx + 1}] ${step}\n`;
        if (idx < steps.length - 1) md += `    ->\n`;
    });
    md += `- No cross-service MS -> DS -> Agent domino is proven by this installer log. This is a single-product XSight installation failure inside the Location Service database deployment workflow.\n`;
    md += `- \`XSFatalErrorDlg\` and \`CopyInstallationLog\` happen after the server install returns 1603, so they are post-failure UI/log-copy symptoms, not root causes.\n`;

    md += `\n### 4. Root Cause - Symptom vs. Source\n`;
    md += `| Finding | Classification |\n`;
    md += `|---|---|\n`;
    if (ctx.loginIdx >= 0) md += `| \`Cannot open database "${login.db}" / Login failed for user '${login.user}'\` | Symptom/prerequisite issue - the target database is missing or the login lacks access, but setup continues past validation. |\n`;
    if (ctx.fqdnIdx >= 0) md += `| \`Location Service FQDN ... is incorrect\` | Non-fatal validation warning in this log because later database deployment actions still execute. |\n`;
    if (ctx.alterIdx >= 0) md += `| \`ALTER DATABASE statement is not supported\` / \`Setting Recovery mode to SIMPLE\` | ROOT CAUSE - the migration script attempts an unsupported SQL operation${ctx.azureSql ? " against Azure SQL Database" : ""}. |\n`;
    if (ctx.abortIdx >= 0) md += `| \`Return ${ctx.returnCode || "1603"}\` / \`Return value 3\` / rollback | Final symptom of the failed database deployment custom action. |\n`;
    md += `| \`XSFatalErrorDlg\` / \`CopyInstallationLog\` | Post-failure UI and log collection actions; they occur after the abort and must not be ranked as root cause. |\n`;

    if (ctx.alterIdx >= 0 && ctx.azureSql) {
        md += `\nConclusion: The SQL target is Azure SQL Database (shown by the \`.database.windows.net\` SQL endpoint${ctx.sqlTarget ? ` \`${ctx.sqlTarget}\`` : ""}). The XSight Location Service database migration script attempts an \`ALTER DATABASE\` recovery-model operation (\`SET RECOVERY SIMPLE\`). Azure SQL Database does not support changing database recovery mode, so SQL Server raises error 5008, DbUp fails the migration, \`DeployLocationServiceDatabase\` fails, and the installer rolls back${ctx.returnCode ? ` with return ${ctx.returnCode}` : ""}.\n`;
        md += `Recommendation:\n`;
        md += `- Use a supported SQL Server instance for this Location Service database deployment, such as on-premises SQL Server or SQL Server on a VM, or obtain a patched XSight installer/migration script that removes or conditionalizes the unsupported \`ALTER DATABASE ... SET RECOVERY SIMPLE\` statement.\n`;
        md += `- Also resolve the earlier database access issue: ensure \`${login.user}\` can open \`${login.db}\` and has the required deployment permissions (for example db_owner where appropriate) if the database is pre-created or reused.\n`;
    } else {
        md += `\nConclusion: The aborting point is the database deployment custom action. Validate the exact SQL/database operation from the cited lines before applying remediation.\n`;
    }

    return md;
}

function buildInstallerMarkdownBlueprint(context) {
    const {
        product,
        sources,
        firstTimestamp,
        lastTimestamp,
        returnCode,
        machine,
        sqlTarget,
        azureSql,
        sorted,
        firstActionable,
        fatalRoot,
        loginEvent,
        validationWarning,
        alterEvent,
        abort
    } = context;

    const sourceText = (sources && sources.length > 0) ? sources.map(s => `\`${s}\``).join(', ') : '`Attached installer log`';
    let md = `\n\n--- INSTALLER FORENSIC FORMAT HINTS (validate against raw logs before using) ---\n`;
    md += `## Forensic Analysis: ${product || "SOTI Installer"} Installation Failure\n`;
    md += `Log Source: ${sourceText}\n`;
    if (firstTimestamp) md += `Install Start: ${firstTimestamp}\n`;
    if (lastTimestamp) md += `Install End: ${lastTimestamp}${returnCode ? ` (Return ${returnCode}${returnCode === "1603" ? " - Fatal Error" : ""})` : ""}\n`;
    const env = [];
    if (machine) env.push(`Server \`${machine}\``);
    if (sqlTarget) env.push(`SQL target \`${sqlTarget}\`${azureSql ? " (Azure SQL Database)" : ""}`);
    if (env.length > 0) md += `Environment: ${env.join(', ')}\n`;

    md += `\n### 1. Chronological Triage - First Failure Point\n`;
    md += `| Timestamp (HH:MM:SS.mmm) | Log Line | Event |\n`;
    md += `|---|---|---|\n`;
    const tableEvents = sorted
        .filter(e => /SQL|database|ALTER DATABASE|Upgrade failed|CustomAction|FQDN|1603|rollback|serviceInstance/i.test(`${e.classification} ${e.text}`))
        .slice(0, 12);
    tableEvents.forEach(e => {
        md += `| ${formatInstallerTime(e.timestamp)} | Line ${e.lineNum} | ${installerEventToMarkdown(e)} |\n`;
    });
    if (firstActionable) {
        md += `The first actionable failure is ${firstActionable.classification.toLowerCase()} at ${formatInstallerTime(firstActionable.timestamp)} (Line ${firstActionable.lineNum})`;
        if (loginEvent && fatalRoot && loginEvent !== fatalRoot) md += `, but it does not appear to stop the installer because later deployment actions continue.`;
        md += `\n`;
    }
    if (fatalRoot) {
        md += `The first deployment failure that causes abortion is ${fatalRoot.classification.toLowerCase()} at ${formatInstallerTime(fatalRoot.timestamp)} (Line ${fatalRoot.lineNum}).\n`;
    }

    md += `\n### 2. Propagation Path - The Domino Effect\n`;
    const steps = [];
    if (loginEvent) steps.push(`SQL authentication/database access failure (${truncateLogLine(loginEvent.text, 180)})`);
    if (loginEvent) steps.push(`Installer validation/configuration discovery cannot reliably read existing service or database state (non-fatal if setup continues)`);
    if (validationWarning) steps.push(`Validation warning observed (${truncateLogLine(validationWarning.text, 160)})`);
    if (alterEvent) steps.push(`Database deployment custom action runs migration script containing unsupported ALTER DATABASE / SET RECOVERY SIMPLE logic`);
    if (alterEvent && azureSql) steps.push(`Azure SQL Database target detected; Azure SQL does not support changing recovery model with ALTER DATABASE`);
    if (fatalRoot) steps.push(`SqlException/custom action failure propagates through DbUp/DeploymentEngine/installer execution`);
    if (abort) steps.push(`Installation rolls back${returnCode ? ` (Return ${returnCode})` : ""}`);
    if (steps.length === 0 && fatalRoot) steps.push(`Installer reaches fatal failure: ${truncateLogLine(fatalRoot.text, 180)}`);
    steps.forEach((step, idx) => {
        md += `[${idx + 1}] ${step}\n`;
        if (idx < steps.length - 1) md += `    ↓\n`;
    });
    md += `- If this is a single-product installer log, do not invent an MS -> DS -> Agent chain. Keep the domino path inside the installer/database deployment workflow unless cross-service logs prove otherwise.\n`;

    md += `\n### 3. Root Cause - Symptom vs. Source\n`;
    md += `| Finding | Classification |\n`;
    md += `|---|---|\n`;
    if (loginEvent) md += `| \`Cannot open database / Login failed\` | Symptom/prerequisite issue - important because credentials or database existence are wrong, but not necessarily the aborting root cause if setup continues. |\n`;
    if (validationWarning) md += `| \`Validation/FQDN warning\` | Inconsequential or non-fatal validation warning unless followed by a blocking custom action failure. |\n`;
    if (alterEvent) md += `| \`ALTER DATABASE statement is not supported\` | ROOT CAUSE - migration attempts an unsupported database operation${azureSql ? " against Azure SQL Database" : ""}. |\n`;
    if (abort) md += `| \`Return ${returnCode || "1603"} / rollback\` | Final symptom - installer rollback caused by earlier fatal custom action/database deployment failure. |\n`;

    if (alterEvent && azureSql) {
        md += `Conclusion: The target SQL Server is Azure SQL Database (indicated by the \`.database.windows.net\` FQDN). The installer/database migration attempts an \`ALTER DATABASE\` / recovery-model change such as \`SET RECOVERY SIMPLE\`, which Azure SQL Database does not support. This throws \`SqlException\`, the database deployment custom action fails, and the installation cannot proceed${returnCode ? ` (Return ${returnCode})` : ""}.\n`;
        md += `Recommendation:\n`;
        md += `- Use a supported SQL Server instance for this installer/database deployment, or obtain a patched installer/migration script that removes or conditionalizes the unsupported \`ALTER DATABASE\` statement.\n`;
        md += `- Resolve the earlier database access issue as well: ensure the SQL user has the required permissions (for example db_owner where appropriate) and the target database exists when the installer expects it.\n`;
    } else if (fatalRoot) {
        md += `Conclusion candidate: The aborting failure may be ${fatalRoot.classification} at Line ${fatalRoot.lineNum}. Validate this against the surrounding installer/custom-action lines before answering.\n`;
    }

    md += `--- END INSTALLER FORENSIC FORMAT HINTS ---\n`;
    return md;
}

function buildInstallerFailureAnalysis(logs) {
    if (!logs || logs.length === 0) return "";

    const events = [];
    const sources = [];
    let combined = "";
    let product = "";
    let sqlTarget = "";
    let machine = "";
    let firstTimestamp = "";
    let lastTimestamp = "";
    let returnCode = "";

    logs.forEach(log => {
        const name = log.name || "Unknown log";
        const content = log.content || "";
        combined += `\n${name}\n${content}`;
        const likelyInstaller = /\b(SetupSOTI|MSI|Windows Installer|CustomAction|Return 1603|Return value 3|Deploy[A-Za-z]*Database|DbUp|DeploymentEngine|PerformUpgrade)\b/i.test(`${name}\n${content}`);
        if (!likelyInstaller) return;

        sources.push(name);
        if (!product) product = inferProductFromLogName(name, content);
        if (!sqlTarget) sqlTarget = extractSqlTarget(content);
        if (!machine) machine = extractMachineName(content);

        const lines = content.split('\n');
        lines.forEach((line, idx) => {
            const ts = extractLogTimestamp(line);
            if (ts) {
                if (!firstTimestamp) firstTimestamp = ts;
                lastTimestamp = ts;
            }
            const rc = line.match(/\b(?:Return(?:ed)?(?:\s+code)?|error code)\s*[:=]?\s*(1603|\d{3,5})\b/i);
            if (rc) returnCode = rc[1];
            const event = getInstallerEvent(line, name, idx + 1);
            if (event) events.push(event);
        });
    });

    if (sources.length === 0 && !/\b(Return 1603|CustomAction|Deploy[A-Za-z]*Database|DbUp|ALTER DATABASE statement is not supported)\b/i.test(combined)) {
        return "";
    }

    if (!product) product = inferProductFromLogName(sources[0] || "", combined) || "SOTI installer";
    if (!sqlTarget) sqlTarget = extractSqlTarget(combined);
    if (!machine) machine = extractMachineName(combined);
    if (!returnCode && /\b1603\b/.test(combined)) returnCode = "1603";

    const azureSql = /\.database\.windows\.net\b/i.test(sqlTarget || combined);
    const sorted = events
        .filter(e => e.score >= 30)
        .sort((a, b) => a.sortTime - b.sortTime || a.lineNum - b.lineNum);
    const firstActionable = sorted.find(e => /SQL authentication|database-access|Validation warning|Fatal/i.test(e.classification)) || sorted[0];
    const fatalRoot = [...sorted].sort((a, b) => {
        const aFatal = /Fatal SQL migration|Fatal database upgrade|Fatal installer custom action/i.test(a.classification) ? 1000 : 0;
        const bFatal = /Fatal SQL migration|Fatal database upgrade|Fatal installer custom action/i.test(b.classification) ? 1000 : 0;
        return (bFatal + b.score) - (aFatal + a.score) || a.sortTime - b.sortTime;
    })[0];
    const abort = sorted.find(e => /abort|rollback|1603/i.test(e.classification));
    const alterEvent = sorted.find(e => /ALTER DATABASE|RECOVERY SIMPLE|migration incompatibility/i.test(e.text + " " + e.classification));
    const loginEvent = sorted.find(e => /Cannot open database|Login failed/i.test(e.text));
    const validationWarning = sorted.find(e => /FQDN|validation warning/i.test(e.text + " " + e.classification));
    const installerBlueprint = buildInstallerMarkdownBlueprint({
        product,
        sources,
        firstTimestamp,
        lastTimestamp,
        returnCode,
        machine,
        sqlTarget,
        azureSql,
        sorted,
        firstActionable,
        fatalRoot,
        loginEvent,
        validationWarning,
        alterEvent,
        abort
    });

    let report = `\n\n=== INSTALLER FAILURE INTELLIGENCE (setup/MSI-specific root-cause model) ===\n`;
    report += `Forensic title candidate: ${product}${returnCode ? ` installation failure (Return ${returnCode})` : " installation analysis"}\n`;
    report += `Log source(s): ${sources.join(', ') || logs.map(l => l.name).join(', ')}\n`;
    if (firstTimestamp) report += `Install/log start: ${firstTimestamp}\n`;
    if (lastTimestamp) report += `Install/log end: ${lastTimestamp}${returnCode ? ` (Return ${returnCode}${returnCode === "1603" ? " - Fatal Error" : ""})` : ""}\n`;
    const env = [];
    if (machine) env.push(`Server ${machine}`);
    if (sqlTarget) env.push(`SQL target ${sqlTarget}${azureSql ? " (Azure SQL Database detected)" : ""}`);
    if (env.length > 0) report += `Environment: ${env.join('; ')}\n`;

    if (sorted.length > 0) {
        report += `\n--- INSTALLER CHRONOLOGICAL TRIAGE ---\n`;
        report += `Timestamp | Location | Classification | Event\n`;
        sorted.slice(0, 30).forEach(e => {
            report += `${e.timestamp || "No timestamp"} | ${e.file}:Line ${e.lineNum} | ${e.classification} | ${truncateLogLine(e.text, 260)}\n`;
        });
    }

    if (firstActionable) {
        report += `\nFirst actionable failure: ${formatIncidentLocation({ file: firstActionable.file, line: firstActionable.lineNum, timestamp: firstActionable.timestamp })} - ${firstActionable.classification} - ${truncateLogLine(firstActionable.text, 300)}\n`;
    }
    if (fatalRoot) {
        report += `First deployment/aborting failure: ${formatIncidentLocation({ file: fatalRoot.file, line: fatalRoot.lineNum, timestamp: fatalRoot.timestamp })} - ${fatalRoot.classification} - ${truncateLogLine(fatalRoot.text, 300)}\n`;
    }

    report += `\n--- INSTALLER PROPAGATION PATH ---\n`;
    if (loginEvent) report += `[1] SQL authentication/database-access failure: ${loginEvent.file}:Line ${loginEvent.lineNum} - ${truncateLogLine(loginEvent.text, 220)}\n`;
    if (loginEvent) report += `[2] Installer validation/config discovery cannot reliably read existing database/service state; this may be non-fatal if setup continues.\n`;
    if (validationWarning) report += `[3] Validation warning observed: ${validationWarning.file}:Line ${validationWarning.lineNum} - ${truncateLogLine(validationWarning.text, 220)}\n`;
    if (alterEvent) report += `[4] Database deployment/migration reaches unsupported SQL statement: ${alterEvent.file}:Line ${alterEvent.lineNum} - ${truncateLogLine(alterEvent.text, 220)}\n`;
    if (alterEvent && azureSql) report += `[5] Azure SQL Database target detected; recovery-model ALTER DATABASE operations such as SET RECOVERY SIMPLE are not supported.\n`;
    if (fatalRoot && fatalRoot !== alterEvent) report += `[6] Fatal deployment/custom-action failure: ${fatalRoot.file}:Line ${fatalRoot.lineNum} - ${truncateLogLine(fatalRoot.text, 220)}\n`;
    if (abort) report += `[7] MSI abort/rollback result: ${abort.file}:Line ${abort.lineNum} - ${truncateLogLine(abort.text, 220)}\n`;
    if (!loginEvent && !alterEvent && fatalRoot) report += `[1] Fatal installer failure: ${fatalRoot.file}:Line ${fatalRoot.lineNum} - ${truncateLogLine(fatalRoot.text, 260)}\n`;

    report += `\n--- ROOT CAUSE VS SYMPTOM CLASSIFICATION ---\n`;
    if (loginEvent) report += `- Cannot open database / login failed: Symptom or prerequisite failure. Important, but not necessarily aborting if installer continues past validation.\n`;
    if (validationWarning) report += `- Validation/FQDN warning: Usually non-fatal unless followed by a blocking custom action failure.\n`;
    if (alterEvent) report += `- ALTER DATABASE statement unsupported: ROOT CAUSE candidate for installer abort, especially with Azure SQL Database targets.\n`;
    if (abort) report += `- Return ${returnCode || "1603"} / rollback: Final symptom of the failed custom action, not the underlying cause.\n`;

    if (alterEvent && azureSql) {
        report += `\nParser root-cause candidate: Azure SQL incompatibility. The installer/database migration appears to attempt an ALTER DATABASE/recovery-model operation that Azure SQL Database does not support, causing the database deployment custom action to fail and the installation to roll back${returnCode ? ` with return ${returnCode}` : ""}. Confirm this against the raw cited lines before making the final verdict.\n`;
        report += `Possible actions if confirmed: use a supported SQL Server instance for this database deployment, or obtain a patched installer/migration script that skips or conditionalizes the unsupported ALTER DATABASE/SET RECOVERY SIMPLE statement. Also resolve any earlier login/db_owner issue if the log shows Cannot open database for the target DB.\n`;
    } else if (fatalRoot) {
        report += `\nParser root-cause candidate: primary abort point is ${fatalRoot.classification} at ${fatalRoot.file}:Line ${fatalRoot.lineNum}. Validate this against the surrounding custom-action and SQL migration lines before final answer.\n`;
    }

    report += installerBlueprint;
    report += `Instruction: if this section exists, use the installer-specific format only when the attached logs are setup/MSI logs, and validate every conclusion against raw log evidence before answering.\n`;
    report += `=== END INSTALLER FAILURE INTELLIGENCE ===`;
    return report;
}

function isExceptionContinuationLine(line) {
    return isStackTraceLine(line)
        || /^\s*(---\s*End|Inner Exception|--->|HResult=|Source=|StackTrace:|Error Number:|Number:|Class:|State:|Procedure:|Server:|ClientConnectionId:|Data Source=|Initial Catalog=|TargetSite=|HelpLink=|SQLState=|ErrorCode=|NativeError=|Message=|Detail=|Reason=)/i.test(line)
        || /^\s+/.test(line)
        || /^\s*$/.test(line);
}

function extractExceptionBlocksFromLog(log) {
    const name = log.name || "Unknown log";
    const lines = (log.content || "").split('\n');
    const blocks = [];
    const consumed = new Set();

    for (let i = 0; i < lines.length; i++) {
        if (consumed.has(i)) continue;
        const line = lines[i];
        const intel = classifyLogLine(line);
        const startsBlock = intel.hasException
            || intel.categories.includes('SQL/Database')
            || intel.categories.includes('Installer/MSI')
            || intel.keywordHits.some(hit => hit.score >= 30)
            || /\b(Caused by:|Inner Exception|--->|Traceback \(most recent call last\))\b/i.test(line);
        if (!startsBlock) continue;

        const start = i;
        const blockLines = [line];
        consumed.add(i);

        for (let j = i + 1; j < Math.min(lines.length, start + 160); j++) {
            const next = lines[j];
            const nextIntel = classifyLogLine(next);
            const looksLikeNewEvent = extractLogTimestamp(next) && nextIntel.isForensic && !nextIntel.hasStackFrame && !/^\s/.test(next);
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
            timestamp: extractLogTimestamp(line),
            sortTime: parseLogTimestampForSort(extractLogTimestamp(line)),
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

function decodeLogBytes(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    if (bytes.length >= 2) {
        if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder("utf-16le").decode(bytes.slice(2));
        if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder("utf-16be").decode(bytes.slice(2));
    }
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        return new TextDecoder("utf-8").decode(bytes.slice(3));
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
    if (oddNulls > 20 && oddNulls > evenNulls * 3) return new TextDecoder("utf-16le").decode(bytes);
    if (evenNulls > 20 && evenNulls > oddNulls * 3) return new TextDecoder("utf-16be").decode(bytes);

    try {
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch (e) {
        return new TextDecoder("windows-1252").decode(bytes);
    }
}

function getLogPanelIntel(log) {
    if (!log) return null;
    const cacheKey = `${log.name || ""}:${(log.content || "").length}`;
    if (log.panelIntel && log.panelIntel.cacheKey === cacheKey) return log.panelIntel;

    const content = log.content || "";
    const lines = content ? content.split('\n') : [];
    const categories = {};
    const rootCandidates = [];
    const installerEvents = [];
    const signalSummary = createSignalSummary();
    let firstTimestamp = "";
    let lastTimestamp = "";
    let eventCount = 0;

    lines.forEach((line, idx) => {
        const timestamp = extractLogTimestamp(line);
        if (timestamp) {
            if (!firstTimestamp) firstTimestamp = timestamp;
            lastTimestamp = timestamp;
        }

        const intel = classifyLogLine(line);
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

        const installerEvent = getInstallerEvent(line, log.name || "Attached log", idx + 1);
        if (installerEvent && installerEvent.score >= 30) installerEvents.push(installerEvent);
    });

    rootCandidates.sort((a, b) => b.score - a.score || a.lineNum - b.lineNum);
    installerEvents.sort((a, b) => b.score - a.score || a.lineNum - b.lineNum);

    const topCategory = Object.entries(categories).sort((a, b) => b[1] - a[1])[0];
    const sqlTarget = extractSqlTarget(content);
    const azureSql = /\.database\.windows\.net\b/i.test(sqlTarget || content);
    const alterEvent = installerEvents.find(e => /ALTER DATABASE|RECOVERY SIMPLE|migration incompatibility/i.test(`${e.classification} ${e.text}`));
    const loginEvent = installerEvents.find(e => /Cannot open database|Login failed/i.test(e.text));
    const fatalInstallerEvent = installerEvents.find(e => /Fatal|abort|rollback|1603/i.test(e.classification));
    const topException = Array.from(signalSummary.exceptionMap.entries()).sort((a, b) => b[1].count - a[1].count)[0];

    let verdict = "Ready for forensic AI analysis";
    let confidence = eventCount > 0 ? "Evidence detected" : "No errors detected";
    let focusLine = rootCandidates[0] ? `Line ${rootCandidates[0].lineNum}` : "";

    if (alterEvent && azureSql) {
        verdict = "Likely root cause: Azure SQL unsupported ALTER DATABASE / recovery-model operation";
        confidence = "High confidence installer pattern";
        focusLine = `Line ${alterEvent.lineNum}`;
    } else if (fatalInstallerEvent) {
        verdict = `Installer abort candidate: ${fatalInstallerEvent.classification}`;
        confidence = "Installer failure detected";
        focusLine = `Line ${fatalInstallerEvent.lineNum}`;
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

function buildRawLogCoverage(content, lines, rankedRootCandidates, parsedBlocks) {
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

function buildCrossLogIncidentIndex(logs) {
    if (!logs || logs.length === 0) return "";

    const allEvents = [];
    const exceptionBlocks = [];
    const signatureMap = new Map();
    const categoryCounts = {};
    const signalSummary = createSignalSummary();
    const installerReport = buildInstallerFailureAnalysis(logs);
    let totalLines = 0;
    let totalChars = 0;

    logs.forEach(log => {
        const name = log.name || "Unknown log";
        const content = log.content || "";
        const lines = content.split('\n');
        totalLines += lines.length;
        totalChars += content.length;
        exceptionBlocks.push(...extractExceptionBlocksFromLog(log));

        lines.forEach((line, idx) => {
            const intel = classifyLogLine(line);
            updateSignalSummary(signalSummary, intel, line, idx + 1, name);
            if (!intel.isForensic || intel.hasStackFrame) return;

            const lineNum = idx + 1;
            const timestamp = extractLogTimestamp(line);
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
            intel.categories.forEach(cat => {
                categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
            });

            const sig = `${name}::${normalizeLogSignature(line)}`;
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
        });
    });

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
    const topBlock = rankedExceptionBlocks[0] || null;
    const topEvent = topRootCandidates[0] || null;
    const domino = buildDominoAnalysis(allEvents, exceptionBlocks);
    const deterministicRoot = domino.root ? {
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

    report += renderSignalSummary(signalSummary, "CROSS-LOG EXCEPTION / ERROR KEYWORD SWEEP");

    if (installerReport) {
        report += installerReport;
    }

    if (domino.report) {
        report += domino.report;
    }

    if (deterministicRoot) {
        report += `\n--- DETERMINISTIC ROOT-CAUSE HYPOTHESIS (must validate, not blindly accept) ---\n`;
        report += `Source: ${deterministicRoot.source}\n`;
        report += `Location: ${deterministicRoot.file}:Line ${deterministicRoot.line}${deterministicRoot.timestamp ? ` @ ${deterministicRoot.timestamp}` : ""}\n`;
        report += `Score: ${deterministicRoot.score}; Component: ${deterministicRoot.component || "Unknown Component"}; Failure kind: ${deterministicRoot.failureKind || "Forensic event"}; Categories: ${deterministicRoot.categories.join(', ') || 'Unclassified'}\n`;
        if (deterministicRoot.innermost) report += `Innermost exception: ${deterministicRoot.innermost}\n`;
        if (deterministicRoot.sql) report += `SQL diagnosis: ${deterministicRoot.sql.type}\n`;
        report += `Evidence: ${deterministicRoot.text}\n`;
        report += `Instruction: final answer must either confirm this as root cause with evidence or explicitly explain why an earlier/stronger event supersedes it.\n`;
    }

    report += `\n--- PRIMARY ROOT-CAUSE CANDIDATES ACROSS ALL LOGS ---\n`;
    topRootCandidates.forEach((event, idx) => {
        report += `${idx + 1}. ${event.file}:Line ${event.lineNum}${event.timestamp ? ` @ ${event.timestamp}` : ""} [score ${event.score}; ${event.categories.join(', ') || 'Unclassified'}] ${event.text}\n`;
    });

    if (rankedExceptionBlocks.length > 0) {
        report += `\n--- EXCEPTION CHAIN INTELLIGENCE (parsed blocks, ranked) ---\n`;
        rankedExceptionBlocks.forEach((block, idx) => {
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
        });
    }

    if (sqlEvents.length > 0 || sqlExceptionBlocks.length > 0) {
        report += `\n--- SQL/DATABASE EVENTS REQUIRING EXPLICIT DIAGNOSIS ---\n`;
        sqlExceptionBlocks.forEach((block, idx) => {
            report += `Block ${idx + 1}. ${block.file}:Lines ${block.startLine}-${block.endLine}${block.timestamp ? ` @ ${block.timestamp}` : ""} [${block.sql.type}; score ${block.score}] ${block.message}\n`;
        });
        sqlEvents.forEach((event, idx) => {
            report += `Event ${idx + 1}. ${event.file}:Line ${event.lineNum}${event.timestamp ? ` @ ${event.timestamp}` : ""} [score ${event.score}] ${event.text}\n`;
        });
    } else {
        report += `\n--- SQL/DATABASE EVENTS ---\nNo SQL/database exception signatures were detected across the uploaded logs.\n`;
    }

    report += `\n--- EARLIEST FORENSIC EVENTS (MASTER TIMELINE START) ---\n`;
    earliest.forEach(event => {
        report += `${event.timestamp || "No timestamp"} | ${event.file}:Line ${event.lineNum} | ${event.categories.join(', ') || 'Unclassified'} | ${event.text}\n`;
    });

    report += `\n--- MOST REPEATED DISTINCT FAILURES ACROSS LOGS ---\n`;
    distinctFailures.forEach(sig => {
        report += `- ${sig.count}x | ${sig.file}:Lines ${sig.firstLine}-${sig.lastLine}${sig.firstTimestamp ? ` | First ${sig.firstTimestamp}` : ""}${sig.lastTimestamp && sig.lastTimestamp !== sig.firstTimestamp ? ` | Last ${sig.lastTimestamp}` : ""} | ${sig.categories.join(', ') || 'Unclassified'} | ${sig.sample}\n`;
    });

    report += `\nAI instruction: use this cross-log index as the master incident map. The CAUSAL DOMINO ANALYSIS is the preferred propagation path because it is scored using SOTI architecture dependencies, timestamp proximity, exception depth, and downstream-symptom penalties. Validate the chosen root against the earliest timeline, SQL section, and parsed exception chains before stating root cause.\n`;
    report += `=== END CROSS-LOG INCIDENT INDEX ===`;
    return report;
}

function getSmartLogSnippet(content, limit = 300000, fileName = "Attached log") {
    if (!content) return "";

    const lines = content.split('\n');
    const totalLines = lines.length;
    const parsedBlocks = extractExceptionBlocksFromLog({ name: fileName, content });
    const installerReport = buildInstallerFailureAnalysis([{ name: fileName, content }]);

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

    for (let i = 0; i < totalLines; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        const intel = classifyLogLine(line);
        const isForensic = intel.isForensic;
        updateSignalSummary(signalSummary, intel, line, i + 1, fileName);

        // Track error type for summary
        if (isForensic && !intel.hasStackFrame) {
            intel.categories.forEach(cat => { errorTypeCounts[cat] = (errorTypeCounts[cat] || 0) + 1; });
            if (firstErrorLine === null) firstErrorLine = i + 1;
            lastErrorLine = i + 1;

            const sig = normalizeLogSignature(line);
            if (sig.length > 8) {
                const existing = signatureMap.get(sig) || {
                    signature: sig,
                    count: 0,
                    firstLine: i + 1,
                    lastLine: i + 1,
                    firstTimestamp: extractLogTimestamp(line),
                    lastTimestamp: extractLogTimestamp(line),
                    categories: new Set(),
                    sample: line.trim()
                };
                existing.count++;
                existing.lastLine = i + 1;
                existing.lastTimestamp = extractLogTimestamp(line) || existing.lastTimestamp;
                intel.categories.forEach(c => existing.categories.add(c));
                signatureMap.set(sig, existing);
            }

            rootCandidates.push({
                lineNum: i + 1,
                timestamp: extractLogTimestamp(line),
                sortTime: parseLogTimestampForSort(extractLogTimestamp(line)),
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
            topSignatures.forEach(sig => {
                forensicReport += `- ${sig.count}x | Lines ${sig.firstLine}-${sig.lastLine}${sig.firstTimestamp ? ` | First ${sig.firstTimestamp}` : ""}${sig.lastTimestamp && sig.lastTimestamp !== sig.firstTimestamp ? ` | Last ${sig.lastTimestamp}` : ""} | ${sig.categories.join(', ') || 'Unclassified'} | ${sig.sample}\n`;
            });
            forensicReport += `--- END DISTINCT FAILURE SIGNATURES ---\n`;
        }

        forensicReport += `\n--- CHRONOLOGICAL FORENSIC TIMELINE (line-preserving extract from whole log) ---\n`;
        
        let lastLineNum = -10;
        compressedEntries.forEach(entry => {
            if (entry.lineNum - lastLineNum > 1) {
                forensicReport += `\n[Line ${entry.lineNum}]\n`;
            }
            forensicReport += `${entry.text}\n`;
            lastLineNum = entry.lineNum;
        });
        forensicReport += `--- END CHRONOLOGICAL FORENSIC TIMELINE ---`;
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
    // For large files, include raw head/middle/tail plus windows around the highest-risk incidents.
    return `${forensicReport}${buildRawLogCoverage(content, lines, rankedRootCandidates, parsedBlocks)}`;
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
    // Zero scrubbing for Local AI - private on-device execution does not require data redaction.
    return s;
}

function getLeanQAPrompt() {
    return `You are a Senior SOTI Technical Architect with 100% accuracy on the SOTI ONE Platform.

CRITICAL: You have been given LIVE DATA in this prompt. USE IT. The sections [MC VERSIONS], [AGENT VERSIONS], [IDENTITY VERSIONS], [RELEASE NOTES], [PULSE SEARCH], [DOCS SEARCH], and [DEEP RESEARCH] contain REAL, UP-TO-DATE information fetched from SOTI Pulse and SOTI Docs right now. You MUST use this data to answer questions. Do not rely on memorized or generic IT knowledge when live sections contain the answer.

RULES YOU MUST FOLLOW:
1. NEVER tell the user to "check the SOTI website", "visit support.soti.com", "check Pulse", or "contact support". YOU already have the data. Just answer directly.
2. LATEST VERSION QUERIES: When asked "what is the latest version" of any SOTI product, use the relevant version list internally and answer directly in plain language, e.g. "The latest Android Agent version is 2026.1.0." Do NOT mention internal prompt section names such as [MC VERSIONS], [AGENT VERSIONS], [IDENTITY VERSIONS], [CASE], [RELEASE NOTES], [PULSE SEARCH], or [DEEP RESEARCH]. Do NOT confuse version numbers found in case context (the customer's currently installed version) with the latest available release.
3. TROUBLESHOOTING WITH VERSIONS: When troubleshooting, use the customer's version from [CASE] to compare against [RELEASE NOTES]. If the customer's issue matches a fix in a newer version, recommend upgrading and cite the specific version and MCMR code.
4. When asked about release notes or what's new for a SPECIFIC version (e.g. 2026.1.0): use ONLY the blocks labeled ### VERSION 2026.1.0 in [RELEASE NOTES]. NEVER mix in fixes/highlights from a different version. If Highlights are empty but Resolved Issues exist for that version, present the resolved issues — do not claim the version has no information. If there is truly no ### VERSION block for the requested version, say you do not have that version's Pulse notes. NEVER tell the user to check [DEEP RESEARCH], [DOCS SEARCH], or any internal prompt label.
5. When asked about features, configuration, or troubleshooting: use [DEEP RESEARCH], [PULSE SEARCH], [DOCS SEARCH], and [RELEASE NOTES] first. Only state facts that appear in those sections or in attached logs.
6. NEVER guess with generic IT knowledge. Only use SOTI-specific information from this prompt.
7. NEVER say "based on my knowledge cutoff" — you have live data in this prompt.
8. NEVER expose internal prompt/source labels to the user. Use natural phrasing like "The latest version is..." instead of "According to [AGENT VERSIONS]...".
9. If [ISSUE SUMMARY] is empty but [CASE] meeting_notes has content, treat meeting_notes as the authoritative issue description (especially the Summary and Next steps sections).
10. When asked for a short subject/title/name for a case, produce one concise line (about 6–12 words) from the case facts, e.g. "Certificate retrieval failure blocking device API calls" — not a generic label like "Critical SOTI MobiControl Issue Investigation".

VERSIONING (always apply):
- MobiControl Console/Server: 202X.0.x | Android Agent / SOTI Identity: 202X.1.x
- Middle digit 0 = Console; middle digit 1 = Agent or Identity (use product context to distinguish)
- Web Console is hosted inside SOTI Management Service (NEVER mention IIS or a separate web hosting service)
- Core topology: Management Service <-> SQL <-> Deployment Server <-> Device Agent | Ports: 5494, 13131, 2197, 443`;
}

function getLeanLogPrompt() {
    return `You are the world's best SOTI Log Forensics Engineer — a Level 3 Escalation specialist. Your SOLE mission is to find the EXACT root cause from the log data. You NEVER guess, generalize, or skip evidence.

The log data has three sections:
1. === CROSS-LOG INCIDENT INDEX === — a whole-dataset scan across ALL attached logs. It includes the master timeline start, CROSS-LOG EXCEPTION / ERROR KEYWORD SWEEP, INSTALLER FAILURE INTELLIGENCE when setup/MSI logs are detected, CAUSAL DOMINO ANALYSIS, deterministic root-cause hypothesis, parsed exception-chain intelligence, cross-log root-cause candidates, repeated failures, category counts, and SQL/database events requiring explicit diagnosis.
2. === FORENSIC INCIDENT REPORT === — a per-file whole-log scan that inspected every line and extracted every detected exception, error, stack trace, inner exception chain, warning, SQL/database issue, certificate/TLS issue, auth failure, service event, memory/thread issue, installer/MSI failure, and network/HTTP failure. The ERROR CATEGORY BREAKDOWN, FILE EXCEPTION / ERROR KEYWORD SWEEP, ROOT-CAUSE CANDIDATE RANKING, FILE-LEVEL CAUSAL / DOMINO MODEL, INSTALLER FAILURE INTELLIGENCE, WHOLE-LOG COVERAGE MAP, PARSED EXCEPTION / SQL BLOCKS, and DISTINCT FAILURE SIGNATURES are computed from the ENTIRE log file, not only the head/tail snippets.
3. [LOG HEAD] — startup config, environment, service initialization. Check for misconfiguration here.
4. [LOG MIDDLE SAMPLES] — raw middle sections sampled from 25%, 50%, and 75% through large files. Use this to verify failures that occur away from startup/tail.
5. [INCIDENT-CENTERED RAW WINDOWS] — raw lines around the highest-risk forensic events and parsed exception blocks.
6. [LOG TAIL] — most recent raw activity. The user's symptom usually manifests here.

YOU MUST START WITH THE CROSS-LOG INCIDENT INDEX. Use it to build one master timeline across all attached files before reading the per-file reports.
If a [DETERMINISTIC INSTALLER ROOT-CAUSE REPORT] section is present, it was generated from exact line-numbered installer evidence and is the controlling evidence for setup/MSI failures. Use it as the primary installer answer, then cite/validate the raw log lines around the same events. Do not invent a different cause unless you can cite an earlier, stronger raw log line.
If INSTALLER FAILURE INTELLIGENCE is present, treat it as parser-generated evidence to validate against the raw log lines. Do not copy it blindly, and do not replace an earlier causal event with later post-failure UI/log-copy actions such as fatal dialogs or CopyInstallationLog.
YOU MUST READ THE EXCEPTION / ERROR KEYWORD SWEEP. It is the deterministic sweep for Exception classes, ERROR/WARN/FATAL/CRITICAL tokens, HRESULT/Win32 codes, return codes, explicit failure words, unsupported operations, denied/refused/missing/invalid keywords, and top high-signal lines. Any root-cause verdict that ignores this sweep is invalid.
HALLUCINATION BLOCKLIST: Never claim missing dependencies, corrupted registry entries, implicit deadlocks, network disconnects, timeout code 4214, log-path-change causality, reboot actions, or HRESULT/Win32 root causes unless the attached raw log lines explicitly show those exact facts. If the deterministic installer report cites SQL lines, SQL wins over generic installer/Windows-error guesses.
TIMESTAMP PRECISION: Preserve milliseconds whenever present. MSI timestamps like \`19:13:57:009\` must be normalized and shown as \`19:13:57.009\` in every timeline, propagation path, root-cause verdict, and evidence citation.
STRICT FAILURE-SIGNAL LADDER: prioritize FATAL/CRITICAL/PANIC/SEVERE, then exception chains with innermost causes, then SQL/certificate/authentication/permission failures, then ERROR/non-zero return codes, then WARN. INFO lines are context only unless they directly identify the failing operation. Lines saying "0 errors", "no errors", or "completed successfully" are not failures.
EVERY exception class listed in the sweep or PARSED EXCEPTION / SQL BLOCKS must be mentioned exactly once in the Exception Deep Dive or explicitly dismissed as downstream/noise with evidence.
YOU MUST USE THE WHOLE-LOG COVERAGE MAP to confirm whether the failure is concentrated in head, middle, tail, or a specific segment. Do not say the middle of the log is clean unless the segment map supports it.
YOU MUST SCAN THE ENTIRE FORENSIC INCIDENT REPORT LINE BY LINE. DO NOT SKIP ANY DISTINCT FAILURE SIGNATURE.
The ROOT-CAUSE CANDIDATE RANKING is a forensic hint, not a verdict. Validate it by chronology, inner exception chains, and downstream symptoms before declaring root cause.
The DETERMINISTIC ROOT-CAUSE HYPOTHESIS is the machine parser's strongest candidate. You MUST either confirm it with cited evidence or reject it with a stronger earlier causal event.
The CAUSAL DOMINO ANALYSIS is mandatory evidence. It is the "Log Whisperer" layer: it lines up every event on one master timeline, scores causal edges using SOTI architecture dependencies, and separates the first domino from distracting downstream noise. Never call a later DS/Agent/Web failure the root cause if an earlier SQL/Identity/MS/certificate/auth failure explains it.
If INSTALLER FAILURE INTELLIGENCE exists, use it as the primary structure unless a [DETERMINISTIC INSTALLER ROOT-CAUSE REPORT] is present; that deterministic report is higher priority. Installer logs require a different judgement: the earliest error may be non-fatal validation, while the real root cause is the first deployment/custom-action failure that causes rollback/1603.
If INSTALLER FORENSIC FORMAT HINTS exist, use them only as formatting guidance after independently validating the root cause against the cross-log index and raw incident windows.

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
- NEVER say "multiple issues were found" without ranking them. ALWAYS identify THE primary root cause.`;
}

function getDeterministicInstallerPrompt() {
    return `You are a SOTI installer forensics specialist. A deterministic parser has already extracted the controlling setup/MSI root-cause evidence from the attached log.

Your task:
- Output the installer forensic report using ONLY the [DETERMINISTIC INSTALLER ROOT-CAUSE REPORT] and its raw evidence blocks.
- Do NOT produce generic sections such as "CROSS-LOG INCIDENT INDEX", "keyword sweep", "stack traces" or "we'll perform a sweep".
- Do NOT say the deterministic report is missing if the section exists in the prompt.
- Do NOT invent Location Service initialization failures, ENOTFOUND, registry keys, .NET prerequisites, Get-ComputerInfo, missing dependencies, deadlocks, TLS/network failures, timeout code 4214, or HRESULT/Win32 root causes unless those exact facts are quoted in the deterministic report.
- Preserve line numbers exactly.
- Preserve milliseconds exactly. MSI timestamps like 19:13:57:009 must be displayed as 19:13:57.009.
- The first actionable failure can be a non-fatal prerequisite/symptom, but the root cause must be the first deployment/custom-action failure that aborts the installer.

Required output:
## Forensic Analysis: [product/version] Installation Failure
Log Source, Install Start, Install End/Return Code, Environment

### 1. Chronological Triage - First Failure Point
Table with Timestamp (HH:MM:SS.mmm), Log Line, Event.

### 2. Propagation Path
Step-by-step chain with timestamps and line numbers.

### 3. Root Cause - Symptom vs. Source
Table classifying symptoms versus the true source.

Conclusion and Recommendation.

If the deterministic report identifies Azure SQL plus ALTER DATABASE/SET RECOVERY SIMPLE, that is the root cause.`;
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
- **LATEST vs CASE Versions (CRITICAL)**: The case context contains the customer's CURRENTLY INSTALLED version — use it for troubleshooting and comparison. The product version lists contain ALL available official releases sorted newest-first. When asked "what is the latest version?", answer directly with the first entry from the appropriate list using natural language, for example "The latest Android Agent version is 2026.1.0." NEVER mention internal prompt labels such as [MC VERSIONS], [AGENT VERSIONS], [IDENTITY VERSIONS], [CASE], [RELEASE NOTES], [PULSE SEARCH], or [DEEP RESEARCH]. When troubleshooting, compare the customer's case version against release notes to find fixes in newer versions.

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
    const versionHeadingRx = /\b(20\d\d\.\d+(?:\.\d+)?)\b/;
    const blocks = [];
    const layoutItems = Array.from(doc.querySelectorAll('.umb-block-grid__layout-item'));

    if (layoutItems.length > 0) {
        let currentVersion = null;
        let currentType = "Highlights";
        const buckets = { Highlights: [], "Resolved Issues": [], "Known Issues": [] };

        layoutItems.forEach(item => {
            const h1 = item.querySelector('h1');
            if (h1 && versionHeadingRx.test(h1.textContent || "")) {
                flushPulseNoteBuckets(currentVersion, buckets, blocks);
                currentVersion = ((h1.textContent || "").match(versionHeadingRx) || [])[1];
                Object.keys(buckets).forEach(k => { buckets[k] = []; });
                currentType = "Highlights";
                return;
            }
            const h2 = item.querySelector('h2');
            if (h2) {
                const section = classifyPulseSectionHeading(h2.textContent || "");
                if (section) {
                    currentType = section;
                    return;
                }
            }
            if (!currentVersion) return;

            const table = item.querySelector('table');
            if (table) {
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
                return;
            }

            const rich = item.querySelector('.umbBlockGridRichTextBlock, .contents');
            if (rich) {
                const parts = [];
                rich.querySelectorAll('p, li, h3, h4').forEach(el => {
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
        flushPulseNoteBuckets(currentVersion, buckets, blocks);
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

async function fetchPulseReleaseBlocksForVersion(baseUrl, primaryVersion) {
    const base = (baseUrl || "").replace(/\?.*$/, "");
    const pageHtml = await sotiFetch(base, 15000);
    const urls = buildPulseVersionFetchUrls(baseUrl, primaryVersion, pageHtml);
    for (const fetchUrl of urls) {
        const html = await sotiFetch(fetchUrl, 15000);
        if (!html) continue;
        let blocks = extractPulseReleaseNoteBlocks(html);
        if (primaryVersion) {
            const matched = blocks.filter(b => b.version === primaryVersion);
            if (matched.length) {
                blocks = blocks
                    .filter(b => b.version === primaryVersion)
                    .map(b => (b.type === "Highlights" && isPulseBoilerplateHighlight(b.text) ? { ...b, text: "" } : b))
                    .filter(b => cleanPulseText(b.text).length > 15);
                return { blocks, fetchUrl };
            }
        } else if (blocks.length) {
            return { blocks, fetchUrl };
        }
    }
    if (!pageHtml) return { blocks: [], fetchUrl: base };
    let blocks = extractPulseReleaseNoteBlocks(pageHtml);
    if (primaryVersion) {
        blocks = blocks.filter(b => b.version === primaryVersion);
    }
    return { blocks, fetchUrl: base };
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
    const fromQuery = [...new Set((query.match(/\b(20\d\d\.\d+(?:\.\d+)?)\b/g) || []))];
    if (fromQuery.length) return fromQuery;
    const caseText = [ci?.meeting_notes, ci?.issue_summary, ci?.email_chain, history].filter(Boolean).join('\n');
    const fromCase = [...new Set((caseText.match(/\b(20\d\d\.\d+(?:\.\d+)?)\b/g) || []))];
    if (fromCase.length) return fromCase;
    const fromHistory = [...new Set((history.match(/\b(20\d\d\.\d+(?:\.\d+)?)\b/g) || []))];
    if (fromHistory.length) return fromHistory.slice(0, 2);
    const combined = `${query} ${history}`.toLowerCase();
    const asksAgent = /\b(android|agent|aea|device agent)\b/.test(combined);
    if (ci) {
        if (asksAgent && ci.agent_version) {
            const m = ci.agent_version.match(/\b(20\d\d\.\d+(?:\.\d+)?)\b/);
            if (m) return [m[1]];
        }
        if (ci.soti_version) {
            const m = ci.soti_version.match(/\b(20\d\d\.\d+(?:\.\d+)?)\b/);
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
    const addByFragment = (fragment, type) => {
        const entry = catalog.find(e => e.path.includes(fragment));
        if (entry) addPath(entry.path, type);
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
        { rx: /\b(console|server|management service|mc\s+version|soti\s+version)\b/, fragment: 'product-notes/release-notes', type: 'Console' },
        { rx: /\b(mobicontrol)\b/, fragment: 'product-notes/release-notes', type: 'Console' }
    ];
    rules.forEach(rule => {
        if (rule.rx.test(combined)) addByFragment(rule.fragment, rule.type);
    });

    if (!sources.length) {
        ['release-notes', 'android-agent-release-notes'].forEach(fragment => {
            const entry = catalog.find(e => e.path.includes(fragment));
            if (entry) addPath(entry.path, fragment.includes('android') ? 'Agent' : 'Console');
        });
    }
    return sources;
}

async function searchPulseAndDocs(query, msgs, ci) {
    try {
        PULSE_SEARCH_RESULTS = ""; DOCS_SEARCH_RESULTS = ""; RESEARCHED_ARTICLE_CONTENT = ""; RELEASE_NOTES_CONTENT = "";
        const qLower = query.toLowerCase();
        const history = (msgs || []).map(m => m.content.toLowerCase()).join(' ');
        const caseBlob = getCaseResearchContext(query, history, ci);
        const combinedLower = caseBlob.toLowerCase();
        
        const asksIdentity = combinedLower.includes('identity') || (ci && ci.product === 'SOTI Identity');
        const asksReleaseNotes = /\b(release\s*notes?|product\s*notes?|what'?s\s+new|whats\s+new|changelog|release\s*highlights?|resolved\s*issues?|known\s*issues?|mcmr[\s-]*\d|fixed\s+in|fixed\s+since)\b/i.test(combinedLower);
        const asksMobiControl = /\b(mobicontrol|mdm|uem|emm|enrollment|deployment server|management service|device policy|profiles?|afw#|soti agent|android enterprise|certificate|cert\b|api\s+call)\b/i.test(combinedLower);
        
        const asksVersion = asksReleaseNotes || /\b(latest|version|release|update|fixed|resolved|mcmr|bug|upgrade|certificate|cert\b)\b/i.test(combinedLower) ||
                            /\b(what about|how about)\b/i.test(query) ||
                            /\b(20\d\d\.\d+(?:\.\d+)?)\b/.test(caseBlob);

        if (asksVersion) {
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
                const primaryVersionEarly = queryVersionsEarly[0] || null;
                const pulseLoad = await fetchPulseReleaseBlocksForVersion(url, primaryVersionEarly);
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
                        const hasFixKeywords = /\b(fix|fixed|bug|mcmr|resolve|resolved|issue|error|exception|crash|prevent|correct|correctly)\b/i.test(qLower) || 
                                               /\b(fix|fixed|bug|mcmr|resolve|resolved|issue|error|exception|crash|prevent|correct|correctly)\b/i.test(history);
                        if (hasFixKeywords && b.type === 'Resolved Issues') {
                            score += 150;
                        }
                        
                        const hasHighlightKeywords = /\b(feature|highlight|improvement|note|new|whatsnew|what's\s+new)\b/i.test(qLower) ||
                                                     /\b(feature|highlight|improvement|note|new|whatsnew|what's\s+new)\b/i.test(history);
                        if (hasHighlightKeywords && b.type === 'Highlights') {
                            score += 150;
                        }
                        
                        return { block: b, score: score };
                    });
                    
                    // Sort descending by score, then by version
                    scoredBlocks.sort((a, b) => {
                        if (b.score !== a.score) return b.score - a.score;
                        return b.block.version.localeCompare(a.block.version, undefined, { numeric: true });
                    });
                    
                    // Build context under dynamic character budget (up to 80k if no log attachments)
                    let clean = "";
                    let charBudget = 15000;
                    
                    const activeCase = typeof cases !== 'undefined' ? cases.find(x => x.id === activeCaseId) : null;
                    const hasLogs = (activeCase && activeCase.logs && activeCase.logs.length > 0) || history.includes('[diagnostic data') || history.includes('=== file:');
                    
                    if (!hasLogs || asksVersion) {
                        charBudget = 80000;
                    }
                    
                    let includedCount = 0;
                    const highestScore = scoredBlocks[0]?.score || 0;
                    const strictVersionFilter = !!primaryVersion;
                    
                    if (primaryVersion) {
                        clean += `\n[USER REQUESTED VERSION: ${primaryVersion} — cite ONLY ### VERSION ${primaryVersion} sections below]\n`;
                    }
                    
                    for (const sb of scoredBlocks) {
                        if (strictVersionFilter && sb.block.version !== primaryVersion) continue;
                        if (sb.score < 0) continue;
                        // Skip unrelevant older blocks if we have high-scoring ones
                        if (!strictVersionFilter && sb.score === 0 && includedCount >= 2 && highestScore > 0) {
                            continue;
                        }
                        
                        const formatBlock = `\n### VERSION ${sb.block.version} - ${sb.block.type.toUpperCase()}:\n${sb.block.text}\n`;
                        if (clean.length + formatBlock.length <= charBudget) {
                            clean += formatBlock;
                            includedCount++;
                        } else {
                            if (sb.score >= 100 && clean.length < (charBudget * 0.4)) {
                                const remaining = charBudget - clean.length;
                                clean += `\n### VERSION ${sb.block.version} - ${sb.block.type.toUpperCase()} (TRUNCATED):\n${sb.block.text.slice(0, remaining - 100)}\n`;
                                includedCount++;
                            }
                            break;
                        }
                    }
                    
                    if (clean.length > 200) {
                        notes.push(`[SOTI PULSE ${type.toUpperCase()} DATA - RELEVANT NOTES]\nOfficial source: ${resolvedUrl}\n${clean}`);
                        toast(`✓ ${type} RAG Context Loaded`, 's');
                    }
                }
            }
            
            if (notes.length > 0) {
                RELEASE_NOTES_CONTENT = notes.join('\n\n---\n\n');
            } else {
                toast('Autonomous Research failed', 'w');
            }
        }
            

        const stopWords = new Set(['what', 'where', 'how', 'when', 'there', 'is', 'are', 'was', 'were', 'the', 'and', 'with', 'some', 'having', 'issues', 'this', 'that', 'they', 'their', 'them', 'from', 'into', 'your', 'will', 'would', 'could', 'should', 'about', 'some', 'doing', 'doing', 'it', 'for', 'give', 'short', 'subject', 'name', 'meeting', 'notes', 'critical', 'investigation']);
        let keywordParts = caseBlob.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w));
        const seenKw = new Set();
        keywordParts = keywordParts.filter(w => { if (seenKw.has(w)) return false; seenKw.add(w); return true; });
        if (asksMobiControl && !keywordParts.includes('mobicontrol')) keywordParts.unshift('mobicontrol');
        if (/\bcertificate|cert\b/i.test(combinedLower) && !keywordParts.includes('certificate')) keywordParts.unshift('certificate');
        const keywords = keywordParts.slice(0, 6).join('%20');
        if (!keywords) return;

        const [pHtml, dHtml, iHtml] = await Promise.all([
            sotiFetch(`${PULSE_ORIGIN}/search/?q=${keywords}`, 10000),
            sotiFetch(`${DOCS_ORIGIN}/soti-mobicontrol/search/?q=${keywords}`, 10000),
            asksIdentity ? sotiFetch(`${PULSE_ORIGIN}/support/soti-identity/search/?q=${keywords}`, 10000) : Promise.resolve(null)
        ]);

        // Helper to resolve relative URLs to absolute (DOMParser resolves to chrome-extension:// otherwise)
        function resolveLink(href, baseOrigin) {
            if (!href || href.startsWith('#') || href.startsWith('javascript:')) return null;
            if (href.startsWith('http://') || href.startsWith('https://')) return href;
            if (href.startsWith('/')) return baseOrigin + href;
            return baseOrigin + '/' + href;
        }

        const deepLinks = [];
        if (pHtml) {
            const doc = new DOMParser().parseFromString(pHtml, 'text/html');
            const items = [...doc.querySelectorAll('a')].map(a => ({
                href: resolveLink(a.getAttribute('href'), PULSE_ORIGIN),
                text: a.textContent.trim()
            })).filter(a => a.href && a.href.includes('pulse.soti.net/support') && isUsefulPulseResearchLink(a.href, a.text))
                .slice(0, asksMobiControl ? 5 : 3);
            PULSE_SEARCH_RESULTS = items.map(i => { deepLinks.push(i.href); return `- ${i.text}`; }).join('\n');
        }
        if (dHtml) {
            const doc = new DOMParser().parseFromString(dHtml, 'text/html');
            const items = [...doc.querySelectorAll('a')].map(a => ({
                href: resolveLink(a.getAttribute('href'), DOCS_ORIGIN),
                text: a.textContent.trim()
            })).filter(a => a.href && a.href.includes('/help/')).slice(0, asksMobiControl ? 5 : 3);
            DOCS_SEARCH_RESULTS = items.map(i => { deepLinks.push(i.href); return `- ${i.text}`; }).join('\n');
        }
        if (iHtml) {
            const doc = new DOMParser().parseFromString(iHtml, 'text/html');
            const items = [...doc.querySelectorAll('a')].map(a => ({
                href: resolveLink(a.getAttribute('href'), PULSE_ORIGIN),
                text: a.textContent.trim()
            })).filter(a => a.href && (a.href.includes('/soti-identity/help/') || a.href.includes('/soti-identity/articles/'))).slice(0, 3);
            DOCS_SEARCH_RESULTS += (DOCS_SEARCH_RESULTS ? '\n' : '') + items.map(i => { deepLinks.push(i.href); return `- ${i.text}`; }).join('\n');
        }

        const deepLinkLimit = asksMobiControl || asksReleaseNotes ? 5 : 3;
        const deepArticleBudget = asksMobiControl || asksReleaseNotes ? 25000 : 15000;
        if (deepLinks.length > 0) {
            const linksToFetch = deepLinks.slice(0, deepLinkLimit);
            const fetched = await Promise.all(linksToFetch.map(url => sotiFetch(url, 15000).catch(() => null)));
            const articles = [];
            const perArticleBudget = Math.floor(deepArticleBudget / linksToFetch.length);

            fetched.forEach((content, idx) => {
                if (content) {
                    const doc = new DOMParser().parseFromString(content, 'text/html');
                    const article = extractDeepResearchArticle(doc);
                    if (article.length > 100 && !isLowQualityResearchArticle(article)) {
                        articles.push(`[DEEP RESEARCH - ${linksToFetch[idx]}]:\n${article.slice(0, perArticleBudget)}`);
                    }
                }
            });

            if (articles.length > 0) {
                RESEARCHED_ARTICLE_CONTENT = articles.join('\n\n---\n\n');
            }
        }
    } catch (e) { console.warn('Research failed', e); }
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

    function extractVersionsFromDOM(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script, style, nav, footer, svg, path, iframe, link').forEach(el => el.remove());
        const versions = new Set();
        const vRx = /\b(20\d\d\.\d+(?:\.\d+)?)\b/;
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
            (bodyText.match(/\b(20\d\d\.\d+(?:\.\d+)?)\b/g) || []).forEach(v => versions.add(v));
        }
        return [...versions].sort((x, y) => y.localeCompare(x, undefined, { numeric: true }));
    }

    if (consoleHtml) VERSIONS = extractVersionsFromDOM(consoleHtml);
    if (agentHtml) AGENT_VERSIONS = extractVersionsFromDOM(agentHtml);
    if (identityHtml) IDENTITY_VERSIONS = extractVersionsFromDOM(identityHtml);
    
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
    syncActiveCaseCiFromForm();
    updateVersionDropdowns();
    updateFieldValidation('product');
    if (_saveStateTimer) clearTimeout(_saveStateTimer);
    saveState();
};

// --- AI ENGINE (LOCAL — OLLAMA) ---
let LOCAL_AI_URL = 'http://localhost:11434';
let LOCAL_AI_MODEL = '';
let LOCAL_AI_MODELS = [];

async function loadLocalAISettings() {
    try {
        let data = {};
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            data = await chrome.storage.local.get(['localAiUrl', 'localAiModel']);
        } else {
            const s = localStorage.getItem('soti_local_ai');
            if (s) data = JSON.parse(s);
        }
        LOCAL_AI_URL = data.localAiUrl || 'http://localhost:11434';
        LOCAL_AI_MODEL = data.localAiModel || '';

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
        const d = { localAiUrl: LOCAL_AI_URL, localAiModel: LOCAL_AI_MODEL };
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            await chrome.storage.local.set(d);
        } else {
            localStorage.setItem('soti_local_ai', JSON.stringify(d));
        }
    } catch (e) { console.warn('Failed to save local AI settings', e); }
}

function sortOllamaModels(models) {
    return [...models].sort((a, b) => {
        const aLlama = /llama3\.2/i.test(a) ? 0 : 1;
        const bLlama = /llama3\.2/i.test(b) ? 0 : 1;
        if (aLlama !== bLlama) return aLlama - bLlama;
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });
}

function pickPreferredOllamaModel(models) {
    const sorted = sortOllamaModels(models);
    return sorted.find(m => /llama3\.2/i.test(m)) || sorted[0] || '';
}

async function fetchOllamaModels(baseUrl) {
    try {
        const url = (baseUrl || LOCAL_AI_URL).replace(/\/$/, '');
        const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return [];
        const data = await res.json();
        return sortOllamaModels((data.models || []).map(m => m.name).filter(Boolean));
    } catch (e) {
        console.warn('Ollama not reachable', e);
        return [];
    }
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
const OpenRouterAI = {
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
            const res = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    model, 
                    messages, 
                    stream: true,
                    options: {
                        num_ctx: 131072
                    }
                })
            });
            if (!res.ok) {
                const err = await res.text();
                throw new Error(`Ollama error ${res.status}: ${err}`);
            }
            return res.body.getReader();
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
    
    const needsDeepPulse = /\b(release\s*notes?|product\s*notes?|mobicontrol|version|latest|mcmr|what'?s\s+new|changelog)\b/i.test(txt);
    const researchMs = needsDeepPulse ? 20000 : 10000;
    try {
        await Promise.race([
            searchPulseAndDocs(txt, c.msgs, ci),
            new Promise(r => setTimeout(r, researchMs))
        ]);
    } catch (e) { console.warn('Research timed out'); }

    try {
        const isGreeting = /^(hi|hello|hey|greetings|morning|afternoon|evening|yo|sup)\b/i.test(txt) && txt.split(' ').length < 3;
        const promptMode = isGreeting ? 'greeting' : 'full';

        // --- LOG CONTEXT ---
        const hasLogs = c.logs.length > 0;
        const deterministicInstallerReport = hasLogs ? buildAuthoritativeInstallerReport(c.logs) : "";
        const deterministicInstallerMode = !!deterministicInstallerReport;
        let logContext = hasLogs ? `\n\n[DIAGNOSTIC DATA — ${c.logs.length} LOG FILE(S) ATTACHED]` : "";
        if (deterministicInstallerMode) {
            logContext += `\n\n[DETERMINISTIC INSTALLER ROOT-CAUSE REPORT - EXACT LOG EVIDENCE]\n${deterministicInstallerReport}\n[END DETERMINISTIC INSTALLER ROOT-CAUSE REPORT]\n`;
            logContext += `\n\n[FINAL CONTROLLING EVIDENCE - DO NOT OVERRIDE]\n${deterministicInstallerReport}\n[END FINAL CONTROLLING EVIDENCE]\n`;
        } else {
            if (hasLogs) {
                logContext += buildCrossLogIncidentIndex(c.logs);
            }
            const perLogLimit = hasLogs ? Math.max(120000, Math.floor(420000 / Math.max(1, c.logs.length))) : 300000;
            c.logs.forEach(l => {
                logContext += `\n\n=== FILE: ${l.name} (${l.content.length} chars) ===\n${getSmartLogSnippet(l.content, perLogLimit, l.name)}\n=== END: ${l.name} ===`;
            });
        }

        const summaryText = buildEffectiveIssueSummary(ci) || 'NO SUMMARY PROVIDED';

        // When logs are present: use the lean forensic prompt so the context window
        // is focused on log data. When no logs: use the full KB prompt for general Q&A.
        const corePrompt = deterministicInstallerMode ? getDeterministicInstallerPrompt() : (hasLogs ? getLeanLogPrompt() : getLeanQAPrompt());

        const sysPrompt = deterministicInstallerMode
            ? scrubPII(`[ISSUE SUMMARY]: ${summaryText}
[TIME]: ${new Date().toLocaleString()}
[CASE]: ${JSON.stringify(ci, null, 2)}

${corePrompt}

${logContext}`)
            : scrubPII(`[ISSUE SUMMARY]: ${summaryText}
[TIME]: ${new Date().toLocaleString()}
[CASE]: ${JSON.stringify(ci, null, 2)}
[MC VERSIONS]: ${VERSIONS.join(', ')}
[AGENT VERSIONS]: ${AGENT_VERSIONS.join(', ')}
[IDENTITY VERSIONS]: ${IDENTITY_VERSIONS.join(', ')}
[RELEASE NOTES]: ${RELEASE_NOTES_CONTENT}
[PULSE SEARCH]: ${PULSE_SEARCH_RESULTS}
[DOCS SEARCH]: ${DOCS_SEARCH_RESULTS}
[DEEP RESEARCH]: ${RESEARCHED_ARTICLE_CONTENT}

${corePrompt}

${imgContext}

${logContext}`);

        // Pure-Text Payload (Option A)
        const userMsgText = deterministicInstallerMode
            ? "Produce the installer forensic report from the deterministic root-cause evidence only. Do not add generic or uncited causes."
            : txt;
        const userMsg = scrubPII(userMsgText) + (imgContext && !deterministicInstallerMode ? `\n\n(Extracted Image Data via OCR):\n${imgContext}` : "");
        c.msgs.push({ role: 'user', content: userMsg, hidden: silent });
        
        // Model is selected from Ollama settings
        const selectedModel = LOCAL_AI_MODEL || null;

        const modelMessages = hasLogs
            ? [{ role: 'system', content: sysPrompt }, c.msgs[c.msgs.length - 1]]
            : [{ role: 'system', content: sysPrompt }, ...c.msgs.slice(-10)];

        const reader = await OpenRouterAI.completions.create({
            model: selectedModel,
            messages: modelMessages,
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
        const onFieldInput = () => {
            syncActiveCaseCiFromForm();
            requestAnimationFrame(() => updateFieldValidation(id));
            if (id === 'caseNum') scheduleRenderTabs();
            scheduleSaveState();
        };
        const onFieldCommit = () => {
            syncActiveCaseCiFromForm();
            updateFieldValidation(id);
            if (id === 'caseNum') renderTabs();
            if (_saveStateTimer) clearTimeout(_saveStateTimer);
            saveState();
        };
        el.oninput = onFieldInput;
        el.onchange = onFieldCommit;
        el.onblur = onFieldCommit;
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
        item.title = f.name;
        item.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
            <span class="log-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
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

const handleFiles = async (files) => {
    const c = cases.find(x => x.id === activeCaseId);
    if (!c) return;

    const uploads = Array.from(files || []);
    if (uploads.length === 0) return;

    toast('Uploading logs...', 'i', 0);
    const added = [];
    const skipped = [];

    for (const f of uploads) {
        try {
            const entries = await readLogUpload(f);
            if (!entries.length) {
                skipped.push(`${f.name}: no supported log files found`);
                continue;
            }

            entries.forEach(entry => {
                const log = {
                    name: entry.name,
                    content: entry.content,
                    sourceZip: entry.sourceZip || "",
                    uploadedAt: Date.now()
                };
                getLogPanelIntel(log);
                c.logs.push(log);
                added.push(entry.name);
            });
        } catch (e) {
            skipped.push(`${f.name}: ${e.message || e}`);
        }
    }

    renderLogs();
    saveState();

    if (added.length > 0) toast('Logs uploaded', 's', 2500);
    else hideToast();
    if (skipped.length > 0) toast(`Skipped ${skipped.length} file(s): ${skipped.slice(0, 2).join('; ')}`, 'w', 7000);
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
    const c = cases.find(x => x.id === activeCaseId);
    const attachedLogs = (c && c.logs) ? c.logs.map(l => `${l.name} (${l.content.length} chars)`).join(', ') : 'No logs attached';
    const forensicPrompt = `Run the deepest possible forensic root-cause analysis on the attached logs.
(Current Analysis Request Time: ${now})
Attached logs: ${attachedLogs}

Mandatory analysis behavior:
1. Use the whole-file FORENSIC INCIDENT REPORT for every attached log. Do not rely only on the visible head/tail snippets.
2. Start with the CROSS-LOG INCIDENT INDEX and CROSS-LOG EXCEPTION / ERROR KEYWORD SWEEP, then validate against each file's FORENSIC INCIDENT REPORT.
3. If a DETERMINISTIC INSTALLER ROOT-CAUSE REPORT exists, use it as the primary setup/MSI answer and validate it against the raw log lines. If only INSTALLER FAILURE INTELLIGENCE exists, use it as parser evidence for setup/MSI logs.
4. Treat the CAUSAL DOMINO ANALYSIS as the architect-level "Log Whisperer" layer: use it to identify the first domino, downstream dominoes, and final symptom.
5. Identify every distinct exception, ERROR/WARN event, SQL exception, timeout, deadlock, authentication failure, certificate/TLS failure, service restart/failure, installer/MSI failure, and HTTP/network failure.
6. Use the keyword sweep to catch every high-signal word: Exception, ERROR, WARN, FATAL, CRITICAL, failed, cannot, unable, denied, refused, invalid, unsupported, missing, timeout, deadlock, rollback, 1603, HRESULT/Win32, and non-zero return/error codes.
7. Build one master chronological timeline across all attached logs using filename, line number, and timestamp.
8. Preserve timestamp precision. MSI timestamps like 19:13:57:009 must be shown as 19:13:57.009 in timelines, root-cause verdicts, and propagation chains.
9. Read exception chains inside-out and stack traces bottom-up. The innermost exception is the strongest root-cause candidate.
10. If SQL exceptions exist, diagnose them explicitly: login/schema/deadlock/timeout/connection-pool/connectivity/unsupported ALTER DATABASE, database/server/query if visible, and whether they are causal or downstream.
11. Use the CAUSAL DOMINO ANALYSIS and FILE-LEVEL CAUSAL / DOMINO MODEL to explain root cause -> downstream failures -> user-visible symptom.
12. Apply the strict signal ladder: FATAL/CRITICAL/PANIC/SEVERE > innermost exception chains > SQL/certificate/auth/permission > ERROR/non-zero return codes > WARN. Treat INFO and "0 errors/no errors/completed successfully" as context, not failures.
13. Give a concrete solution, not only a diagnosis. Tie every fix to the proven root cause.
14. Rank root-cause candidates, separate causal errors from noisy symptoms, and give one primary root-cause verdict.
15. If the logs do not contain enough evidence, say exactly which extra log file/time window is required. Do not guess.
16. Do not invent missing dependencies, corrupted registry entries, implicit deadlocks, network disconnects, timeout code 4214, log-path-change causality, reboot steps, or HRESULT/Win32 root causes unless exact cited log lines prove them.`;

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
        if (!LOCAL_AI_MODEL) {
            $('mGen').style.display = 'none';
            return toast('No model selected. Open Settings (⚙) and pick an Ollama model.', 'e', 5000);
        }
        const baseUrl = LOCAL_AI_URL.replace(/\/$/, '');
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: LOCAL_AI_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                stream: false
            })
        });
        if (!res.ok) throw new Error(`Ollama error ${res.status}`);
        const data = await res.json();
        const filled = data.choices?.[0]?.message?.content || '';
        $('mGen').style.display = 'none';
        if (!filled) return toast('JIRA generation failed', 'e');
        $('jiraTa').value = filled;
        $('mJira').style.display = 'flex';
        toast('✓ JIRA Report Ready', 's');
    } catch (e) { 
        $('mGen').style.display = 'none';
        toast('JIRA failed: ' + e.message, 'e'); 
    }
};
$('mJiraClose').onclick = $('btnJiraDone').onclick = () => $('mJira').style.display = 'none';
$('btnCopyJira').onclick = () => { $('jiraTa').select(); document.execCommand('copy'); toast('Copied!', 's'); };

loadState();
fetchLatestSOTIVersions();
loadLocalAISettings().then(() => updateLocalAIBadge());

// --- SETTINGS MODAL (AI — OLLAMA) ---
async function refreshSettingsModal() {
    const urlInp = $('localAiUrl');
    const modelSel = $('localAiModelSel');
    const statusEl = $('localAiStatus');
    if (urlInp) urlInp.value = LOCAL_AI_URL;

    if (statusEl) { statusEl.textContent = 'Connecting to Ollama...'; statusEl.style.color = 'var(--txt2)'; }
    const models = await fetchOllamaModels(urlInp ? urlInp.value : LOCAL_AI_URL);
    LOCAL_AI_MODELS = models;
    if (modelSel) {
        if (models.length === 0) {
            modelSel.innerHTML = '<option value="">No models found — is Ollama running?</option>';
            if (statusEl) { statusEl.textContent = '⚠ Ollama not reachable at ' + (urlInp ? urlInp.value : LOCAL_AI_URL); statusEl.style.color = 'var(--warn)'; }
        } else {
            modelSel.innerHTML = models.map(m => `<option value="${m}" ${m === LOCAL_AI_MODEL ? 'selected' : ''}>${m.replace(/:latest$/i, '')}</option>`).join('');
            if (!LOCAL_AI_MODEL && models.length > 0) LOCAL_AI_MODEL = pickPreferredOllamaModel(models);
            if (statusEl) { statusEl.textContent = `✓ ${models.length} model(s) available`; statusEl.style.color = 'var(--green)'; }
        }
    }
}

async function openSettingsModal() {
    $('mSettings').style.display = 'flex';
    await refreshSettingsModal();
}

$('mSettingsClose').onclick = () => $('mSettings').style.display = 'none';

$('localAiUrl').oninput = () => {
    LOCAL_AI_URL = $('localAiUrl').value.trim() || 'http://localhost:11434';
};

$('btnRefreshModels').onclick = async () => {
    LOCAL_AI_URL = $('localAiUrl').value.trim() || 'http://localhost:11434';
    await refreshSettingsModal();
};

$('localAiModelSel').onchange = () => {
    LOCAL_AI_MODEL = $('localAiModelSel').value;
};

$('btnSaveLocalAI').onclick = async () => {
    LOCAL_AI_URL = $('localAiUrl').value.trim() || 'http://localhost:11434';
    LOCAL_AI_MODEL = $('localAiModelSel').value || LOCAL_AI_MODEL;
    await saveLocalAISettings();
    updateLocalAIBadge();
    $('mSettings').style.display = 'none';
    toast(`✓ Model set: ${LOCAL_AI_MODEL ? LOCAL_AI_MODEL.replace(/:latest$/i, '') : 'Ollama'}`, 's');
};

if ($('btnDownloadLocalAISetup')) {
    $('btnDownloadLocalAISetup').onclick = () => {
        const url = chrome.runtime.getURL('setup_local_ai.bat');
        if (chrome.downloads?.download) {
            chrome.downloads.download({ url, filename: 'SOTI-setup_local_ai.bat', saveAs: false }, () => {
                toast('Installer downloaded — run SOTI-setup_local_ai.bat from Downloads', 's', 8000);
            });
        } else {
            window.open(url, '_blank');
            toast('Save and run setup_local_ai.bat from the extension folder', 'w', 8000);
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

// Real-time sync between Sidepanel and Floating Window
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.cases || changes.activeCaseId)) {
        if (busy || _suppressStorageReload) return;
        loadState();
    }
});
