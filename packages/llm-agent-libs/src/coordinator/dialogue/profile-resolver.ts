import type {
  AgentProfileError,
  AgentPrompts,
  CallOptions,
  IAgentProfileSource,
  Result,
  WorkerProfile,
  WorkerProfileSummary,
} from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';

const summarySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  result: z.enum(['report', 'verdict']),
});
const profileSchema = summarySchema.extend({
  systemPrompt: z.string(),
  tools: z.union([
    z.literal('all'),
    z.literal('read-only'),
    z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
      })
      .strict(),
  ]),
});
const promptsSchema = z.object({
  workerBase: z.string().optional(),
  planner: z.string().optional(),
});

class ProfileSourceError extends Error {
  readonly code: AgentProfileError['code'];
  constructor(error: AgentProfileError) {
    super(`profile source ${error.code}: ${error.message}`);
    this.code = error.code;
  }
}

export class ProfileResolver {
  constructor(
    readonly source: IAgentProfileSource,
    readonly timeoutMs = 3_000,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error('profileTimeoutMs must be positive');
  }
  async call<T>(
    read: (options: CallOptions) => Promise<Result<T, AgentProfileError>>,
    options?: CallOptions,
  ): Promise<T> {
    const controller = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    let removeListener: (() => void) | undefined;
    const timer = setTimeout(
      () => controller.abort(new Error('profile deadline expired')),
      this.timeoutMs,
    );
    try {
      const aborted = new Promise<never>((_, reject) => {
        const abort = () =>
          reject(
            new Error(
              'profile source unavailable: cancelled or deadline expired',
            ),
          );
        signal.addEventListener('abort', abort, { once: true });
        removeListener = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
      });
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (signal.aborted)
            throw new Error('profile source unavailable: cancelled');
          return read({ ...options, signal });
        }),
        aborted,
      ]);
      if (!result.ok) throw new ProfileSourceError(result.error);
      return result.value;
    } catch (error) {
      if (error instanceof ProfileSourceError) throw error;
      throw new ProfileSourceError({
        code: 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
      removeListener?.();
    }
  }
  async discovery(
    options?: CallOptions,
  ): Promise<{ profiles: WorkerProfileSummary[]; prompts: AgentPrompts }> {
    const [listing, text] = await this.call(async (callOptions) => {
      const [profiles, prompts] = await Promise.all([
        this.source.list(callOptions),
        this.source.getPrompts(callOptions),
      ]);
      if (!profiles.ok) return profiles;
      if (!prompts.ok) return prompts;
      return { ok: true, value: [profiles.value, prompts.value] as const };
    }, options);
    const profiles = z.array(summarySchema).parse(listing);
    if (new Set(profiles.map((p) => p.name)).size !== profiles.length)
      throw new Error('invalid duplicate profile names');
    return { profiles, prompts: promptsSchema.parse(text) };
  }
  async selection(name: string, options?: CallOptions): Promise<WorkerProfile> {
    const [listing, record] = await this.call(async (opts) => {
      const [enabled, profile] = await Promise.all([
        this.source.list(opts),
        this.source.get(name, opts),
      ]);
      if (!enabled.ok) return enabled;
      if (!profile.ok) return profile;
      return { ok: true, value: [enabled.value, profile.value] as const };
    }, options);
    const summaries = z.array(summarySchema).parse(listing);
    if (
      new Set(summaries.map((profile) => profile.name)).size !==
      summaries.length
    )
      throw new ProfileSourceError({
        code: 'invalid',
        message: 'duplicate profile names',
      });
    const summary = summaries.find((profile) => profile.name === name);
    if (!summary)
      throw new ProfileSourceError({
        code: 'disabled',
        message: `profile ${name} is not enabled`,
      });
    const profile = profileSchema.parse(record);
    if (profile.name !== name || profile.result !== summary.result)
      throw new ProfileSourceError({
        code: 'invalid',
        message: `profile ${name} differs from its enabled summary`,
      });
    return profile;
  }
  async get(name: string, options?: CallOptions): Promise<WorkerProfile> {
    const profile = profileSchema.parse(
      await this.call((opts) => this.source.get(name, opts), options),
    );
    if (profile.name !== name)
      throw new Error(
        `profile ${name} is invalid: returned name ${profile.name}`,
      );
    return profile;
  }
  async execution(
    name: string,
    options?: CallOptions,
  ): Promise<{ profile: WorkerProfile; workerBase?: string }> {
    const [profile, prompts] = await this.call(async (opts) => {
      const [record, text] = await Promise.all([
        this.source.get(name, opts),
        this.source.getPrompts(opts),
      ]);
      if (!record.ok) return record;
      if (!text.ok) return text;
      return { ok: true, value: [record.value, text.value] as const };
    }, options);
    const validated = profileSchema.parse(profile);
    if (validated.name !== name)
      throw new Error(
        `profile ${name} is invalid: returned name ${validated.name}`,
      );
    return {
      profile: validated,
      workerBase: promptsSchema.parse(prompts).workerBase,
    };
  }
}
