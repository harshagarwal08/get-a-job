// Shared, pure helpers for parsing job-alert / recommendation emails (Wellfound, Cutshort,
// Instahyre). Input is the email body as plain text (Gmail PLAIN_TEXT) or HTML; output is
// [{title, company, location, url}] ready for `jobs:import --source email-alert --via <platform>`.
// No network: links are never fetched, only recognised, unwrapped and cleaned.
import { decodeEntities } from '../text.js';
import { detectCountries, detectRegions } from '../geo.js';

const MAX_TITLE = 200;
const MAX_COMPANY = 120;
const MAX_LOCATION = 120;

// Query params that only track the click (dropped everywhere).
const TRACKING_PARAM = /^(utm_[a-z_]+|ref|refid|ref_src|source|src|trk|trackingid|tracking_id|mc_cid|mc_eid|_hs(enc|mi)|hsctatracking|gclid|fbclid|msclkid|yclid|mkt_tok|campaign|medium|email|e|eid|uid|user_id|token|t|sig|s|cid|lid|from|via|share|sharer|invite|redirect_source|_branch_match_id|_branch_referrer|si|igshid)$/i;
// Params of click-tracking redirectors that carry the real destination.
const REDIRECT_PARAMS = ['url', 'u', 'q', 'target', 'redirect', 'redirect_url', 'redirect_uri', 'dest', 'destination', 'link', 'to', 'r', 'goto', 'next'];

