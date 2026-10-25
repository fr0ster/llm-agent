import { readFileSync } from 'node:fs';

const tag = process.argv[2] ?? '';
const match = /^@mcp-abap-adt\/([a-z0-9-]+)@(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/.exec(tag);
if (!match) throw new Error(`Invalid package release tag: ${tag}`);
const [, directory, version] = match;
const packageDir = new URL(`../packages/${directory}/`, import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', packageDir), 'utf8'));
if (manifest.name !== `@mcp-abap-adt/${directory}` || manifest.version !== version) {
  throw new Error(`Tag does not match package manifest: ${tag}`);
}
const lines = readFileSync(new URL('CHANGELOG.md', packageDir), 'utf8').split(/\r?\n/);
const start = lines.findIndex(line => line === `## ${version}` || line === `## [${version}]`);
if (start < 0) throw new Error(`Missing changelog section: ${tag}`);
let end = start + 1;
while (end < lines.length && !/^## /.test(lines[end])) end++;
const notes = lines.slice(start + 1, end).join('\n').trim();
if (!notes) throw new Error(`Empty changelog section: ${tag}`);
console.log(notes);
