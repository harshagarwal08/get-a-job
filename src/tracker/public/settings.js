// Settings view (profile/preferences.json editor) and the "Run search" panel.
import { h, icon, api, toast, label } from './util.js';

const WORK_MODES = ['remote', 'hybrid', 'onsite'];
const STAGES = ['seed', 'series-a', 'series-b', 'series-c', 'growth', 'public'];
const SIZES = ['2-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];
const SENIORITY = ['junior', 'mid', 'senior', 'staff', 'principal'];
const FREE_SOURCES = [
  ['ats', 'Company ATS feeds', 'Greenhouse, Lever, Ashby, Workable and more, for companies in config/companies.json.'],
  ['careersPages', 'Careers pages', 'Crawls listed careers pages for companies without a supported ATS.'],
  ['hn', 'Hacker News: Who is hiring?', 'The monthly thread; one posting per comment.'],
  ['arbeitnow', 'Arbeitnow', 'Europe-focused board with a visa-sponsorship flag.'],
  ['remotive', 'Remotive', 'Remote software jobs. Small and delayed 24h on the free API.'],
  ['remoteok', 'RemoteOK', 'Remote jobs; links back to RemoteOK as required.'],
  ['linkedin', 'LinkedIn guest search', 'Public guest search, no login.', 'Scraping-based: may conflict with LinkedIn\'s terms. Use sparingly.'],
];

const clone = (o) => JSON.parse(JSON.stringify(o));
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

// ---------------- state ----------------
export function settingsDirty(ctx) {
  const st = ctx.settings;
  return !!(st?.prefs && JSON.stringify(st.prefs) !== st.original);
}

export async function loadSettings(ctx) {
  const data = await api('/api/preferences');
  ctx.settings = {
    prefs: data.prefs, original: JSON.stringify(data.prefs), saved: clone(data.prefs), exists: data.exists,
    errors: data.errors ?? [], warnings: data.warnings ?? [], remoteScopes: data.remoteScopes ?? ['global'],
    usage: data.usage, newTracks: new Set(), saving: false,
  };
  ctx.settingsEl = null;
}

// ---------------- small components ----------------
function chipInput(list, { placeholder = 'Type and press Enter', suggestions = [], onChange, id, ariaLabel } = {}) {
  const wrap = h('div', { class: 'chip-input', onclick: (e) => { if (e.target === wrap) inp.focus(); } });
  const listId = suggestions.length ? `dl-${Math.random().toString(36).slice(2, 8)}` : null;
  const inp = h('input', { id, placeholder, 'aria-label': ariaLabel ?? placeholder, list: listId, autocomplete: 'off' });
  const draw = () => {
    wrap.replaceChildren(...[
      ...list.map((v, i) => h('span', { class: 'tag' }, v, h('button', {
        type: 'button', 'aria-label': `Remove ${v}`, title: 'Remove',
        onclick: () => { list.splice(i, 1); onChange(); draw(); inp.focus(); },
      }, '×'))),
      inp,
      listId ? h('datalist', { id: listId }, suggestions.filter((s) => !list.includes(s)).map((s) => h('option', { value: s }))) : null,
    ].filter(Boolean));
  };
  const commit = () => {
    const vals = inp.value.split(',').map((v) => v.trim()).filter(Boolean);
    let changed = false;
    for (const v of vals) if (!list.some((x) => x.toLowerCase() === v.toLowerCase())) { list.push(v); changed = true; }
    inp.value = '';
    if (changed) { onChange(); draw(); inp.focus(); }
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
    else if (e.key === 'Backspace' && !inp.value && list.length) { list.pop(); onChange(); draw(); inp.focus(); }
  });
  inp.addEventListener('blur', () => { if (inp.value.trim()) commit(); });
  inp.addEventListener('change', () => { if (suggestions.includes(inp.value)) commit(); });
  draw();
  return wrap;
}

function toggle(checked, onChange, labelText, desc) {
  const id = `t-${Math.random().toString(36).slice(2, 8)}`;
  return h('label', { class: 'toggle-row', for: id },
    h('span', { class: 'switch' }, h('input', { type: 'checkbox', id, role: 'switch', checked: !!checked, onchange: (e) => onChange(e.target.checked) }), h('i')),
    h('span', { class: 'toggle-text' }, h('b', null, labelText), desc ? h('small', null, desc) : null));
}

