/* ============================================================================
 * SOTI AI Analyser — Power & Resource Governor  (power.js)
 * ============================================================================
 * WHY THIS FILE EXISTS
 * --------------------
 * The analyser does genuinely heavy work inside a browser tab: it holds whole
 * log bundles in memory, splits them into per-line arrays, builds per-line
 * classification caches, indexes a ~24MB offline knowledge corpus, spawns
 * Tesseract WASM workers for OCR, and streams from a local LLM. On a developer
 * machine that is fine. On a support engineer's 16GB laptop — already running
 * Chrome, Salesforce, Teams and Ollama holding a model resident — the same work
 * pushes the machine into swap and the whole panel freezes.
 *
 * This module is the app's own governor. It does four things:
 *
 *   1. PROFILES THE MACHINE it is running on (RAM class, core count, the V8 heap
 *      ceiling Chrome will actually grant) and derives a HARD MEMORY BUDGET in
 *      megabytes that this app is allowed to occupy on THIS machine. On the
 *      reference laptop (16GB / 8-core-16-thread Ryzen AI 7 PRO 350) that lands
 *      at ~1810MB — the "no more than ~1800MB" ceiling the app is meant to hold.
 *
 *   2. MEASURES ITSELF CONTINUOUSLY — JS heap in use against that budget, and
 *      main-thread EVENT-LOOP LAG, which is the thing the user actually feels as
 *      "the app froze". Memory pressure and CPU pressure are tracked separately
 *      and combined into one level: ok → warm → high → critical.
 *
 *   3. HANDS OUT THROTTLE SETTINGS the rest of the app reads before doing
 *      expensive work — how often to yield to the browser, how many log lines to
 *      scan per chunk, how much of the context window to fill, how many OCR
 *      workers may run at once, whether the KB index may be pre-warmed. These are
 *      recomputed live from the CURRENT level, never cached, so a caller that
 *      asks mid-analysis gets the throttle that applies right now.
 *
 *   4. RECLAIMS MEMORY under pressure. Subsystems register a reclaimer with a
 *      priority; when pressure hits high/critical the governor drops the cheapest-
 *      to-rebuild caches first (per-line intel caches, then line arrays, then the
 *      KB index) until the app is back inside its budget.
 *
 * It also keeps an INTERNAL PERFORMANCE LOG of every AI run — model, context
 * size, prompt size, time to first token, tokens/sec, peak heap, pressure at
 * start and end — plus ingest/OCR/index/reclaim events. That log is what the
 * Power Monitor panel renders, and it is what makes "why was that run slow?"
 * answerable without guessing.
 *
 * DESIGN CONSTRAINTS
 * ------------------
 *  • ZERO dependencies, no build step, loaded BEFORE sidepanel.js via a plain
 *    <script> tag. Everything the app needs hangs off window.SotiPower.
 *  • NEVER throws into a caller. Every public method is defensive: if the
 *    browser lacks performance.memory (Firefox/Safari), the governor degrades to
 *    CPU-lag-only sensing and keeps working rather than disabling itself.
 *  • The app must still run with this file ABSENT. Every call site in
 *    sidepanel.js is written as an optional bridge with a static fallback, so a
 *    missing/blocked power.js costs behaviour, not correctness.
 *  • Fully testable off-browser: createGovernor(env) accepts an injected
 *    environment, so tests/power.test.js drives the exact same code paths with a
 *    synthetic machine and a synthetic clock. No browser globals are touched at
 *    module scope beyond the final singleton construction.
 * ============================================================================ */
