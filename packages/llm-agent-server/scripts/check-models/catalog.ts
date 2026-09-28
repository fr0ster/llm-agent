/**
 * Pure helpers for `npm run models:check`: plan which modes (chat / embedding) to
 * probe for a model, judge the outcome against what the SAP AI Core catalog
 * declares, and turn an SDK error into a one-line reason.
 */

/** The subset of an AI Core `foundation-models` catalog entry we read. */
export interface ICatalogModel {
  model: string;
  versions: Array<{
    name: string;
    isLatest: boolean;
    capabilities?: string[];
  }>;
}

export type ProbeMode = 'chat' | 'embed';

/** One mode to probe; `expected` is undefined when nothing declares it. */
export interface IModeProbe {
  mode: ProbeMode;
  expected: boolean | undefined;
}

export interface IProbeOutcome extends IModeProbe {
  ok: boolean;
}

/** Capabilities of the latest catalog version, as the two probe modes. */
export function declaredModes(
  entry: ICatalogModel,
): Record<ProbeMode, boolean> {
  const version =
    entry.versions.find((v) => v.isLatest) ?? entry.versions.at(0);
  const capabilities = version?.capabilities ?? [];
  return {
    chat: capabilities.includes('text-generation'),
    embed: capabilities.includes('embedding'),
  };
}

/**
 * Every requested mode is probed, whatever the catalog declares — the point
 * is to learn what the model actually does. The catalog only sets the
 * expectation; a model absent from it has none.
 */
export function planProbes(
  entry: ICatalogModel | undefined,
  modes: readonly ProbeMode[],
): IModeProbe[] {
  const declared = entry ? declaredModes(entry) : undefined;
  return modes.map((mode) => ({ mode, expected: declared?.[mode] }));
}

/** A failure worth reporting: the mode was declared, or nothing was known. */
export function isUnexpectedFailure(outcome: IProbeOutcome): boolean {
  return !outcome.ok && outcome.expected !== false;
}

/**
 * A model is broken when a declared mode failed, or — with no declaration —
 * when none of its probed modes worked.
 */
export function isModelFailed(outcomes: readonly IProbeOutcome[]): boolean {
  if (outcomes.length === 0) return false;
  if (outcomes.some((o) => o.expected === true && !o.ok)) return true;
  if (outcomes.every((o) => o.expected === undefined)) {
    return !outcomes.some((o) => o.ok);
  }
  return false;
}

/** Collapse whitespace so a multi-line model reply stays on one row. */
export function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * `HTTP <status>: <AI Core message>` when the reason can be found — on the SDK
 * error's `cause`, or inside the JSON body a provider folds into its message.
 */
export function extractCheckError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const status = msg.match(/status code (\d+)/)?.[1];
  // biome-ignore lint/suspicious/noExplicitAny: SDK error inspection
  const e = err as any;
  const inMessage = msg.match(/"message":\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  const body: unknown =
    e?.cause?.response?.data?.error?.message ??
    e?.response?.data?.error?.message ??
    (inMessage !== undefined ? JSON.parse(`"${inMessage}"`) : undefined);
  if (typeof body === 'string' && body.length > 0) {
    const text = oneLine(body.replace(/^\d{3}\s*-\s*/, ''), 120);
    return status ? `HTTP ${status}: ${text}` : text;
  }
  if (status) return `HTTP ${status}`;
  const cause = e?.cause?.message;
  if (cause) return `${msg.slice(0, 40)} — ${String(cause).slice(0, 40)}`;
  return oneLine(msg, 80);
}
