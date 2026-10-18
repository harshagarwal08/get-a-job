// Jobs inbox and Stats views.
import { h, s, icon, label, api, toast, ago, daysSince, scoreBig, emptyState, STATUSES } from './util.js';

// ---------------- Jobs inbox ----------------
function jobMatches(j, q) {
  if (!q) return true;
  const hay = [j.title, j.company, j.location, j.track, j.source, j.department].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

export function filteredJobs(ctx) {
  const f = ctx.jobFilters;
  return ctx.jobs.filter((j) => jobMatches(j, ctx.search)
    && (!f.eligibility || j.eligibility === f.eligibility)
    && (!f.track || j.track === f.track)
    && (f.status === 'all' || (!f.status ? ['new', 'ranked'].includes(j.status) : j.status === f.status))
    && (!f.minScore || (j.rank?.score ?? -1) >= f.minScore))
    .sort((a, b) => (b.rank?.score ?? -1) - (a.rank?.score ?? -1)
      || ({ green: 0, unknown: 1, orange: 2 }[a.eligibility] ?? 3) - ({ green: 0, unknown: 1, orange: 2 }[b.eligibility] ?? 3)
      || (b.postedAt ?? b.firstSeen ?? '').localeCompare(a.postedAt ?? a.firstSeen ?? ''));
}

function sel(ctx, key, title, opts) {
  const val = ctx.jobFilters[key] ?? '';
  return h('select', { class: `select${val ? ' active' : ''}`, 'aria-label': title, onchange: (e) => { ctx.jobFilters[key] = e.target.value; ctx.saveUi(); ctx.render(); } },
    h('option', { value: '' }, title), opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
}

function jobRow(ctx, j) {
  const expanded = ctx.expandedJob === j.key;
  const age = j.postedAt ?? j.firstSeen;
  const old = daysSince(age) > 30;
  const verdict = j.rank?.verdict;
  const tracked = j.status === 'tracked' || j.applicationId;
  const row = h('article', { class: `job is-${j.status}` },
    scoreBig(j.rank?.score, verdict),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'job-title' },
        typeof j.url === 'string' && /^https?:\/\//i.test(j.url)
          ? h('a', { href: j.url, target: '_blank', rel: 'noopener noreferrer', title: 'Open posting' }, j.title)
          : h('span', null, j.title),
        verdict ? h('span', { class: `chip v-${verdict}` }, verdict) : null,
        j.status !== 'new' && j.status !== 'ranked' ? h('span', { class: 'chip plain' }, label(j.status)) : null),
      h('div', { class: 'job-sub' },
        h('b', null, j.company), h('span', { class: 'sep' }, '·'), j.location ?? 'Location n/a',
        j.workMode && j.workMode !== 'unknown' ? [h('span', { class: 'sep' }, '·'), label(j.workMode)] : null,
        j.salary ? [h('span', { class: 'sep' }, '·'), fmtSalary(j.salary)] : null),
      h('div', { class: 'job-chips' },
        h('span', { class: `chip dot el-${j.eligibility}`, title: j.eligibilityReason || label(j.eligibility) }, j.eligibility === 'green' ? 'Eligible' : j.eligibility === 'orange' ? 'Check eligibility' : 'Eligibility unknown'),
        j.quickFit ? h('span', { class: 'chip plain', title: 'Quick fit from /scrape' }, `Quick fit: ${j.quickFit}`) : null,
        j.track ? h('span', { class: 'chip outline' }, j.track.toUpperCase()) : null,
        h('span', { class: `chip plain${old ? ' tag-flag' : ''}`, title: age ? `Posted ${age.slice(0, 10)}` : '' }, old ? `⚠ ${ago(age)} old` : `${ago(age)}${ago(age) === 'today' ? '' : ' ago'}`),
        h('span', { class: 'chip plain' }, label(j.source)),
        h('button', { class: 'expand-btn', 'aria-expanded': String(expanded), onclick: () => toggleJob(ctx, j.key) }, expanded ? 'Less' : 'Details', icon('chev', 11)))),
    h('div', { class: 'job-actions' },
      tracked
        ? h('button', { class: 'btn sm', onclick: () => { if (j.applicationId) ctx.openDrawer(j.applicationId); } }, 'Open application')
        : [
          j.status === 'skipped'
            ? h('button', { class: 'btn sm ghost', onclick: () => setJob(ctx, j, j.rank ? 'ranked' : 'new') }, 'Restore')
            : h('button', { class: 'btn sm ghost', onclick: () => setJob(ctx, j, 'skipped') }, 'Skip'),
          h('button', { class: 'btn sm primary', onclick: () => trackJob(ctx, j) }, 'Track'),
        ]));
  if (expanded) {
    const more = h('div', { class: 'job-more' });
    if (j.rank) {
      more.append(
        h('div', { class: 'pros' }, h('h4', null, 'Strengths'), h('ul', null, (j.rank.strengths ?? []).map((x) => h('li', null, x)))),
        h('div', { class: 'cons' }, h('h4', null, 'Gaps'), h('ul', null, (j.rank.gaps ?? []).map((x) => h('li', null, x)))));
      if (j.rank.dimensions) {
        more.append(h('div', { class: 'dims' }, Object.entries(j.rank.dimensions).map(([k, v]) => h('div', { class: 'dim' },
          h('span', { style: { textTransform: 'capitalize' } }, k), ' ', h('b', null, v), h('div', { class: 'track' }, h('i', { style: { width: `${v}%` } }))))));
      }
    } else {
      more.append(h('div', { class: 'muted', style: { gridColumn: '1 / -1' } }, 'Not ranked yet. Run /rank in Claude Code for a weighted score, strengths and gaps.'));
    }
    more.append(h('div', { class: 'muted', style: { gridColumn: '1 / -1' } }, `Eligibility: ${j.eligibilityReason || label(j.eligibility)}`));
    const desc = h('pre', { class: 'job-desc' }, 'Loading description…');
    more.append(desc);
    api(`/api/jobs?key=${encodeURIComponent(j.key)}`).then((full) => { desc.textContent = full.description || 'No description stored.'; })
      .catch(() => { desc.textContent = 'Could not load description.'; });
    row.append(more);
  }
  return row;
}

