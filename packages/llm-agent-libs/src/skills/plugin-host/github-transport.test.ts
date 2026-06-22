import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseGitHubRepo,
  parseMarketplace,
  skillDirsFromContents,
} from './github-transport.js';

test('parseGitHubRepo accepts all URL forms', () => {
  const expected = { owner: 'secondsky', repo: 'sap-skills' };
  assert.deepEqual(
    parseGitHubRepo('https://github.com/secondsky/sap-skills.git'),
    expected,
  );
  assert.deepEqual(
    parseGitHubRepo('https://github.com/secondsky/sap-skills'),
    expected,
  );
  assert.deepEqual(
    parseGitHubRepo('github.com/secondsky/sap-skills'),
    expected,
  );
  assert.deepEqual(parseGitHubRepo('secondsky/sap-skills'), expected);
  assert.deepEqual(
    parseGitHubRepo('https://github.com/secondsky/sap-skills/'),
    expected,
  );
});

test('parseGitHubRepo throws on garbage', () => {
  assert.throws(
    () => parseGitHubRepo('not a repo'),
    /cannot parse GitHub repo/,
  );
});

test('parseMarketplace maps plugins[] and strips a leading ./', () => {
  const out = parseMarketplace({
    plugins: [
      { name: 'sap-abap', version: '2.3.2', source: './plugins/sap-abap' },
      { name: 'x', source: 'plugins/x' },
    ],
  });
  assert.deepEqual(out, [
    { plugin: 'sap-abap', version: '2.3.2', sourcePath: 'plugins/sap-abap' },
    { plugin: 'x', version: '0.0.0', sourcePath: 'plugins/x' },
  ]);
});

test('parseMarketplace throws when plugins[] is missing', () => {
  assert.throws(() => parseMarketplace({}), /no plugins\[\] array/);
});

test('skillDirsFromContents returns only dir entries', () => {
  const out = skillDirsFromContents([
    { name: 'sap-abap', type: 'dir' },
    { name: 'README.md', type: 'file' },
    { name: 'extra', type: 'dir' },
  ]);
  assert.deepEqual(out, ['sap-abap', 'extra']);
});

test('skillDirsFromContents throws on a non-array', () => {
  assert.throws(
    () => skillDirsFromContents({ message: 'Not Found' }),
    /expected a Contents-API directory array/,
  );
});