(function (root, factory) {
    'use strict';
    const api = factory();
    // Browser: expose the singleton the app talks to, plus the factory for tests.
    if (typeof window !== 'undefined') {
        window.SotiPower = api.governor;
        window.SotiPowerFactory = api;
    }
    // Node (tests): export the factory so a synthetic machine can be injected.
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    return api;
})(this, function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     * TUNING CONSTANTS
     * ------------------------------------------------------------------ */

    // Share of the machine's reported RAM this app may occupy. Deliberately
    // conservative: the engineer is also running Chrome itself, Salesforce, Teams
    // and — critically — Ollama with a model resident (gemma e2b ≈ 3-4GB). We are
    // one tenant on this machine, not the only one.
    const RAM_FRACTION = 0.17;

    // navigator.deviceMemory is CAPPED AT 8 by the spec for fingerprinting
    // reasons, so an 8GB laptop and a 32GB workstation both report "8". Core
    // count is the only other cheap signal that separates them, and it correlates
    // well in practice: a 16-thread mobile workstation is not an 8GB netbook.
    // This factor is therefore doing real work, not cosmetic tuning.
    const CORE_FACTOR_STEPS = [
        [16, 1.30],
        [12, 1.20],
        [8, 1.05],
        [6, 0.85],
        [4, 0.70]
    ];
    const CORE_FACTOR_MIN = 0.55;

    // Never plan to use more than this share of the ceiling V8 will actually
    // grant us. Going past it does not get us more memory — it gets us an
    // "Aw, Snap!" tab crash, which is the exact failure this module prevents.
    const HEAP_LIMIT_SHARE = 0.75;

    const BUDGET_FLOOR_MB = 256;
    const BUDGET_CEILING_MB = 3072;

    // Budget → capability tier. Tiers gear BEHAVIOUR (how many OCR workers, may
    // we pre-warm the KB index, how many cases stay hydrated); level gears
    // INTENSITY moment to moment. Both are needed: a high-tier machine under
    // momentary pressure should back off without being permanently demoted.
    const TIER_STEPS = [
        [1600, 'high'],
        [1000, 'balanced'],
        [600, 'low']
    ];
    const TIER_MIN = 'minimal';

    // Memory pressure thresholds, as a ratio of used heap to our budget.
    const MEM_WARM = 0.70;
    const MEM_HIGH = 0.85;
    const MEM_CRITICAL = 0.95;

    // Event-loop lag thresholds in ms. Lag is measured as the overshoot of a
    // self-scheduling timer: if we asked to be woken in 1000ms and were woken in
    // 1420ms, 420ms of main-thread work ran without yielding. Above ~150ms the
    // panel visibly stutters; above ~400ms it is what a user calls "frozen".
    const LAG_WARM = 50;
    const LAG_HIGH = 150;
    const LAG_CRITICAL = 400;

    const LEVELS = ['ok', 'warm', 'high', 'critical'];
    const LEVEL_RANK = { ok: 0, warm: 1, high: 2, critical: 3 };

    // Sampling cadence. Fast while the app is doing work, slow when idle — the
    // monitor itself must not become a source of the load it is measuring.
    const SAMPLE_MS_ACTIVE = 2000;
    const SAMPLE_MS_IDLE = 6000;

    // Minimum gap between reclaim sweeps. Without this, a run that legitimately
    // sits at 'high' for a minute would fire the reclaimers dozens of times,
    // repeatedly throwing away caches the run is actively rebuilding — turning a
    // memory problem into a CPU problem.
    const RECLAIM_COOLDOWN_MS = 8000;

    const PERF_RING_SIZE = 250;

    /* ------------------------------------------------------------------ *
     * SMALL HELPERS
     * ------------------------------------------------------------------ */

    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
    const MB = 1024 * 1024;

    function coreFactor(cores) {
        const c = Number(cores) || 0;
        for (const [threshold, factor] of CORE_FACTOR_STEPS) {
            if (c >= threshold) return factor;
        }
        return CORE_FACTOR_MIN;
    }

    function tierForBudget(budgetMB) {
        for (const [threshold, tier] of TIER_STEPS) {
            if (budgetMB >= threshold) return tier;
        }
        return TIER_MIN;
    }

    function worstLevel(a, b) {
        return (LEVEL_RANK[a] || 0) >= (LEVEL_RANK[b] || 0) ? a : b;
    }

    function memLevelFor(ratio) {
        if (ratio >= MEM_CRITICAL) return 'critical';
        if (ratio >= MEM_HIGH) return 'high';
        if (ratio >= MEM_WARM) return 'warm';
        return 'ok';
    }

    function cpuLevelFor(lagMs) {
        if (lagMs >= LAG_CRITICAL) return 'critical';
        if (lagMs >= LAG_HIGH) return 'high';
        if (lagMs >= LAG_WARM) return 'warm';
        return 'ok';
    }

    function formatMB(mb) {
        if (!isFinite(mb)) return '—';
        if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
        return Math.round(mb) + ' MB';
    }

    function formatMs(ms) {
        if (!isFinite(ms) || ms < 0) return '—';
        if (ms >= 60000) return (ms / 60000).toFixed(1) + ' min';
        if (ms >= 1000) return (ms / 1000).toFixed(1) + ' s';
        return Math.round(ms) + ' ms';
    }

    /* ------------------------------------------------------------------ *
     * MACHINE PROFILING
     * ------------------------------------------------------------------ *
     * Everything here is a BEST-EFFORT read of an optional API. A browser that
     * exposes none of them still produces a usable (conservative) profile — it
     * just lands on the low tier, which is the safe direction to be wrong in.
     */
    function profileMachine(env) {
        const nav = env.navigator || {};
        const perf = env.performance || {};

        // navigator.deviceMemory: GiB of RAM, rounded to a power of two and
        // CAPPED AT 8. Absent in Firefox/Safari → assume a modest 4GB machine
        // rather than optimistically assuming a big one.
        const rawDeviceMemory = Number(nav.deviceMemory) || 0;
        const deviceMemoryGB = rawDeviceMemory > 0 ? rawDeviceMemory : 4;
        const deviceMemoryReported = rawDeviceMemory > 0;

        // navigator.hardwareConcurrency: LOGICAL processors (threads), so the
        // reference Ryzen AI 7 PRO 350 (8 cores / 16 threads) reports 16.
        const rawCores = Number(nav.hardwareConcurrency) || 0;
        const cores = rawCores > 0 ? rawCores : 4;
        const coresReported = rawCores > 0;

        // performance.memory.jsHeapSizeLimit: the hard ceiling V8 will grant this
        // renderer. Chrome desktop 64-bit is typically ~2GB or ~4GB. This is the
        // number that decides whether our RAM-derived budget is even reachable.
        const mem = perf.memory || null;
        const heapLimitMB = mem && mem.jsHeapSizeLimit ? mem.jsHeapSizeLimit / MB : 0;

        // ---- THE BUDGET ----
        const ramBudget = deviceMemoryGB * 1024 * RAM_FRACTION * coreFactor(cores);
        const heapCap = heapLimitMB > 0 ? heapLimitMB * HEAP_LIMIT_SHARE : Infinity;
        const budgetMB = Math.round(clamp(Math.min(ramBudget, heapCap), BUDGET_FLOOR_MB, BUDGET_CEILING_MB));

        // Why did we land on this number? Surfaced in the monitor UI so the
        // budget is explainable rather than magic.
        let limitedBy = 'ram';
        if (heapCap < ramBudget) limitedBy = 'heap';
        if (budgetMB === BUDGET_FLOOR_MB && Math.min(ramBudget, heapCap) < BUDGET_FLOOR_MB) limitedBy = 'floor';
        if (budgetMB === BUDGET_CEILING_MB && Math.min(ramBudget, heapCap) > BUDGET_CEILING_MB) limitedBy = 'ceiling';

        return {
            deviceMemoryGB,
            deviceMemoryReported,
            cores,
            coresReported,
            coreFactor: coreFactor(cores),
            heapLimitMB: Math.round(heapLimitMB),
            heapMeasurable: !!mem,
            ramBudgetMB: Math.round(ramBudget),
            budgetMB,
            budgetBytes: budgetMB * MB,
            limitedBy,
            tier: tierForBudget(budgetMB),
            platform: nav.platform || nav.userAgentData?.platform || 'unknown',
            ua: typeof nav.userAgent === 'string' ? nav.userAgent.slice(0, 180) : ''
        };
    }

    /* ------------------------------------------------------------------ *
     * THE GOVERNOR
     * ------------------------------------------------------------------ */
    function createGovernor(env) {
        env = env || {};
        const perf = env.performance || { now: () => Date.now() };
        const now = () => (typeof perf.now === 'function' ? perf.now() : Date.now());
        const setTimer = env.setTimeout || ((fn, ms) => setTimeout(fn, ms));
        const clearTimer = env.clearTimeout || ((h) => clearTimeout(h));

        const profile = profileMachine(env);

        const state = {
            running: false,
            timer: null,
            usedMB: 0,
            peakMB: 0,
            ratio: 0,
            lagMs: 0,
            memLevel: 'ok',
            cpuLevel: 'ok',
            level: 'ok',
            samples: 0,
            lastSampleAt: 0,
            lastScheduledAt: 0,
            scheduledDelay: 0,
            activeUntil: 0,        // "busy" hint — while set, sample fast
            // -Infinity, not 0: the cooldown is a gap between SWEEPS, and with 0
            // the very first pressure event was suppressed because
            // performance.now() is near zero right after load — exactly when a
            // heavy startup ingest is most likely to need reclaiming.
            lastReclaimAt: -Infinity,
            reclaimCount: 0,
            reclaimedBytes: 0,
            history: []            // recent samples, for the monitor sparkline
        };

        const listeners = new Set();
        const reclaimers = [];

        /* -------------------- measurement -------------------- */

        // Read the JS heap. NOTE for anyone reading the monitor: this is the V8
        // heap only. Detached DOM nodes, WASM linear memory (Tesseract), image
        // bitmaps and the network stack live outside it, so the real process
        // footprint is higher. We govern against the number we can actually read
        // and act on — and the budget's HEAP_LIMIT_SHARE leaves the difference.
        function readHeapMB() {
            const m = env.performance && env.performance.memory;
            if (!m || typeof m.usedJSHeapSize !== 'number') return null;
            return m.usedJSHeapSize / MB;
        }

        function takeSample() {
            const t = now();

            // Event-loop lag: how much later than requested did this tick run?
            let lag = 0;
            if (state.lastScheduledAt && state.scheduledDelay) {
                lag = Math.max(0, (t - state.lastScheduledAt) - state.scheduledDelay);
            }

            const used = readHeapMB();
            if (used !== null) {
                state.usedMB = used;
                if (used > state.peakMB) state.peakMB = used;
                state.ratio = profile.budgetMB > 0 ? used / profile.budgetMB : 0;
                state.memLevel = memLevelFor(state.ratio);
                // Feed the peak of any run currently in flight. Without this a
                // run's "peak heap" was only ever the reading at its start and
                // end, so the spike in the middle — the thing that made the
                // machine stutter — never appeared in the performance log.
                perfLog._touchOpen(used);
            } else {
                // No heap API — CPU lag is the only sensor we have. Report the
                // memory side as unknown rather than pretending it is fine.
                state.memLevel = 'ok';
                state.ratio = 0;
            }

            state.lagMs = lag;
            state.cpuLevel = cpuLevelFor(lag);

            const next = worstLevel(state.memLevel, state.cpuLevel);
            const changed = next !== state.level;
            state.level = next;
            state.samples++;
            state.lastSampleAt = t;

            state.history.push({ at: t, usedMB: state.usedMB, lagMs: lag, level: next });
            if (state.history.length > 120) state.history.shift();

            if (changed) emit();

            // Pressure response. Only 'high' and 'critical' reclaim; 'warm' is
            // handled by the throttle knobs alone, which is a far cheaper lever
            // than throwing away caches.
            if (next === 'high' || next === 'critical') {
                maybeReclaim(t);
            }

            return snapshot();
        }

        function scheduleNext() {
            if (!state.running) return;
            const busy = state.activeUntil > now();
            const delay = busy ? SAMPLE_MS_ACTIVE : SAMPLE_MS_IDLE;
            state.lastScheduledAt = now();
            state.scheduledDelay = delay;
            state.timer = setTimer(() => {
                state.timer = null;
                try { takeSample(); } catch (e) { /* sensing must never break the app */ }
                scheduleNext();
            }, delay);
        }

        function emit() {
            const snap = snapshot();
            listeners.forEach(fn => {
                try { fn(snap); } catch (e) { /* a bad listener must not stop the rest */ }
            });
        }

        function snapshot() {
            return {
                usedMB: state.usedMB,
                peakMB: state.peakMB,
                budgetMB: profile.budgetMB,
                ratio: state.ratio,
                lagMs: state.lagMs,
                level: state.level,
                memLevel: state.memLevel,
                cpuLevel: state.cpuLevel,
                tier: profile.tier,
                samples: state.samples,
                heapMeasurable: profile.heapMeasurable,
                reclaimCount: state.reclaimCount,
                reclaimedMB: state.reclaimedBytes / MB,
                at: state.lastSampleAt
            };
        }

        /* -------------------- reclaim -------------------- */

        // A reclaimer is a subsystem's offer to give memory back. `priority` is
        // the ORDER OF SACRIFICE: lower number = dropped first, because it is
        // cheapest to rebuild. Per-line intel caches (priority 10) are pure
        // derived data recomputed in seconds; the KB index (priority 60) costs a
        // 24MB re-parse; a case's own log text is never registered at all,
        // because losing it would lose the user's work.
        function registerReclaimer(spec) {
            if (!spec || typeof spec.reclaim !== 'function') return () => {};
            const entry = {
                name: spec.name || 'anonymous',
                priority: typeof spec.priority === 'number' ? spec.priority : 50,
                minLevel: spec.minLevel || 'high',
                reclaim: spec.reclaim
            };
            reclaimers.push(entry);
            reclaimers.sort((a, b) => a.priority - b.priority);
            return function unregister() {
                const i = reclaimers.indexOf(entry);
                if (i >= 0) reclaimers.splice(i, 1);
            };
        }

        function maybeReclaim(t) {
            if (t - state.lastReclaimAt < RECLAIM_COOLDOWN_MS) return;
            state.lastReclaimAt = t;
            // Fire and forget: reclaim is async (a reclaimer may await), but the
            // sampler must not block on it.
            reclaim(state.level).catch(() => {});
        }

        // Run reclaimers in sacrifice order. Returns bytes freed.
        //
        // TWO MODES, and the difference matters:
        //  • AUTOMATIC (the sampler's response to pressure) stops as soon as the
        //    app is back under the warm threshold. Dropping more than needed just
        //    means rebuilding it, turning a memory problem into a CPU one.
        //  • FORCED (`{ force: true }` — the user pressed "Free memory now", or
        //    admission control is trying to make room for an upload) runs the
        //    WHOLE sweep. Without this, an explicit request did nothing whenever
        //    the app happened to be comfortably under budget at that moment,
        //    which is exactly when a user asks for room before a big upload.
        async function reclaim(level, opts) {
            level = level || state.level;
            const force = !!(opts && opts.force);
            let freed = 0;
            const ran = [];
            for (const r of reclaimers) {
                if (LEVEL_RANK[level] < LEVEL_RANK[r.minLevel]) continue;
                let got = 0;
                try {
                    got = await r.reclaim({ level, force, budgetMB: profile.budgetMB, usedMB: state.usedMB }) || 0;
                } catch (e) {
                    got = 0;
                }
                if (got > 0) {
                    freed += got;
                    ran.push({ name: r.name, bytes: got });
                }
                if (force) continue;
                // Re-read the heap between reclaimers: if dropping the cheap
                // caches already brought us home, do not also throw away the
                // expensive KB index.
                const used = readHeapMB();
                if (used !== null && profile.budgetMB > 0 && used / profile.budgetMB < MEM_WARM) break;
            }
            if (freed > 0) {
                state.reclaimCount++;
                state.reclaimedBytes += freed;
                perfLog.mark('reclaim', {
                    level,
                    forced: force,
                    freedMB: +(freed / MB).toFixed(1),
                    ran: ran.map(x => `${x.name}:${Math.round(x.bytes / MB)}MB`).join(', ')
                });
                emit();
            }
            return freed;
        }

        /* -------------------- throttle knobs -------------------- *
         * ALWAYS COMPUTED LIVE. An earlier revision cached these at construction
         * and the app kept using an 'ok' throttle for a whole analysis that had
         * long since gone critical — the governor could see the pressure and did
         * nothing about it. `knobs` is a getter for exactly that reason.
         */

        const TIER_YIELD_MS = { minimal: 12, low: 16, balanced: 20, high: 24 };
        const TIER_CHUNK = { minimal: 500, low: 1000, balanced: 2000, high: 4000 };
        const TIER_OCR = { minimal: 1, low: 1, balanced: 2, high: 3 };
        const TIER_CASES = { minimal: 1, low: 1, balanced: 2, high: 3 };
        const TIER_PROMPT_CAP = { minimal: 0.60, low: 0.80, balanced: 1.0, high: 1.0 };

        const LEVEL_YIELD_MUL = { ok: 1.0, warm: 0.8, high: 0.6, critical: 0.45 };
        const LEVEL_CHUNK_MUL = { ok: 1.0, warm: 0.7, high: 0.5, critical: 0.3 };
        const LEVEL_PROMPT_MUL = { ok: 1.0, warm: 0.85, high: 0.70, critical: 0.55 };
        const LEVEL_ANSWER_MUL = { ok: 1.0, warm: 0.90, high: 0.75, critical: 0.60 };
        const LEVEL_LOGBYTES_MUL = { ok: 1.0, warm: 0.85, high: 0.6, critical: 0.4 };

        function computeKnobs() {
            const tier = profile.tier;
            const lvl = state.level;

            return {
                // How often a hot loop should hand the main thread back. Under
                // pressure we yield MORE often (smaller number) so the panel keeps
                // painting even while a 150k-line bundle is being classified.
                yieldEveryMs: Math.round(clamp(TIER_YIELD_MS[tier] * LEVEL_YIELD_MUL[lvl], 8, 32)),

                // Lines processed between yields in the log scanners.
                chunkLines: Math.max(200, Math.round(TIER_CHUNK[tier] * LEVEL_CHUNK_MUL[lvl])),

                // Multiplier applied to the computed prompt char budget. Shrinking
                // the prompt is the single most effective CPU lever available: on a
                // CPU-bound model prefill cost scales with prompt tokens.
                promptScale: +(TIER_PROMPT_CAP[tier] * LEVEL_PROMPT_MUL[lvl]).toFixed(3),

                // Multiplier on num_predict. Kept gentler than promptScale — a
                // truncated answer is a worse failure than a slow one.
                answerScale: +LEVEL_ANSWER_MUL[lvl].toFixed(3),

                // Concurrent Tesseract WASM workers. Each one is a fresh WASM
                // instance with its own linear memory (~80-150MB with the English
                // traineddata loaded), so N images previously meant N× that.
                maxOcrWorkers: Math.max(1, LEVEL_RANK[lvl] >= LEVEL_RANK.high
                    ? Math.floor(TIER_OCR[tier] / 2) || 1
                    : TIER_OCR[tier]),

                // Ceiling on total resident log TEXT across all hydrated cases.
                maxResidentLogBytes: Math.round(profile.budgetBytes * 0.25 * LEVEL_LOGBYTES_MUL[lvl]),

                // Cases whose log text may stay hydrated at once. The rest are
                // metadata-only until opened.
                maxHydratedCases: TIER_CASES[tier],

                // Whether to pay the 24MB knowledge-corpus parse at startup on
                // spec. On a low-tier machine, or while already under pressure,
                // we defer it to the first question that actually needs it.
                prewarmKb: (tier === 'balanced' || tier === 'high') && LEVEL_RANK[lvl] <= LEVEL_RANK.warm,

                // Advisory for the UI/caller.
                level: lvl,
                tier: tier
            };
        }

        /* -------------------- internal performance log -------------------- *
         * The "internal logging of the AI tool" — a ring buffer of timed events.
         * A run is opened with perf.start() and closed with handle.end(); the
         * governor stamps heap and pressure at both ends, so a slow run can be
         * attributed to prompt size, model, or machine pressure after the fact.
         */
        const perfLog = (function () {
            const entries = [];
            let seq = 0;

            function push(entry) {
                entries.push(entry);
                if (entries.length > PERF_RING_SIZE) entries.shift();
                return entry;
            }

            return {
                // Open a timed span. Returns a handle whose .end() closes it.
                start(kind, meta) {
                    const startedAt = now();
                    const entry = push({
                        id: ++seq,
                        kind: kind || 'run',
                        meta: Object.assign({}, meta || {}),
                        startedAt,
                        wallStart: Date.now(),
                        startHeapMB: state.usedMB,
                        startLevel: state.level,
                        open: true,
                        ms: 0,
                        ttftMs: null,
                        tokens: null,
                        tps: null,
                        endHeapMB: null,
                        peakHeapMB: state.usedMB,
                        endLevel: null,
                        error: null
                    });
                    // Tell the sampler we are busy so it samples on the fast
                    // cadence for the duration of the run.
                    markActive(120000);

                    let firstTokenAt = null;
                    return {
                        entry,
                        // Call on the first streamed token — this is the number
                        // that tells prefill cost apart from generation cost.
                        firstToken() {
                            if (firstTokenAt !== null) return;
                            firstTokenAt = now();
                            entry.ttftMs = Math.round(firstTokenAt - startedAt);
                        },
                        // Optional running peak, cheap enough to call per chunk.
                        touch() {
                            if (state.usedMB > entry.peakHeapMB) entry.peakHeapMB = state.usedMB;
                        },
                        end(extra) {
                            if (!entry.open) return entry;
                            const t = now();
                            entry.open = false;
                            entry.ms = Math.round(t - startedAt);
                            entry.endHeapMB = state.usedMB;
                            entry.endLevel = state.level;
                            if (state.usedMB > entry.peakHeapMB) entry.peakHeapMB = state.usedMB;
                            Object.assign(entry, extra || {});
                            // tokens/sec measured over GENERATION only (excluding
                            // prefill) when we know when the first token landed —
                            // otherwise it flatters a slow prefill.
                            if (typeof entry.tokens === 'number' && entry.tokens > 0) {
                                const genMs = entry.ttftMs !== null ? (entry.ms - entry.ttftMs) : entry.ms;
                                entry.tps = genMs > 0 ? +(entry.tokens / (genMs / 1000)).toFixed(2) : null;
                            }
                            return entry;
                        }
                    };
                },

                // A point-in-time event (ingest, OCR, index build, reclaim).
                mark(kind, data) {
                    return push({
                        id: ++seq,
                        kind: kind || 'event',
                        meta: Object.assign({}, data || {}),
                        startedAt: now(),
                        wallStart: Date.now(),
                        startHeapMB: state.usedMB,
                        startLevel: state.level,
                        open: false,
                        ms: (data && typeof data.ms === 'number') ? data.ms : 0,
                        ttftMs: null,
                        tokens: null,
                        tps: null,
                        endHeapMB: state.usedMB,
                        peakHeapMB: state.usedMB,
                        endLevel: state.level,
                        error: null
                    });
                },

                entries() { return entries.slice(); },

                // Called by the sampler on every tick so an open run's peak heap
                // reflects the whole run, not just its endpoints.
                _touchOpen(usedMB) {
                    for (let i = entries.length - 1; i >= 0; i--) {
                        const e = entries[i];
                        if (!e.open) continue;
                        if (usedMB > e.peakHeapMB) e.peakHeapMB = usedMB;
                    }
                },

                // Aggregate view for the monitor panel: per-kind counts, median
                // and worst duration. Median, not mean — one 4-minute cold-start
                // run should not make every subsequent run look slow.
                summary() {
                    const byKind = {};
                    for (const e of entries) {
                        if (e.open) continue;
                        const k = e.kind;
                        if (!byKind[k]) byKind[k] = { kind: k, count: 0, totalMs: 0, worstMs: 0, durations: [], errors: 0 };
                        const b = byKind[k];
                        b.count++;
                        b.totalMs += e.ms;
                        b.durations.push(e.ms);
                        if (e.ms > b.worstMs) b.worstMs = e.ms;
                        if (e.error) b.errors++;
                    }
                    return Object.values(byKind).map(b => {
                        const sorted = b.durations.slice().sort((x, y) => x - y);
                        const mid = Math.floor(sorted.length / 2);
                        const median = sorted.length === 0 ? 0
                            : (sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2));
                        return {
                            kind: b.kind,
                            count: b.count,
                            medianMs: median,
                            worstMs: b.worstMs,
                            totalMs: b.totalMs,
                            errors: b.errors
                        };
                    }).sort((a, b) => b.totalMs - a.totalMs);
                },

                clear() { entries.length = 0; }
            };
        })();

        /* -------------------- activity hint -------------------- */

        // Tell the governor real work is happening, so it samples on the fast
        // cadence. Called by send(), log ingest, OCR and index builds.
        function markActive(ms) {
            state.activeUntil = now() + (ms || 15000);
        }

        /* -------------------- admission control -------------------- */

        // Would holding `bytes` more take us past the budget? Used by the log
        // ingest path to refuse a bundle that would blow the machine up BEFORE
        // reading it into memory, rather than crashing halfway through.
        function canAllocate(bytes) {
            const used = readHeapMB();
            if (used === null) return { ok: true, reason: 'unmeasurable' };
            const projectedMB = used + (bytes / MB);
            if (projectedMB <= profile.budgetMB * MEM_HIGH) return { ok: true, projectedMB, reason: 'fits' };
            if (projectedMB <= profile.budgetMB) return { ok: true, projectedMB, reason: 'tight' };
            return {
                ok: false,
                projectedMB,
                reason: 'over-budget',
                message: `This would take the app to about ${formatMB(projectedMB)}, past its ${formatMB(profile.budgetMB)} budget on this machine.`
            };
        }

        /* -------------------- lifecycle -------------------- */

        function start() {
            if (state.running) return governor;
            state.running = true;
            // Prime the heap reading immediately so the first UI paint is real.
            try {
                const used = readHeapMB();
                if (used !== null) {
                    state.usedMB = used;
                    state.peakMB = used;
                    state.ratio = profile.budgetMB > 0 ? used / profile.budgetMB : 0;
                    state.memLevel = memLevelFor(state.ratio);
                    state.level = state.memLevel;
                }
            } catch (e) { /* ignore */ }
            scheduleNext();
            return governor;
        }

        function stop() {
            state.running = false;
            if (state.timer) { clearTimer(state.timer); state.timer = null; }
            return governor;
        }

        /* -------------------- public surface -------------------- */

        const governor = {
            profile,
            perf: perfLog,

            get tier() { return profile.tier; },
            get budgetMB() { return profile.budgetMB; },
            get level() { return state.level; },
            get knobs() { return computeKnobs(); },
            get running() { return state.running; },

            start,
            stop,
            sample: takeSample,
            snapshot,
            markActive,
            canAllocate,
            registerReclaimer,
            reclaim,

            onChange(fn) {
                if (typeof fn !== 'function') return () => {};
                listeners.add(fn);
                return () => listeners.delete(fn);
            },

            history() { return state.history.slice(); },

            // Formatting helpers, shared with the monitor UI so the panel and the
            // console agree on units.
            format: { mb: formatMB, ms: formatMs },

            // Test seams — deliberately exposed rather than reached into via
            // closure tricks, so the tests exercise the same code the app does.
            _state: state,
            _setLevelForTest(level) {
                state.level = level;
                state.memLevel = level;
                emit();
            }
        };

        return governor;
    }

    /* ------------------------------------------------------------------ *
     * SINGLETON
     * ------------------------------------------------------------------ */
    const browserEnv = (typeof window !== 'undefined') ? {
        navigator: typeof navigator !== 'undefined' ? navigator : {},
        performance: typeof performance !== 'undefined' ? performance : {},
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h)
    } : null;

    const governor = browserEnv ? createGovernor(browserEnv) : null;
    if (governor) {
        try { governor.start(); } catch (e) { /* never block app boot */ }
    }

    return {
        governor,
        createGovernor,
        profileMachine,
        // Constants the tests assert against, so a tuning change is a visible
        // diff in one place rather than a silent behaviour drift.
        constants: {
            RAM_FRACTION, CORE_FACTOR_STEPS, CORE_FACTOR_MIN, HEAP_LIMIT_SHARE,
            BUDGET_FLOOR_MB, BUDGET_CEILING_MB, TIER_STEPS, TIER_MIN,
            MEM_WARM, MEM_HIGH, MEM_CRITICAL, LAG_WARM, LAG_HIGH, LAG_CRITICAL,
            LEVELS, LEVEL_RANK, SAMPLE_MS_ACTIVE, SAMPLE_MS_IDLE,
            RECLAIM_COOLDOWN_MS, PERF_RING_SIZE
        },
        helpers: { clamp, coreFactor, tierForBudget, worstLevel, memLevelFor, cpuLevelFor, formatMB, formatMs }
    };
});
