'use strict';

/**
 * metrics.js — Time-bucketed metrics store for FreeDeepseekAPI dashboard.
 *
 * Design:
 *  - Events are aggregated into 5-minute buckets (aligned to the clock,
 *    e.g. 10:00, 10:05, 10:10... UTC).
 *  - Persisted to a JSON file (METRICS_FILE) so stats survive restarts.
 *  - Retention: buckets older than METRICS_RETENTION_DAYS (30) are pruned
 *    on load and on every persist.
 *
 * Bucket shape:
 * {
 *   ts: 1785957600000,            // bucket start (ms epoch)
 *   calls: 0,                     // total /v1/* requests
 *   tokensPrompt: 0, tokensCompletion: 0, tokensReasoning: 0,
 *   errors: 0,                    // HTTP >= 400 / server errors
 *   toolErrors: 0,                // tool-call parse failures
 *   toolCalls: 0,                 // successful tool calls parsed
 *   byEndpoint: { '/v1/chat/completions': 0, ... }
 * }
 */

const fs = require('fs');
const path = require('path');

const BUCKET_MS = 5 * 60 * 1000;                 // 5 minutes
const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 3600 * 1000;
const METRICS_FILE = path.join(__dirname, 'metrics.json');

let buckets = new Map(); // ts -> bucket object

function bucketStart(ts = Date.now()) {
    return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

function ensureBucket(ts = Date.now()) {
    const start = bucketStart(ts);
    if (!buckets.has(start)) {
        buckets.set(start, {
            ts: start,
            calls: 0,
            tokensPrompt: 0,
            tokensCompletion: 0,
            tokensReasoning: 0,
            errors: 0,
            toolErrors: 0,
            toolCalls: 0,
            byEndpoint: {},
        });
    }
    return buckets.get(start);
}

function prune() {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [ts, _b] of buckets) {
        if (ts < cutoff) buckets.delete(ts);
    }
}

function recordCall(endpoint = 'unknown', { tokensPrompt = 0, tokensCompletion = 0, tokensReasoning = 0 } = {}) {
    const b = ensureBucket();
    b.calls++;
    b.byEndpoint[endpoint] = (b.byEndpoint[endpoint] || 0) + 1;
    b.tokensPrompt += tokensPrompt;
    b.tokensCompletion += tokensCompletion;
    b.tokensReasoning += tokensReasoning;
}

/** Add token usage to the current bucket WITHOUT incrementing the call count
 *  (used when the call was already counted at request start). */
function recordTokens({ tokensPrompt = 0, tokensCompletion = 0, tokensReasoning = 0 } = {}) {
    const b = ensureBucket();
    b.tokensPrompt += tokensPrompt;
    b.tokensCompletion += tokensCompletion;
    b.tokensReasoning += tokensReasoning;
}

function recordError(endpoint = 'unknown') {
    const b = ensureBucket();
    b.errors++;
    b.byEndpoint[endpoint] = (b.byEndpoint[endpoint] || 0) + 1;
}

function recordToolError() {
    ensureBucket().toolErrors++;
}

function recordToolCall() {
    ensureBucket().toolCalls++;
}

/**
 * Serialize buckets into a compact JSON array (sorted oldest->newest).
 * @returns {Array} serializable array
 */
function serialize() {
    prune();
    const arr = [...buckets.values()].sort((a, b) => a.ts - b.ts);
    return arr.map(b => ({
        ts: b.ts,
        calls: b.calls,
        tp: b.tokensPrompt,
        tc: b.tokensCompletion,
        tr: b.tokensReasoning,
        err: b.errors,
        terr: b.toolErrors,
        tcalls: b.toolCalls,
        ep: b.byEndpoint,
    }));
}

function persist() {
    try {
        prune();
        const tmp = METRICS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(serialize()), 'utf8');
        fs.renameSync(tmp, METRICS_FILE);
    } catch (e) {
        console.log(`[metrics] persist failed: ${e.message}`);
    }
}

function load() {
    try {
        if (!fs.existsSync(METRICS_FILE)) return;
        const arr = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
        buckets = new Map();
        for (const item of arr) {
            buckets.set(item.ts, {
                ts: item.ts,
                calls: item.calls || 0,
                tokensPrompt: item.tp || 0,
                tokensCompletion: item.tc || 0,
                tokensReasoning: item.tr || 0,
                errors: item.err || 0,
                toolErrors: item.terr || 0,
                toolCalls: item.tcalls || 0,
                byEndpoint: item.ep || {},
            });
        }
        prune();
    } catch (e) {
        console.log(`[metrics] load failed (starting fresh): ${e.message}`);
        buckets = new Map();
    }
}

// Auto-persist every 5 minutes so a crash loses at most one bucket.
// Only when metrics.js is the main module (server) — tests import it and
// must be able to exit cleanly.
if (require.main === module) {
    setInterval(persist, BUCKET_MS);
    // Flush on exit.
    process.on('exit', persist);
    process.on('SIGINT', () => { persist(); process.exit(0); });
    process.on('SIGTERM', () => { persist(); process.exit(0); });
}

module.exports = {
    BUCKET_MS,
    RETENTION_DAYS,
    METRICS_FILE,
    load,
    persist,
    prune,
    recordCall,
    recordTokens,
    recordError,
    recordToolError,
    recordToolCall,
    serialize,
    reset: () => { buckets = new Map(); },
    _buckets: () => buckets,
};