const URL_RE = /https?:\/\/[^\s<>"'()\[\]{}]+/gi;

/** Drop trailing punctuation that plain-text emails glue onto URLs. */
function trimUrl(u) {
  return u.replace(/[.,;:!?*_>]+$/, '').replace(/&amp;/g, '&');
}

/**
 * Follow redirect-wrapper params (`?url=`, `?u=` …, up to 3 levels) when they carry an http(s)
 * URL. Opaque trackers (e.g. SendGrid `ls/click?upn=`) are returned unchanged.
 * @param {string} url
 * @returns {string}
 */
export function unwrapRedirect(url) {
  let cur = url;
  for (let i = 0; i < 3; i++) {
    let u;
    try { u = new URL(cur); } catch { return cur; }
    let next = null;
    for (const p of REDIRECT_PARAMS) {
      const v = u.searchParams.get(p);
      if (v && /^https?:\/\//i.test(v)) { next = v; break; }
      if (v && /^https?%3a/i.test(v)) { try { next = decodeURIComponent(v); break; } catch { /* keep looking */ } }
    }
    if (!next) return cur;
    cur = next;
  }
  return cur;
}

/**
 * Remove tracking query params and the fragment; lowercases the host and forces https.
 * @param {string} url
 * @returns {string|null} null when not an http(s) URL
 */
export function stripTracking(url) {
  let u;
  try { u = new URL(String(url ?? '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';
  u.username = '';
  u.password = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  return u.href;
}

/**
 * Turn an email body (plain text or HTML) into lines of `{text, links: [{url, anchor}]}`.
 * HTML anchors become "anchor <url>"; markdown links "[anchor](url)" are recognised too.
 * @param {string} body
 */
export function emailLines(body) {
  let s = String(body ?? '').replace(/\r\n?/g, '\n').replace(/[​-‍⁠﻿­͏]/g, '');
  if (/<(a|br|p|div|td|tr|table)\b[^>]*>/i.test(s)) {
    s = s
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (m, href, inner) => {
        const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return ` [${text}](${decodeEntities(href)}) `;
      })
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|td|tr|li|h[1-6]|table)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    s = decodeEntities(s);
  }
  const out = [];
  for (const raw of s.split('\n')) {
    const links = [];
    // [anchor](url)
    let text = raw.replace(/\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)\s*\)/gi, (m, anchor, url) => {
      links.push({ url: trimUrl(url), anchor: clean(anchor) });
      return ` ${anchor} `;
    });
    // "anchor <url>" / "anchor: url" / bare url
    text = text.replace(/<?(https?:\/\/[^\s<>"']+)>?/gi, (m, url) => {
      links.push({ url: trimUrl(url), anchor: null });
      return ' ';
    });
    out.push({ text: clean(text), links });
  }
  return out;
}

function clean(s) {
  return String(s ?? '')
    .replace(/[*_`#>]+/g, ' ')
    .replace(/^\s*(?:[-–•·▪►→]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Lines that never hold job data.
const BOILERPLATE = [
  /^(hi|hey|hello|dear|greetings)\b/i,
  /^(view|see|apply|check|explore|read|open|show|browse|learn|get|discover|find|click|tap|save|share|update|manage|edit)\b.{0,40}$/i,
  /^(apply( now)?|view( job| details| role| more)?|interested\??|not interested|save|skip|i'?m interested|reply.*|more jobs?.*|see all.*)$/i,
  /\b(unsubscribe|email preferences|notification settings|privacy policy|terms of (use|service)|all rights reserved|you are receiving|you received this|manage (your )?alerts|stop (these|alerts)|snooze|why am i seeing|sent to you|this email was|download the app|follow us|help center|contact us)\b/i,
  /^(posted|updated|active|new|featured|promoted|easy apply|actively hiring|be an early applicant|reposted)\b.{0,30}$/i,
  /^(\d+\s*(\+\s*)?(applicants?|days?|hours?|weeks?)\b.*)$/i,
  /\b(jobs?|roles?|opportunit(y|ies)|matches|openings?)\b.*\b(for you|matching|match your|you might|you may|recommended|picked|curated|based on)\b/i,
  /^(here are|here's|we found|we've found|today's|this week's|your (daily|weekly)|top picks|recommended for you|new jobs? (for|matching))\b/i,
  /^(cheers|thanks|thank you|regards|best|team)\b.{0,40}$/i,
  /^(wellfound|cutshort|instahyre|angellist)( (team|talent|job alerts))?[.!]?$/i,
  /^©/,
];

/** Whether a cleaned line carries no job data. */
export function isBoilerplate(line) {
  const s = String(line ?? '').trim();
  return !s || s.length > 160 || /[.!?]$/.test(s) && s.split(/\s+/).length > 8 || BOILERPLATE.some((re) => re.test(s));
}

const ROLE_RE = /\b(engineers?|engineering|developers?|designers?|managers?|leads?|architects?|sde|sde-?\s?\d|swe|analysts?|scientists?|interns?|internship|head|directors?|vp|cto|cpo|consultants?|specialists?|programmers?|devops|sre|qa|testers?|front-?\s?end|back-?\s?end|full-?\s?stack|product|marketers?|marketing|sales|executives?|associates?|officers?|writers?|researchers?|administrators?|admins?|recruiters?|ops|operations|support|mts|staff|principal|founding)\b/i;
const SALARY_RE = /(₹|\$|€|£|\binr\b|\busd\b|\blpa\b|\bctc\b|\blakhs?\b|\bcrores?\b|\d\s?l\b|\d\s?k\b|\bequity\b|\/\s?(yr|year|month|mo)\b|\bsalary\b|\bcompensation\b)/i;
const EXPERIENCE_RE = /^\d+\s*(?:[-–to]+\s*\d+\s*)?\+?\s*(yrs?|years?)\b|\bexperience\b|\b\d+\s*(yrs?|years?)\b/i;
const WORKMODE_RE = /^(remote|hybrid|on-?site|in[- ]office|wfh|work from home|remote[- ]friendly|remote only|fully remote)\b/i;
const MISC_RE = /^(full[- ]?time|part[- ]?time|contract|internship|freelance|permanent|seed|series [a-f]|pre-seed|bootstrapped|\d+\s*[-–]\s*\d+\s*employees|\d+\+?\s*employees|[\d,]+\+? (applicants|people))\b/i;
const SEP_RE = /\s+[·•|—–]\s+|\s+-\s+|\s*\|\s*|\s*·\s*|\s*•\s*/;

/** Whether a fragment looks like a place (or a work mode). */
export function looksLikeLocation(s) {
  const t = String(s ?? '').trim();
  if (!t || t.length > MAX_LOCATION || SALARY_RE.test(t) || EXPERIENCE_RE.test(t)) return false;
  return WORKMODE_RE.test(t) || detectCountries(t).length > 0 || detectRegions(t).length > 0
    || /\b(remote|hybrid|on-?site|anywhere|multiple locations|pan india)\b/i.test(t);
}

function isNoise(s) {
  const t = String(s ?? '').trim();
  return !t || SALARY_RE.test(t) || EXPERIENCE_RE.test(t) || MISC_RE.test(t) || /^\d+$/.test(t);
}

/** Split "A · B | C" style fragments. */
function parts(line) {
  return line.split(SEP_RE).map((p) => p.trim()).filter(Boolean);
}

/** Pull "Location: X" / "Company: X" / "Role: X" key-value lines. */
function keyValue(line) {
  if (/^(salary|ctc|compensation|pay|experience|exp|equity|skills|notice period|job type|employment type)\s*[:\-–]/i.test(line)) return { field: 'skip' };
  const m = /^(role|title|position|job title|job|company|organisation|organization|employer|startup|location|locations|city|based in)\s*[:\-–]\s*(.+)$/i.exec(line);
  if (!m) return null;
  const k = m[1].toLowerCase();
  const field = /role|title|position|job/.test(k) ? 'title' : /company|organi|employer|startup/.test(k) ? 'company' : 'location';
  return { field, value: m[2].trim() };
}

/**
 * Extract {title, company, location} from the text lines of one job card. Lines must be
 * already cleaned; boilerplate is skipped here.
 * Recognises: "Title at Company", "New match: Title at Company", "Company is hiring (a) Title",
 * "Title | Company | Location", "Company · Location · ₹30L", "Location: X", plus a bare
 * title line followed by a company line.
 * @param {string[]} lines
 * @returns {{title: string, company: string, location: string}}
 */
export function parseCardLines(lines) {
  const r = { title: '', company: '', location: '' };
  const locs = [];
  const loose = [];
  for (const raw of lines) {
    const line = clean(raw).replace(/^(new match|new job|job alert|recommended|top match|match|hot job|featured job)\s*[:\-–]\s*/i, '');
    if (isBoilerplate(line)) continue;
    const kv = keyValue(line);
    if (kv) {
      if (kv.field === 'skip') continue;
      if (kv.field === 'location') locs.push(kv.value);
      else if (!r[kv.field]) r[kv.field] = kv.value;
      continue;
    }
    let m = /^(.{2,120}?)\s+is (?:hiring|looking for)(?: an?| for(?: an?)?)?\s+(.{2,160})$/i.exec(line);
    if (m && !r.title) {
      r.company ||= m[1].trim();
      const [t, ...rest] = parts(m[2]);
      r.title = t.replace(/[.!]$/, '');
      rest.filter(looksLikeLocation).forEach((x) => locs.push(x));
      continue;
    }
    let ps = parts(line);
    // "Senior Software Engineer - Frontend": both halves name a role → one title.
    if (ps.length === 2 && ROLE_RE.test(ps[0]) && ROLE_RE.test(ps[1]) && !ps.some((p) => looksLikeLocation(p) || isNoise(p))) ps = [line];
    m = /^(.{2,160}?)\s+(?:at|@)\s+(.{1,120})$/i.exec(ps[0]);
    if (m && !r.title && ROLE_RE.test(m[1])) {
      r.title = m[1].trim();
      r.company ||= m[2].trim();
      ps.slice(1).filter(looksLikeLocation).forEach((x) => locs.push(x));
      continue;
    }
    if (ps.length > 1) {
      // "Title | Company | Location" or "Company · Location · Salary"
      let rest = ps;
      if (!r.title && ROLE_RE.test(ps[0]) && !looksLikeLocation(ps[0])) { r.title = ps[0]; rest = ps.slice(1); }
      for (const p of rest) {
        if (looksLikeLocation(p)) locs.push(p);
        else if (isNoise(p)) continue;
        else if (!r.company && r.title) r.company = p;
        else if (!r.title && ROLE_RE.test(p)) r.title = p;
        else if (!r.company) r.company = p;
      }
      continue;
    }
    if (looksLikeLocation(line) && (r.title || loose.length)) { locs.push(line); continue; }
    if (isNoise(line)) continue;
    loose.push(line);
  }
  // Bare lines: first role-like line is the title, the next non-title line the company.
  for (const l of loose) {
    if (!r.title && (ROLE_RE.test(l) || !r.company)) { r.title = l; continue; }
    if (!r.company) { r.company = l.replace(/^(at|@)\s+/i, ''); continue; }
  }
  r.title = r.title.slice(0, MAX_TITLE).trim();
  r.company = r.company.replace(/\s*\((?:[^)]*)\)\s*$/, (p) => (looksLikeLocation(p.slice(1, -1).trim()) ? (locs.push(p.trim().slice(1, -1)), '') : p)).slice(0, MAX_COMPANY).trim();
  r.location = [...new Set(locs.map((l) => l.trim()))].join(', ').slice(0, MAX_LOCATION);
  return r;
}

const CTA_RE = /^(view|see|apply|open|check|explore|read|know|learn|i'?m interested|interested|details|more)\b/i;

/**
 * Generic alert-email parser. Jobs are identified by links that are platform job URLs
 * (after unwrapping redirect params). Two layouts are handled:
 *  - details then link ("Title / Company · City / View job: <url>"): the card is the text
 *    lines since the previous job link (the last few meaningful ones);
 *  - title as the link anchor ("[Title](url) / Company · City"): the card is the anchor plus
 *    the text lines up to the next job link.
 * Missing title/company fall back to `fromUrl(url)` (slug info). Duplicate URLs merge.
 * @param {string} body email text or HTML
 * @param {{isJobUrl: (u: string) => boolean, normalize: (u: string) => string|null, fromUrl?: (u: string) => {title?: string, company?: string, location?: string}}} platform
 * @returns {{title: string, company: string, location: string, url: string}[]}
 */
export function parseAlertBody(body, { isJobUrl, normalize, fromUrl = () => ({}) }) {
  const lines = emailLines(body);
  // Flatten into a stream of text lines and job-link events.
  const stream = [];
  for (const l of lines) {
    const jobLinks = l.links.map((k) => ({ ...k, url: normalize(k.url) })).filter((k) => k.url && isJobUrl(k.url));
    if (!jobLinks.length) { stream.push({ text: l.text }); continue; }
    for (const k of jobLinks) {
      const anchor = k.anchor && !CTA_RE.test(k.anchor) && !isBoilerplate(k.anchor) ? k.anchor : null;
      // Text on the same line that isn't the anchor (e.g. "Senior FE at Acme: <url>").
      const rest = l.text.replace(k.anchor ?? '\u0000', '').replace(/[:\-–→>]+\s*$/, '').trim();
      stream.push({ url: k.url, anchor, inline: rest && !CTA_RE.test(rest) && !isBoilerplate(rest) ? rest : null });
    }
  }
  const linkIdx = stream.map((e, i) => (e.url ? i : -1)).filter((i) => i >= 0);
  const anchorStyle = linkIdx.length > 0 && linkIdx.filter((i) => stream[i].anchor).length * 2 > linkIdx.length;
  const byUrl = new Map();
  linkIdx.forEach((idx, n) => {
    const ev = stream[idx];
    let card;
    if (anchorStyle && ev.anchor) {
      const end = n + 1 < linkIdx.length ? linkIdx[n + 1] : stream.length;
      // stop at the first blank-line gap after some content, so footers don't leak in
      card = untilGap([ev.anchor, ...(ev.inline ? [ev.inline] : [])], stream.slice(idx + 1, end));
    } else {
      const start = n > 0 ? linkIdx[n - 1] + 1 : 0;
      const before = stream.slice(start, idx).map((e) => e.text);
      card = [...lastParagraphs(before), ...(ev.anchor ? [ev.anchor] : []), ...(ev.inline ? [ev.inline] : [])];
    }
    let info = parseCardLines(card);
    if (!anchorStyle && (!info.title || !info.company)) {
      // e.g. "Title / <url> / Company: X / Location: Y": read on to the next gap.
      const end = n + 1 < linkIdx.length ? linkIdx[n + 1] : stream.length;
      const more = parseCardLines(untilGap(card, stream.slice(idx + 1, end)));
      info = { title: info.title || more.title, company: info.company || more.company, location: info.location || more.location };
    }
    const slug = fromUrl(ev.url) ?? {};
    const job = {
      title: info.title || slug.title || '',
      company: info.company || slug.company || '',
      location: info.location || slug.location || '',
      url: ev.url,
    };
    const prev = byUrl.get(ev.url);
    if (prev) { for (const k of ['title', 'company', 'location']) prev[k] ||= job[k]; return; }
    byUrl.set(ev.url, job);
  });
  return [...byUrl.values()].filter((j) => j.title && j.company);
}

function untilGap(head, rest) {
  const out = [...head];
  let started = false;
  for (const e of rest) {
    if (e.url) break;
    if (!e.text) { if (started) break; continue; }
    if (isBoilerplate(clean(e.text))) continue;
    started = true;
    out.push(e.text);
    if (out.length >= head.length + 3) break;
  }
  return out;
}

/**
 * The last ≤4 meaningful lines before a link. A blank-line gap ends the card once it holds
 * at least two lines and one of them is more than a key/value, salary or location line.
 */
function lastParagraphs(texts) {
  const out = [];
  const substantive = (l) => !keyValue(l) && !isNoise(l) && !looksLikeLocation(l);
  for (let i = texts.length - 1; i >= 0 && out.length < 4; i--) {
    const t = clean(texts[i]);
    if (!t || isBoilerplate(t)) {
      if (out.length >= 2 && out.some(substantive)) break;
      continue;
    }
    out.unshift(t);
  }
  return out;
}

/** Title-case a URL slug ("senior-frontend-engineer" → "Senior Frontend Engineer"). */
export function unslug(s) {
  return String(s ?? '').split(/[-_]+/).filter(Boolean)
    .map((w) => (/^(sde|ui|ux|qa|ai|ml|ios|api|sre|vp|cto|hr|it|aws|gcp|ii|iii|iv)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}
