// Claude tasks from the tracker (tailor, rank, cover, cold DM) and the job-description editor.
import { h, icon, api, toast } from './util.js';

const TASK_LABEL = { tailor: 'Tailor resume', rank: 'Rank job', cover: 'Draft message', 'cold-dm': 'Cold DM' };
let panel;
let timer;

export const taskBusy = (ctx) => !!ctx.task?.running;

/** Start a Claude task; the panel shows progress until it finishes. */
export async function runTask(ctx, body, title) {
  if (taskBusy(ctx)) { toast('A Claude task is already running', { sub: 'Wait for it to finish.' }); return; }
  try {
    await api('/api/agent', { method: 'POST', body });
    ctx.task = { running: true, title, task: body, log: [] };
    drawPanel(ctx);
    ctx.render();
    poll(ctx);
  } catch (e) {
    toast(e.status === 400 && /not installed/.test(e.message) ? 'Claude Code is not installed' : e.message, {
      error: true, sub: e.status === 400 && /not installed/.test(e.message) ? 'Install it, or run the command in a terminal instead.' : undefined,
    });
  }
}

/** Resume polling on page load if a task is running. */
export async function pollTask(ctx) {
  try {
    const s = await api('/api/agent/status');
    if (s.running) { ctx.task = { ...s, title: TASK_LABEL[s.task?.task] ?? 'Claude task' }; drawPanel(ctx); poll(ctx); }
    ctx.claudeAvailable = s.available !== false;
  } catch { /* server without agent support */ }
}

function poll(ctx) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    let s;
    try { s = await api('/api/agent/status'); } catch { poll(ctx); return; }
    ctx.task = { ...s, title: ctx.task?.title ?? TASK_LABEL[s.task?.task] };
    drawPanel(ctx);
    if (s.running) { poll(ctx); return; }
    await ctx.onTaskDone?.(s);
    ctx.render();
  }, 2000);
}

function drawPanel(ctx) {
  const t = ctx.task;
  if (!t) { panel?.remove(); panel = null; return; }
  if (!panel) { panel = h('aside', { class: 'task-panel', role: 'status', 'aria-live': 'polite' }); document.body.append(panel); }
  const done = !t.running;
  const ok = done && !t.error && t.exitCode === 0;
  const log = h('pre', { class: 'task-log' }, (t.log ?? []).slice(-14).join('\n') || 'Starting Claude…');
  panel.className = `task-panel${done ? (ok ? ' ok' : ' bad') : ''}`;
  panel.replaceChildren(
    h('div', { class: 'task-head' },
      done ? icon(ok ? 'check' : 'alert', 15) : h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('b', null, t.title ?? 'Claude task'),
      h('span', { class: 'muted' }, done ? (ok ? 'Done' : 'Failed') : 'Running…'),
      h('span', { class: 'grow' }),
      done ? h('button', { class: 'btn ghost icon-btn', 'aria-label': 'Dismiss', onclick: () => { ctx.task = null; drawPanel(ctx); } }, icon('x', 13)) : null),
    log,
    done && t.result ? h('details', null, h('summary', null, 'Claude\'s summary'), h('pre', { class: 'task-log' }, t.result)) : null,
    done && t.error ? h('div', { class: 'err' }, t.error) : null);
  log.scrollTop = log.scrollHeight;
}

