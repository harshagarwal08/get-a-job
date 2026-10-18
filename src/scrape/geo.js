// Lightweight location heuristics: countries, regions and work mode from free text.

const PLACES = {
  IN: ['india', 'bengaluru', 'bangalore', 'mumbai', 'bombay', 'pune', 'hyderabad', 'chennai', 'new delhi', 'delhi', 'ncr',
    'gurgaon', 'gurugram', 'noida', 'kolkata', 'ahmedabad', 'jaipur', 'kochi', 'cochin', 'trivandrum', 'thiruvananthapuram',
    'coimbatore', 'indore', 'chandigarh', 'mysore', 'mysuru', 'goa', 'bhubaneswar', 'nagpur', 'lucknow', 'vadodara',
    'surat', 'visakhapatnam', 'karnataka', 'maharashtra', 'telangana', 'tamil nadu'],
  US: ['united states', 'united states of america', 'u.s.', 'san francisco', 'new york', 'seattle', 'austin', 'boston',
    'los angeles', 'chicago', 'denver', 'palo alto', 'mountain view', 'menlo park', 'sunnyvale', 'san jose', 'san mateo',
    'redwood city', 'oakland', 'berkeley', 'atlanta', 'miami', 'washington dc', 'washington, dc', 'portland', 'salt lake city',
    'philadelphia', 'pittsburgh', 'dallas', 'houston', 'raleigh', 'bay area', 'silicon valley', 'california', 'texas',
    'new jersey', 'brooklyn', 'manhattan', 'san diego', 'boulder', 'nashville', 'minneapolis', 'detroit', 'phoenix'],
  CA: ['canada', 'toronto', 'vancouver', 'montreal', 'montréal', 'ottawa', 'waterloo', 'calgary'],
  GB: ['united kingdom', 'england', 'london', 'manchester', 'edinburgh', 'bristol', 'scotland', 'great britain'],
  IE: ['ireland', 'dublin'],
  DE: ['germany', 'deutschland', 'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne'],
  FR: ['france', 'paris', 'lyon'],
  NL: ['netherlands', 'amsterdam', 'rotterdam', 'the hague', 'utrecht'],
  ES: ['spain', 'madrid', 'barcelona'],
  PT: ['portugal', 'lisbon', 'porto'],
  IT: ['italy', 'milan', 'rome'],
  SE: ['sweden', 'stockholm'], DK: ['denmark', 'copenhagen'], NO: ['norway', 'oslo'], FI: ['finland', 'helsinki'],
  PL: ['poland', 'warsaw', 'krakow', 'kraków'], CH: ['switzerland', 'zurich', 'zürich', 'geneva'],
  AT: ['austria', 'vienna'], BE: ['belgium', 'brussels'], CZ: ['czech', 'czechia', 'prague'],
  RO: ['romania', 'bucharest'], BG: ['bulgaria', 'sofia'], HU: ['hungary', 'budapest'], HR: ['croatia', 'zagreb'],
  LV: ['latvia', 'riga'], SK: ['slovakia', 'bratislava'], SI: ['slovenia', 'ljubljana'], RS: ['serbia', 'belgrade'],
  UA: ['ukraine', 'kyiv', 'kiev'], GR: ['greece', 'athens'], EE: ['estonia', 'tallinn'], LT: ['lithuania', 'vilnius'],
  SG: ['singapore'], AE: ['united arab emirates', 'dubai', 'abu dhabi'], SA: ['saudi arabia', 'riyadh'],
  IL: ['israel', 'tel aviv'], JP: ['japan', 'tokyo'], KR: ['south korea', 'korea', 'seoul'],
  CN: ['china', 'beijing', 'shanghai', 'shenzhen'], HK: ['hong kong'], TW: ['taiwan', 'taipei'],
  AU: ['australia', 'sydney', 'melbourne', 'brisbane'], NZ: ['new zealand', 'auckland'],
  ID: ['indonesia', 'jakarta'], MY: ['malaysia', 'kuala lumpur'], PH: ['philippines', 'manila'],
  VN: ['vietnam', 'ho chi minh', 'hanoi'], TH: ['thailand', 'bangkok'],
  BR: ['brazil', 'brasil', 'são paulo', 'sao paulo'], MX: ['mexico', 'méxico', 'mexico city'],
  AR: ['argentina', 'buenos aires'], CO: ['colombia', 'bogota', 'bogotá'], CL: ['chile', 'santiago'],
  ZA: ['south africa', 'cape town', 'johannesburg'], NG: ['nigeria', 'lagos'], KE: ['kenya', 'nairobi'],
  EG: ['egypt', 'cairo'], TR: ['turkey', 'türkiye', 'istanbul'], PK: ['pakistan', 'karachi', 'lahore'],
  BD: ['bangladesh', 'dhaka'], LK: ['sri lanka', 'colombo'],
};

