import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toolItemFromTool } from '../index.js';

const ids = { itemId: 'tool:t', originalName: 't' };

describe('toolItemFromTool — any server, generic schema read', () => {
  const tool = {
    name: 'files__read_file',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file. Absolute' },
        encoding: { type: 'string', enum: ['utf8', 'latin1', 3] },
        mode: {
          oneOf: [
            { const: 'text', description: 'As text' },
            { const: 'binary', title: 'Raw bytes' },
            { type: 'number' },
          ],
        },
      },
      required: ['path'],
    },
  };
  const item = toolItemFromTool(tool, {
    itemId: 'tool:read_file',
    originalName: 'read_file',
  });

  it('names, ids and description', () => {
    assert.equal(item.itemId, 'tool:read_file');
    assert.equal(item.name, 'files__read_file');
    assert.equal(item.originalName, 'read_file');
    assert.equal(item.description, 'Read a file');
  });
  it('parameters in schema order with required, descriptions and string values', () => {
    assert.deepEqual(item.parameters, [
      {
        name: 'path',
        description: 'Path of the file. Absolute',
        required: true,
        values: [],
      },
      {
        name: 'encoding',
        required: false,
        values: [{ value: 'utf8' }, { value: 'latin1' }],
      },
      {
        name: 'mode',
        required: false,
        values: [
          { value: 'text', description: 'As text' },
          { value: 'binary', description: 'Raw bytes' },
        ],
      },
    ]);
  });
  it('keeps the raw schema and the definition size', () => {
    assert.equal(item.inputSchema, tool.inputSchema);
    assert.equal(
      item.definitionChars,
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }).length,
    );
  });
  it('a tool without a schema has no parameters', () => {
    const bare = toolItemFromTool(
      { name: 'ping' },
      { itemId: 'tool:ping', originalName: 'ping' },
    );
    assert.deepEqual(bare.parameters, []);
    assert.equal(bare.description, '');
  });
  it('a schema without properties has no parameters', () => {
    assert.deepEqual(
      toolItemFromTool({ name: 'p', inputSchema: { type: 'object' } }, ids)
        .parameters,
      [],
    );
  });
});

describe('toolItemFromTool — a malformed schema fails loud', () => {
  const bad = (inputSchema: Record<string, unknown>) =>
    toolItemFromTool({ name: 't', inputSchema }, ids);
  it('properties that is not an object', () => {
    assert.throws(() => bad({ properties: ['a'] }), /properties/);
    assert.throws(() => bad({ properties: 'a' }), /properties/);
  });
  it('required that is not an array of strings', () => {
    assert.throws(() => bad({ properties: {}, required: 'a' }), /required/);
    assert.throws(() => bad({ properties: {}, required: [1] }), /required/);
  });
  it('a property whose schema is not an object', () => {
    assert.throws(() => bad({ properties: { a: 'string' } }), /"a"/);
  });
  it('enum / oneOf / anyOf that is not an array', () => {
    assert.throws(() => bad({ properties: { a: { enum: 'x' } } }), /enum/);
    assert.throws(() => bad({ properties: { a: { oneOf: {} } } }), /oneOf/);
  });
  it('anyOf that is not an array, or has a non-object entry', () => {
    assert.throws(() => bad({ properties: { a: { anyOf: {} } } }), /anyOf/);
    assert.throws(() => bad({ properties: { a: { anyOf: ['x'] } } }), /anyOf/);
  });
  it('the message names the tool', () => {
    assert.throws(() => bad({ properties: 'a' }), /Tool "t"/);
  });
  it('a oneOf entry that is not an object', () => {
    assert.throws(() => bad({ properties: { a: { oneOf: ['x'] } } }), /oneOf/);
  });
});

describe('toolItemFromTool — valid shapes', () => {
  const one = (p: unknown) =>
    toolItemFromTool({ name: 't', inputSchema: { properties: { a: p } } }, ids)
      .parameters[0];
  it('boolean property schemas are parameters with nothing else', () => {
    assert.deepEqual(one(true), { name: 'a', required: false, values: [] });
    assert.deepEqual(one(false), { name: 'a', required: false, values: [] });
  });
  it('boolean oneOf / anyOf entries are skipped', () => {
    assert.deepEqual(one({ oneOf: [true, false, { const: 'x' }] })?.values, [
      { value: 'x' },
    ]);
    assert.deepEqual(one({ anyOf: [true, { const: 'y' }] })?.values, [
      { value: 'y' },
    ]);
  });
  it('anyOf success path', () => {
    assert.deepEqual(one({ anyOf: [{ const: 'a', title: 'A' }] })?.values, [
      { value: 'a', description: 'A' },
    ]);
  });
  it('enum wins over oneOf', () => {
    assert.deepEqual(one({ enum: ['e'], oneOf: [{ const: 'o' }] })?.values, [
      { value: 'e' },
    ]);
  });
  it('a nested object property is not recursed into', () => {
    assert.deepEqual(
      one({ type: 'object', properties: { inner: { enum: ['z'] } } }),
      { name: 'a', required: false, values: [] },
    );
  });
});