/** Modal to paste or fetch the full job description. */
export function openJd(ctx, j, { thenTailor = false } = {}) {
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'jd-title' });
  const area = h('textarea', { class: 'jd-input', placeholder: 'Paste the full job description: responsibilities, requirements, nice-to-haves.', 'aria-label': 'Job description' });
  const err = h('div', { class: 'err', role: 'alert' });
  const count = h('span', { class: 'muted' }, '');
  const close = () => { modal.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const busy = (on) => modal.querySelectorAll('button').forEach((b) => { b.disabled = on; });
  area.addEventListener('input', () => { count.textContent = `${area.value.trim().length.toLocaleString()} characters`; });

  api(`/api/jobs?key=${encodeURIComponent(j.key)}`).then((full) => {
    if (full.description && !area.value) { area.value = full.description; area.dispatchEvent(new Event('input')); }
  }).catch(() => {});

  const after = async (saved) => {
    Object.assign(j, saved);
    ctx.lastRaw.jobs = '';
    close();
    toast(`Saved the job description for ${j.company}`, { sub: `${saved.descLen.toLocaleString()} characters` });
    if (thenTailor) ctx.runTask({ task: 'tailor', key: j.key }, `Tailoring for ${j.company}`);
    else ctx.render();
  };
  const save = async () => {
    err.textContent = '';
    busy(true);
    try { await after(await api(`/api/jobs/${encodeURIComponent(j.key)}/description`, { method: 'POST', body: { text: area.value } })); }
    catch (e) { err.textContent = e.message; busy(false); }
  };
  const fetchIt = async () => {
    err.textContent = '';
    busy(true);
    fetchBtn.textContent = 'Fetching…';
    try { await after(await api(`/api/jobs/${encodeURIComponent(j.key)}/fetch`, { method: 'POST', body: {} })); }
    catch (e) { err.textContent = `${e.message}. Open the posting, copy the description and paste it here.`; busy(false); fetchBtn.textContent = 'Fetch from posting'; }
  };
  const hasUrl = typeof j.url === 'string' && /^https?:\/\//i.test(j.url);
  const fetchBtn = h('button', { class: 'btn', type: 'button', disabled: !hasUrl, title: hasUrl ? 'Download the posting page and keep its text' : 'No posting URL stored', onclick: fetchIt }, 'Fetch from posting');

  modal.append(h('div', { class: 'modal-card jd-sheet' },
    h('h2', { id: 'jd-title' }, 'Job description'),
    h('p', { class: 'muted' }, h('b', null, j.title), ` · ${j.company}`, thenTailor ? ' · tailoring starts after you save' : ''),
    hasUrl ? h('p', null, h('a', { href: j.url, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 12), ' Open the posting'), ' to copy its text, or fetch it.') : null,
    area,
    h('div', { class: 'jd-foot' }, count, err, h('span', { class: 'grow' }),
      fetchBtn,
      h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: save }, thenTailor ? 'Save and tailor' : 'Save'))));
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(modal);
  area.focus();
}

/** Action buttons and files for an application (drawer). */
export function appActions(ctx, a) {
  const run = (body, title) => ctx.runTask(body, title);
  const busy = taskBusy(ctx);
  const files = h('div', { class: 'file-list' }, h('span', { class: 'muted' }, a.appDir ? 'Loading files…' : 'No application folder yet. Tailor creates one.'));
  if (a.appDir) {
    api(`/api/applications/${a.id}/files`).then(({ files: list }) => {
      files.replaceChildren(...(list.length ? list.map((f) => h('a', { class: 'chip file', href: `/files?path=${encodeURIComponent(f.path)}`, target: '_blank', rel: 'noopener', title: f.path }, icon('file', 11), f.name))
        : [h('span', { class: 'muted' }, 'Folder is empty.')]));
    }).catch(() => { files.replaceChildren(h('span', { class: 'muted' }, 'Could not list files.')); });
  }
  const isCold = a.channel === 'cold';
  return h('div', { class: 'section ai-actions' },
    h('h3', null, 'Claude'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn sm primary', type: 'button', disabled: busy, onclick: () => run(a.jobKey ? { task: 'tailor', key: a.jobKey } : { task: 'tailor', id: a.id }, `Tailoring for ${a.company}`) }, icon('file', 12), a.resumePath ? 'Re-tailor resume' : 'Tailor resume'),
      h('button', { class: 'btn sm', type: 'button', disabled: busy, onclick: () => run({ task: 'cover', id: a.id, kind: 'cover' }, `Cover note for ${a.company}`) }, 'Cover note'),
      h('button', { class: 'btn sm', type: 'button', disabled: busy, onclick: () => run({ task: 'cover', id: a.id, kind: 'referral' }, `Referral DM for ${a.company}`) }, 'Referral DM'),
      h('button', { class: 'btn sm', type: 'button', disabled: busy, onclick: () => run({ task: 'cover', id: a.id, kind: 'recruiter' }, `Recruiter email for ${a.company}`) }, 'Recruiter email'),
      isCold && a.fundedId ? h('button', { class: 'btn sm', type: 'button', disabled: busy, onclick: () => run({ task: 'cold-dm', key: a.fundedId }, `Cold DM for ${a.company}`) }, 'Redo cold DM') : null),
    h('p', { class: 'hint-line' }, 'Runs Claude Code on this machine. Drafts only: nothing is sent.'),
    files);
}