function pills(options, selected, onChange, { labelFor = (x) => x } = {}) {
  return h('div', { class: 'pills', role: 'group' }, options.map((o) => h('button', {
    type: 'button', class: `pill${selected.includes(o) ? ' on' : ''}`, 'aria-pressed': String(selected.includes(o)),
    onclick: (e) => {
      const i = selected.indexOf(o);
      if (i >= 0) selected.splice(i, 1); else selected.push(o);
      e.currentTarget.classList.toggle('on', i < 0);
      e.currentTarget.setAttribute('aria-pressed', String(i < 0));
      onChange();
    },
  }, labelFor(o))));
}

// Errors for a path: exact "path: msg" or nested "path.x"/"path[i]" prefixes.
function errorsFor(ctx, key, exact = false) {
  return (ctx.settings.errors ?? []).filter((e) => {
    const p = e.split(':')[0];
    return p === key || (!exact && (p.startsWith(`${key}.`) || p.startsWith(`${key}[`)));
  });
}
const msgOf = (e) => { const m = e.replace(/^[^:]+:\s*/, ''); return m === 'missing' ? 'Required' : m.charAt(0).toUpperCase() + m.slice(1); };
function errLine(ctx, key, exact = false) {
  const errs = errorsFor(ctx, key, exact);
  return errs.length ? h('div', { class: 'field-err', role: 'alert' }, errs.map(msgOf).join('; ')) : null;
}
// "tracks[0].titles: need …" → "Track 1 › titles: need …"
export const humanizeError = (e) => e.replace(/tracks\[(\d+)\]/g, (_, n) => `Track ${Number(n) + 1}`).replace(/^([^:]+):/, (m, p) => `${p.replace(/\./g, ' › ')}:`);

function fieldWrap(labelText, control, { hint, err, full, id } = {}) {
  return h('div', { class: `field${full ? ' full' : ''}${err ? ' has-err' : ''}` },
    h('label', { for: id }, labelText), control, hint ? h('small', { class: 'hint-line' }, hint) : null, err);
}