function toggleJob(ctx, key) { ctx.expandedJob = ctx.expandedJob === key ? null : key; ctx.render(); }

const fmtSalary = (sal) => {
  const f = (n) => (sal.currency === 'INR' && n >= 100000 ? `${+(n / 100000).toFixed(1)}L` : n >= 1000 ? `${Math.round(n / 1000)}k` : n);
  return `${sal.currency ?? ''} ${sal.min && sal.max && sal.min !== sal.max ? `${f(sal.min)}–${f(sal.max)}` : f(sal.max || sal.min)}`;
};

async function setJob(ctx, j, status) {
  try {
    await api(`/api/jobs/${encodeURIComponent(j.key)}`, { method: 'PATCH', body: { status } });
    j.status = status;
    ctx.render();
    if (status === 'skipped') toast(`Skipped ${j.company}`, { action: { label: 'Undo', run: () => setJob(ctx, j, j.rank ? 'ranked' : 'new') } });
  } catch (e) { toast(e.message, { error: true }); }
}

async function trackJob(ctx, j) {
  try {
    const app = await api(`/api/jobs/${encodeURIComponent(j.key)}/track`, { method: 'POST', body: {} });
    j.status = 'tracked';
    j.applicationId = app.id;
    ctx.apps.push(app);
    ctx.render();
    toast(`Tracking ${app.company}`, { sub: 'Added to Saved. Run /tailor in Claude Code to draft the resume.', action: { label: 'Open', run: () => ctx.openDrawer(app.id) } });
  } catch (e) {
    if (e.status === 409 && e.data?.existing) { toast('Already tracked'); ctx.openDrawer(e.data.existing.id); } else toast(e.message, { error: true });
  }
}

