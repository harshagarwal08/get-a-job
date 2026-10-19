// Digest modal + tiny safe markdown renderer (builds DOM nodes; never uses innerHTML for content).
import { h, icon, api, toast } from './util.js';

// Inline: \escapes, **bold**, _italic_, `code`, [text](http(s) url). Everything else is text.
export function inline(text) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  let i = 0;
  const s = String(text);
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue; }
    if (c === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) { flush(); out.push(h('strong', null, inline(s.slice(i + 2, end)))); i = end + 2; continue; }
    }
    if (c === '_' && (i === 0 || /\s|\(/.test(s[i - 1]))) {
      const end = s.indexOf('_', i + 1);
      if (end > i + 1 && (end + 1 >= s.length || /[\s.,;:!?)]/.test(s[end + 1]))) { flush(); out.push(h('em', null, inline(s.slice(i + 1, end)))); i = end + 1; continue; }
    }
    if (c === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) { flush(); out.push(h('code', null, s.slice(i + 1, end))); i = end + 1; continue; }
    }
    if (c === '[') {
      const m = /^\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/i.exec(s.slice(i));
      if (m) { flush(); out.push(h('a', { href: m[2], target: '_blank', rel: 'noopener noreferrer' }, inline(m[1]))); i += m[0].length; continue; }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

export function renderMarkdown(text) {
  const root = h('div', { class: 'md' });
  let list = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^<!--.*-->$/.test(line.trim())) continue;
    const li = /^\s*[-*] (.*)$/.exec(line);
    if (li) {
      if (!list) { list = h('ul'); root.append(list); }
      const body = li[1];
      const mark = /^(🟢|⚪|🟠) (.*)$/u.exec(body);
      list.append(mark ? h('li', { class: `dl ${{ '🟢': 'g', '⚪': 'u', '🟠': 'o' }[mark[1]]}` }, inline(mark[2])) : h('li', null, inline(body)));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const hd = /^(#{1,3}) (.*)$/.exec(line);
    if (hd) root.append(h(`h${hd[1].length + 1}`, null, inline(hd[2])));
    else root.append(h('p', null, inline(line)));
  }
  return root;
}

export async function openDigestModal(ctx) {
  const prevFocus = document.activeElement;
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'digest-title' });
  const close = () => { modal.remove(); prevFocus?.focus?.(); };
  modal.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  const body = h('div', { class: 'digest-body' }, h('p', { class: 'muted' }, 'Loading…'));
  const info = ctx.digest?.latest;
  const card = h('div', { class: 'modal-card digest-card' },
    h('div', { class: 'digest-head' },
      h('div', null, h('h2', { id: 'digest-title' }, info ? `Job digest · ${info.date}` : 'Job digest'),
        h('div', { class: 'muted small' }, info ? `${info.path}` : 'data/digests/')),
      h('button', { class: 'btn ghost icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('x', 16))),
    body,
    h('div', { class: 'digest-foot' },
      h('span', { class: 'muted small' }, 'Written by ', h('code', null, 'gaj digest'), '. Schedule it daily in Settings.'),
      h('a', { class: 'btn sm', href: '#settings', onclick: close }, 'Daily search settings')));
  modal.append(card);
  document.body.append(modal);
  card.querySelector('button').focus();
  try {
    const res = await fetch('/api/digest/latest');
    if (res.status === 404) {
      body.replaceChildren(h('div', { class: 'empty slim' }, h('h2', null, 'No digest yet'),
        h('p', null, 'Run ', h('code', null, 'gaj digest'), ' (or ask Claude) to summarise jobs found since the last one, or schedule it to run every morning.')));
      return;
    }
    if (!res.ok) throw new Error('Could not load the digest');
    body.replaceChildren(renderMarkdown(await res.text()));
  } catch (e) {
    toast(e.message, { error: true });
    close();
  }
}
