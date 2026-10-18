// Pipeline (kanban) and Table views.
import { h, icon, label, ACTIVE, CLOSED, STATUSES, CHANNELS, VERDICTS, statusChip, fitBadge, ago, daysSince, dueState, relDue, shortDate, emptyState } from './util.js';

export function matchesSearch(a, q) {
  if (!q) return true;
  const hay = [a.company, a.role, a.location, a.track, a.notes, a.nextAction, a.contact, a.status, a.channel].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

function trackName(ctx, id) {
  if (!id) return null;
  return ctx.meta.tracks?.find((t) => t.id === id)?.name ?? id;
}
const trackChip = (ctx, id) => (id ? h('span', { class: 'chip outline', title: trackName(ctx, id) }, id.toUpperCase()) : null);

function card(ctx, a) {
  const due = a.nextAction || a.nextActionDate ? dueState(a.nextActionDate) : null;
  const closed = CLOSED.includes(a.status);
  const el = h('article', {
    class: `card st-${a.status}`, tabindex: 0, draggable: 'true', dataset: { id: a.id },
    'aria-label': `${a.company}, ${a.role}, ${label(a.status)}. Enter to open, Shift+Arrow keys to move.`,
    onclick: () => ctx.openDrawer(a.id),
    onkeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ctx.openDrawer(a.id); return; }
      if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        const order = ACTIVE;
        const i = order.indexOf(a.status);
        const next = i === -1 ? (e.key === 'ArrowLeft' ? 'offer' : null) : order[i + (e.key === 'ArrowRight' ? 1 : -1)];
        if (next) ctx.moveStatus(a.id, next, { refocus: true });
      }
    },
    ondragstart: (e) => {
      ctx.dragging = a.id;
      e.dataTransfer.setData('text/plain', a.id);
      e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => el.classList.add('dragging'));
    },
    ondragend: () => { ctx.dragging = null; el.classList.remove('dragging'); document.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); },
  },
  h('div', { class: 'card-top' }, h('div', { class: 'card-company' }, a.company), fitBadge(a.fit)),
  h('div', { class: 'card-role' }, a.role),
  h('div', { class: 'card-meta' },
    closed ? statusChip(a.status) : null,
    trackChip(ctx, a.track),
    a.deadline && !closed ? h('span', { class: 'deadline', title: `Deadline ${a.deadline}` }, `Due ${shortDate(a.deadline)}`) : null,
    h('span', { class: 'age', title: `Updated ${a.updatedAt?.slice(0, 10) ?? ''}` }, ago(a.updatedAt))),
  !closed && (a.nextAction || a.nextActionDate)
    ? h('div', { class: `card-next${due === 'overdue' ? ' overdue' : due === 'today' ? ' today' : ''}` },
      icon(due === 'overdue' ? 'alert' : 'clock', 13),
      h('span', { class: 't' }, a.nextAction || 'Next action'),
      a.nextActionDate ? h('span', { class: 'd' }, relDue(a.nextActionDate)) : null)
    : null);
  return el;
}

function dropTarget(ctx, el, status) {
  el.addEventListener('dragover', (e) => { if (!ctx.dragging) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drop'); });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
  el.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('drop');
    const id = e.dataTransfer.getData('text/plain') || ctx.dragging;
    if (id) ctx.moveStatus(id, status);
  });
}

