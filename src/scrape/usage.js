// Monthly ledger of paid-provider usage (data/usage.json), enforced before every HTTP attempt.
import path from 'node:path';
import { paths } from '../lib/paths.js';
import { readJSON, writeJSON } from '../lib/store.js';

const file = () => path.join(paths.dataDir, 'usage.json');
export const monthOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);

/** Error thrown when a call would exceed the monthly budget (never retried). */
export class BudgetError extends Error {
  constructor(msg) { super(msg); this.noRetry = true; this.code = 'BUDGET'; }
}

function load() {
  try { return readJSON(file(), {}) ?? {}; } catch { return {}; }
}

/** This month's usage for a provider: `{requests, usdCap}`. */
export function usageFor(provider, now = Date.now()) {
  const u = load()[monthOf(now)]?.[provider] ?? {};
  return { requests: u.requests ?? 0, usdCap: u.usdCap ?? 0 };
}

/** Add to this month's usage (written immediately so a crash still counts). */
export function addUsage(provider, { requests = 0, usdCap = 0 }, now = Date.now()) {
  const all = load();
  const m = monthOf(now);
  const cur = all[m]?.[provider] ?? { requests: 0, usdCap: 0 };
  all[m] = { ...(all[m] ?? {}), [provider]: { requests: (cur.requests ?? 0) + requests, usdCap: Math.round(((cur.usdCap ?? 0) + usdCap) * 100) / 100 } };
  writeJSON(file(), all);
  return all[m][provider];
}

/**
 * A per-run meter for one provider. `attempt()` is passed to http `onAttempt`: it refuses
 * (BudgetError) when one more request would pass `maxRequests` this month, otherwise records it.
 * `reserveUsd(x)` does the same for the dollar cap of an Apify run.
 * @param {string} provider ledger name ("googleJobs" | "apify")
 * @param {{maxRequests?: number, maxUsd?: number, now?: number}} limits
 */
export function meter(provider, { maxRequests = Infinity, maxUsd = Infinity, now } = {}) {
  const run = { requests: 0, usdCap: 0 };
  return {
    run,
    attempt() {
      const u = usageFor(provider, now ?? Date.now());
      if (u.requests + 1 > maxRequests) throw new BudgetError(`${provider}: monthly request budget reached (${u.requests}/${maxRequests}); skipping`);
      addUsage(provider, { requests: 1 }, now ?? Date.now());
      run.requests++;
    },
    reserveUsd(x) {
      const u = usageFor(provider, now ?? Date.now());
      if (u.usdCap + x > maxUsd + 1e-9) throw new BudgetError(`${provider}: monthly budget would pass $${maxUsd} ($${u.usdCap.toFixed(2)} of caps used); skipping`);
      addUsage(provider, { usdCap: x }, now ?? Date.now());
      run.usdCap += x;
    },
    month: () => usageFor(provider, now ?? Date.now()),
  };
}
