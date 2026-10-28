import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAts, achievementLines } from '../src/resume/ats.js';

const GOOD = [
  'Jane Doe',
  'Pune, India · jane@example.com · +91 90000 00000 · linkedin.com/in/janedoe',
  'SUMMARY',
  'Frontend engineer with 5 years building dashboards for logistics teams.',
  'EXPERIENCE',
  'Frontend Engineer, Acme · Pune Mar 2021 - Present',
  'Rebuilt the order dashboard in React, cutting load time from 6s to 1.8s for',
  'about 900 daily users.',
  'Shipped offline mode for the driver app, ending 18% of support tickets.',
  'Led a team of four engineers through a TypeScript migration of 120k lines.',
  'PROJECTS',
  'Route Planner | Side project',
  'Built a route planner that groups 2,000 stops into delivery waves in under a second.',
  'Wrote a CLI that checks 300 resumes a minute for broken date formats.',
  'Published a guide to map clustering that reached 10k readers.',
  'SKILLS',
  'Languages: TypeScript, JavaScript, SQL',
  'EDUCATION',
  'B.Tech, Some University 2019',
];
const lines = (arr, extra = []) => [...arr, ...extra];

test('clean resume scores strong; keywords skipped when absent', () => {
  const r = scoreAts({ lines: GOOD, pages: 1, links: ['https://linkedin.com/in/janedoe', 'mailto:jane@example.com'] });
  assert.equal(r.keywordsScored, false);
  assert.equal(r.categories.keywords, undefined);
  assert.equal(r.categories.parseability.links.earned, 5);
  assert.equal(r.categories.sections.experience.earned, 8);
  assert.ok(r.score >= 85, `score ${r.score}`);
});

test('hidden links, missing Experience heading, weak phrases and dashes lose points', () => {
  const bad = GOOD.map((l) => l.replace('linkedin.com/in/janedoe', 'LinkedIn').replace('EXPERIENCE', 'FELLOWSHIP')
    .replace('Mar 2021 - Present', 'Mar 2021 – Present').replace('Shipped offline', 'Responsible for offline'));
  const r = scoreAts({ lines: bad, pages: 1, links: ['https://www.linkedin.com/in/janedoe/'] });
  assert.equal(r.categories.parseability.links.earned, 0);
  assert.equal(r.categories.contact.linkedin.earned, 2);
  assert.equal(r.categories.sections.experience.earned, 4);
  assert.match(r.categories.sections.experience.fix, /FELLOWSHIP/);
  assert.equal(r.categories.parseability.dates.earned, 2);
  assert.deepEqual(r.categories.content.weakPhrases.detail, 'found: responsible for');
  assert.ok(r.fixes[0].lost >= r.fixes.at(-1).lost, 'fixes sorted by points lost');
});

test('letter-spaced headings still map to sections but are flagged', () => {
  const spaced = GOOD.map((l) => (l === 'EXPERIENCE' ? 'E X P E R I E N C E' : l));
  const r = scoreAts({ lines: spaced, pages: 1 });
  assert.equal(r.categories.sections.experience.earned, 8);
  assert.equal(r.categories.parseability.headings.earned, 0);
});

test('keyword category uses exact and variant matches', () => {
  const r = scoreAts({ lines: GOOD, pages: 1, keywords: ['React', 'TypeScript', 'GraphQL', 'Node.js'] });
  assert.equal(r.keywordsScored, true);
  assert.equal(r.categories.keywords.match.earned, 10);
  assert.match(r.categories.keywords.match.fix, /GraphQL, Node\.js/);
});

test('achievement lines join wrapped lines and skip entry heads and label lines', () => {
  const heads = [[2, 'summary'], [4, 'experience'], [10, 'projects'], [15, 'skills'], [17, 'education']];
  const items = achievementLines(lines(GOOD), heads);
  assert.equal(items.length, 6);
  assert.ok(items[0].endsWith('for about 900 daily users.'));
  assert.ok(!items.some((i) => i.includes('Mar 2021') || i.includes('|') || i.startsWith('Languages:')));
});

test('glyph bullets that contain a colon are not treated as label lines', () => {
  const items = achievementLines(['EXPERIENCE', '• Tested with six users: 4 of 6 tasks succeeded in about 28 seconds.'], [[0, 'experience']]);
  assert.equal(items.length, 1);
});
