/**
 * Recognise a job posting URL from a supported ATS or LinkedIn.
 * @param {string} url
 * @returns {{source: string, slug?: string, id: string, byUrl?: boolean}|null} (`byUrl`: the source's fetchOne takes the URL)
 */
export function recognizeUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const i = parts.indexOf('jobs');
    if (i >= 1 && /^\d+$/.test(parts[i + 1] ?? '')) return { source: 'greenhouse', slug: parts[i - 1], id: parts[i + 1] };
    const gh = u.searchParams.get('gh_jid'), board = u.searchParams.get('for');
    if (gh && board) return { source: 'greenhouse', slug: board, id: gh };
    return null;
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    return parts.length >= 2 ? { source: 'lever', slug: parts[0], id: parts[1] } : null;
  }
  if (host === 'jobs.ashbyhq.com') {
    return parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1]) ? { source: 'ashby', slug: parts[0], id: parts[1] } : null;
  }
  if (host === 'apply.workable.com') {
    const i = parts.indexOf('j');
    return i === 1 && parts[2] ? { source: 'workable', slug: parts[0], id: parts[2] } : null;
  }
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') {
    const m = /^(\d{6,})/.exec(parts[1] ?? '');
    return parts[0] && m ? { source: 'smartrecruiters', slug: parts[0], id: m[1] } : null;
  }
  const rc = /^([a-z0-9-]+)\.recruitee\.com$/.exec(host);
  if (rc) {
    const i = parts.indexOf('o');
    return i >= 0 && parts[i + 1] ? { source: 'recruitee', slug: rc[1], id: parts[i + 1] } : null;
  }
  const wd = /^([a-z0-9-]+)\.wd\d{1,3}\.myworkdayjobs\.com$/.exec(host);
  if (wd) {
    const i = parts.indexOf('job');
    return i >= 1 && parts.length > i + 1 ? { source: 'workday', slug: wd[1], id: parts.slice(i).join('/'), byUrl: true } : null;
  }
  const kk = /^([a-z0-9-]+)\.keka\.com$/.exec(host);
  if (kk) {
    const i = parts.indexOf('jobdetails');
    return parts[0] === 'careers' && i >= 0 && /^\d+$/.test(parts[i + 1] ?? '') ? { source: 'keka', slug: kk[1], id: parts[i + 1], byUrl: true } : null;
  }
  const zr = /^([a-z0-9-]+)\.zohorecruit\.(com|in|eu|com\.au)$/.exec(host);
  if (zr) {
    return parts[0] === 'jobs' && parts[1]?.toLowerCase() === 'careers' && /^\d+$/.test(parts[2] ?? '') ? { source: 'zohorecruit', slug: zr[1], id: parts[2], byUrl: true } : null;
  }
  if (/(^|\.)linkedin\.com$/.test(host)) {
    const cur = u.searchParams.get('currentJobId');
    if (cur && /^\d+$/.test(cur)) return { source: 'linkedin', id: cur };
    const i = parts.indexOf('view');
    const m = i >= 0 ? /(\d{6,})$/.exec(parts[i + 1] ?? '') : null;
    return m ? { source: 'linkedin', id: m[1] } : null;
  }
  return null;
}

const ATS_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|myworkdayjobs\.com|smartrecruiters\.com|bamboohr\.com|recruitee\.com|breezy\.hr|jobvite\.com|icims\.com|teamtailor\.com|personio\.(de|com)|keka\.com|darwinbox\.in|freshteam\.com|zohorecruit\.(com|in))$/;

/**
 * Classify a posting host for the "⚠ Unverified" rule.
 * @param {string} url
 * @returns {'ats'|'linkedin'|'unknown'}
 */
export function hostClass(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return 'unknown'; }
  if (/(^|\.)linkedin\.com$/.test(host)) return 'linkedin';
  return ATS_HOSTS.test(host) ? 'ats' : 'unknown';
}
