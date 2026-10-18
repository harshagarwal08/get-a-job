import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Repo root; override with GAJ_ROOT (used by tests to point at a temp dir).
export const ROOT = process.env.GAJ_ROOT
  ? path.resolve(process.env.GAJ_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const r = (...p) => path.join(ROOT, ...p);

export const paths = {
  root: ROOT,
  profileDir: r('profile'),
  preferences: r('profile', 'preferences.json'),
  profile: r('profile', 'profile.md'),
  resume: r('profile', 'resume.md'),
  inbox: r('inbox'),
  configDir: r('config'),
  companies: r('config', 'companies.json'),
  companiesExample: r('config', 'companies.example.json'),
  examples: r('examples'),
  dataDir: r('data'),
  jobs: r('data', 'jobs.json'),
  tracker: r('data', 'tracker.json'),
  research: r('data', 'research'),
  applications: r('data', 'applications'),
  exports: r('data', 'exports'),
};

export function slugify(s, max = 80) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, max).replace(/-+$/g, '');
}

export function applicationDir(company, role) {
  return r('data', 'applications', slugify(`${company}-${role}`));
}