export function renderPipeline(ctx) {
  const apps = ctx.apps.filter((a) => matchesSearch(a, ctx.search));
  const wrap = h('section', null,
    h('div', { class: 'view-head' },
      h('div', null, h('h1', null, 'Pipeline'),
        h('p', null, `${ctx.apps.filter((a) => ACTIVE.includes(a.status)).length} active · drag cards between stages, or focus one and press Shift + ←/→`))));
  if (!ctx.apps.length) {
    wrap.append(emptyState({
      iconName: 'board', title: 'No applications yet',
      body: 'Run /onboard in Claude Code to set up your profile, /scrape to find jobs, then /tailor <job> to draft a resume. Tracked jobs land here.',
      cmds: ['/onboard', '/scrape', '/tailor <url>'],
      actions: [h('button', { class: 'btn sm primary', onclick: () => ctx.openNew() }, 'Add one manually')],
    }));
    return wrap;
  }
  const board = h('div', { class: `board${ctx.closedOpen ? ' closed-open' : ''}` });
  for (const st of ACTIVE) {
    const items = apps.filter((a) => a.status === st).sort(sortByUrgency);
    const body = h('div', { class: 'col-body' }, items.length ? items.map((a) => card(ctx, a)) : h('div', { class: 'col-empty' }, ctx.search ? 'No matches' : 'Drop here'));
    const col = h('div', { class: `col st-${st}`, dataset: { status: st }, role: 'region', 'aria-label': `${label(st)}, ${items.length}` },
      h('div', { class: 'col-head' }, h('span', { class: 'bar' }), h('span', null, label(st)), h('span', { class: 'count' }, items.length)),
      body);
    dropTarget(ctx, col, st);
    board.append(col);
  }
  // Closed column
  const closedItems = apps.filter((a) => CLOSED.includes(a.status));
  const open = ctx.closedOpen;
  const closedCol = h('div', { class: `col closed-col st-withdrawn${open ? '' : ' collapsed'}` },
    h('button', { class: 'closed-toggle', 'aria-expanded': String(open), onclick: () => { ctx.closedOpen = !open; ctx.render(); } },
      icon('chev', 14), h('span', null, 'Closed'), h('span', { class: 'count muted' }, closedItems.length)));
  const zones = h('div', { class: 'closed-zones' }, CLOSED.map((st) => {
    const z = h('div', { class: `closed-zone st-${st}`, title: `Drop to mark ${label(st)}` }, label(st));
    dropTarget(ctx, z, st);
    return z;
  }));
  closedCol.append(zones);
  if (open) {
    const body = h('div', { class: 'col-body' });
    for (const st of CLOSED) {
      const items = closedItems.filter((a) => a.status === st);
      if (!items.length) continue;
      body.append(h('div', { class: `closed-group-label st-${st}` }, `${label(st)} · ${items.length}`), items.map((a) => card(ctx, a)));
    }
    if (!closedItems.length) body.append(h('div', { class: 'col-empty' }, 'Nothing closed yet'));
    closedCol.append(body);
  } else {
    closedCol.append(h('div', { class: 'closed-summary' }, CLOSED.map((st) => {
      const n = closedItems.filter((a) => a.status === st).length;
      return n ? h('span', { class: `chip dot st-${st}` }, `${label(st)} ${n}`) : null;
    })));
  }
  board.append(closedCol);
  wrap.append(board);
  return wrap;
}

function sortByUrgency(a, b) {
  const da = a.nextActionDate ?? '9999', db = b.nextActionDate ?? '9999';
  if (da !== db) return da < db ? -1 : 1;
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
}

// ---------------- Table ----------------
const COLS = [
  { key: 'company', label: 'Company', get: (a) => a.company.toLowerCase() },
  { key: 'status', label: 'Status', get: (a) => STATUSES.indexOf(a.status) },
  { key: 'track', label: 'Track', get: (a) => a.track ?? '', cls: 'hide-sm' },
  { key: 'fit', label: 'Fit', get: (a) => a.fit?.score ?? -1, cls: 'hide-sm' },
  { key: 'channel', label: 'Channel', get: (a) => a.channel, cls: 'hide-md' },
  { key: 'applied', label: 'Applied', get: (a) => a.appliedAt ?? '', cls: 'hide-sm' },
  { key: 'next', label: 'Next action', get: (a) => a.nextActionDate ?? '9999', cls: 'hide-md' },
  { key: 'updated', label: 'Updated', get: (a) => a.updatedAt ?? '', cls: 'hide-sm' },
];