// ---------------- view ----------------
export function renderSettings(ctx) {
  if (!ctx.settings) {
    loadSettings(ctx).then(() => ctx.render()).catch((e) => toast(e.message, { error: true }));
    return h('section', null, h('div', { class: 'view-head' }, h('div', null, h('h1', null, 'Settings'), h('p', null, 'Loading…'))));
  }
  if (ctx.settingsEl) return ctx.settingsEl;
  const st = ctx.settings;
  const p = st.prefs;
  p.tracks ??= [];
  p.location ??= {};
  p.compensation ??= { currency: '', min: 0, unit: 'year' };
  p.sources ??= {};
  const markDirty = () => updateDirty(ctx);
  const rerender = () => { ctx.settingsEl = null; ctx.render(); };

  const saveBtn = h('button', { class: 'btn', type: 'button', disabled: true, onclick: () => save(ctx) }, 'Save');
  const discardBtn = h('button', { class: 'btn ghost', type: 'button', disabled: true, onclick: () => discard(ctx) }, 'Discard changes');
  const saveRunBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => save(ctx, { run: true }) }, 'Save & run search');
  ctx.settingsButtons = { saveBtn, discardBtn, saveRunBtn };

  // ---- banners ----
  const generalErrors = st.errors.filter((e) => !/^(tracks|location|compensation|noticePeriodDays|sources)/.test(e));
  const banners = h('div', { class: 'banners' },
    !st.exists ? h('div', { class: 'banner info' }, icon('file', 15), h('div', null, h('b', null, 'No preferences yet. '), 'These are the example defaults. Edit and save to create profile/preferences.json, or run /onboard in Claude Code for a guided setup.')) : null,
    st.errors.length ? h('div', { class: 'banner error', role: 'alert' }, icon('alert', 15), h('div', null, h('b', null, `${st.errors.length} problem${st.errors.length > 1 ? 's' : ''} to fix before saving`),
      h('ul', null, (generalErrors.length ? generalErrors : st.errors).map((e) => h('li', null, humanizeError(e)))))) : null,
    // Source warnings are shown next to their provider; summarise them here so they aren't missed.
    st.warnings.length ? h('div', { class: 'banner warn' }, icon('alert', 15), h('div', null,
      st.warnings.length === 1 ? st.warnings[0] : h('ul', null, st.warnings.map((w) => h('li', null, w))))) : null);

  // ---- tracks ----
  const trackCards = p.tracks.map((t, i) => {
    t.titles ??= []; t.excludeTitles ??= []; t.keywords ??= [];
    const isNew = st.newTracks.has(t);
    const idChip = h('span', { class: 'chip outline mono', title: isNew ? 'Generated from the name' : 'Track ids are fixed once saved' }, `id: ${t.id || '…'}`);
    return h('div', { class: 'track-card' },
      h('div', { class: 'track-head' },
        h('input', {
          class: 'input track-name', value: t.name ?? '', placeholder: 'Track name, e.g. Frontend Engineer', 'aria-label': `Track ${i + 1} name`,
          oninput: (e) => { t.name = e.target.value; if (isNew) { t.id = slug(t.name); idChip.textContent = `id: ${t.id || '…'}`; } markDirty(); },
        }),
        idChip,
        h('button', { class: 'btn ghost icon-btn', type: 'button', title: 'Remove track', 'aria-label': `Remove track ${t.name}`,
          onclick: () => { if (confirm(`Remove the "${t.name || t.id}" track?`)) { p.tracks.splice(i, 1); markDirty(); rerender(); } } }, icon('trash', 15))),
      errLine(ctx, `tracks[${i}].id`), errLine(ctx, `tracks[${i}].name`),
      h('div', { class: 'fields' },
        fieldWrap('Job titles to search', chipInput(t.titles, { onChange: markDirty, placeholder: 'Add a title', ariaLabel: 'Job titles' }), { full: true, err: errLine(ctx, `tracks[${i}].titles`) }),
        fieldWrap('Exclude titles containing', chipInput(t.excludeTitles, { onChange: markDirty, placeholder: 'e.g. Intern', ariaLabel: 'Excluded titles' }), { err: errLine(ctx, `tracks[${i}].excludeTitles`) }),
        fieldWrap('Keywords', chipInput(t.keywords, { onChange: markDirty, placeholder: 'e.g. React', ariaLabel: 'Keywords' }), { err: errLine(ctx, `tracks[${i}].keywords`) })));
  });
  const tracksCard = card('Tracks', 'Each track is a kind of role you want. Titles drive the search; excluded words filter titles out.', [
    errLine(ctx, 'tracks', true),
    h('div', { class: 'track-list' }, trackCards),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => {
        const t = { id: '', name: '', titles: [], excludeTitles: [], keywords: [], resume: 'profile/resume.md' };
        p.tracks.push(t); st.newTracks.add(t); markDirty(); rerender();
        requestAnimationFrame(() => [...document.querySelectorAll('.track-name')].at(-1)?.focus());
      } }, icon('plus', 14), 'Add track'),
      h('div', { class: 'field inline' }, h('label', null, 'Seniority'), pills(SENIORITY, (p.seniority ??= []), markDirty, { labelFor: cap }))),
  ], { wide: true });

  // ---- location ----
  const loc = p.location;
  loc.acceptableLocations ??= []; loc.workModes ??= []; loc.remoteScope ??= []; loc.workAuthorization ??= [];
  const workModes = h('div', { class: 'checks' }, WORK_MODES.map((m) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: loc.workModes.includes(m), onchange: (e) => {
      const i = loc.workModes.indexOf(m);
      if (e.target.checked && i < 0) loc.workModes.push(m);
      if (!e.target.checked && i >= 0) loc.workModes.splice(i, 1);
      markDirty();
    } }), label(m))));
  const locationCard = card('Location & eligibility', 'Used to tag jobs green (eligible), orange (check) or unknown.', [
    h('div', { class: 'fields' },
      fieldWrap('Based in', h('input', { class: 'input', id: 's-based', value: loc.based ?? '', placeholder: 'City, Country', oninput: (e) => { loc.based = e.target.value; markDirty(); } }), { id: 's-based', err: errLine(ctx, 'location.based') }),
      fieldWrap('Country code', h('input', { class: 'input mono', id: 's-cc', value: loc.countryCode ?? '', maxLength: 2, placeholder: 'IN', oninput: (e) => { loc.countryCode = e.target.value.toUpperCase(); e.target.value = loc.countryCode; markDirty(); } }), { id: 's-cc', err: errLine(ctx, 'location.countryCode') }),
      fieldWrap('Acceptable locations', chipInput(loc.acceptableLocations, { onChange: markDirty, placeholder: 'City, region or country', ariaLabel: 'Acceptable locations' }), { full: true, err: errLine(ctx, 'location.acceptableLocations') }),
      fieldWrap('Work modes', workModes, { err: errLine(ctx, 'location.workModes') }),
      fieldWrap('Work authorization', chipInput(loc.workAuthorization, { onChange: markDirty, placeholder: 'Country code, e.g. IN', ariaLabel: 'Work authorization' }), { err: errLine(ctx, 'location.workAuthorization') }),
      fieldWrap('Remote jobs open to', pills(st.remoteScopes, loc.remoteScope, markDirty, { labelFor: (x) => (x.length <= 4 ? x.toUpperCase() : cap(x)) }), { full: true, hint: 'Regions a remote role may be restricted to and still count for you.', err: errLine(ctx, 'location.remoteScope') }),
      h('div', { class: 'field full toggles' },
        toggle(loc.needsSponsorship, (v) => { loc.needsSponsorship = v; markDirty(); }, 'I need visa sponsorship', 'Roles outside your work authorization are flagged.'),
        toggle(loc.openToRelocation, (v) => { loc.openToRelocation = v; markDirty(); }, 'Open to relocation', 'Onsite roles elsewhere are tagged orange instead of filtered.'),
        errLine(ctx, 'location.needsSponsorship'))),
  ]);

  // ---- comp & notice ----
  const comp = p.compensation;
  const compCard = card('Compensation & notice', 'The floor gates jobs that publish a salary.', [
    h('div', { class: 'fields three' },
      fieldWrap('Currency', h('input', { class: 'input mono', id: 's-cur', value: comp.currency ?? '', maxLength: 3, placeholder: 'INR', oninput: (e) => { comp.currency = e.target.value.toUpperCase(); e.target.value = comp.currency; markDirty(); } }), { id: 's-cur' }),
      fieldWrap('Minimum', h('input', { class: 'input num', id: 's-min', type: 'number', min: 0, step: 'any', value: comp.min ?? 0, oninput: (e) => { comp.min = e.target.value === '' ? 0 : Number(e.target.value); markDirty(); } }), { id: 's-min' }),
      fieldWrap('Per', h('select', { class: 'select', id: 's-unit', onchange: (e) => { comp.unit = e.target.value; markDirty(); } },
        ['year', 'month', 'hour'].map((u) => h('option', { value: u, selected: comp.unit === u }, cap(u)))), { id: 's-unit' })),
    errLine(ctx, 'compensation'),
    h('div', { class: 'fields' },
      fieldWrap('Notice period (days)', h('input', { class: 'input num', id: 's-notice', type: 'number', min: 0, max: 365, value: p.noticePeriodDays ?? '', oninput: (e) => { p.noticePeriodDays = e.target.value === '' ? undefined : Number(e.target.value); markDirty(); } }), { id: 's-notice', err: errLine(ctx, 'noticePeriodDays') }),
      fieldWrap('Comp note', h('input', { class: 'input', id: 's-cnote', value: comp.note ?? '', placeholder: 'Optional', oninput: (e) => { comp.note = e.target.value; markDirty(); } }), { id: 's-cnote' })),
  ]);

  // ---- companies & deal-breakers ----
  const companyCard = card('Companies', 'Preferences used when ranking. They don\'t filter the search.', [
    h('div', { class: 'fields one' },
      fieldWrap('Stage', chipInput((p.companyStage ??= []), { onChange: markDirty, suggestions: STAGES, placeholder: 'e.g. series-a', ariaLabel: 'Company stage' })),
      fieldWrap('Size', chipInput((p.companySize ??= []), { onChange: markDirty, suggestions: SIZES, placeholder: 'e.g. 51-200', ariaLabel: 'Company size' })),
      fieldWrap('Industries', chipInput((p.industries ??= []), { onChange: markDirty, placeholder: 'e.g. fintech', ariaLabel: 'Industries' }))),
  ]);
  const dealCard = card('Deal-breakers', 'Anything that rules a job out. Claude checks these when ranking.', [
    chipInput((p.dealBreakers ??= []), { onChange: markDirty, placeholder: 'e.g. 5 days onsite', ariaLabel: 'Deal-breakers' }),
  ]);

  // ---- sources ----
  const src = p.sources;
  const warnFor = (k) => st.warnings.filter((w) => w.startsWith(`sources.${k}`));
  const free = h('div', { class: 'source-list' }, FREE_SOURCES.map(([k, name, desc, tos]) => h('div', { class: 'source' },
    toggle(src[k] ?? (k === 'careersPages'), (v) => { src[k] = v; markDirty(); }, name, desc),
    tos ? h('div', { class: 'tos' }, icon('alert', 13), tos) : null, errLine(ctx, `sources.${k}`))));

  const numField = (obj, key, lbl, { min, max, step = 1 } = {}) => {
    const id = `n-${Math.random().toString(36).slice(2, 7)}`;
    return fieldWrap(lbl, h('input', { class: 'input num', id, type: 'number', min, max, step, value: obj[key] ?? '',
      oninput: (e) => { if (e.target.value === '') delete obj[key]; else obj[key] = Number(e.target.value); markDirty(); } }), { id });
  };
  const provider = (k, title, desc, body, { paid, tos } = {}) => {
    src[k] ??= { enabled: false };
    const o = src[k];
    const details = h('div', { class: `provider-body${o.enabled ? '' : ' off'}` }, body(o));
    return h('div', { class: 'provider' },
      h('div', { class: 'provider-head' },
        toggle(o.enabled, (v) => { o.enabled = v; details.classList.toggle('off', !v); markDirty(); }, title, desc),
        paid ? h('span', { class: 'chip st-interview' }, 'Paid') : h('span', { class: 'chip plain' }, 'Free, local')),
      warnFor(k).map((w) => h('div', { class: 'tos warn' }, icon('alert', 13), w)),
      tos ? h('div', { class: 'tos' }, icon('alert', 13), tos) : null,
      errLine(ctx, `sources.${k}`), details);
  };
  const providers = h('div', { class: 'provider-list' },
    provider('googleJobs', 'Google for Jobs', 'Search Google\'s job index through JSearch or SerpAPI. Needs an API key in .env.', (o) => h('div', { class: 'fields three' },
      fieldWrap('Provider', h('select', { class: 'select', onchange: (e) => { o.provider = e.target.value; markDirty(); } },
        [['jsearch', 'JSearch (RapidAPI)'], ['serpapi', 'SerpAPI']].map(([v, l]) => h('option', { value: v, selected: (o.provider ?? 'jsearch') === v }, l)))),
      numField(o, 'maxQueries', 'Queries per run', { min: 1, max: 20 }),
      numField(o, 'maxRequestsPerMonth', 'Requests per month', { min: 1, max: 10000 }),
      fieldWrap('Country', h('input', { class: 'input mono', value: o.country ?? '', maxLength: 2, placeholder: 'in', oninput: (e) => { o.country = e.target.value.toLowerCase(); markDirty(); } })),
      fieldWrap('Posted within', h('select', { class: 'select', onchange: (e) => { o.datePosted = e.target.value; markDirty(); } },
        [['today', 'Today'], ['3days', '3 days'], ['week', 'A week'], ['month', 'A month']].map(([v, l]) => h('option', { value: v, selected: (o.datePosted ?? 'week') === v }, l)))))
    , { paid: true }),
    provider('apify', 'Apify actors', 'Run up to 3 Apify scrapers you choose. Needs APIFY_TOKEN in .env.', (o) => h('div', null,
      h('div', { class: 'fields three' },
        numField(o, 'maxItems', 'Max items per actor', { min: 1, max: 500 }),
        numField(o, 'maxChargeUsd', 'Max $ per actor run', { min: 0.01, max: 5, step: 0.01 }),
        numField(o, 'maxUsdPerMonth', 'Max $ per month', { min: 0.01, max: 1000, step: 0.01 })),
      h('small', { class: 'hint-line' }, `${(o.actors ?? []).length} actor${(o.actors ?? []).length === 1 ? '' : 's'} configured. Edit the actor list in profile/preferences.json.`)), { paid: true }),
    provider('jobspy', 'JobSpy', 'Open-source scraper for Indeed, Naukri, Glassdoor and Google, run locally with uv.', (o) => h('div', { class: 'fields three' },
      fieldWrap('Sites', chipInput((o.sites ??= []), { onChange: markDirty, suggestions: ['indeed', 'naukri', 'glassdoor', 'google', 'linkedin', 'zip_recruiter'], placeholder: 'Add a site', ariaLabel: 'JobSpy sites' }), { full: true }),
      numField(o, 'resultsWanted', 'Results per query', { min: 1, max: 100 }),
      numField(o, 'hoursOld', 'Max age (hours)', { min: 1, max: 720 }),
      numField(o, 'maxQueries', 'Queries per run', { min: 1, max: 5 })),
    { tos: 'Scraping-based: may conflict with the sites\' terms. LinkedIn is only used if LinkedIn is enabled above.' }));

  const sourcesCard = card('Sources', 'Where the search looks. Free sources need no keys; paid providers only run when you tick "Include paid providers".', [
    h('h4', { class: 'sub' }, 'Free sources'), free,
    h('h4', { class: 'sub' }, 'Providers'), providers,
    h('div', { class: 'fields' }, fieldWrap('Ignore postings older than (days)', h('input', { class: 'input num', id: 's-age', type: 'number', min: 0, max: 365, value: src.maxAgeDays ?? '',
      oninput: (e) => { if (e.target.value === '') delete src.maxAgeDays; else src.maxAgeDays = Number(e.target.value); markDirty(); } }), { id: 's-age', err: errLine(ctx, 'sources.maxAgeDays') })),
  ], { wide: true });

  const el = h('section', { class: 'settings' },
    h('div', { class: 'view-head sticky-head' },
      h('div', null, h('h1', null, 'Settings'), h('p', null, 'Search preferences, saved to profile/preferences.json.')),
      h('span', { class: 'spacer' }),
      h('span', { class: 'dirty-flag', hidden: true }, 'Unsaved changes'),
      discardBtn, saveBtn, saveRunBtn),
    banners,
    searchPanel(ctx, { where: 'settings' }),
    h('div', { class: 'settings-grid' }, tracksCard,
      h('div', { class: 'settings-col' }, locationCard),
      h('div', { class: 'settings-col' }, compCard, dealCard, companyCard),
      sourcesCard));
  ctx.settingsEl = el;
  requestAnimationFrame(() => updateDirty(ctx));
  return el;
}

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

