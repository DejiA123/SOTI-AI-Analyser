const fs = require('fs');
let code = fs.readFileSync('sidepanel.js', 'utf8');

// 1. handleFiles: Cache normalized content and lines
let oldHandleFiles = `            for (const entry of entries) {
                const log = {
                    name: entry.name,
                    content: entry.content,
                    sourceZip: entry.sourceZip || "",
                    uploadedAt: Date.now()
                };`;
let newHandleFiles = `            for (const entry of entries) {
                const content = normalizeLogText(entry.content || "");
                const lines = content ? content.split('\\n') : [];
                const log = {
                    name: entry.name,
                    content: content,
                    lines: lines,
                    sourceZip: entry.sourceZip || "",
                    uploadedAt: Date.now()
                };`;
code = code.replace(oldHandleFiles, newHandleFiles);

// 2. buildLogPatternProfile
let oldProfileLines = `    for (const log of logs) {
        const fileName = log.name || "Attached log";
        const content = normalizeLogText(log.content || "");
        const lines = content.split('\\n');`;
let newProfileLines = `    for (const log of logs) {
        const fileName = log.name || "Attached log";
        const content = log.content || "";
        const lines = log.lines || (content ? content.split('\\n') : []);`;
code = code.replace(oldProfileLines, newProfileLines);

// 3. buildInstallerPatternSummary
let oldSummaryLines = `    for (const log of logs) {
        const content = normalizeLogText(log.content || "");
        combinedHeader += content.slice(0, 100000) + "\\n";
        const lines = content.split('\\n');`;
let newSummaryLines = `    for (const log of logs) {
        const content = log.content || "";
        combinedHeader += content.slice(0, 100000) + "\\n";
        const lines = log.lines || (content ? content.split('\\n') : []);`;
code = code.replace(oldSummaryLines, newSummaryLines);

// 4. getLogPanelIntel
let oldIntelLines = `async function getLogPanelIntel(log) {
    if (!log) return null;
    const cacheKey = \`\${log.name || ""}:\${(log.content || "").length}\`;
    if (log.panelIntel && log.panelIntel.cacheKey === cacheKey) return log.panelIntel;

    const content = normalizeLogText(log.content || "");
    const lines = content ? content.split('\\n') : [];`;
let newIntelLines = `async function getLogPanelIntel(log) {
    if (!log) return null;
    const cacheKey = \`\${log.name || ""}:\${(log.content || "").length}\`;
    if (log.panelIntel && log.panelIntel.cacheKey === cacheKey) return log.panelIntel;

    const content = log.content || "";
    const lines = log.lines || (content ? content.split('\\n') : []);`;
code = code.replace(oldIntelLines, newIntelLines);

// 5. extractExceptionBlocksFromLog
let oldExLines = `async function extractExceptionBlocksFromLog(logName, content) {
    const lines = content.split('\\n');`;
let newExLines = `async function extractExceptionBlocksFromLog(logName, content, precalculatedLines = null) {
    const lines = precalculatedLines || content.split('\\n');`;
code = code.replace(oldExLines, newExLines);

// 6. buildInstallerFailureAnalysis
let oldBuildInstLines = `async function buildInstallerFailureAnalysis(logs) {
    if (!logs || logs.length === 0) return "";
    let report = "";
    
    for (const log of logs) {
        const content = normalizeLogText(log.content || "");
        const lines = content.split('\\n');`;
let newBuildInstLines = `async function buildInstallerFailureAnalysis(logs) {
    if (!logs || logs.length === 0) return "";
    let report = "";
    
    for (const log of logs) {
        const content = log.content || "";
        const lines = log.lines || (content ? content.split('\\n') : []);`;
code = code.replace(oldBuildInstLines, newBuildInstLines);

// 7. buildPrecisionLogBrief
let oldBriefLines = `async function buildPrecisionLogBrief(content, fileName = "Attached log", precalculatedLines = null) {
    if (!content) return "";
    content = normalizeLogText(content);
    const lines = precalculatedLines || content.split('\\n');`;
// wait, I made buildPrecisionLogBrief async earlier, let's just make it use precalculatedLines
// first let's see what the current code is.
code = code.replace(/async function buildPrecisionLogBrief\(content, fileName = "Attached log"\) \{\s*if \(!content\) return "";\s*content = normalizeLogText\(content\);\s*const lines = content\.split\('\\n'\);/, `async function buildPrecisionLogBrief(content, fileName = "Attached log", precalculatedLines = null) {\n    if (!content) return "";\n    const lines = precalculatedLines || content.split('\\n');`);

// 8. getSmartLogSnippet
// getSmartLogSnippet doesn't take the full log object, it takes logs[0].content in buildLogAnalysisContext
let oldSnippetLines = `async function getSmartLogSnippet(content, limit = 300000, fileName = "Attached log") {
    if (!content) return "";
    content = normalizeLogText(content);

    const lines = content.split('\\n');`;
let newSnippetLines = `async function getSmartLogSnippet(content, limit = 300000, fileName = "Attached log", precalculatedLines = null) {
    if (!content) return "";
    const lines = precalculatedLines || content.split('\\n');`;
code = code.replace(oldSnippetLines, newSnippetLines);

// Update calls to getSmartLogSnippet in buildLogAnalysisContext
code = code.replace(/ctx \+= await getSmartLogSnippet\(logs\[0\]\.content, 350000, logs\[0\]\.name\);/, `ctx += await getSmartLogSnippet(logs[0].content, 350000, logs[0].name, logs[0].lines);`);

// Update calls to extractExceptionBlocksFromLog in buildInstallerFailureAnalysis
code = code.replace(/await extractExceptionBlocksFromLog\(log\.name, content\)/g, `await extractExceptionBlocksFromLog(log.name, content, lines)`);

// Update calls to buildPrecisionLogBrief in getSmartLogSnippet
code = code.replace(/const precisionBrief = await buildPrecisionLogBrief\(content, fileName\);/, `const precisionBrief = await buildPrecisionLogBrief(content, fileName, lines);`);

fs.writeFileSync('sidepanel.js', code);
