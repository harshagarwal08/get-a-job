import test from 'node:test';
import assert from 'node:assert/strict';
import { keywordCoverage, exactRegex } from '../src/resume/keywords.js';
import { findNonAsciiDateDashes } from '../src/resume/dates.js';
import { groupLines } from '../src/resume/pdf.js';

const TEXT = `Built apps with React.js and Next.js in TS. Ran on k8s with CI/CD.
Wrote C++ tools, front end testing, microservice design, NodeJS gateway. Used C# and GraphQL APIs.`;
const cov = (kws) => Object.fromEntries(keywordCoverage(TEXT, kws).map((k) => [k.keyword, k.status]));

test('keyword exact matches with punctuation', () => {
  assert.deepEqual(cov(['Next.js', 'C++', 'CI/CD', 'graphql', 'C#']), {
    'Next.js': 'covered', 'C++': 'covered', 'CI/CD': 'covered', graphql: 'covered', 'C#': 'covered',
  });
});

test('keyword word boundaries', () => {
  assert.ok(!exactRegex('C').test('C++ and C#'));
  assert.ok(!exactRegex('Go').test('Google'));
  assert.ok(!exactRegex('Java').test('JavaScript'));
  assert.ok(exactRegex('Java').test('Java, Kotlin'));
  assert.ok(!exactRegex('js').test('React.js'));
  assert.ok(!exactRegex('Node').test('Node.js'));
  assert.ok(exactRegex('React').test('Built with React.'));
});

test('keyword variants and synonyms', () => {
  assert.deepEqual(cov(['React', 'TypeScript', 'Kubernetes', 'Frontend', 'microservices', 'Node.js', 'GraphQL API']), {
    React: 'variant', TypeScript: 'variant', Kubernetes: 'variant', Frontend: 'variant',
    microservices: 'variant', 'Node.js': 'variant', 'GraphQL API': 'variant',
  });
  assert.equal(cov(['Rust']).Rust, 'missing');
  assert.equal(cov(['JavaScript']).JavaScript, 'missing');
});

test('date dash detector flags en/em dashes between dates only', () => {
  assert.equal(findNonAsciiDateDashes('Jul 2023 - Present').length, 0);
  const hits = findNonAsciiDateDashes('Jul 2023 – Present, 2019—2021, Sept. 2020 – Jan 2021, fast – reliable');
  assert.deepEqual(hits.map((h) => h.match), ['Jul 2023 – Present', '2019—2021', 'Sept. 2020 – Jan 2021']);
});

test('groupLines rebuilds lines by y then x', () => {
  const it = (str, x, y, width = str.length * 5) => ({ str, transform: [10, 0, 0, 10, x, y], width });
  const lines = groupLines([it('Present', 300, 700), it('Engineer', 10, 700.5), it('Second', 10, 680), it('line', 50, 680)]);
  assert.deepEqual(lines, ['Engineer Present', 'Second line']);
});
