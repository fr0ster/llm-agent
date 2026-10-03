/** A recorded request and a scripted response, for driving the SDK offline. */
export interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export function fakeFetch(
  respond: (req: Recorded) => { status: number; body: unknown },
) {
  const calls: Recorded[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const rec: Recorded = {
      url: input,
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    };
    calls.push(rec);
    const { status, body } = respond(rec);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

/**
 * A fetch that never answers, with real fetch semantics for cancellation: an
 * ALREADY-aborted signal rejects at once (an 'abort' listener would never fire
 * for it — the classic hang), and a later abort rejects when it happens.
 * `entered` resolves once the request is inside fetch.
 */
export function blockingFetch() {
  let markEntered: () => void = () => {};
  const entered = new Promise<void>((r) => {
    markEntered = r;
  });
  const fetch = (_input: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
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

/** A well-formed SystemOne response for the given answers. */
export function okBody(answers: Record<string, unknown>, model = 'jev-1.13.0') {
  return {
    status: 200,
    body: { model, answers, usage: { input_tokens: 12, output_tokens: 3 } },
  };
}
