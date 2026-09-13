/**
 * Trace files hold the full prompt, the full response, and the arguments and
 * results of every tool call. At the common umask of 022 they were created
 * world readable (#289).
 *
 * Asserted rather than assumed, because a mode argument is the kind of thing a
 * refactor drops in silence: nothing fails, the files are simply readable again.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SessionLogger } from '../session-logger.js';

const onPosix = process.platform !== 'win32';

describe('SessionLogger file permissions', { skip: !onPosix }, () => {
  let base: string;

  before(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'session-logger-perms-'));
  });

  after(() => fs.rmSync(base, { recursive: true, force: true }));

  const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

  it('creates the request directory private to the owner', () => {
    const logger = new SessionLogger(base, 'sess-1', 'trace-1');
    logger.logStep('llm_request', { prompt: 'secret' });
    const dir = fs
      .readdirSync(base)
      .map((d) => path.join(base, d))
      .flatMap((d) => fs.readdirSync(d).map((r) => path.join(d, r)))[0];
    assert.equal(modeOf(dir), 0o700, `directory is ${modeOf(dir).toString(8)}`);
  });

  it('writes each step file readable by nobody else', () => {
    const logger = new SessionLogger(base, 'sess-2', 'trace-2');
    logger.logStep('llm_response', { content: 'table contents' });
    const files = fs
      .readdirSync(base)
      .map((d) => path.join(base, d))
      .flatMap((d) => fs.readdirSync(d).map((r) => path.join(d, r)))
      .flatMap((r) =>
        fs.statSync(r).isDirectory()
          ? fs.readdirSync(r).map((f) => path.join(r, f))
          : [],
      );
    assert.ok(files.length > 0, 'no trace file was written');
    for (const f of files) {
      assert.equal(
        modeOf(f),
        0o600,
        `${path.basename(f)} is ${modeOf(f).toString(8)}`,
      );
    }
  });
});
