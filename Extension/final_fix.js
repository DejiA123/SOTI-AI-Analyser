const fs = require('fs');
let code = fs.readFileSync('sidepanel.js', 'utf8');

// 1. buildMandatoryForensicChecklist (approx 2630)
let oldMandatory = `        const fileName = log.name || "Attached log";
        const content = normalizeLogText(log.content || "");
        const fileLines = content.split('\\n');
        const phases = await extractFailurePhases(fileLines);
        const sqlTarget = extractSqlTarget(content);
        const returnMatch = content.match(/\\bMainEngineThread is returning\\s+(1603|\\d{3,5})\\b/i);`;
let newMandatory = `        const fileName = log.name || "Attached log";
        const content = log.content || "";
        const fileLines = log.lines || (content ? content.split('\\n') : []);
        const phases = await extractFailurePhases(fileLines);
        const sqlTarget = extractSqlTarget(content);
        const returnMatch = content.slice(0, 150000).match(/\\bMainEngineThread is returning\\s+(1603|\\d{3,5})\\b/i);`;
code = code.replace(oldMandatory, newMandatory);

// 2. shouldUseFocusedLogPipeline (approx 2320)
let oldShouldUse = `    return logs.some(log => {
        const content = normalizeLogText(log.content || "");
        const lineCount = content.split('\\n').length;
        if (lineCount < 3000 || !isInstallerLogContent(log.name, content)) return false;
        return /\\b(SqlException|ALTER DATABASE statement is not supported|Cannot open database|Login failed|Upgrade failed due to an unexpected exception|Location Service database deployment|MainEngineThread is returning 1603)\\b/i.test(content);`;
let newShouldUse = `    return logs.some(log => {
        const content = log.content || "";
        const lineCount = log.lines ? log.lines.length : (content.match(/\\n/g) || []).length;
        if (lineCount < 3000 || !isInstallerLogContent(log.name, content)) return false;
        return /\\b(SqlException|ALTER DATABASE statement is not supported|Cannot open database|Login failed|Upgrade failed due to an unexpected exception|Location Service database deployment|MainEngineThread is returning 1603)\\b/i.test(content.slice(0, 500000));`;
code = code.replace(oldShouldUse, newShouldUse);

// 3. collectDistinctSqlFacts (approx 2167)
let oldCollectSql = `function collectDistinctSqlFacts(lines) {
    if (typeof lines === 'string') {
        const content = normalizeLogText(lines);
        lines = content.split('\\n');
    }
    const facts = [];`;
let newCollectSql = `function collectDistinctSqlFacts(lines) {
    if (typeof lines === 'string') {
        const content = lines;
        lines = content.split('\\n');
    }
    const facts = [];`;
code = code.replace(oldCollectSql, newCollectSql);

// 4. collectCuratedFailureAnchors (approx 1653)
let oldCollectCurated = `async function collectCuratedFailureAnchors(lines) {
    if (typeof lines === 'string') {
        const content = normalizeLogText(lines);
        lines = content.split('\\n');
    }
    const anchors = [];`;
let newCollectCurated = `async function collectCuratedFailureAnchors(lines) {
    if (typeof lines === 'string') {
        const content = lines;
        lines = content.split('\\n');
    }
    const anchors = [];`;
code = code.replace(oldCollectCurated, newCollectCurated);

// 5. extractFailurePhases (approx 2800)
let oldExtractPhases = `async function extractFailurePhases(lines) {
    if (typeof lines === 'string') {
        const content = normalizeLogText(lines);
        lines = content.split('\\n');
    }
    const phases = [];`;
let newExtractPhases = `async function extractFailurePhases(lines) {
    if (typeof lines === 'string') {
        const content = lines;
        lines = content.split('\\n');
    }
    const phases = [];`;
code = code.replace(oldExtractPhases, newExtractPhases);

// 6. getLogForensicsSystemPrompt - it might do something? Let's check 2881
let oldBuildDet = `        const fileName = log.name || "Attached log";
        const content = normalizeLogText(log.content || "");
        const lines = content.split('\\n');`;
let newBuildDet = `        const fileName = log.name || "Attached log";
        const content = log.content || "";
        const lines = log.lines || (content ? content.split('\\n') : []);`;
code = code.replace(oldBuildDet, newBuildDet);

// 7. extractExceptionBlocksFromLog (approx 1624? No, we updated it to use precalculatedLines)
// Let's check the line `const lines = content.split('\n');` in buildLogPatternProfile
// It was at 2483
let oldBuildLogProfile = `async function buildLogPatternProfile(logs) {
    if (!logs || logs.length === 0) return "";
    let report = \`\\n\\n=== LOG PATTERN & KEYWORD PROFILE ===\\n\`;
    report += \`Whole-file scan using signal rules, keyword patterns, and normalized failure signatures (not line-by-line narration).\\n\`;

    for (const log of logs) {
        const fileName = log.name || "Attached log";
        const content = normalizeLogText(log.content || "");
        const lines = content.split('\\n');`;
let newBuildLogProfile = `async function buildLogPatternProfile(logs) {
    if (!logs || logs.length === 0) return "";
    let report = \`\\n\\n=== LOG PATTERN & KEYWORD PROFILE ===\\n\`;
    report += \`Whole-file scan using signal rules, keyword patterns, and normalized failure signatures (not line-by-line narration).\\n\`;

    for (const log of logs) {
        const fileName = log.name || "Attached log";
        const content = log.content || "";
        const lines = log.lines || (content ? content.split('\\n') : []);`;
code = code.replace(oldBuildLogProfile, newBuildLogProfile);

fs.writeFileSync('sidepanel.js', code);