// Case-sensitive tokens (avoid matching "in", "us" in prose).
const CODES = { US: ['US', 'USA', 'SF', 'NYC'], GB: ['UK', 'GB'], AE: ['UAE'] };
const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const US_STATE_RE = new RegExp(`,\\s*(${US_STATES})(?=\\s*($|[,;|()/-]))`);
const CITY_STATE_RE = new RegExp(`([A-Za-z][A-Za-z .'-]{1,30}),\\s*(${US_STATES})(?=\\s*($|[,;|()/-]))`, 'g');

const EU = ['IE', 'DE', 'FR', 'NL', 'ES', 'PT', 'IT', 'SE', 'DK', 'FI', 'PL', 'AT', 'BE', 'CZ', 'RO', 'GR', 'EE', 'LT', 'BG', 'HU', 'HR', 'LV', 'SK', 'SI'];
export const REGIONS = {
  eu: EU,
  europe: [...EU, 'GB', 'CH', 'NO', 'RS', 'UA'],
  emea: [...EU, 'GB', 'CH', 'NO', 'RS', 'UA', 'AE', 'SA', 'IL', 'ZA', 'NG', 'KE', 'EG', 'TR'],
  apac: ['IN', 'SG', 'JP', 'KR', 'CN', 'HK', 'TW', 'AU', 'NZ', 'ID', 'MY', 'PH', 'VN', 'TH', 'PK', 'BD', 'LK'],
  asia: ['IN', 'SG', 'JP', 'KR', 'CN', 'HK', 'TW', 'ID', 'MY', 'PH', 'VN', 'TH', 'PK', 'BD', 'LK', 'AE', 'SA', 'IL'],
  americas: ['US', 'CA', 'BR', 'MX', 'AR', 'CO', 'CL'],
  'north america': ['US', 'CA'],
  latam: ['BR', 'MX', 'AR', 'CO', 'CL'],
};