export function renderJobs(ctx) {
  const running = !!ctx.searchState?.running;
  const runBtn = h('button', { class: 'btn primary run-btn', type: 'button', disabled: running, onclick: () => ctx.runSearch() }, icon('search', 14), 'Run search');
  const wrap = h('section', null, h('div', { class: 'view-head' }, h('div', null, h('h1', null, 'Jobs inbox'),
    h('p', null, 'Scraped postings, best fit first. Track the good ones, skip the rest.')),
    h('span', { class: 'spacer' }),
    h('a', { class: 'btn ghost', href: '#settings', title: 'Edit tracks, locations and sources' }, icon('gear', 14), h('span', { class: 'hide-sm' }, 'Search settings')),
    runBtn),
  ctx.searchStatusBox(ctx));
  if (!ctx.jobs.length) {
    wrap.append(emptyState({ iconName: 'inbox', title: 'No scraped jobs yet', body: 'Run a search here, or /scrape in Claude Code, to pull fresh postings from your target companies. Then ask Claude to /rank them.', cmds: ['/onboard', '/scrape', '/rank'] }));
    return wrap;
  }
  const tracks = [...new Set(ctx.jobs.map((j) => j.track).filter(Boolean))];
  const list = filteredJobs(ctx);
  const f = ctx.jobFilters;
  const rangeOut = h('output', null, f.minScore || 0);
  wrap.append(h('div', { class: 'toolbar' },
    sel(ctx, 'status', 'Open (new + ranked)', [['all', 'All statuses'], ...['new', 'ranked', 'tracked', 'skipped', 'expired'].map((x) => [x, label(x)])]),
    sel(ctx, 'eligibility', 'Any eligibility', [['green', 'Eligible'], ['orange', 'Check'], ['unknown', 'Unknown']]),
    sel(ctx, 'track', 'All tracks', tracks.map((t) => [t, ctx.meta.tracks?.find((x) => x.id === t)?.name ?? t])),
    h('label', { class: 'range' }, 'Min score',
      h('input', { type: 'range', min: 0, max: 90, step: 5, value: f.minScore || 0,
        oninput: (e) => { rangeOut.value = e.target.value; },
        onchange: (e) => { ctx.jobFilters.minScore = Number(e.target.value); ctx.saveUi(); ctx.render(); } }), rangeOut),
    h('span', { class: 'count' }, `${list.length} of ${ctx.jobs.length}`)));
  wrap.append(list.length ? h('div', { class: 'jobs' }, list.map((j) => jobRow(ctx, j)))
    : emptyState({ title: 'Inbox zero', body: 'No jobs match these filters. Loosen them, or run /scrape for more.', actions: [h('button', { class: 'btn sm', onclick: () => { ctx.jobFilters = {}; ctx.saveUi(); ctx.render(); } }, 'Reset filters')] }));
  return wrap;
}

// ---------------- Stats ----------------
const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);

