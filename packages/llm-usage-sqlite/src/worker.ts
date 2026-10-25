/** Self-contained worker entry, serialized after TypeScript has removed types. */
export function sqliteWorker(
  parentPort: import('node:worker_threads').MessagePort | null,
  workerData: {
    path: string;
    autoCreateSchema: boolean;
    ddl: string;
    columns: string;
  },
  DatabaseSync: typeof import('node:sqlite').DatabaseSync,
): void {
  let db: import('node:sqlite').DatabaseSync;
  const port = parentPort;
  if (!port) throw new Error('SQLite worker requires parentPort');
  let ready = false;
  port.on(
    'message',
    (message: {
      id: number;
      op: string;
      values?: (string | number | null)[][];
      from?: number;
      to?: number;
      cutoff?: number;
    }) => {
      let possiblyDelivered = false;
      try {
        db ??= new DatabaseSync(workerData.path);
        if (message.op === 'close') {
          db.close();
          port.postMessage({ id: message.id });
          port.close();
          return;
        }
        if (!ready) {
          if (workerData.autoCreateSchema) db.exec(workerData.ddl);
          try {
            db.prepare('SELECT id FROM USAGE_RECORDS WHERE 1 = 0').all();
          } catch (error) {
            throw new Error(
              'USAGE_RECORDS is unavailable; apply ddl/usage.sql or enable autoCreateSchema',
              { cause: error },
            );
          }
          ready = true;
        }
        let result: unknown;
        if (message.op === 'write') {
          const insert = db.prepare(
            `INSERT INTO USAGE_RECORDS (${workerData.columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          );
          db.exec('BEGIN');
          try {
            possiblyDelivered = true;
            for (const row of message.values ?? []) insert.run(...row);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            possiblyDelivered = false;
            throw error;
          }
        } else if (message.op === 'read') {
          result = db
            .prepare(
              "SELECT record_json FROM USAGE_RECORDS WHERE (at >= ? AND at < ?) OR kind = 'x.usage.lost' ORDER BY at, id",
            )
            .all(message.from ?? 0, message.to ?? 0);
        } else if (message.op === 'delete') {
          result = Number(
            db
              .prepare('DELETE FROM USAGE_RECORDS WHERE at < ?')
              .run(message.cutoff ?? 0).changes,
          );
        } else throw new Error('Unknown SQLite worker operation');
        port.postMessage({ id: message.id, result });
      } catch (error) {
        port.postMessage({
          id: message.id,
          possiblyDelivered,
          code: String((error as { code?: unknown })?.code ?? 'SQLITE_FAILED'),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
