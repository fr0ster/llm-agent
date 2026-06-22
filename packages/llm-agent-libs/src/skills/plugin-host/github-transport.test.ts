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

import { makeGitHubTransport } from './github-transport.js';

/** Build a fake `fetch` from a URL→response map. Each value is `{ status?, body }`
 *  where body is an object (JSON) or string (raw text). Unmapped URL → 404. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = [];
  const headers: Array<Record<string, string> | undefined> = [];
  const impl = async (
    input: unknown,
    init?: { headers?: Record<string, string> },
  ) => {
    const url = String(input);
    calls.push(url);
    headers.push(init?.headers);
    const hit = routes[url];
    const status = hit?.status ?? (hit ? 200 : 404);
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Not Found',
      json: async () => hit?.body,
      text: async () => String(hit?.body ?? ''),
    } as unknown as Response;
  };
  return { impl: impl as unknown as typeof fetch, calls, headers };
}

const RAW = 'https://raw.githubusercontent.com';
const API = 'https://api.github.com';

const MARKETPLACE = {
  plugins: [
    { name: 'sap-abap', version: '2.3.2', source: './plugins/sap-abap' },
    { name: 'sap-btp', version: '1.0.0', source: './plugins/sap-btp' },
    { name: 'unused', version: '9.9.9', source: './plugins/unused' },
  ],
};

test('listPlugins resolves default branch and enumerates ONLY enabled plugins', async () => {
  const { impl, calls } = fakeFetch({
    [`${API}/repos/o/r`]: { body: { default_branch: 'main' } },
    [`${RAW}/o/r/main/.claude-plugin/marketplace.json`]: { body: MARKETPLACE },
    [`${API}/repos/o/r/contents/plugins/sap-abap/skills?ref=main`]: {
      body: [{ name: 'sap-abap', type: 'dir' }],
    },
    [`${API}/repos/o/r/contents/plugins/sap-btp/skills?ref=main`]: {
      body: [{ name: 'sap-btp', type: 'dir' }],
    },
  });
  const t = makeGitHubTransport({
    owner: 'o',
    repo: 'r',
    enabled: ['sap-abap', 'sap-btp'],
    fetchImpl: impl,
  });
  const out = await t.listPlugins();
  assert.deepEqual(out, [
    { plugin: 'sap-abap', version: '2.3.2', skills: ['sap-abap'] },
    { plugin: 'sap-btp', version: '1.0.0', skills: ['sap-btp'] },
  ]);
  // The 'unused' plugin must NOT be enumerated (no Contents-API call for it).
  assert.ok(!calls.some((u) => u.includes('plugins/unused/skills')));
});

test('an explicit ref skips the default-branch metadata call', async () => {
  const { impl, calls } = fakeFetch({
    [`${RAW}/o/r/dev/.claude-plugin/marketplace.json`]: { body: MARKETPLACE },
    [`${API}/repos/o/r/contents/plugins/sap-abap/skills?ref=dev`]: {
      body: [{ name: 'sap-abap', type: 'dir' }],
    },
  });
  const t = makeGitHubTransport({
    owner: 'o',
    repo: 'r',
    ref: 'dev',
    enabled: ['sap-abap'],
    fetchImpl: impl,
  });
  await t.listPlugins();
  assert.ok(!calls.some((u) => u === `${API}/repos/o/r`));
});

test('fetchSkillMd hits the raw SKILL.md URL and returns the body', async () => {
  const { impl } = fakeFetch({
    [`${API}/repos/o/r`]: { body: { default_branch: 'main' } },
    [`${RAW}/o/r/main/.claude-plugin/marketplace.json`]: { body: MARKETPLACE },
    [`${RAW}/o/r/main/plugins/sap-abap/skills/sap-abap/SKILL.md`]: {
      body: '# ABAP skill',
    },
  });
  const t = makeGitHubTransport({
    owner: 'o',
    repo: 'r',
    enabled: ['sap-abap'],
    fetchImpl: impl,
  });
  assert.equal(await t.fetchSkillMd('sap-abap', 'sap-abap'), '# ABAP skill');
});

test('a token attaches an Authorization header to every request', async () => {
  // Proper response sequence: marketplace JSON for the manifest URL, a directory
  // array for the one enabled plugin's Contents URL. (ref is provided, so no
  // default-branch metadata call.) Then assert EVERY captured call carried auth.
  const { impl, headers } = fakeFetch({
    [`${RAW}/o/r/main/.claude-plugin/marketplace.json`]: { body: MARKETPLACE },
    [`${API}/repos/o/r/contents/plugins/sap-abap/skills?ref=main`]: {
      body: [{ name: 'sap-abap', type: 'dir' }],
    },
  });
  const t = makeGitHubTransport({
    owner: 'o',
    repo: 'r',
    ref: 'main',
    token: 'gho_x',
    enabled: ['sap-abap'],
    fetchImpl: impl,
  });
  await t.listPlugins();
  assert.ok(headers.length > 0);
  for (const h of headers) {
    assert.equal(h?.authorization, 'Bearer gho_x');
  }
});

test('listPlugins throws with a token hint on a 403', async () => {
  const { impl } = fakeFetch({
    [`${RAW}/o/r/main/.claude-plugin/marketplace.json`]: { body: MARKETPLACE },
    [`${API}/repos/o/r/contents/plugins/sap-abap/skills?ref=main`]: {
      status: 403,
      body: {},
    },
  });
  const t = makeGitHubTransport({
    owner: 'o',
    repo: 'r',
    ref: 'main',
    enabled: ['sap-abap'],
    fetchImpl: impl,
  });
  await assert.rejects(() => t.listPlugins(), /set a token/);
});
