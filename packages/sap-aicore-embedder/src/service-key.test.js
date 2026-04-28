import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseServiceKey } from './service-key.js';
test('parseServiceKey extracts credentials from raw SAP AI Core service key JSON', () => {
    const raw = JSON.stringify({
        clientid: 'sb-123',
        clientsecret: 'secret-abc',
        url: 'https://example.authentication.eu10.hana.ondemand.com',
        serviceurls: {
            AI_API_URL: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com',
        },
    });
    const parsed = parseServiceKey(raw);
    assert.equal(parsed.clientId, 'sb-123');
    assert.equal(parsed.clientSecret, 'secret-abc');
    assert.equal(parsed.tokenUrl, 'https://example.authentication.eu10.hana.ondemand.com/oauth/token');
    assert.equal(parsed.apiBaseUrl, 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com');
});
test('parseServiceKey does not double-append /oauth/token', () => {
    const raw = JSON.stringify({
        clientid: 'x',
        clientsecret: 'y',
        url: 'https://example.authentication.eu10.hana.ondemand.com/oauth/token',
        serviceurls: { AI_API_URL: 'https://api.example.com' },
    });
    assert.equal(parseServiceKey(raw).tokenUrl, 'https://example.authentication.eu10.hana.ondemand.com/oauth/token');
});
test('parseServiceKey throws on missing required fields', () => {
    const raw = JSON.stringify({ clientid: 'x' });
    assert.throws(() => parseServiceKey(raw), /AICORE_SERVICE_KEY/);
});
test('parseServiceKey throws on invalid JSON', () => {
    assert.throws(() => parseServiceKey('not json'), /AICORE_SERVICE_KEY/);
});
test('parseServiceKey handles trailing slash on URL already ending in /oauth/token', () => {
    const raw = JSON.stringify({
        clientid: 'x',
        clientsecret: 'y',
        url: 'https://example.authentication.eu10.hana.ondemand.com/oauth/token/',
        serviceurls: { AI_API_URL: 'https://api.example.com' },
    });
    assert.equal(parseServiceKey(raw).tokenUrl, 'https://example.authentication.eu10.hana.ondemand.com/oauth/token');
});
//# sourceMappingURL=service-key.test.js.map