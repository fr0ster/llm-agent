import type { IConcurrencyPool } from '@mcp-abap-adt/llm-agent';

export class SemaphorePool implements IConcurrencyPool {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error('pool limit must be a positive integer');
  }
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(grant);
        if (index >= 0) this.queue.splice(index, 1);
        signal?.removeEventListener('abort', abort);
        reject(new Error('pool acquisition stopped'));
      };
      const grant = () => {
        signal?.removeEventListener('abort', abort);
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.queue.shift()?.();
        });
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      if (this.active < this.limit) grant();
      else this.queue.push(grant);
    });
  }
}
