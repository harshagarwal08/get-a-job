// get-a-job tracker UI: state, routing, drawer, header, shortcuts, polling.
import { h, icon, label, api, toast, storage, debounce, STATUSES, CHANNELS, WORK_MODES, VERDICTS, statusChip, fitBadge, dateTime, relDue, dueState } from './util.js';
import { renderPipeline, renderTable } from './views.js';
import { renderJobs, renderStats } from './views2.js';

const VIEWS = ['pipeline', 'table', 'jobs', 'stats'];
const ui = storage.get('gaj.ui', {});

const ctx = {
  apps: [], jobs: [], meta: { tracks: [] }, stats: null,
  view: 'pipeline', search: '',
  filters: ui.filters ?? {}, sort: ui.sort ?? { key: 'updated', dir: 'desc' },
  jobFilters: ui.jobFilters ?? {}, closedOpen: ui.closedOpen ?? false,
  expandedJob: null, dragging: null,
  drawer: { id: null, mode: null, dirty: false },
  lastRaw: { apps: '', jobs: '' },
  saveUi() { storage.set('gaj.ui', { filters: ctx.filters, sort: ctx.sort, jobFilters: ctx.jobFilters, closedOpen: ctx.closedOpen }); },
  render, openDrawer, openNew, moveStatus,
};

const $ = (id) => document.getElementById(id);
const main = $('main');

// ---------------- data ----------------
async function loadApps() {
  const res = await fetch('/api/applications');
  const raw = await res.text();
  if (!res.ok) throw new Error('Could not load applications');
  const changed = raw !== ctx.lastRaw.apps;
  ctx.lastRaw.apps = raw;
  if (changed) ctx.apps = JSON.parse(raw).applications;
  return changed;
}
async function loadJobs() {
  const res = await fetch('/api/jobs');
  const raw = await res.text();
  if (!res.ok) throw new Error('Could not load jobs');
  const changed = raw !== ctx.lastRaw.jobs;
  ctx.lastRaw.jobs = raw;
  if (changed) ctx.jobs = JSON.parse(raw).jobs;
  return changed;
}
async function loadStats() { ctx.stats = await api('/api/stats'); }

async function refresh({ force = false } = {}) {
  const [a, j] = await Promise.all([loadApps(), loadJobs()]);
  if (a || force) await loadStats();
  return a || j || force;
}

