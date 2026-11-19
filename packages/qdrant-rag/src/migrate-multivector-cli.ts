#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { RagError } from '@mcp-abap-adt/llm-agent';
import { migrateQdrantMultivectors } from './migrate-multivector.js';

const controller = new AbortController();
const abort = () => controller.abort();

try {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      collection: { type: 'string' },
      collections: { type: 'string', multiple: true },
      catalog: { type: 'string' },
      all: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });
  const url = values.url ?? process.env.QDRANT_URL;
  const selectors = [
    values.collection !== undefined,
    values.collections !== undefined,
    values.all === true,
  ];
  if (
    !url ||
    selectors.filter(Boolean).length !== 1 ||
    (values.catalog !== undefined && !values.all)
  )
    throw new Error(
      'Usage: qdrant-migrate-multivector [--url URL] [--dry-run] (--collection NAME | --collections NAME[,NAME...] | --all [--catalog NAME]). Use --collections= for recovery only.',
    );
  const collections =
    values.collections?.length === 1 && values.collections[0] === ''
      ? []
      : values.collections?.flatMap((names) =>
          names.split(',').map((name) => name.trim()),
        );
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const key = process.env.QDRANT_API_KEY;
  const reports = await migrateQdrantMultivectors({
    url,
    credential: key ? { kind: 'api-key', secret: async () => key } : undefined,
    signal: controller.signal,
    collection: values.collection,
    collections,
    catalogCollection: values.catalog,
    dryRun: values['dry-run'],
  });
  for (const report of reports) console.log(JSON.stringify(report));
} catch (error) {
  console.error(
    error instanceof RagError
      ? `${error.code}: ${error.message}`
      : String(error),
  );
  process.exitCode = 1;
} finally {
  process.off('SIGINT', abort);
  process.off('SIGTERM', abort);
}