function card(title, desc, kids, { wide } = {}) {
  return h('section', { class: `panel settings-card${wide ? ' wide' : ''}` }, h('h3', null, title), desc ? h('p', { class: 'hint' }, desc) : null, kids);
}

function updateDirty(ctx) {
  const dirty = settingsDirty(ctx);
  const b = ctx.settingsButtons;
  if (!b) return;
  b.saveBtn.disabled = !dirty || ctx.settings.saving;
  b.discardBtn.disabled = !dirty || ctx.settings.saving;
  b.saveRunBtn.hidden = !dirty;
  b.discardBtn.hidden = !dirty;
  const flag = ctx.settingsEl?.querySelector('.dirty-flag');
  if (flag) flag.hidden = !dirty;
}

function discard(ctx) {
  if (!confirm('Discard your unsaved changes?')) return;
  const st = ctx.settings;
  st.prefs = clone(st.saved);
  st.newTracks = new Set();
  ctx.settingsEl = null;
  ctx.render();
}

async function save(ctx, { run = false } = {}) {
  const st = ctx.settings;
  const dirty = settingsDirty(ctx);
  if (!dirty && run) return runSearch(ctx);
  if (!dirty) return;
  st.saving = true;
  updateDirty(ctx);
  try {
    const res = await api('/api/preferences', { method: 'PUT', body: st.prefs });
    st.prefs = res.prefs; st.saved = clone(res.prefs); st.original = JSON.stringify(res.prefs);
    st.errors = []; st.warnings = res.warnings ?? []; st.exists = true; st.usage = res.usage ?? st.usage;
    st.newTracks = new Set();
    ctx.meta = await api('/api/meta').catch(() => ctx.meta);
    toast('Preferences saved', { sub: run ? 'Starting the search…' : 'They apply to the next search.' });
    st.saving = false;
    ctx.settingsEl = null;
    ctx.render();
    if (run) runSearch(ctx);
  } catch (e) {
    st.saving = false;
    if (e.data?.errors) {
      st.errors = e.data.errors; st.warnings = e.data.warnings ?? st.warnings;
      ctx.settingsEl = null;
      ctx.render();
      toast(`Not saved: ${e.data.errors.length} problem${e.data.errors.length > 1 ? 's' : ''} to fix`, { error: true });
      requestAnimationFrame(() => document.querySelector('.settings .banner.error, .settings .has-err')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    } else {
      updateDirty(ctx);
      toast(e.message, { error: true });
    }
  }
}

// ---------------- search ----------------
const paidEnabled = (prefs) => !!(prefs?.sources?.googleJobs?.enabled || prefs?.sources?.apify?.enabled);

export async function runSearch(ctx, { paid = ctx.searchOpts.paid, track = ctx.searchOpts.track } = {}) {
  if (ctx.searchState?.running) { toast('A search is already running'); return; }
  try {
    await api('/api/search', { method: 'POST', body: { ...(paid ? { paid: true, confirmPaid: true } : {}), ...(track ? { track } : {}) } });
    ctx.searchSeen = false;
    await pollSearch(ctx);
  } catch (e) {
    toast(e.message, { error: true });
  }
}

let pollTimer = null;
export async function pollSearch(ctx) {
  clearTimeout(pollTimer);
  try {
    const prev = ctx.searchState;
    ctx.searchState = await api('/api/search/status');
    const s = ctx.searchState;
    drawSearchStatus(ctx);
    if (s.running) { pollTimer = setTimeout(() => pollSearch(ctx), 1000); return; }
    if (prev?.running && !s.running) await ctx.onSearchDone?.(s);
  } catch { pollTimer = setTimeout(() => pollSearch(ctx), 3000); }
}

function confirmPaid(ctx) {
  const st = ctx.settings;
  const u = st?.usage;
  const prefs = st?.saved ?? {};
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'paid-title' });
    const done = (ok) => { modal.remove(); prevFocus?.focus?.(); resolve(ok); };
    modal.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') done(false); });
    const row = (name, used, limit, unit) => {
      const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
      return h('div', { class: 'usage-row' },
        h('div', { class: 'usage-top' }, h('b', null, name), h('span', { class: 'num' }, `${unit === '$' ? `$${used.toFixed(2)}` : used} of ${unit === '$' ? `$${limit}` : `${limit} ${unit}`}`)),
        h('div', { class: 'meter' }, h('i', { style: { width: `${pct}%` }, class: pct > 80 ? 'hot' : '' })));
    };
    modal.replaceChildren(h('div', { class: 'modal-card' },
      h('h2', { id: 'paid-title' }, 'Include paid providers?'),
      h('p', { class: 'muted', style: { marginTop: 0 } }, 'This search will make paid API calls. Budgets are enforced before every request, so it stops at your monthly caps.'),
      h('div', { class: 'usage' },
        h('div', { class: 'usage-month' }, `This month (${u?.month ?? ''})`),
        prefs.sources?.googleJobs?.enabled ? row('Google for Jobs', u?.googleJobs?.requests ?? 0, u?.googleJobs?.limit ?? 100, 'requests') : null,
        prefs.sources?.apify?.enabled ? row('Apify', u?.apify?.usd ?? 0, u?.apify?.limit ?? 5, '$') : null),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => done(true) }, 'Include paid providers'))));
    document.body.append(modal);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
    modal.querySelector('.btn.primary').focus();
  });
}

