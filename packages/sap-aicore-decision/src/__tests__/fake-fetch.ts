/** A recorded request and a scripted response, for driving the provider offline. */
export interface Recorded {
  url: string;
  /** `init.method`, unset → 'GET' (as fetch). */
  method: string;
  headers: Record<string, string>;
  body: {
    model?: string;
    query?: string;
    documents?: string[];
    top_n?: number;
  };
}

export function fakeFetch(
  respond: (req: Recorded) => { status: number; body: unknown },
) {
  const calls: Recorded[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    if (init.signal?.aborted) throw init.signal.reason;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const rec: Recorded = {
      url,
      method: init.method ?? 'GET',
      headers,
      body: init.body ? JSON.parse(String(init.body)) : {},
    };
    calls.push(rec);
    const { status, body } = respond(rec);
    return new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      {
        status,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
  return { fetch, calls };
}

/** A fetch that never answers and rejects on abort (an already-aborted signal at once). */
export function blockingFetch() {
  let markEntered: () => void = () => {};
  const entered = new Promise<void>((r) => {
    markEntered = r;
  });
  const fetch = (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
      markEntered();
    });
  return { fetch, entered };
}