function filterSelect(ctx, key, title, options) {
  const val = ctx.filters[key] ?? '';
  return h('select', {
    class: `select${val ? ' active' : ''}`, 'aria-label': title,
    onchange: (e) => { ctx.filters[key] = e.target.value; ctx.saveUi(); ctx.render(); },
  }, h('option', { value: '' }, title), options.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
}

export function renderTable(ctx) {
  const f = ctx.filters;
  let apps = ctx.apps.filter((a) => matchesSearch(a, ctx.search)
    && (!f.status || (f.status === '_active' ? ACTIVE.includes(a.status) : f.status === '_closed' ? CLOSED.includes(a.status) : a.status === f.status))
    && (!f.track || (a.track ?? '') === (f.track === '_none' ? '' : f.track))
    && (!f.verdict || a.fit?.verdict === f.verdict)
    && (!f.channel || a.channel === f.channel));
  const col = COLS.find((c) => c.key === ctx.sort.key) ?? COLS[7];
  const dir = ctx.sort.dir === 'asc' ? 1 : -1;
  apps = [...apps].sort((x, y) => { const a = col.get(x), b = col.get(y); return (a < b ? -1 : a > b ? 1 : 0) * dir; });

  const tracks = [...new Set(ctx.apps.map((a) => a.track).filter(Boolean))];
  const anyFilter = Object.values(f).some(Boolean);
  const wrap = h('section', null,
    h('div', { class: 'view-head' }, h('div', null, h('h1', null, 'Applications'), h('p', null, 'Every application, sortable and filterable. Click a row for details.'))));
  if (!ctx.apps.length) {
    wrap.append(emptyState({ iconName: 'board', title: 'Nothing tracked yet', body: 'Track jobs from the Jobs inbox, run /tailor <job url> in Claude Code, or add one manually.', cmds: ['/scrape', '/tailor <url>', 'gaj track add'] }));
    return wrap;
  }
  wrap.append(h('div', { class: 'toolbar' },
    filterSelect(ctx, 'status', 'All statuses', [['_active', 'Active'], ['_closed', 'Closed'], ...STATUSES.map((s) => [s, label(s)])]),
    filterSelect(ctx, 'track', 'All tracks', [...tracks.map((t) => [t, trackName(ctx, t)]), ['_none', 'No track']]),
    filterSelect(ctx, 'verdict', 'Any verdict', VERDICTS.map((v) => [v, v])),
    filterSelect(ctx, 'channel', 'Any channel', CHANNELS.map((c) => [c, label(c)])),
    anyFilter ? h('button', { class: 'btn sm ghost', onclick: () => { ctx.filters = {}; ctx.saveUi(); ctx.render(); } }, 'Clear filters') : null,
    h('span', { class: 'count' }, `${apps.length} of ${ctx.apps.length}`)));

  const thead = h('thead', null, h('tr', null, COLS.map((c) => {
    const active = ctx.sort.key === c.key;
    return h('th', { class: c.cls ?? '', 'aria-sort': active ? (ctx.sort.dir === 'asc' ? 'ascending' : 'descending') : null },
      h('button', { onclick: () => { ctx.sort = { key: c.key, dir: active && ctx.sort.dir === 'desc' ? 'asc' : 'desc' }; ctx.saveUi(); ctx.render(); } },
        c.label, active ? h('span', { class: 'arrow' }, ctx.sort.dir === 'asc' ? '▲' : '▼') : null));
  })));
  const tbody = h('tbody', null, apps.map((a) => {
    const due = dueState(a.nextActionDate);
    const sel = h('select', {
      class: `status-select st-${a.status}`, 'aria-label': `Status for ${a.company}`,
      onclick: (e) => e.stopPropagation(), onkeydown: (e) => e.stopPropagation(),
      onchange: (e) => ctx.moveStatus(a.id, e.target.value),
    }, STATUSES.map((s) => h('option', { value: s, selected: s === a.status }, label(s))));
    return h('tr', { tabindex: 0, onclick: () => ctx.openDrawer(a.id), onkeydown: (e) => { if (e.key === 'Enter') ctx.openDrawer(a.id); } },
      h('td', null, h('div', { class: 'co' }, a.company), h('div', { class: 'ro' }, a.role)),
      h('td', null, sel),
      h('td', { class: 'hide-sm' }, trackChip(ctx, a.track) ?? h('span', { class: 'muted' }, '—')),
      h('td', { class: 'hide-sm' }, fitBadge(a.fit) ?? h('span', { class: 'muted' }, '—')),
      h('td', { class: 'hide-md' }, label(a.channel)),
      h('td', { class: 'hide-sm num' }, a.appliedAt ? shortDate(a.appliedAt) : h('span', { class: 'muted' }, '—')),
      h('td', { class: 'hide-md' }, a.nextAction || a.nextActionDate
        ? h('div', { class: 'next' }, a.nextAction ?? '', a.nextActionDate ? h('span', { class: due === 'overdue' ? 'overdue' : 'muted' }, ` · ${relDue(a.nextActionDate)}`) : null)
        : h('span', { class: 'muted' }, '—')),
      h('td', { class: 'hide-sm muted num', title: a.updatedAt }, daysSince(a.updatedAt) === 0 ? 'today' : `${ago(a.updatedAt)} ago`));
  }));
  wrap.append(apps.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'grid' }, thead, tbody))
    : emptyState({ title: 'No matches', body: 'No applications match these filters.', actions: [h('button', { class: 'btn sm', onclick: () => { ctx.filters = {}; ctx.search = ''; document.getElementById('search').value = ''; ctx.render(); } }, 'Reset')] }));
  return wrap;
}
