import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleHealthRoute } from '../health-route-handler.js';

function makeRc(status: string, ready: boolean) {
  let capturedCode = 0;
  let capturedBody = '';
  return {
    rc: {
      healthChecker: {
        check: async () => ({ status, components: {} }),
      },
      ready,
      res: {
        writeHead(code: number, _headers?: Record<string, string>) {
          capturedCode = code;
        },
        end(body: string) {
          capturedBody = body;
        },
      },
    },
    getCode: () => capturedCode,
    getBody: () => capturedBody,
  };
}

describe('handleHealthRoute', () => {
  it('status:unhealthy + ready:true → 200 (soft failure, pod still serves)', async () => {
    const { rc, getCode, getBody } = makeRc('unhealthy', true);
    await handleHealthRoute(rc as never);
    assert.equal(
      getCode(),
      200,
      'expected 200 when ready=true even if status=unhealthy',
    );
    const body = JSON.parse(getBody());
    assert.equal(body.status, 'unhealthy');
    assert.equal(body.ready, true);
  });

  it('status:degraded + ready:true → 200', async () => {
    const { rc, getCode } = makeRc('degraded', true);
    await handleHealthRoute(rc as never);
    assert.equal(getCode(), 200);
  });

  it('status:healthy + ready:true → 200', async () => {
    const { rc, getCode } = makeRc('healthy', true);
    await handleHealthRoute(rc as never);
    assert.equal(getCode(), 200);
  });

  it('ready:false (any status) → 503', async () => {
    const { rc, getCode, getBody } = makeRc('healthy', false);
    await handleHealthRoute(rc as never);
    assert.equal(getCode(), 503, 'expected 503 when ready=false');
    const body = JSON.parse(getBody());
    assert.equal(body.ready, false);
  });

  it('body shape contains spread status + ready', async () => {
    const { rc, getBody } = makeRc('healthy', true);
    await handleHealthRoute(rc as never);
    const body = JSON.parse(getBody());
    assert.ok('status' in body, 'body must have status field');
    assert.ok('ready' in body, 'body must have ready field');
    assert.ok('components' in body, 'body must have components field');
  });
});
