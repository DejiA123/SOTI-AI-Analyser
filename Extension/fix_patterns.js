const fs = require('fs');
let code = fs.readFileSync('sidepanel.js', 'utf8');

// 1. extractSqlTarget
code = code.replace(/function extractSqlTarget\(text\) \{[\s\S]*?    const explicitPatterns = \[/m, `function extractSqlTarget(text) {
    const slice = (text || "").slice(0, 120000);
    const candidates = [];
    const addCandidate = value => {
        const cleaned = (value || "").trim().replace(/^['"]|['"].*$/g, "");
        if (cleaned && !candidates.includes(cleaned)) candidates.push(cleaned);
    };

    const explicitPatterns = [`);

code = code.replace(/while \(\(m = p\.exec\(text \|\| ""\)\) !== null\) addCandidate\(m\[1\]\);/g, `while ((m = p.exec(slice)) !== null) addCandidate(m[1]);`);

code = code.replace(/const m1 = \(text \|\| ""\)\.match\(/g, `const m1 = slice.match(`);
code = code.replace(/const m2 = \(text \|\| ""\)\.match\(/g, `const m2 = slice.match(`);

// 2. extractMachineName
code = code.replace(/function extractMachineName\(text\) \{[\s\S]*?    for \(const p of patterns\) \{/m, `function extractMachineName(text) {
    const slice = (text || "").slice(0, 120000);
    const patterns = [
        /\\b(?:ComputerName|MachineName|Server Name|Hostname|Host)\\s*[:=]\\s*([A-Za-z0-9_.-]+)/i,
        /\\bServer\\s+\`?([A-Z0-9_.-]{4,})\`?/i
    ];
    for (const p of patterns) {`);

code = code.replace(/const m = \(text \|\| ""\)\.match\(p\);/g, `const m = slice.match(p);`);

// 3. buildLogPatternProfile
let oldProfile = `        const exceptionTypes = new Set();

        for (let idx = 0; idx < lines.length; idx++) {
            const line = lines[idx];
            if (idx % 200 === 0 && idx > 0) {
                await new Promise(r => setTimeout(r, 0));
            }
            const intel = classifyLogLine(line);`;

let newProfile = `        const exceptionTypes = new Set();
        const patternCounts = {};
        LOG_PATTERN_CHECKS.forEach(c => patternCounts[c.label] = 0);
        let returnCode = "";

        for (let idx = 0; idx < lines.length; idx++) {
            const line = lines[idx];
            if (idx % 200 === 0 && idx > 0) {
                await new Promise(r => setTimeout(r, 0));
            }
            
            for (const check of LOG_PATTERN_CHECKS) {
                const hits = line.match(check.regex);
                if (hits) patternCounts[check.label] += hits.length;
            }
            if (!returnCode) {
                const rm = line.match(/\\bMainEngineThread is returning\\s+(1603|\\d{3,5})\\b/i);
                if (rm) returnCode = rm[1];
            }

            const intel = classifyLogLine(line);`;
code = code.replace(oldProfile, newProfile);

let oldProfileBottom = `        const returnMatch = content.match(/\\bMainEngineThread is returning\\s+(1603|\\d{3,5})\\b/i);
        if (returnMatch) report += \`MSI return code pattern: \${returnMatch[1]}\\n\`;

        report += \`\\n### Pattern detection\\n\`;
        LOG_PATTERN_CHECKS.forEach(check => {
            const count = (content.match(check.regex) || []).length;
            report += count > 0
                ? \`- \${check.label}: **detected** (\${count} match(es))\\n\`
                : \`- \${check.label}: not detected\\n\`;
        });`;

let newProfileBottom = `        if (returnCode) report += \`MSI return code pattern: \${returnCode}\\n\`;

        report += \`\\n### Pattern detection\\n\`;
        LOG_PATTERN_CHECKS.forEach(check => {
            const count = patternCounts[check.label];
            report += count > 0
                ? \`- \${check.label}: **detected** (\${count} match(es))\\n\`
                : \`- \${check.label}: not detected\\n\`;
        });`;
code = code.replace(oldProfileBottom, newProfileBottom);

// 4. buildInstallerPatternSummary
let oldSummary = /function buildInstallerPatternSummary[\s\S]*?=== END INSTALLER PATTERN SUMMARY ===\\n`;\s*return report;\s*}/m;
let newSummary = `async function buildInstallerPatternSummary(logs) {
    if (!logs || logs.length === 0) return "";
    let combinedHeader = "";
    let returnCode = "";
    const patternCounts = {};
    LOG_PATTERN_CHECKS.forEach(c => patternCounts[c.label] = 0);

    for (const log of logs) {
        const content = normalizeLogText(log.content || "");
        combinedHeader += content.slice(0, 100000) + "\\n";
        const lines = content.split('\\n');
        for (let i = 0; i < lines.length; i++) {
            if (i % 200 === 0 && i > 0) await new Promise(r => setTimeout(r, 0));
            const line = lines[i];
            for (const check of LOG_PATTERN_CHECKS) {
                const hits = line.match(check.regex);
                if (hits) patternCounts[check.label] += hits.length;
            }
            if (!returnCode) {
                const rc = line.match(/\\bMainEngineThread is returning\\s+(1603|\\d{3,5})\\b/i);
                if (rc) returnCode = rc[1];
            }
        }
    }

    if (!/\\b(SetupSOTI|MSI|Windows Installer|CustomAction|Return 1603|Deploy[A-Za-z]*Database|DbUp)\\b/i.test(combinedHeader)) return "";

    const product = logs.map(l => inferProductFromLogName(l.name || "", l.content || "")).find(Boolean) || "SOTI installer";
    const sqlTarget = extractSqlTarget(combinedHeader);
    const azureSql = /\\.database\\.windows\\.net\\b/i.test(sqlTarget || combinedHeader);

    let report = \`\\n\\n=== INSTALLER PATTERN SUMMARY ===\\n\`;
    report += \`Product: \${product}\${returnCode ? \` | MSI return: \${returnCode}\` : ""}\\n\`;
    if (sqlTarget) report += \`SQL target: \${sqlTarget}\${azureSql ? " (Azure SQL)" : ""}\\n\`;

    const detected = LOG_PATTERN_CHECKS
        .map(c => ({ label: c.label, count: patternCounts[c.label] }))
        .filter(x => x.count > 0)
        .sort((a, b) => b.count - a.count);

    report += \`\\nActive installer failure patterns:\\n\`;
    detected.forEach(p => { report += \`- \${p.label} (\${p.count}×)\\n\`; });

    if (azureSql && detected.some(p => /ALTER DATABASE/i.test(p.label))) {
        report += \`\\nLikely root-cause pattern: Azure SQL host + unsupported ALTER DATABASE / RECOVERY SIMPLE during Location Service migration.\\n\`;
    } else if (detected.some(p => /SqlException|ALTER DATABASE/i.test(p.label))) {
        report += \`\\nLikely root-cause pattern: SQL migration/deployment failure during installer custom action.\\n\`;
    }
    report += \`=== END INSTALLER PATTERN SUMMARY ===\\n\`;
    return report;
}`;
code = code.replace(oldSummary, newSummary);

// 5. getSmartLogSnippet (await buildInstallerPatternSummary)
code = code.replace(/focused \+= buildInstallerPatternSummary\(\[\{ name: fileName, content \}\]\);/, `focused += await buildInstallerPatternSummary([{ name: fileName, content }]);`);

fs.writeFileSync('sidepanel.js', code);
