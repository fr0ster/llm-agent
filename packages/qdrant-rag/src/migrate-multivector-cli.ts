#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { migrateQdrantMultivectors } from './migrate-multivector.js';

try {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      collection: { type: 'string' },
      catalog: { type: 'string' },
      all: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });
  const url = values.url ?? process.env.QDRANT_URL;
  if (!url || Boolean(values.collection) === Boolean(values.all))
    throw new Error(
      'Usage: qdrant-migrate-multivector --url URL (--collection NAME | --all [--catalog NAME]) [--dry-run]',
    );
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const key = process.env.QDRANT_API_KEY;
  const reports = await migrateQdrantMultivectors({
    url,
    collection: values.collection,
    catalogCollection: values.catalog,
    credential: key ? { kind: 'api-key', secret: async () => key } : undefined,
    dryRun: values['dry-run'],
    signal: controller.signal,
  });
  for (const report of reports) console.log(JSON.stringify(report));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