function kpi(labelText, value, sub, c) {
  return h('div', { class: 'kpi' }, h('div', { class: 'label' }, c ? h('span', { class: 'dotc', style: { '--c': c } }) : null, labelText), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
}

function weeklyChart(weekly) {
  const narrow = window.innerWidth < 560;
  const W = narrow ? 340 : 640, H = narrow ? 170 : 190, padL = 22, padB = 24, padT = 14;
  const max = Math.max(4, ...weekly.map((w) => w.count));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const bw = (W - padL) / weekly.length;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Applications per week, last 12 weeks: ${weekly.map((w) => w.count).join(', ')}` });
  for (let i = 0; i <= 4; i++) {
    const v = step * i;
    svg.append(s('line', { class: 'gridline', x1: padL, x2: W, y1: y(v), y2: y(v) }), s('text', { x: padL - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, String(v)));
  }
  weekly.forEach((w, i) => {
    const x = padL + i * bw + bw * 0.18;
    const bh = H - padB - y(w.count);
    const g = s('g', null, s('title', null, `Week of ${w.weekStart}: ${w.count}`));
    g.append(s('rect', { class: `colbar${i === weekly.length - 1 ? ' current' : ''}`, x, y: y(w.count), width: bw * 0.64, height: Math.max(bh, w.count ? 2 : 0), rx: 4 }));
    if (w.count) g.append(s('text', { class: 'vlabel', x: x + bw * 0.32, y: y(w.count) - 4, 'text-anchor': 'middle' }, String(w.count)));
    if (i % (narrow ? 3 : 2) === (weekly.length - 1) % (narrow ? 3 : 2)) {
      const [, m, d] = w.weekStart.split('-').map(Number);
      g.append(s('text', { x: x + bw * 0.32, y: H - 6, 'text-anchor': 'middle' }, i === weekly.length - 1 ? 'This wk' : `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${d}`));
    }
    svg.append(g);
  });
  return svg;
}

function breakdown(rows, nameFn) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return h('div', null,
    rows.map((r) => h('div', { class: 'hbar-row', title: `${nameFn(r.key)}: ${r.count} total, ${r.applied} applied, ${r.responded} got a response` },
      h('span', { class: 'lbl' }, nameFn(r.key)),
      h('div', { class: 'barwrap' },
        h('i', { style: { width: `${(r.responded / max) * 100}%`, background: 'var(--accent)' } }),
        h('i', { style: { width: `${((r.applied - r.responded) / max) * 100}%`, background: 'color-mix(in srgb, var(--accent) 45%, transparent)' } }),
        h('i', { style: { width: `${((r.count - r.applied) / max) * 100}%`, background: 'var(--surface-3)' } })),
      h('span', { class: 'val' }, h('b', null, r.count), r.applied ? ` · ${pct(r.responded / r.applied)} resp.` : ''))),
    h('div', { class: 'legend' },
      h('span', null, h('i', { style: { background: 'var(--accent)' } }), 'Got a response'),
      h('span', null, h('i', { style: { background: 'color-mix(in srgb, var(--accent) 45%, transparent)' } }), 'Applied'),
      h('span', null, h('i', { style: { background: 'var(--surface-3)', boxShadow: 'inset 0 0 0 1px var(--border)' } }), 'Not yet applied')));
}

export function renderStats(ctx) {
  const st = ctx.stats;
  const wrap = h('section', null, h('div', { class: 'view-head' }, h('div', null, h('h1', null, 'Stats'), h('p', null, 'How the search is going. Funnel counts each application at the furthest stage it reached.'))));
  if (!ctx.apps.length) {
    wrap.append(emptyState({ iconName: 'chart', title: 'No data yet', body: 'Stats appear once you track applications. Start with /scrape and /tailor in Claude Code.', cmds: ['/scrape', '/tailor <url>'] }));
    return wrap;
  }
  if (!st) { wrap.append(h('p', { class: 'muted' }, 'Loading…')); return wrap; }
  const k = st.kpis;
  wrap.append(h('div', { class: 'kpis' },
    kpi('Active', k.active, k.overdue ? `${k.overdue} next action${k.overdue > 1 ? 's' : ''} overdue` : `${k.total} tracked in total`, 'var(--accent)'),
    kpi('Applied · last 7 days', k.appliedThisWeek, `${k.applied} applied overall`, 'var(--st-applied)'),
    kpi('Response rate', pct(k.responseRate), k.applied ? `${k.responded} of ${k.applied} reached screening` : 'Apply to start measuring', 'var(--st-screening)'),
    kpi('Interviews', k.interviews, k.applied ? `${pct(k.interviews / k.applied)} of applications` : '', 'var(--st-interview)'),
    kpi('Offers', k.offers, k.interviews ? `${pct(k.offers / k.interviews)} of interviews` : '', 'var(--st-offer)')));

  const f = st.funnel;
  const fmax = Math.max(1, ...f.map((x) => x.count));
  const funnel = h('div', { class: 'panel' }, h('h3', null, 'Funnel'), h('p', { class: 'hint' }, 'Furthest stage reached · % = conversion from previous stage'),
    f.map((row, i) => h('div', { class: `funnel-row st-${row.stage}` },
      h('span', { class: 'lbl' }, label(row.stage)),
      h('div', { class: 'barwrap' }, row.count === 0 ? null : h('div', { class: 'barfill', style: { width: `${(row.count / fmax) * 100}%`, minWidth: row.count ? '22px' : '0' } }, row.count ? row.count : '')),
      h('span', { class: 'conv' }, i === 0 || !f[i - 1].count ? '' : pct(row.count / f[i - 1].count)))));
  const weekly = h('div', { class: 'panel' }, h('h3', null, 'Applications per week'), h('p', { class: 'hint' }, `Last 12 weeks · ${st.weekly.reduce((n, w) => n + w.count, 0)} submitted`), weeklyChart(st.weekly));
  const tname = (key) => (key === 'none' ? 'No track' : ctx.meta.tracks?.find((t) => t.id === key)?.name ?? key.toUpperCase());
  const byTrack = h('div', { class: 'panel' }, h('h3', null, 'By track'), h('p', { class: 'hint' }, 'Volume and response rate per target track'), breakdown(st.byTrack, tname));
  const byChannel = h('div', { class: 'panel' }, h('h3', null, 'By channel'), h('p', { class: 'hint' }, 'Where responses actually come from'), breakdown(st.byChannel, label));
  const statusPanel = h('div', { class: 'panel wide' }, h('h3', null, 'Current status'), h('p', { class: 'hint' }, 'Where everything sits right now'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } }, STATUSES.filter((x) => st.byStatus[x]).map((x) => h('span', { class: `chip dot st-${x}` }, `${label(x)} ${st.byStatus[x]}`))));
  wrap.append(h('div', { class: 'panels' }, funnel, weekly, byTrack, byChannel, statusPanel));
  return wrap;
}
