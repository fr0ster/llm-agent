/**
 * The server's one queue of config transactions and its "config not applied"
 * state (spec §10.5.9 V6, V10, §10.5.10; D80, D82). Internal — not exported
 * from the package.
 */

/** Which config change ran a transaction (spec §10.5.10, D82). */
export type ConfigChangeSource = 'reload' | 'put';

/**
 * Whether a config change carries the whole config (spec §10.5.9 V10, D82 (8)):
 * a file reload always does (it re-reads the whole file); a PUT does when it
 * carries every section the route can change. Only a whole change clears the
 * "config not applied" state; a partial one is refused while it is set.
 */
export type ConfigChangeScope = 'full' | 'partial';

/**
 * The server's "config not applied" state (spec §10.5.10, D82): what the last
 * settled config transaction left when it failed. No rollback — the server is
 * not ready until a later config change applies.
 */
export interface ConfigNotApplied {
  /** The failed transaction's error message — every step that failed. */
  readonly reason: string;
  readonly source: ConfigChangeSource;
  /** When it failed (ISO 8601). */
  readonly at: string;
}

/**
 * The server's one queue of config transactions (spec §10.5.9 V6, V10; D80,
 * D82). The file reload and PUT /v1/config run through the same instance, so
 * a transaction starts only after the previous one settled.
 */
export interface IConfigTransactionQueue {
  /**
   * Runs `tx` after every earlier transaction settled and returns `tx`'s own
   * promise. A rejection is this caller's alone: it never blocks the next one.
   * It sets `notApplied`; a resolution clears it. A `'partial'` change that
   * starts while `notApplied` is set is refused (D82 (8)): `tx` never runs,
   * the state is unchanged, and the promise rejects with
   * `ConfigChangeRefusedError`. The scope is checked when the transaction
   * starts, in queue order — a transaction ahead of it can set the state.
   */
  run<T>(
    source: ConfigChangeSource,
    scope: ConfigChangeScope,
    tx: () => Promise<T>,
  ): Promise<T>;
  /**
   * Set when the last settled transaction failed; undefined at construction
   * (the server starts ready from its config) and after one that applied.
   */
  readonly notApplied: ConfigNotApplied | undefined;
}

/**
 * A partial config change refused at its start because the server is not
 * ready (spec D82 (8)): the transaction never ran and the state is unchanged.
 */
export class ConfigChangeRefusedError extends Error {
  constructor(readonly notApplied: ConfigNotApplied) {
    super(
      `server not ready — a partial config change cannot clear it (config not applied — ${notApplied.reason})`,
    );
    this.name = 'ConfigChangeRefusedError';
  }
}

export class ConfigTransactionQueue implements IConfigTransactionQueue {
  /** Settles when the last queued transaction settled. */
  private tail: Promise<void> = Promise.resolve();
  private _notApplied: ConfigNotApplied | undefined;

  get notApplied(): ConfigNotApplied | undefined {
    return this._notApplied;
  }

  run<T>(
    source: ConfigChangeSource,
    scope: ConfigChangeScope,
    tx: () => Promise<T>,
  ): Promise<T> {
    const run = this.tail.then(async () => {
      // D82 (8): only a whole config clears the not-ready state. Decided here,
      // when the transaction starts — not when it was queued.
      const refused = scope === 'partial' ? this._notApplied : undefined;
      if (refused) throw new ConfigChangeRefusedError(refused);
      try {
        const value = await tx();
        this._notApplied = undefined;
        return value;
      } catch (err) {
        this._notApplied = {
          reason: err instanceof Error ? err.message : String(err),
          source,
          at: new Date().toISOString(),
        };
        throw err;
      }
    });
    // The queue waits only for `run` to settle. Its rejection is not handled
    // here: it is returned to the caller (the watcher's event boundary logs
    // config_reload_failed; the route answers 500).
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
