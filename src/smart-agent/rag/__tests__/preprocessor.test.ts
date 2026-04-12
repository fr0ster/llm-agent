import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RagError } from '../../interfaces/types.js';
import { makeLlm } from '../../testing/index.js';
import {
  ExpandPreprocessor,
  type IQueryPreprocessor,
  NoopDocumentEnricher,
  NoopQueryPreprocessor,
  PreprocessorChain,
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

describe('ExpandPreprocessor', () => {
  it('expands query with LLM-generated synonyms', async () => {
    const llm = makeLlm([
      { content: 'transport request workbench customizing' },
    ]);
    const pp = new ExpandPreprocessor(llm);
    const result = await pp.process('create transport');
    assert.ok(result.ok);
    assert.equal(
      result.value,
      'create transport transport request workbench customizing',
    );
  });

  it('returns original when LLM fails', async () => {
    const llm = makeLlm([new Error('LLM unavailable')]);
    const pp = new ExpandPreprocessor(llm);
    const result = await pp.process('create transport');
    assert.ok(result.ok);
    assert.equal(result.value, 'create transport');
  });

  it('name is expand', () => {
    const llm = makeLlm([]);
    assert.equal(new ExpandPreprocessor(llm).name, 'expand');
  });
});

describe('PreprocessorChain', () => {
  it('runs preprocessors in sequence', async () => {
    const translate = new TranslatePreprocessor(
      makeLlm([{ content: 'read dumps' }]),
    );
    const expand = new ExpandPreprocessor(
      makeLlm([{ content: 'runtime feeds' }]),
    );
    const chain = new PreprocessorChain([translate, expand]);

    // Input is non-ASCII and >= 15 chars so translate fires, then expand fires on translated text
    const result = await chain.process('Прочитай системні дампи');
    assert.ok(result.ok);
    assert.equal(result.value, 'read dumps runtime feeds');
  });

  it('empty chain returns text unchanged', async () => {
    const chain = new PreprocessorChain([]);
    const result = await chain.process('hello');
    assert.ok(result.ok);
    assert.equal(result.value, 'hello');
  });

  it('stops on first error and returns it', async () => {
    const failing: IQueryPreprocessor = {
      name: 'fail',
      async process() {
        return {
          ok: false as const,
          error: new RagError('boom', 'QUERY_EXPAND_ERROR'),
        };
      },
    };
    const never = new NoopQueryPreprocessor();
    const chain = new PreprocessorChain([failing, never]);

    const result = await chain.process('hello');
    assert.ok(!result.ok);
    assert.equal(result.error.message, 'boom');
  });

  it('name concatenates child names', () => {
    const chain = new PreprocessorChain([
      new TranslatePreprocessor(makeLlm([])),
      new ExpandPreprocessor(makeLlm([])),
    ]);
    assert.equal(chain.name, 'translate+expand');
  });
});