// ---------------- render ----------------
function render() {
  document.querySelectorAll('#tabs a').forEach((t) => {
    if (t.dataset.view === ctx.view) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  const openJobs = ctx.jobs.filter((j) => j.status === 'new' || j.status === 'ranked').length;
  $('jobs-count').textContent = openJobs ? String(openJobs) : '';
  $('search').placeholder = ctx.view === 'jobs' ? 'Search jobs' : 'Search applications';
  const scroll = main.querySelector('.board')?.scrollLeft;
  const views = { pipeline: renderPipeline, table: renderTable, jobs: renderJobs, stats: renderStats };
  main.replaceChildren(views[ctx.view](ctx));
  if (scroll) { const b = main.querySelector('.board'); if (b) b.scrollLeft = scroll; }
}

function setView(v) {
  if (!VIEWS.includes(v)) v = 'pipeline';
  ctx.view = v;
  if (location.hash !== `#${v}`) history.replaceState(null, '', `#${v}`);
  if (v === 'stats') loadStats().then(render).catch(() => {});
  render();
}

// ---------------- mutations ----------------
async function moveStatus(id, status, { refocus = false } = {}) {
  const app = ctx.apps.find((a) => a.id === id);
  if (!app || app.status === status) return;
  const prev = app.status;
  app.status = status; // optimistic
  render();
  try {
    const updated = await api(`/api/applications/${id}`, { method: 'PATCH', body: { status } });
    Object.assign(app, updated);
    ctx.lastRaw.apps = '';
    await loadStats().catch(() => {});
    render();
    const el = main.querySelector(`[data-id="${id}"]`);
    if (el) { el.classList.add('flash'); if (refocus) el.focus(); }
    toast(`${app.company} → ${label(status)}`, { action: { label: 'Undo', run: () => undoLast(id) } });
    if (ctx.drawer.id === id && !ctx.drawer.dirty) openDrawer(id);
  } catch (e) {
    app.status = prev;
    render();
    toast(e.message, { error: true });
  }
}

// Server-side undo: marks the last history entry undone and restores the previous status.
async function undoLast(id) {
  try {
    const updated = await api(`/api/applications/${id}/undo`, { method: 'POST', body: {} });
    const app = ctx.apps.find((a) => a.id === id);
    if (app) Object.assign(app, updated);
    ctx.lastRaw.apps = '';
    await loadStats().catch(() => {});
    render();
    toast(`${updated.company} back to ${label(updated.status)}`, { ms: 2000 });
    if (ctx.drawer.id === id && !ctx.drawer.dirty) openDrawer(id);
  } catch (e) { toast(e.message, { error: true }); }
}

// ---------------- drawer ----------------
const drawerEl = $('drawer');
const scrim = $('scrim');
let lastFocus = null;

function field(name, labelText, control, { full = false } = {}) {
  control.name = name;
  control.id = `f-${name}`;
  return h('div', { class: `field${full ? ' full' : ''}` }, h('label', { for: control.id }, labelText), control);
}
const input = (value, props = {}) => h('input', { class: 'input', ...props, value: value ?? '' });
const select = (value, options, props = {}) => h('select', { class: 'select', ...props },
  options.map(([v, l]) => h('option', { value: v, selected: v === (value ?? '') }, l)));

function openNew() { openDrawer(null); }

function openDrawer(id) {
  const isNew = !id;
  const a = isNew
    ? { company: '', role: '', status: 'saved', channel: 'ats', workMode: 'unknown', track: ctx.meta.tracks?.[0]?.id ?? null, history: [], notes: '' }
    : ctx.apps.find((x) => x.id === id);
  if (!a) { toast('Application not found', { error: true }); return; }
  if (!drawerEl.classList.contains('open')) lastFocus = document.activeElement;
  ctx.drawer = { id: id ?? null, mode: isNew ? 'new' : 'edit', dirty: false };

  const tracks = [...new Map([...ctx.apps.filter((x) => x.track).map((x) => [x.track, x.track]), ...(ctx.meta.tracks ?? []).map((t) => [t.id, t.name])])];
  if (a.track && !tracks.some(([t]) => t === a.track)) tracks.push([a.track, a.track]);
  const form = h('form', { id: 'app-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); save(); } });
  const dirtyEl = h('span', { class: 'dirty', hidden: true }, 'Unsaved changes');
  form.addEventListener('input', () => { ctx.drawer.dirty = true; dirtyEl.hidden = false; });

  const openLink = (path) => (path ? h('a', { class: 'btn sm', href: `/files?path=${encodeURIComponent(path)}`, target: '_blank', rel: 'noopener', title: path }, icon('file', 13), 'Open') : null);
  const urlLink = a.url && /^https?:\/\//i.test(a.url) ? h('a', { class: 'btn sm', href: a.url, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 13), 'Open') : null;

  form.append(
    h('div', { class: 'section' }, h('h3', null, 'Role'), h('div', { class: 'fields' },
      field('company', 'Company', input(a.company, { required: true, autocomplete: 'off' })),
      field('role', 'Role', input(a.role, { required: true, autocomplete: 'off' })),
      field('status', 'Status', select(a.status, STATUSES.map((s) => [s, label(s)]))),
      field('track', 'Track', select(a.track ?? '', [['', 'None'], ...tracks.map(([t, n]) => [t, n])])),
      field('channel', 'Channel', select(a.channel, CHANNELS.map((c) => [c, label(c)]))),
      field('workMode', 'Work mode', select(a.workMode ?? 'unknown', WORK_MODES.map((m) => [m, label(m)]))),
      field('location', 'Location', input(a.location), { full: true }),
      h('div', { class: 'field full' }, h('label', { for: 'f-url' }, 'Posting URL'),
        h('div', { class: 'with-link' }, Object.assign(input(a.url, { type: 'url', placeholder: 'https://', id: 'f-url' }), { name: 'url' }), urlLink)))),
    h('div', { class: 'section' }, h('h3', null, 'Next step'), h('div', { class: 'fields' },
      field('nextAction', 'Next action', input(a.nextAction, { placeholder: 'e.g. Follow up with recruiter' }), { full: true }),
      field('nextActionDate', 'Due', input(a.nextActionDate, { type: 'date' })),
      field('deadline', 'Application deadline', input(a.deadline, { type: 'date' })))),
    h('div', { class: 'section' }, h('h3', null, 'Fit & details'), h('div', { class: 'fields' },
      field('fitScore', 'Fit score (0-100)', input(a.fit?.score ?? '', { type: 'number', min: 0, max: 100, inputMode: 'numeric' })),
      field('fitVerdict', 'Verdict', select(a.fit?.verdict ?? '', [['', 'Auto from score'], ...VERDICTS.map((v) => [v, v])])),
      field('appliedAt', 'Applied on', input(a.appliedAt ? a.appliedAt.slice(0, 10) : '', { type: 'date' })),
      field('salary', 'Salary', input(a.salary, { placeholder: 'e.g. INR 40-50L' })),
      field('contact', 'Contact', input(a.contact, { placeholder: 'Recruiter, referrer…' }), { full: true }))),
    h('div', { class: 'section' }, h('h3', null, 'Files'), h('div', { class: 'fields' },
      h('div', { class: 'field full' }, h('label', { for: 'f-resumePath' }, 'Tailored resume'),
        h('div', { class: 'with-link' }, Object.assign(input(a.resumePath, { id: 'f-resumePath', placeholder: 'data/applications/<slug>/resume.pdf' }), { name: 'resumePath' }), openLink(a.resumePath))),
      h('div', { class: 'field full' }, h('label', { for: 'f-coverPath' }, 'Cover note'),
        h('div', { class: 'with-link' }, Object.assign(input(a.coverPath, { id: 'f-coverPath', placeholder: 'data/applications/<slug>/cover.md' }), { name: 'coverPath' }), openLink(a.coverPath))))),
    h('div', { class: 'section' }, h('h3', null, 'Notes'), h('div', { class: 'fields' },
      field('notes', 'Notes', h('textarea', { value: a.notes ?? '', placeholder: 'Anything worth remembering' }), { full: true }))),
  );

  const errEl = h('div', { class: 'field' }, h('span', { class: 'err', role: 'alert' }));
  let timeline = null;
  if (!isNew) {
    const noteInput = input('', { placeholder: 'Add a note to the timeline', 'aria-label': 'New note' });
    const addNote = async () => {
      const note = noteInput.value.trim();
      if (!note) return;
      try {
        const updated = await api(`/api/applications/${a.id}`, { method: 'PATCH', body: { note } });
        Object.assign(a, updated);
        ctx.lastRaw.apps = '';
        noteInput.value = '';
        renderTimeline();
        render();
      } catch (e) { toast(e.message, { error: true }); }
    };
    noteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addNote(); } });
    const list = h('ol', { class: 'timeline' });
    const renderTimeline = () => {
      list.replaceChildren(...[...(a.history ?? [])].reverse().map((e) => h('li', { class: `st-${e.status}${e.undone ? ' undone' : ''}`, title: e.undone ? 'Undone' : null },
        h('div', { class: 'what' }, statusChip(e.status), h('span', { class: 'when' }, dateTime(e.at))),
        e.note ? h('div', { class: 'note' }, e.note) : null)));
    };
    renderTimeline();
    timeline = h('div', { class: 'section' }, h('h3', null, 'Timeline'),
      h('div', { class: 'note-add' }, noteInput, h('button', { class: 'btn', type: 'button', onclick: addNote }, 'Add')), list);
  }

  const due = dueState(a.nextActionDate);
  drawerEl.replaceChildren(
    h('div', { class: 'drawer-head' },
      h('div', { class: 'titles' },
        h('h2', { id: 'drawer-title' }, isNew ? 'New application' : a.company),
        isNew ? h('div', { class: 'role' }, 'Track a role you found anywhere.') : h('div', { class: 'role' }, a.role),
        !isNew ? h('div', { class: 'chips' }, statusChip(a.status), fitBadge(a.fit),
          a.nextActionDate ? h('span', { class: `chip ${due === 'overdue' ? 'st-rejected' : 'plain'}` }, `Next: ${relDue(a.nextActionDate)}`) : null,
          a.jobKey ? h('span', { class: 'chip plain', title: a.jobKey }, 'From jobs inbox') : null) : null),
      h('button', { class: 'btn ghost icon-btn', type: 'button', 'aria-label': 'Close', onclick: closeDrawer }, icon('x', 16))),
    h('div', { class: 'drawer-body' }, form, errEl, timeline),
    h('div', { class: 'drawer-foot' },
      !isNew ? h('button', { class: 'btn danger', type: 'button', onclick: () => remove(a) }, icon('trash', 14), h('span', { class: 'hide-sm' }, 'Delete')) : null,
      h('span', { class: 'grow' }), dirtyEl,
      h('button', { class: 'btn', type: 'button', onclick: closeDrawer }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit', form: 'app-form' }, isNew ? 'Create' : 'Save')));

  async function save() {
    const fd = Object.fromEntries(new FormData(form));
    const err = errEl.querySelector('.err');
    err.textContent = '';
    if (!fd.company.trim() || !fd.role.trim()) { err.textContent = 'Company and role are required.'; return; }
    const body = {
      company: fd.company, role: fd.role, status: fd.status, track: fd.track || null, channel: fd.channel, workMode: fd.workMode,
      location: fd.location || null, url: fd.url || null, nextAction: fd.nextAction || null, nextActionDate: fd.nextActionDate || null,
      deadline: fd.deadline || null, salary: fd.salary || null, contact: fd.contact || null,
      resumePath: fd.resumePath || null, coverPath: fd.coverPath || null, notes: fd.notes ?? '',
      fit: fd.fitScore === '' && !fd.fitVerdict ? null : { score: fd.fitScore === '' ? null : Number(fd.fitScore), verdict: fd.fitVerdict || null },
    };
    if (fd.appliedAt) body.appliedAt = fd.appliedAt;
    else if (!isNew && a.appliedAt) body.appliedAt = null;
    // Only send fields that changed, so concurrent CLI edits to other fields survive.
    if (!isNew) {
      for (const k of Object.keys(body)) {
        const next = body[k];
        let same;
        if (k === 'fit') {
          const cur = a.fit ?? null;
          same = (!cur && !next) || (cur && next && (cur.score ?? null) === next.score && (next.verdict === null || next.verdict === cur.verdict));
        } else if (k === 'appliedAt') same = (a.appliedAt ? a.appliedAt.slice(0, 10) : null) === next;
        else if (k === 'notes') same = (a.notes ?? '') === next;
        else same = (a[k] ?? null) === next;
        if (same) delete body[k];
      }
    }
    try {
      const saved = isNew
        ? await api('/api/applications', { method: 'POST', body })
        : Object.keys(body).length ? await api(`/api/applications/${a.id}`, { method: 'PATCH', body }) : a;
      ctx.drawer.dirty = false;
      ctx.lastRaw.apps = '';
      await refresh({ force: true });
      render();
      toast(isNew ? `Added ${saved.company}` : 'Saved');
      if (isNew) openDrawer(saved.id); else closeDrawer();
    } catch (e) { err.textContent = e.message; }
  }

  scrim.hidden = false;
  drawerEl.classList.add('open');
  drawerEl.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => (isNew ? form.querySelector('[name=company]') : drawerEl.querySelector('.drawer-head button')).focus());
}

async function remove(a) {
  if (!confirm(`Delete ${a.company} - ${a.role}? This can't be undone.`)) return;
  try {
    await api(`/api/applications/${a.id}`, { method: 'DELETE' });
    ctx.apps = ctx.apps.filter((x) => x.id !== a.id);
    ctx.drawer.dirty = false;
    closeDrawer();
    await refresh({ force: true });
    render();
    toast(`Deleted ${a.company}`);
  } catch (e) { toast(e.message, { error: true }); }
}

function closeDrawer() {
  if (ctx.drawer.dirty && !confirm('Discard unsaved changes?')) return;
  ctx.drawer = { id: null, mode: null, dirty: false };
  drawerEl.classList.remove('open');
  drawerEl.setAttribute('aria-hidden', 'true');
  scrim.hidden = true;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}
scrim.addEventListener('click', closeDrawer);
drawerEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const f = [...drawerEl.querySelectorAll('button, a[href], input, select, textarea')].filter((x) => !x.disabled && x.offsetParent);
  if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
  else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
});

// ---------------- header: search, export, theme, help ----------------
const searchEl = $('search');
searchEl.addEventListener('input', debounce(() => { ctx.search = searchEl.value.trim(); render(); }, 120));
searchEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchEl.value = ''; ctx.search = ''; render(); searchEl.blur(); } });

