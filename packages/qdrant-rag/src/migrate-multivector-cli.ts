#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  migrateQdrantMultivectors,
  releaseQdrantMultivectorMigrationLock,
} from './migrate-multivector.js';

try {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      collection: { type: 'string' },
      catalog: { type: 'string' },
      all: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'release-lock': { type: 'string' },
    },
  });
  const url = values.url ?? process.env.QDRANT_URL;
  const releaseToken = values['release-lock'];
  const validMode =
    releaseToken === undefined
      ? Boolean(values.collection) !== Boolean(values.all)
      : Boolean(releaseToken) &&
        values.collection === undefined &&
        !values.all &&
        values.catalog === undefined &&
        !values['dry-run'];
  if (!url || !validMode)
    throw new Error(
      'Usage: qdrant-migrate-multivector [--url URL] [--dry-run] (--collection NAME | --all [--catalog NAME])\n       qdrant-migrate-multivector [--url URL] --release-lock TOKEN',
    );
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const key = process.env.QDRANT_API_KEY;
  const connection = {
    url,
    credential: key
      ? { kind: 'api-key' as const, secret: async () => key }
      : undefined,
    signal: controller.signal,
  };
  if (releaseToken !== undefined) {
    await releaseQdrantMultivectorMigrationLock(connection, releaseToken);
    console.log('Released the Qdrant multivector migration lock.');
  } else {
    const reports = await migrateQdrantMultivectors({
      ...connection,
      collection: values.collection,
      catalogCollection: values.catalog,
      dryRun: values['dry-run'],
      onLockStatus: (lock) => console.log(JSON.stringify({ lock })),
    });
    for (const report of reports) console.log(JSON.stringify(report));
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