// Controls + status area. Status re-draws in place every poll; controls keep their state.
export function searchPanel(ctx, { where = 'settings' } = {}) {
  const saved = ctx.settings?.saved ?? null;
  const tracks = (saved?.tracks ?? ctx.meta.tracks ?? []).map((t) => [t.id, t.name ?? t.id]);
  const status = h('div', { class: 'search-status', dataset: { where } });
  const paidBox = paidEnabled(saved) ? h('label', { class: 'check paid-check' },
    h('input', { type: 'checkbox', checked: ctx.searchOpts.paid, onchange: async (e) => {
      if (e.target.checked) {
        const ok = await confirmPaid(ctx);
        e.target.checked = ok;
      }
      ctx.searchOpts.paid = e.target.checked;
    } }), 'Include paid providers (Google for Jobs / Apify)') : null;
  const panel = h('section', { class: `panel search-panel${where === 'jobs' ? ' compact' : ''}` },
    h('div', { class: 'search-head' },
      h('div', { class: 'search-title' },
        h('h3', null, 'Run a search'),
        h('p', { class: 'hint' }, 'Fetches new postings from your enabled sources into the Jobs inbox, using your saved settings.')),
      h('div', { class: 'search-controls' },
        tracks.length > 1 ? h('select', { class: 'select', 'aria-label': 'Track to search', onchange: (e) => { ctx.searchOpts.track = e.target.value || null; } },
          h('option', { value: '' }, 'All tracks'), tracks.map(([id, n]) => h('option', { value: id, selected: ctx.searchOpts.track === id }, n))) : null,
        paidBox,
        h('button', { class: 'btn primary run-btn', type: 'button', onclick: () => (where === 'settings' && settingsDirty(ctx) ? save(ctx, { run: true }) : runSearch(ctx)) },
          icon('search', 14), 'Run search'))),
    h('p', { class: 'stale-note' }, 'Re-running marks new jobs that no longer match your tracks or locations as skipped. Ranked and tracked jobs are kept.'),
    status);
  drawStatusInto(ctx, status);
  return panel;
}

