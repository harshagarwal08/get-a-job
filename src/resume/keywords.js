/** Small synonym groups for common tech terms (lowercase). Any member counts as a variant of another. */
export const SYNONYMS = [
  ['javascript', 'js', 'ecmascript', 'es6'],
  ['typescript', 'ts'],
  ['kubernetes', 'k8s'],
  ['react', 'react.js', 'reactjs'],
  ['react native', 'react-native'],
  ['node.js', 'node', 'nodejs'],
  ['vue', 'vue.js', 'vuejs'],
  ['next.js', 'nextjs'],
  ['angular', 'angularjs', 'angular.js'],
  ['postgresql', 'postgres', 'psql'],
  ['mongodb', 'mongo'],
  ['golang', 'go lang'],
  ['aws', 'amazon web services'],
  ['gcp', 'google cloud', 'google cloud platform'],
  ['azure', 'microsoft azure'],
  ['ci/cd', 'continuous integration', 'continuous delivery', 'continuous deployment'],
  ['machine learning', 'ml'],
  ['artificial intelligence', 'ai'],
  ['llm', 'large language model', 'llms', 'large language models'],
  ['graphql', 'gql'],
  ['rest', 'restful', 'rest api', 'rest apis'],
  ['css', 'css3'],
  ['html', 'html5'],
  ['ui', 'user interface'],
  ['ux', 'user experience'],
  ['e2e', 'end-to-end', 'end to end'],
  ['a11y', 'accessibility', 'wcag'],
  ['i18n', 'internationalization', 'localization', 'l10n'],
  ['tailwind', 'tailwindcss', 'tailwind css'],
  ['frontend', 'front-end', 'front end'],
  ['backend', 'back-end', 'back end'],
  ['full stack', 'full-stack', 'fullstack'],
  ['redux', 'redux toolkit', 'rtk'],
];

// Boundaries also treat "x.y" as one token, so "js" does not match inside "React.js".
const BOUND_L = '(?<![A-Za-z0-9+#])(?<![A-Za-z0-9][./])';
const BOUND_R = '(?![A-Za-z0-9+#])(?![./][A-Za-z0-9])';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s) => String(s).toLowerCase().trim();

/** Exact, case-insensitive, word-boundary-aware regex for a keyword (handles "Next.js", "C++", "CI/CD"). */
export function exactRegex(kw) {
  return new RegExp(`${BOUND_L}${esc(kw.trim())}${BOUND_R}`, 'i');
}

/** Flexible regex: alnum chunks joined by optional space/./-/ separators, optional plural suffix. */
export function variantRegex(kw) {
  const chunks = norm(kw).match(/[a-z0-9+#]+/g) ?? [];
  if (!chunks.length) return null;
  const last = chunks.at(-1);
  if (last.length > 3 && /[a-z]s$/.test(last)) chunks[chunks.length - 1] = last.slice(0, -1);
  const body = chunks.map(esc).join('[\\s./-]?');
  const plural = /[a-z]$/.test(chunks.at(-1)) ? '(?:e?s)?' : '';
  return new RegExp(`${BOUND_L}${body}${plural}${BOUND_R}`, 'i');
}

/** All forms (keyword plus synonyms) worth trying as variants. */
export function variantForms(kw) {
  const k = norm(kw);
  const flat = k.replace(/[^a-z0-9+#]/g, '');
  const forms = new Set([k]);
  for (const group of SYNONYMS) {
    if (group.some((g) => g === k || g.replace(/[^a-z0-9+#]/g, '') === flat)) group.forEach((g) => forms.add(g));
  }
  return [...forms];
}

/**
 * Classify each keyword against text: covered (exact) / variant (spacing, punctuation, plural, synonym) / missing.
 * @param {string} text
 * @param {string[]} keywords
 * @returns {{keyword: string, status: 'covered'|'variant'|'missing', match?: string}[]}
 */
export function keywordCoverage(text, keywords) {
  const t = String(text ?? '');
  return keywords.map((k) => k.trim()).filter(Boolean).map((keyword) => {
    const exact = t.match(exactRegex(keyword));
    if (exact) return { keyword, status: 'covered', match: exact[0] };
    for (const form of variantForms(keyword)) {
      const re = variantRegex(form);
      const m = re && t.match(re);
      if (m) return { keyword, status: 'variant', match: m[0] };
    }
    return { keyword, status: 'missing' };
  });
}

/** Parse a keyword list from a comma- or newline-separated string. */
export const parseKeywords = (s) => String(s ?? '').split(/[,\n]/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