const exportBtn = $('export-btn');
const exportMenu = $('export-menu');
const toggleMenu = (open = exportMenu.hidden) => {
  exportMenu.hidden = !open;
  exportBtn.setAttribute('aria-expanded', String(open));
  if (open) exportMenu.querySelector('button').focus();
};
exportBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
document.addEventListener('click', (e) => { if (!exportMenu.hidden && !exportMenu.contains(e.target)) toggleMenu(false); });
exportMenu.addEventListener('keydown', (e) => {
  const items = [...exportMenu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  if (e.key === 'Escape') { toggleMenu(false); exportBtn.focus(); }
});
exportMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-export]');
  if (!btn) return;
  toggleMenu(false);
  const kind = btn.dataset.export;
  if (kind !== 'sheets') {
    const a = h('a', { href: `/api/export.${kind}`, download: '' });
    document.body.append(a); a.click(); a.remove();
    return;
  }
  try {
    const res = await fetch('/api/export.tsv?download=0');
    const tsv = await res.text();
    await navigator.clipboard.writeText(tsv);
    toast(`Copied ${ctx.apps.length} rows for Google Sheets`, { sub: 'Open a blank sheet, click cell A1 and paste (Cmd/Ctrl+V).', ms: 6500 });
  } catch {
    toast('Clipboard blocked by the browser', { error: true, sub: 'Use the CSV export, then File → Import in Google Sheets.' });
  }
});

