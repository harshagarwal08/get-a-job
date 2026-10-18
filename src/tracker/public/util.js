// Shared helpers: DOM builders (no innerHTML with data), formatting, API, toasts.
export const ACTIVE = ['saved', 'drafted', 'applied', 'screening', 'interview', 'offer'];
export const CLOSED = ['hired', 'rejected', 'withdrawn', 'no_response', 'offer_declined'];
export const STATUSES = [...ACTIVE, ...CLOSED];
export const CHANNELS = ['ats', 'referral', 'linkedin', 'email', 'recruiter', 'other'];
export const WORK_MODES = ['remote', 'hybrid', 'onsite', 'unknown'];
export const VERDICTS = ['Strong', 'Good', 'Moderate', 'Weak', 'Poor'];
export const LABEL = {
  saved: 'Saved', drafted: 'Drafted', applied: 'Applied', screening: 'Screening', interview: 'Interview', offer: 'Offer',
  hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn', no_response: 'No response', offer_declined: 'Offer declined',
  ats: 'ATS', referral: 'Referral', linkedin: 'LinkedIn', email: 'Email', recruiter: 'Recruiter', other: 'Other',
  remote: 'Remote', hybrid: 'Hybrid', onsite: 'Onsite', unknown: 'Unknown', none: 'No track',
  green: 'Eligible', orange: 'Check', new: 'New', ranked: 'Ranked', tracked: 'Tracked', skipped: 'Skipped', expired: 'Expired',
};
export const label = (k) => LABEL[k] ?? k ?? '';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  setProps(el, props);
  append(el, kids);
  return el;
}
const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, props, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(props ?? {})) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
  append(el, kids);
  return el;
}
function setProps(el, props) {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) el.style.setProperty(p, String(val));
        else el.style[p] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && !k.includes('-') && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : String(k));
  }
}
// Static icon markup (trusted strings only).
export function icon(name, size = 14) {
  const paths = {
    clock: '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6v4l2.5 2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
    alert: '<path d="M10 3l7.5 13h-15z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8v3.5M10 14v.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    link: '<path d="M8.5 11.5a3 3 0 004.2 0l2.6-2.6a3 3 0 00-4.2-4.2l-.9.9M11.5 8.5a3 3 0 00-4.2 0l-2.6 2.6a3 3 0 004.2 4.2l.9-.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    file: '<path d="M6 2.5h5.5L15 6v11.5H6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M11 2.5V6.5h4" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    x: '<path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    chev: '<path d="M7.5 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    sun: '<circle cx="10" cy="10" r="3.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    moon: '<path d="M16 12.5A6.5 6.5 0 017.5 4a6.5 6.5 0 108.5 8.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    system: '<rect x="2.5" y="3.5" width="15" height="10" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 17h6M10 13.5V17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    inbox: '<path d="M3 11l2.2-6.5h9.6L17 11v4.5H3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M3 11h4l1 2h4l1-2h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    board: '<rect x="3" y="3.5" width="4" height="13" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="8.5" y="3.5" width="4" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="3.5" width="3" height="6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    chart: '<path d="M3.5 16.5h13M6 13v-3M10 13V6M14 13V9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    plus: '<path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    search: '<circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M13.2 13.2L17 17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    check: '<circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.8 10.3l2.2 2.2 4.3-4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    gear: '<circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    trash: '<path d="M4 6h12M8 6V4h4v2M6 6l.8 10.5h6.4L14 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>',
  };
  const span = document.createElement('span');
  span.style.display = 'inline-flex';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 20 20" width="${size}" height="${size}">${paths[name] ?? ''}</svg>`;
  return span;
}

// ---- dates ----
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export function daysSince(iso) {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}
export function ago(iso) {
  const d = daysSince(iso);
  if (d === null) return '';
  if (d === 0) return 'today';
  if (d < 7) return `${d}d`;
  if (d < 60) return `${Math.floor(d / 7)}w`;
  return `${Math.floor(d / 30)}mo`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(str) {
  if (!str) return '';
  const [y, m, d] = str.slice(0, 10).split('-').map(Number);
  const sameYear = y === new Date().getFullYear();
  return `${MONTHS[m - 1]} ${d}${sameYear ? '' : ` ${y}`}`;
}
export function dateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
// 'overdue' | 'today' | 'soon' | null
export function dueState(date) {
  if (!date) return null;
  const t = todayStr();
  if (date < t) return 'overdue';
  if (date === t) return 'today';
  return 'soon';
}
export function relDue(date) {
  if (!date) return '';
  const t = new Date(todayStr() + 'T00:00:00');
  const d = new Date(date + 'T00:00:00');
  const n = Math.round((d - t) / 86400000);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n < 0) return `${-n}d overdue`;
  if (n < 7) return `in ${n}d`;
  return shortDate(date);
}

// ---- chips ----
export const statusChip = (st) => h('span', { class: `chip dot st-${st}` }, label(st));
export function fitBadge(fit) {
  if (!fit || (fit.score === null && !fit.verdict)) return null;
  const v = fit.verdict ?? '';
  return h('span', { class: `fit v-${v}`, title: `Fit ${fit.score ?? '?'}${v ? ` · ${v}` : ''}`, 'aria-label': `Fit ${fit.score ?? ''} ${v}` },
    fit.score ?? v);
}
export function scoreBig(score, verdict) {
  if (score === null || score === undefined) return h('div', { class: 'score-none', title: 'Not ranked yet. Run /rank' }, '—');
  return h('div', { class: `score-big v-${verdict ?? ''}`, title: `${score} · ${verdict ?? ''}`, style: { '--p': score } }, h('span', null, score));
}

// ---- API ----
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(data?.error ?? `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---- toasts ----
export function toast(msg, { sub, error = false, ms = 3800, action } = {}) {
  const root = document.getElementById('toasts');
  const el = h('div', { class: `toast${error ? ' error' : ''}` },
    h('div', null, msg, sub ? h('small', null, sub) : null),
    action ? h('button', { onclick: () => { action.run(); el.remove(); } }, action.label) : null);
  root.append(el);
  setTimeout(() => el.remove(), ms);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const storage = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

export function emptyState({ iconName = 'inbox', title, body, cmds = [], actions = [] }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'art' }, icon(iconName, 26)),
    h('h2', null, title),
    h('p', null, body),
    cmds.length || actions.length ? h('div', { class: 'cmds' }, cmds.map((c) => h('code', null, c)), actions) : null);
}
