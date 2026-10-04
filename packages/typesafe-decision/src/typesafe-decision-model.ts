import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import type {
  CallOptions,
  DecisionAnswer,
  DecisionError,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  IDecisionModel,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  type Question,
  type Questions,
  type RequestOptions,
  TypeSafeClient,
  type TypeSafeClientConfig,
} from '@typesafe-ai/sdk';
import { mapAnswers } from './map-answers.js';
import { mapError } from './map-error.js';

export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';
export const TYPESAFE_DEFAULT_BASE_URL = 'https://api.typesafe.ai';

export interface TypeSafeDecisionConfig {
  /** Asked on every call, so a rotating key rotates. */
  credential: IApiKeyCredential;
  /** Unset → `jev-latest`. */
  model?: string;
  /** Unset → `https://api.typesafe.ai`. */
  baseUrl?: string;
  /** Per-attempt timeout in ms; unset → SDK default. */
  timeoutMs?: number;
  /** Unset → SDK default (2). `0` disables retries. */
  maxRetries?: number;
  /** Test seam; unset → global fetch. */
  fetch?: TypeSafeClientConfig['fetch'];
}

function toSdkQuestions(
  questions: Record<string, DecisionQuestion>,
): Questions {
  // Shapes match the SDK's field for field; the score rubric's "at least two"
  // tuple type is enforced by the SDK at run time (TypeSafeError → invalid).
  // Object.fromEntries defines own properties, so a key such as `__proto__`
  // stays a question instead of replacing the object's prototype.
  return Object.fromEntries(
    Object.entries(questions).map(([key, q]) => [
      key,
      q as unknown as Question,
    ]),
  ) as Questions;
}

/**
 * `IDecisionModel` over TypeSafe AI's Jev. A fresh `TypeSafeClient` per call:
 * the SDK freezes the key at construction and appends its own Authorization
 * header after per-call headers, so a per-call client is the only way to honour
 * a rotating credential. Every option is explicit, so `TYPESAFE_*` environment
 * variables are never consulted.
 */
export class TypeSafeDecisionModel implements IDecisionModel {
  readonly model: string;
  private readonly cfg: TypeSafeDecisionConfig;

  constructor(cfg: TypeSafeDecisionConfig) {
    if (!cfg?.credential) {
      throw new Error('TypeSafeDecisionModel requires a credential');
    }
    this.cfg = cfg;
    this.model = cfg.model ?? TYPESAFE_DEFAULT_MODEL;
  }

  async decide(
    request: DecisionRequest,
    options?: CallOptions,
  ): Promise<Result<DecisionResult, DecisionError>> {
    try {
      const client = new TypeSafeClient({
        apiKey: await this.cfg.credential.secret(),
        baseURL: this.cfg.baseUrl ?? TYPESAFE_DEFAULT_BASE_URL,
        defaultModel: this.model,
        logLevel: 'off',
        ...(this.cfg.timeoutMs !== undefined
          ? { timeout: this.cfg.timeoutMs }
          : {}),
        ...(this.cfg.maxRetries !== undefined
          ? { retry: { maxRetries: this.cfg.maxRetries } }
          : {}),
        ...(this.cfg.fetch !== undefined ? { fetch: this.cfg.fetch } : {}),
      });
      const callOptions: RequestOptions = options?.signal
        ? { signal: options.signal }
        : {};
      const raw = await client.systemOne(
        { state: request.state, questions: toSdkQuestions(request.questions) },
        callOptions,
      );
      const answers = mapAnswers(
        request.questions,
        raw.answers as Record<string, unknown>,
      );
      if (!answers.ok) return answers;
      const value: DecisionResult = {
        answers: answers.value as Record<string, DecisionAnswer>,
        model: raw.model,
      };
      if (raw.usage) {
        value.usage = {
          inputTokens: raw.usage.input_tokens,
          outputTokens: raw.usage.output_tokens,
        };
      }
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: mapError(err) };
    }
  }
}
