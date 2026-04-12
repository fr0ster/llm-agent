import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeLlm } from '../../testing/index.js';
import {
  NoopDocumentEnricher,
  NoopQueryPreprocessor,
  TranslatePreprocessor,
} from '../preprocessor.js';

describe('NoopQueryPreprocessor', () => {
  it('returns text unchanged', async () => {
    const preprocessor = new NoopQueryPreprocessor();
    const result = await preprocessor.process('some query text');
    assert.ok(result.ok);
    assert.equal(result.value, 'some query text');
  });

  it('name is noop', () => {
    const preprocessor = new NoopQueryPreprocessor();
    assert.equal(preprocessor.name, 'noop');
  });
});

describe('NoopDocumentEnricher', () => {
  it('returns text unchanged', async () => {
    const enricher = new NoopDocumentEnricher();
    const result = await enricher.enrich('some document text');
    assert.ok(result.ok);
    assert.equal(result.value, 'some document text');
  });
});

describe('TranslatePreprocessor', () => {
  it('translates non-ASCII text via LLM', async () => {
    const llm = makeLlm([{ content: 'internal ABAP tables' }]);
    const preprocessor = new TranslatePreprocessor(llm);
    const result = await preprocessor.process('внутренние таблицы ABAP запрос');
    assert.ok(result.ok);
    assert.equal(result.value, 'internal ABAP tables');
    assert.equal(llm.callCount, 1);
  });

  it('passes through ASCII text without LLM call', async () => {
    const llm = makeLlm([new Error('LLM unavailable')]);
    const preprocessor = new TranslatePreprocessor(llm);
    const result = await preprocessor.process('ABAP internal tables select');
    assert.ok(result.ok);
    assert.equal(result.value, 'ABAP internal tables select');
    assert.equal(llm.callCount, 0);
  });

  it('passes through short text (< 15 chars) without LLM call', async () => {
    const llm = makeLlm([new Error('LLM unavailable')]);
    const preprocessor = new TranslatePreprocessor(llm);
    const result = await preprocessor.process('тест');
    assert.ok(result.ok);
    assert.equal(result.value, 'тест');
    assert.equal(llm.callCount, 0);
  });

  it('returns original text when LLM fails', async () => {
    const llm = makeLlm([new Error('LLM unavailable')]);
    const preprocessor = new TranslatePreprocessor(llm);
    const result = await preprocessor.process('внутренние таблицы ABAP запрос');
    assert.ok(result.ok);
    assert.equal(result.value, 'внутренние таблицы ABAP запрос');
  });

  it('name is translate', () => {
    const llm = makeLlm([]);
    const preprocessor = new TranslatePreprocessor(llm);
    assert.equal(preprocessor.name, 'translate');
  });
});