const REGION_RE = [
  ['global', /\b(anywhere|worldwide|world-wide|global(ly)?|international|any location|all locations)\b/i],
  ['apac', /\b(apac|asia[- ]pacific|apj)\b/i],
  ['asia', /\basia\b(?![- ]pacific)/i],
  ['emea', /\bemea\b/i],
  ['europe', /\beurope(an)?\b|\b(cet|cest|emea time ?zones?)\b/i],
  ['eu', /\bEU\b/],
  ['north america', /\bnorth(ern)? america\b|\bNAMER\b/i],
  ['latam', /\b(latam|latin america|south america)\b/i],
  ['americas', /\bamericas\b/i],
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PLACE_RES = Object.entries(PLACES).map(([cc, names]) =>
  [cc, new RegExp(`(^|[^\\p{L}])(${names.map(esc).join('|')})(?=$|[^\\p{L}])`, 'iu')]);
const CODE_RES = Object.entries(CODES).map(([cc, codes]) => [cc, new RegExp(`(^|[^A-Za-z])(${codes.join('|')})(?=$|[^A-Za-z])`)]);
const NAME_TO_CODE = new Map(Object.entries(PLACES).map(([cc, n]) => [n[0], cc]));

/**
 * Detect ISO-3166 alpha-2 country codes mentioned in a location string.
 * @param {string} text
 * @returns {string[]}
 */
export function detectCountries(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const found = new Set();
  // "<City>, <US state>" is a US place even when the city name exists elsewhere ("Delhi, NY").
  // Exception: "<Indian city>, TN" (Tamil Nadu) and anything followed by ", India".
  let rest = s.replace(CITY_STATE_RE, (m, city, st) => {
    if (/^\s*,\s*india\b/i.test(s.slice(s.indexOf(m) + m.length))) return m;
    if (st === 'TN' && PLACE_RES.find(([cc]) => cc === 'IN')[1].test(city)) return m;
    found.add('US');
    return ' ';
  });
  for (const [cc, re] of PLACE_RES) if (re.test(rest)) found.add(cc);
  for (const [cc, re] of CODE_RES) if (re.test(rest)) found.add(cc);
  if (US_STATE_RE.test(rest) && !found.has('IN')) found.add('US');
  return [...found];
}

/** Map a country name or 2-letter code to a code (null if unknown). */
export function countryCode(nameOrCode) {
  const s = String(nameOrCode ?? '').trim();
  if (!s) return null;
  if (/^[A-Z]{2}$/.test(s)) return s === 'UK' ? 'GB' : s;
  if (/^[a-z]{2}$/.test(s)) return s.toUpperCase();
  return NAME_TO_CODE.get(s.toLowerCase()) ?? detectCountries(s)[0] ?? null;
}

/**
 * Detect region scopes ("global", "apac", "emea", ...) in text.
 * @param {string} text
 * @returns {string[]}
 */
export function detectRegions(text) {
  const s = String(text ?? '');
  return REGION_RE.filter(([, re]) => re.test(s)).map(([r]) => r);
}

/** Whether a region scope covers a country code. "global" covers everything. */
export function regionCovers(region, cc) {
  if (region === 'global') return true;
  return (REGIONS[region] ?? []).includes(cc);
}

/**
 * Detect work mode. Structured ATS fields win; otherwise infer from text.
 * @param {string|null|undefined} structured e.g. "Remote", "OnSite", "hybrid", "unspecified"
 * @param {...string} texts location/title strings
 * @returns {'remote'|'hybrid'|'onsite'|'unknown'}
 */
export function detectWorkMode(structured, ...texts) {
  const k = String(structured ?? '').toLowerCase().replace(/[_-]/g, '').replace(/\s+/g, '');
  const mapped = { remote: 'remote', hybrid: 'hybrid', onsite: 'onsite', inoffice: 'onsite', office: 'onsite' }[k];
  if (mapped) return mapped;
  const s = texts.filter(Boolean).join(' | ');
  if (/\bhybrid\b/i.test(s)) return 'hybrid';
  if (/\b(remote|work from home|wfh|distributed|anywhere|worldwide)\b/i.test(s)) return 'remote';
  if (/\b(on-?site|in[- ]office|in[- ]person)\b/i.test(s)) return 'onsite';
  return 'unknown';
}

const EXCLUDE_RE = /\b(?:excluding|except(?:\s+for)?|not\s+in|not|outside(?:\s+of)?)\s+([^.;)|]+)/i;

/**
 * Split a location string into the allowed part and an exclusion clause
 * ("Remote (worldwide, excluding India)" → allowed "Remote (worldwide, )", excluded countries [IN]).
 * @param {string} text
 * @returns {{text: string, excludedText: string, excludedCountries: string[], excludedRegions: string[]}}
 */
export function splitExclusions(text) {
  const s = String(text ?? '');
  const m = EXCLUDE_RE.exec(s);
  if (!m) return { text: s, excludedText: '', excludedCountries: [], excludedRegions: [] };
  return { text: s.replace(m[0], ' '), excludedText: m[1].trim(), excludedCountries: detectCountries(m[1]), excludedRegions: detectRegions(m[1]) };
}
