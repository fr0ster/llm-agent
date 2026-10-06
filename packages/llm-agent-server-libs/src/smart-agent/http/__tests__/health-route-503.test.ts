import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleHealthRoute } from '../health-route-handler.js';

// Spec §10.5.10 (D72, H1): /health answers 200 only when the server is ready
// and every configured component works; degraded or unhealthy ⇒ 503.

function makeRc(status: string, ready: boolean) {
  let code = 0;
  let body = '';
  return {
    rc: {
      healthChecker: {
        check: async () => ({ status, components: { llm: false } }),
      },
      ready,
      res: {
        writeHead(c: number) {
          code = c;
        },
        end(b: string) {
          body = b;
        },
      },
    },
    code: () => code,
    body: () => JSON.parse(body) as { status: string; ready: boolean },
  };
}

describe('handleHealthRoute — H1 (D72)', () => {
  it('degraded + ready ⇒ 503; the body still names the status', async () => {
    const h = makeRc('degraded', true);
    await handleHealthRoute(h.rc as never);
    assert.equal(h.code(), 503);
    assert.equal(h.body().status, 'degraded');
    assert.equal(h.body().ready, true);
  });

  it('healthy + ready ⇒ 200', async () => {
    const h = makeRc('healthy', true);
    await handleHealthRoute(h.rc as never);
    assert.equal(h.code(), 200);
  });

  it('healthy + not ready ⇒ 503 (unchanged)', async () => {
    const h = makeRc('healthy', false);
    await handleHealthRoute(h.rc as never);
    assert.equal(h.code(), 503);
    assert.equal(h.body().ready, false);
  });
});
