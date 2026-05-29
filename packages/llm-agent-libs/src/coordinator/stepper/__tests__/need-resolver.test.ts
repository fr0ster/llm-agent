import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmNeedResolver, RegexNeedResolver } from '../need-resolver.js';

test('RegexNeedResolver detects need phrasings and maps to a tools-RAG query', async () => {
  const nr = new RegexNeedResolver();
  assert.deepEqual(await nr.resolve("I can't read the program code"), {
    queryToolsRag: 'read the program code',
  });
  assert.deepEqual(await nr.resolve('I need to read the includes'), {
    queryToolsRag: 'read the includes',
  });
  assert.equal(await nr.resolve('Here is the final analysis.'), undefined);
  assert.equal(await nr.resolve('Call GetProgram(X).'), undefined);
});

test('LlmNeedResolver delegates classification to its llm', async () => {
  const llm = {
    name: 'stub',
    async chat() {
      return {
        ok: true as const,
        value: { content: '{"need":true,"capability":"read program source"}' },
      };
    },
  };
  const nr = new LlmNeedResolver(llm as never);
  assert.deepEqual(await nr.resolve('cannot proceed'), {
    queryToolsRag: 'read program source',
  });
});