const THEMES = ['system', 'light', 'dark'];
let theme = storage.get('gaj.theme', 'system');
function applyTheme() {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  const btn = $('theme-btn');
  btn.replaceChildren(icon(theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'system', 17));
  btn.title = `Theme: ${theme} (click to change)`;
}
$('theme-btn').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  storage.set('gaj.theme', theme);
  applyTheme();
  toast(`Theme: ${theme}`, { ms: 1400 });
});
applyTheme();

const helpEl = $('help');
function showHelp(show = helpEl.hidden) {
  helpEl.hidden = !show;
  if (!show) return;
  const k = (...keys) => h('dt', null, keys.map((x) => h('kbd', null, x)));
  helpEl.replaceChildren(h('div', { class: 'modal-card' },
    h('h2', { id: 'help-title' }, 'Keyboard shortcuts'),
    h('dl', { class: 'shortcuts' },
      k('/'), h('dd', null, 'Search'),
      k('n'), h('dd', null, 'New application'),
      k('1'), h('dd', null, 'Pipeline'), k('2'), h('dd', null, 'Table'), k('3'), h('dd', null, 'Jobs inbox'), k('4'), h('dd', null, 'Stats'),
      k('Shift', '←', '→'), h('dd', null, 'Move focused card to previous / next stage'),
      k('Enter'), h('dd', null, 'Open focused card or row'),
      k('Esc'), h('dd', null, 'Close drawer or dialog'),
      k('?'), h('dd', null, 'This help')),
    h('div', { style: { textAlign: 'right', marginTop: '16px' } }, h('button', { class: 'btn', onclick: () => showHelp(false) }, 'Close'))));
  helpEl.querySelector('button').focus();
}
helpEl.addEventListener('click', (e) => { if (e.target === helpEl) showHelp(false); });
$('help-btn').addEventListener('click', () => showHelp(true));
$('new-btn').addEventListener('click', openNew);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!helpEl.hidden) return showHelp(false);
    if (!exportMenu.hidden) return toggleMenu(false);
    if (drawerEl.classList.contains('open')) return closeDrawer();
  }
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
  if (drawerEl.classList.contains('open') || !helpEl.hidden) return;
  if (e.key === '/') { e.preventDefault(); searchEl.focus(); searchEl.select(); }
  else if (e.key === 'n') { e.preventDefault(); openNew(); }
  else if (e.key === '?') { e.preventDefault(); showHelp(true); }
  else if (['1', '2', '3', '4'].includes(e.key)) setView(VIEWS[Number(e.key) - 1]);
});

window.addEventListener('hashchange', () => setView(location.hash.slice(1)));

// ---------------- polling: pick up CLI edits without clobbering open edits ----------------
async function poll() {
  if (document.visibilityState !== 'visible' || ctx.dragging) return;
  const active = document.activeElement;
  if (active && main.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;
  try {
    const changed = await refresh();
    if (!changed) return;
    render();
    if (ctx.drawer.id && !ctx.drawer.dirty && !drawerEl.contains(document.activeElement)) openDrawer(ctx.drawer.id);
  } catch { /* server stopped; keep last view */ }
}
setInterval(poll, 5000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });

// ---------------- boot ----------------
(async () => {
  try {
    ctx.meta = await api('/api/meta');
    $('demo-badge').hidden = !ctx.meta.demo;
    await refresh({ force: true });
  } catch (e) {
    toast('Could not reach the tracker server', { error: true, sub: 'Is `gaj tracker` still running?' });
  }
  setView(location.hash.slice(1) || 'pipeline');
})();