// Status-only box (Jobs inbox): progress + result, no controls.
export function searchStatusBox(ctx) {
  const el = h('div', { class: 'search-status standalone' });
  drawStatusInto(ctx, el);
  return el;
}

function drawSearchStatus(ctx) {
  for (const el of document.querySelectorAll('.search-status')) drawStatusInto(ctx, el);
  for (const b of document.querySelectorAll('.run-btn')) b.disabled = !!ctx.searchState?.running;
}

const elapsed = (from, to) => {
  const s = Math.max(0, Math.round(((to ? new Date(to) : new Date()) - new Date(from)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function drawStatusInto(ctx, el) {
  const s = ctx.searchState;
  if (!s || (!s.running && !s.finishedAt) || (ctx.searchDismissed === s.id && !s.running)) { el.replaceChildren(); el.hidden = true; return; }
  el.hidden = false;
  if (s.running) {
    el.replaceChildren(h('div', { class: 'run-state' },
      h('div', { class: 'run-top' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('b', null, 'Searching…'),
        h('span', { class: 'muted num' }, elapsed(s.startedAt)), s.options?.paid ? h('span', { class: 'chip st-interview' }, 'Paid on') : null),
      h('pre', { class: 'log', 'aria-live': 'polite' }, s.log.length ? s.log.slice(-8).join('\n') : 'Starting…')));
    return;
  }
  const sum = s.summary;
  const ok = s.exitCode === 0 && sum;
  const tile = (n, lbl, cls = '') => h('div', { class: `mini ${cls}` }, h('b', { class: 'num' }, n ?? 0), h('span', null, lbl));
  const sources = Object.entries(sum?.sources ?? {});
  el.replaceChildren(h('div', { class: `run-result ${ok ? 'ok' : 'fail'}` },
    h('div', { class: 'run-top' },
      icon(ok ? 'check' : 'alert', 16),
      h('b', null, ok ? 'Search finished' : 'Search failed'),
      h('span', { class: 'muted num' }, `${elapsed(s.startedAt, s.finishedAt)} · ${new Date(s.finishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { ctx.searchDismissed = s.id; drawSearchStatus(ctx); } }, 'Dismiss')),
    s.error ? h('div', { class: 'run-error' }, s.error) : null,
    ok ? h('div', { class: 'minis' }, tile(sum.new, 'new', 'accent'), tile(sum.updated, 'updated'), tile(sum.expired, 'expired'), tile(sum.skipped, 'skipped')) : null,
    sources.length ? h('div', { class: 'per-source' }, sources.map(([k, v]) => h('span', { class: 'chip plain', title: `${v.jobs ?? 0} postings fetched, ${v.matched ?? 0} matched` }, `${k} `, h('b', { class: 'num' }, v.matched ?? 0), h('span', { class: 'muted' }, ` / ${v.jobs ?? 0}`)))) : null,
    (sum?.errors ?? []).length ? h('details', { class: 'run-list' }, h('summary', null, `${sum.errors.length} source error${sum.errors.length > 1 ? 's' : ''}`),
      h('ul', null, sum.errors.map((e) => h('li', null, `${e.company} (${e.source}): ${e.error}`)))) : null,
    [...(sum?.warnings ?? []), ...(sum?.usage ?? [])].length ? h('ul', { class: 'run-warn' }, [...(sum.warnings ?? []), ...(sum.usage ?? []).map((u) => `Usage: ${u}`)].map((w) => h('li', null, w))) : null,
    !ok && s.log.length ? h('pre', { class: 'log' }, s.log.slice(-8).join('\n')) : null,
    ok ? h('div', { class: 'next-hint' },
      h('span', null, sum.new ? h('span', null, 'Next: ask Claude to ', h('code', null, '/rank'), ' the new jobs.') : 'No new jobs this time.'),
      h('a', { class: 'btn sm', href: '#jobs' }, 'Open Jobs inbox')) : null));
}
