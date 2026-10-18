// Pure stats over tracker applications. Shared by the server (/api/stats) and tests.
import { STAGES, ACTIVE_STATUSES, CHANNELS } from './store.js';

const DAY = 86400000;

// Furthest stage reached (index into STAGES), from current status + history. -1 if none.
export function furthestStage(app) {
  let max = -1;
  const consider = (s) => {
    const mapped = s === 'offer_declined' ? 'offer' : s;
    const i = STAGES.indexOf(mapped);
    if (i > max) max = i;
  };
  consider(app.status);
  for (const h of app.history ?? []) if (!h.undone) consider(h.status);
  // Final statuses that imply an application went out.
  if (max < STAGES.indexOf('applied') && (app.appliedAt || app.status === 'no_response')) max = STAGES.indexOf('applied');
  return max;
}

// When the application was submitted (appliedAt, else first history entry at applied or later).
export function appliedDate(app) {
  if (app.appliedAt) return app.appliedAt;
  const ai = STAGES.indexOf('applied');
  const h = (app.history ?? []).find((e) => !e.undone && STAGES.indexOf(e.status) >= ai);
  return h ? h.at : null;
}

// Monday 00:00 UTC of the week containing d.
export function weekStart(d) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
}

export function computeStats(applications, now = new Date()) {
  const apps = applications ?? [];
  const nowMs = new Date(now).getTime();
  const reached = (app, stage) => furthestStage(app) >= STAGES.indexOf(stage);

  const appliedApps = apps.filter((a) => reached(a, 'applied'));
  const responded = appliedApps.filter((a) => reached(a, 'screening'));
  const today = new Date(nowMs).toISOString().slice(0, 10);

  const kpis = {
    total: apps.length,
    active: apps.filter((a) => ACTIVE_STATUSES.includes(a.status)).length,
    applied: appliedApps.length,
    appliedThisWeek: apps.filter((a) => {
      const d = appliedDate(a);
      return d && nowMs - new Date(d).getTime() < 7 * DAY && new Date(d).getTime() <= nowMs;
    }).length,
    responseRate: appliedApps.length ? responded.length / appliedApps.length : null,
    responded: responded.length,
    interviews: apps.filter((a) => reached(a, 'interview')).length,
    offers: apps.filter((a) => reached(a, 'offer')).length,
    overdue: apps.filter((a) => ACTIVE_STATUSES.includes(a.status) && a.nextActionDate && a.nextActionDate < today).length,
  };

  const funnel = STAGES.map((stage) => ({ stage, count: apps.filter((a) => reached(a, stage)).length }));

  const thisWeek = weekStart(nowMs).getTime();
  const weekly = [];
  for (let i = 11; i >= 0; i--) {
    const start = thisWeek - i * 7 * DAY;
    weekly.push({ weekStart: new Date(start).toISOString().slice(0, 10), count: 0 });
  }
  for (const a of apps) {
    const d = appliedDate(a);
    if (!d) continue;
    const idx = Math.floor((weekStart(d).getTime() - (thisWeek - 11 * 7 * DAY)) / (7 * DAY));
    if (idx >= 0 && idx < 12) weekly[idx].count++;
  }

  const group = (keyFn, order = []) => {
    const m = new Map(order.map((k) => [k, { key: k, count: 0, applied: 0, responded: 0 }]));
    for (const a of apps) {
      const k = keyFn(a) ?? 'none';
      if (!m.has(k)) m.set(k, { key: k, count: 0, applied: 0, responded: 0 });
      const g = m.get(k);
      g.count++;
      if (reached(a, 'applied')) g.applied++;
      if (reached(a, 'screening')) g.responded++;
    }
    return [...m.values()].filter((g) => g.count > 0).sort((x, y) => y.count - x.count);
  };

  const byStatus = {};
  for (const a of apps) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    kpis, funnel, weekly, byStatus,
    byTrack: group((a) => a.track),
    byChannel: group((a) => a.channel, CHANNELS),
  };
}
