# Subagent Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the ability to invoke nested `SmartAgent` instances (subagents) from the pipeline as a new built-in stage type, configurable via YAML, with parallel/repeat orchestration handled by existing control-flow stages.

**Architecture:** A new `ISubAgent` interface lives in `@mcp-abap-adt/llm-agent` (contracts). A registry (`SubAgentRegistry`) is built by the server-side YAML loader from a new top-level `subagents:` config block, where each entry points to a full `SmartAgent` YAML config. A new `SubAgentHandler` (stage type `subagent`) in `@mcp-abap-adt/llm-agent-libs` resolves the named subagent from the registry, evaluates a Mustache-style task template against `PipelineContext`, runs the subagent, and writes the result back to a configurable `outputTo` path on `ctx.subResults`. Parallel fan-out and iterative refinement reuse the existing `parallel` and `repeat` control-flow stages.

**Tech Stack:** TypeScript ESM, Biome lint/format, Node ≥18. No new runtime deps. Conforms to existing `IStageHandler` contract.

---

## File Structure

**New files:**
- `packages/llm-agent/src/interfaces/subagent.ts` — `ISubAgent`, `ISubAgentInput`, `ISubAgentResult`, `SubAgentRegistry` types.
- `packages/llm-agent-libs/src/pipeline/handlers/subagent.ts` — `SubAgentHandler` (implements `IStageHandler<PipelineContext>`).
- `packages/llm-agent-libs/src/pipeline/handlers/__tests__/subagent.test.ts` — handler unit smoke (driven via build+start; see Testing Notes).
- `packages/llm-agent-libs/src/util/template.ts` — `resolveTemplate(str, ctx)` Mustache-lite (`{{path.to.value}}`) and `setPath(obj, path, value)` helpers.
- `docs/examples/subagent-orchestration.yaml` — runnable example: fanout + merge + repeat-until-approved.
- `examples/subagents/abap-coder.yaml`, `examples/subagents/code-reviewer.yaml` — minimal sub-agent configs the example references.

**Modified files:**
- `packages/llm-agent/src/index.ts` — re-export new subagent types.
- `packages/llm-agent/src/interfaces/pipeline.ts` — extend `BuiltInStageType` union with `'subagent'`.
- `packages/llm-agent-libs/src/pipeline/handlers/index.ts` — register `SubAgentHandler` (constructor takes registry; default registry uses empty map).
- `packages/llm-agent-libs/src/pipeline/default-pipeline.ts` — accept optional `SubAgentRegistry`, wire into handler registry.
- `packages/llm-agent-libs/src/builder.ts` — `withSubAgents(registry)` fluent method on `SmartAgentBuilder`; thread into `DefaultPipeline`.
- `packages/llm-agent-server/src/smart-agent/config.ts` — parse top-level `subagents:` array; for each entry, recursively build a `SmartAgent` via the existing builder; populate a `SubAgentRegistry`; pass to parent agent's builder.
- `docs/ARCHITECTURE.md` — short section describing subagent orchestration.
- `docs/EXAMPLES.md` — reference the new YAML example.

**Responsibility split:**
- Contracts (`llm-agent`): interface only — zero runtime.
- Composition (`llm-agent-libs`): handler + template helper + builder wiring.
- Binary (`llm-agent-server`): YAML loader for `subagents:` section.

---

## Task 1: Define `ISubAgent` contracts

**Files:**
- Create: `packages/llm-agent/src/interfaces/subagent.ts`
- Modify: `packages/llm-agent/src/index.ts`

- [ ] **Step 1: Create the interface file**

Create `packages/llm-agent/src/interfaces/subagent.ts`:

```ts
import type { IToolCall, ITokenUsage } from './types.js';

export interface ISubAgentInput {
  task: string;
  context?: Record<string, unknown>;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface ISubAgentResult {
  output: string;
  toolCalls?: IToolCall[];
  usage?: ITokenUsage;
  metadata?: Record<string, unknown>;
}

export interface ISubAgent {
  readonly name: string;
  run(input: ISubAgentInput): Promise<ISubAgentResult>;
}

export type SubAgentRegistry = Map<string, ISubAgent>;
```

- [ ] **Step 2: Re-export from package root**

Modify `packages/llm-agent/src/index.ts` — add near other interface re-exports:

```ts
export type {
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  SubAgentRegistry,
} from './interfaces/subagent.js';
```

- [ ] **Step 3: Verify `IToolCall` / `ITokenUsage` are exported from `./types.js`**

Run: `grep -E "export (type|interface) (IToolCall|ITokenUsage)" packages/llm-agent/src/interfaces/types.ts`
Expected: both types appear. If `ITokenUsage` is named differently in this codebase (e.g. `IUsage`, `LlmUsage`), update the import in `subagent.ts` to match — do not invent a new type.

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: PASS, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/subagent.ts packages/llm-agent/src/index.ts
git commit -m "feat(llm-agent): add ISubAgent contracts for subagent orchestration"
```

---

## Task 2: Add `'subagent'` to `BuiltInStageType` union

**Files:**
- Modify: `packages/llm-agent/src/interfaces/pipeline.ts`

- [ ] **Step 1: Locate the union**

Run: `grep -n "BuiltInStageType\|StageType" packages/llm-agent/src/interfaces/pipeline.ts`
Expected: a `BuiltInStageType` (or similarly named) string-literal union listing existing types like `'classify' | 'summarize' | ... | 'tool-loop' | 'history-upsert'`.

- [ ] **Step 2: Add `'subagent'` to the union**

Modify the union (preserve existing members exactly; only append):

```ts
export type BuiltInStageType =
  | 'classify'
  | 'summarize'
  | 'translate'
  | 'expand'
  | 'rag-query'
  | 'rerank'
  | 'skill-select'
  | 'build-tool-query'
  | 'tool-select'
  | 'assemble'
  | 'tool-loop'
  | 'history-upsert'
  | 'subagent';
```

If the file already has all members listed differently, only append `| 'subagent'` to the end without rewriting the rest.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent/src/interfaces/pipeline.ts
git commit -m "feat(llm-agent): register 'subagent' as built-in stage type"
```

---

## Task 3: Implement Mustache-lite template + setPath helpers

**Files:**
- Create: `packages/llm-agent-libs/src/util/template.ts`

- [ ] **Step 1: Create helper file**

Create `packages/llm-agent-libs/src/util/template.ts`:

```ts
/**
 * Resolve `{{path.to.value}}` placeholders against a context object.
 * Missing paths render as empty string. Non-string values are JSON-stringified.
 */
export function resolveTemplate(
  template: string,
  ctx: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const v = getPath(ctx, path);
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

export function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function setPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cur[key];
    if (next == null || typeof next !== 'object') {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/util/template.ts
git commit -m "feat(llm-agent-libs): add template/path helpers for subagent stage"
```

---

## Task 4: Implement `SubAgentHandler`

**Files:**
- Create: `packages/llm-agent-libs/src/pipeline/handlers/subagent.ts`

- [ ] **Step 1: Inspect existing handler shape**

Run: `sed -n '1,60p' packages/llm-agent-libs/src/pipeline/handlers/classify.ts`
Expected: see the import of `IStageHandler`, `PipelineContext`, `ISpan`, and the class signature `class ClassifyHandler implements IStageHandler<PipelineContext>`. Match this style.

- [ ] **Step 2: Create the handler**

Create `packages/llm-agent-libs/src/pipeline/handlers/subagent.ts`:

```ts
import type {
  ISubAgent,
  SubAgentRegistry,
} from '@mcp-abap-adt/llm-agent';
import type { IStageHandler } from '../stage-handler.js';
import type { PipelineContext } from '../context.js';
import { resolveTemplate, setPath } from '../../util/template.js';

interface SubAgentStageConfig {
  agent: string;
  task?: string;
  outputTo?: string;
  timeoutMs?: number;
}

export class SubAgentHandler implements IStageHandler<PipelineContext> {
  constructor(private readonly registry: SubAgentRegistry) {}

  async execute(
    ctx: PipelineContext,
    rawConfig: Record<string, unknown>,
    _span: unknown,
  ): Promise<boolean> {
    const config = rawConfig as unknown as SubAgentStageConfig;

    if (!config.agent || typeof config.agent !== 'string') {
      ctx.error = new Error("subagent stage: 'agent' is required");
      return false;
    }

    const sub: ISubAgent | undefined = this.registry.get(config.agent);
    if (!sub) {
      ctx.error = new Error(
        `subagent '${config.agent}' not found. Registered: ${
          [...this.registry.keys()].join(', ') || '(none)'
        }`,
      );
      return false;
    }

    const taskTemplate = config.task ?? '{{inputText}}';
    const task = resolveTemplate(
      taskTemplate,
      ctx as unknown as Record<string, unknown>,
    );

    const signal = ctx.options?.signal;
    let result;
    try {
      result = await sub.run({
        task,
        sessionId: ctx.sessionId,
        signal,
      });
    } catch (err) {
      ctx.error = err instanceof Error ? err : new Error(String(err));
      return false;
    }

    const outputPath = config.outputTo ?? `subResults.${config.agent}`;
    const ctxRecord = ctx as unknown as Record<string, unknown>;
    if (!ctxRecord.subResults) ctxRecord.subResults = {};
    setPath(ctxRecord, outputPath, result.output);

    ctx.options?.sessionLogger?.logStep(`subagent_${config.agent}`, {
      task: task.slice(0, 200),
      outputLength: result.output.length,
      usage: result.usage,
    });

    return true;
  }
}
```

- [ ] **Step 3: Build to verify imports resolve**

Run: `npm run build`
Expected: PASS. If `IStageHandler` lives in a different file, fix the import path — do **not** create a duplicate type.

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/subagent.ts
git commit -m "feat(llm-agent-libs): add SubAgentHandler for stage type 'subagent'"
```

---

## Task 5: Wire `SubAgentHandler` into the registry

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/index.ts`

- [ ] **Step 1: Add import and registry parameter**

Modify `packages/llm-agent-libs/src/pipeline/handlers/index.ts`. Add this import at the top with the others:

```ts
import type { SubAgentRegistry } from '@mcp-abap-adt/llm-agent';
import { SubAgentHandler } from './subagent.js';
```

- [ ] **Step 2: Extend `buildDefaultHandlerRegistry` signature**

Change the function signature from `buildDefaultHandlerRegistry()` to accept an optional registry:

```ts
export function buildDefaultHandlerRegistry(
  subAgents?: SubAgentRegistry,
): StageHandlerRegistry {
  const registry = new Map<string, IStageHandler>([
    ['classify', new ClassifyHandler()],
    ['summarize', new SummarizeHandler()],
    ['translate', new TranslateHandler()],
    ['expand', new ExpandHandler()],
    ['rag-query', new RagQueryHandler()],
    ['rerank', new RerankHandler()],
    ['skill-select', new SkillSelectHandler()],
    ['build-tool-query', new BuildToolQueryHandler()],
    ['tool-select', new ToolSelectHandler()],
    ['assemble', new AssembleHandler()],
    ['tool-loop', new ToolLoopHandler()],
    ['history-upsert', new HistoryUpsertHandler()],
  ]);
  if (subAgents && subAgents.size > 0) {
    registry.set('subagent', new SubAgentHandler(subAgents));
  }
  return registry;
}
```

(Preserve the existing trailing re-exports at the bottom of the file unchanged.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS. If the type literal for `StageHandlerRegistry` changed, leave it — `Map<string, IStageHandler>` is correct.

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/index.ts
git commit -m "feat(llm-agent-libs): register subagent handler when registry provided"
```

---

## Task 6: Thread `SubAgentRegistry` through `DefaultPipeline` and `SmartAgentBuilder`

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/default-pipeline.ts`
- Modify: `packages/llm-agent-libs/src/builder.ts`

- [ ] **Step 1: Inspect `DefaultPipeline` constructor**

Run: `grep -n "buildDefaultHandlerRegistry\|constructor" packages/llm-agent-libs/src/pipeline/default-pipeline.ts | head -10`
Expected: a constructor that calls `buildDefaultHandlerRegistry()` (no args today). Locate the call site for the next step.

- [ ] **Step 2: Accept registry in `DefaultPipeline`**

In `default-pipeline.ts`, add a constructor parameter `subAgents?: SubAgentRegistry` and pass it to `buildDefaultHandlerRegistry`. If the class already accepts an options object, add `subAgents` there instead — match the existing pattern. The call must become:

```ts
const handlers = buildDefaultHandlerRegistry(opts.subAgents);
```

(`opts` here is whatever existing parameter the constructor uses; if it takes individual args, add `subAgents` as a new optional last arg.)

Add the import at the top:

```ts
import type { SubAgentRegistry } from '@mcp-abap-adt/llm-agent';
```

- [ ] **Step 3: Add fluent method on `SmartAgentBuilder`**

In `packages/llm-agent-libs/src/builder.ts`, add the import:

```ts
import type { SubAgentRegistry } from '@mcp-abap-adt/llm-agent';
```

Add a private field and fluent method to the `SmartAgentBuilder` class:

```ts
  private _subAgents?: SubAgentRegistry;

  withSubAgents(registry: SubAgentRegistry): this {
    this._subAgents = registry;
    return this;
  }
```

In the existing `build()` method, where `DefaultPipeline` is instantiated, pass `subAgents: this._subAgents` (or as the new positional arg, depending on the constructor shape from Step 2). Locate the instantiation:

Run: `grep -n "new DefaultPipeline" packages/llm-agent-libs/src/builder.ts`
Expected: one or two call sites; update each one.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/default-pipeline.ts packages/llm-agent-libs/src/builder.ts
git commit -m "feat(llm-agent-libs): thread SubAgentRegistry through builder and pipeline"
```

---

## Task 7: Implement `SmartAgentSubAgent` adapter

**Files:**
- Create: `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts`
- Modify: `packages/llm-agent-libs/src/index.ts`

- [ ] **Step 1: Inspect SmartAgent's public method for one-shot processing**

Run: `grep -nE "async (process|run|streamProcess)\b" packages/llm-agent-libs/src/agent.ts | head`
Expected: locate the non-streaming public method (often `process(input, opts)` returning `{ text, toolCalls?, usage? }`). Use that signature in the adapter. If only `streamProcess` is public, collect the stream into a string here.

- [ ] **Step 2: Create the adapter**

Create `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts`:

```ts
import type {
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../agent.js';

export class SmartAgentSubAgent implements ISubAgent {
  constructor(
    public readonly name: string,
    private readonly agent: SmartAgent,
  ) {}

  async run(input: ISubAgentInput): Promise<ISubAgentResult> {
    const res = await this.agent.process(input.task, {
      sessionId: input.sessionId,
      signal: input.signal,
    });
    return {
      output: res.text ?? '',
      toolCalls: res.toolCalls,
      usage: res.usage,
    };
  }
}
```

If the actual method is `streamProcess`, replace the body with a stream collector that joins all `chunk.text` values into one string and returns it as `output`. Do **not** invent a method that does not exist — verify with `grep` before writing.

- [ ] **Step 3: Re-export**

In `packages/llm-agent-libs/src/index.ts` add:

```ts
export { SmartAgentSubAgent } from './subagent/smart-agent-subagent.js';
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts packages/llm-agent-libs/src/index.ts
git commit -m "feat(llm-agent-libs): add SmartAgentSubAgent adapter for ISubAgent"
```

---

## Task 8: YAML loader — parse `subagents:` and build registry

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/config.ts`

- [ ] **Step 1: Inspect the existing loader's entry point**

Run: `grep -nE "export (async )?function|loadConfig|buildAgentFromYaml" packages/llm-agent-server/src/smart-agent/config.ts | head -20`
Expected: locate the main "build a SmartAgent from YAML" function (it returns or wires up a `SmartAgent` via `SmartAgentBuilder`). Note its name; that is the function we will call recursively per subagent.

- [ ] **Step 2: Add subagent loading**

Inside the main builder function (after the YAML is parsed but before `.build()` is called), insert:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  SmartAgentSubAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import type { SubAgentRegistry } from '@mcp-abap-adt/llm-agent';

// ... inside the function, after `yaml` is loaded:
const subagentsCfg = (yaml as any).subagents as
  | Array<{ name: string; config: string }>
  | undefined;

if (subagentsCfg && subagentsCfg.length > 0) {
  const registry: SubAgentRegistry = new Map();
  for (const entry of subagentsCfg) {
    if (!entry.name || !entry.config) {
      throw new Error(
        `subagents[]: each entry needs 'name' and 'config' (got ${JSON.stringify(entry)})`,
      );
    }
    const subConfigPath = path.resolve(path.dirname(configPath), entry.config);
    const subYamlText = await fs.readFile(subConfigPath, 'utf8');
    const subYaml = parseYaml(subYamlText);
    if ((subYaml as any).subagents) {
      throw new Error(
        `subagent '${entry.name}' must not define its own 'subagents:' (nested orchestration is not supported in v1)`,
      );
    }
    // Recursively build using the same loader (without subagents to prevent cycles).
    const subAgent = await buildSmartAgentFromYamlObject(subYaml, subConfigPath);
    registry.set(entry.name, new SmartAgentSubAgent(entry.name, subAgent));
  }
  builder.withSubAgents(registry);
}
```

(`configPath` and the helper `buildSmartAgentFromYamlObject` should match the names already present in this file — adapt if the loader uses different identifiers. The key invariant: **the recursive call must NOT re-process `subagents:`**, otherwise cycles are possible.)

- [ ] **Step 3: Document the YAML schema**

Add a comment block to the schema documentation string already present in this file (around the existing `# pluginDir:` example):

```yaml
# subagents:                            # Optional: nested agents callable from pipeline
#   - name: code-reviewer               # Used as stage config: { agent: code-reviewer }
#     config: ./agents/code-reviewer.yaml
#   - name: abap-coder
#     config: ./agents/abap-coder.yaml
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/config.ts
git commit -m "feat(llm-agent-server): load 'subagents:' YAML block into SubAgentRegistry"
```

---

## Task 9: Example YAML — fanout + merge + repeat-until-approved

**Files:**
- Create: `examples/subagents/abap-coder.yaml`
- Create: `examples/subagents/code-reviewer.yaml`
- Create: `docs/examples/subagent-orchestration.yaml`

- [ ] **Step 1: Create minimal subagent configs**

Create `examples/subagents/abap-coder.yaml`:

```yaml
# Minimal SmartAgent config for an ABAP-focused coder subagent.
llm:
  provider: ${LLM_PROVIDER:-openai}
  model: ${OPENAI_MODEL:-gpt-4o-mini}
systemPrompt: |
  You are an expert ABAP developer. Produce concise, production-grade ABAP code
  for the given task. Do not explain unless asked.
mcp:
  disabled: true
pipeline:
  stages:
    - id: assemble
      type: assemble
    - id: tool-loop
      type: tool-loop
      config: { maxIterations: 1 }
```

Create `examples/subagents/code-reviewer.yaml`:

```yaml
llm:
  provider: ${LLM_PROVIDER:-openai}
  model: ${OPENAI_MODEL:-gpt-4o-mini}
systemPrompt: |
  You are a senior code reviewer. Read the code and respond with a JSON object:
  {"approved": boolean, "issues": string[]}.
  Approve only if the code is correct, idiomatic, and complete.
mcp:
  disabled: true
pipeline:
  stages:
    - id: assemble
      type: assemble
    - id: tool-loop
      type: tool-loop
      config: { maxIterations: 1 }
```

(If the project's `llm:` schema uses different keys — e.g. `model:` at top level — adjust to match an existing example file. Run `ls docs/examples/*.yaml | head` and copy the schema from `01-*.yaml` or the simplest example present.)

- [ ] **Step 2: Create orchestration example**

Create `docs/examples/subagent-orchestration.yaml`:

```yaml
# Subagent orchestration: parallel fanout + iterative refinement.
llm:
  provider: ${LLM_PROVIDER:-openai}
  model: ${OPENAI_MODEL:-gpt-4o-mini}

subagents:
  - name: abap-coder
    config: ../../examples/subagents/abap-coder.yaml
  - name: code-reviewer
    config: ../../examples/subagents/code-reviewer.yaml

pipeline:
  stages:
    - id: assemble
      type: assemble

    - id: refine
      type: repeat
      maxIterations: 3
      until: "ctx.subResults?.review?.includes('\"approved\": true')"
      stages:
        - id: code
          type: subagent
          config:
            agent: abap-coder
            task: |
              {{inputText}}
              Previous attempt (if any):
              {{subResults.code}}
              Reviewer feedback (if any):
              {{subResults.review}}
            outputTo: subResults.code
        - id: review
          type: subagent
          config:
            agent: code-reviewer
            task: "Review this ABAP code:\n{{subResults.code}}"
            outputTo: subResults.review

    - id: tool-loop
      type: tool-loop
      config: { maxIterations: 1 }
```

- [ ] **Step 3: Smoke-test the build**

Run: `npm run build`
Expected: PASS. No runtime invocation required at this step — actual run happens in Task 11.

- [ ] **Step 4: Commit**

```bash
git add examples/subagents/abap-coder.yaml examples/subagents/code-reviewer.yaml docs/examples/subagent-orchestration.yaml
git commit -m "docs(examples): add subagent orchestration example (fanout + repeat)"
```

---

## Task 10: Documentation updates

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/EXAMPLES.md`

- [ ] **Step 1: Architecture note**

Append a new section to `docs/ARCHITECTURE.md` (at the end, before any trailing references section):

```markdown
## Subagent orchestration

Pipelines can invoke nested `SmartAgent` instances as a stage. A top-level
`subagents:` YAML block declares named subagents (each a full SmartAgent
config); the `subagent` stage type runs one by name, with task and output
binding driven by `{{path}}` templates against `PipelineContext`.

Parallel fanout uses the existing `parallel` control-flow stage; iterative
refinement uses `repeat` with an `until:` expression.

Nested subagents (a subagent declaring its own `subagents:`) are rejected by
the loader to prevent cycles. To compose more deeply, build the outer agent
programmatically and pass a custom `SubAgentRegistry` via
`SmartAgentBuilder.withSubAgents(...)`.
```

- [ ] **Step 2: Examples index**

Append to `docs/EXAMPLES.md`:

```markdown
### Subagent orchestration

`docs/examples/subagent-orchestration.yaml` — fan out to a coder + reviewer
subagent pair and loop until the reviewer approves. References
`examples/subagents/abap-coder.yaml` and `examples/subagents/code-reviewer.yaml`.
```

- [ ] **Step 3: Lint check**

Run: `npm run lint:check`
Expected: PASS (markdown not linted, but ensure no source file regressed).

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md docs/EXAMPLES.md
git commit -m "docs: describe subagent orchestration and example index"
```

---

## Task 11: Manual smoke verification

**Files:** none (manual run)

- [ ] **Step 1: Build clean**

Run: `npm run clean && npm run build`
Expected: PASS.

- [ ] **Step 2: Lint**

Run: `npm run lint:check`
Expected: PASS.

- [ ] **Step 3: Run the example**

Set provider credentials (`OPENAI_API_KEY` or whatever `LLM_PROVIDER` is set to) in `.env`, then:

Run: `npx llm-agent --config docs/examples/subagent-orchestration.yaml --input "Write an ABAP report that prints 'Hello World'."`
Expected:
- Logs show `stage subagent_abap-coder` and `stage subagent_code-reviewer` per iteration.
- `repeat` loop exits when reviewer output contains `"approved": true`, or after 3 iterations.
- Final response references the approved code.

If the CLI binary name differs, run: `grep -nE '"bin":' packages/llm-agent-server/package.json` and use the actual binary.

- [ ] **Step 4: Failure-path check**

Run: `npx llm-agent --config docs/examples/subagent-orchestration.yaml --input "nonsense"` after editing `code-reviewer.yaml` to always disapprove (e.g. add `"approved": false` to its system prompt instruction).
Expected: loop runs exactly 3 iterations, exits on `maxIterations`, no crash, response surfaces the last code attempt.

Revert the disapproval edit before committing anything else.

- [ ] **Step 5: No commit unless changes were needed**

If any source-file fix was required during smoke testing, commit it with a separate `fix(subagent): ...` commit. Otherwise no commit for this task.

---

## Testing Notes

This repo has no unit-test framework (`npm run test` is `build + start`). Verification is therefore:

1. `npm run build` — TypeScript catches contract regressions across packages.
2. `npm run lint:check` — Biome catches style and unused-import regressions.
3. Manual smoke (Task 11) — proves the new stage actually runs end-to-end.

If a unit-test harness is added later, the highest-value tests for this feature are:
- `resolveTemplate` covers `{{a.b.c}}`, missing paths, non-string values.
- `setPath` creates intermediate objects and overwrites existing values.
- `SubAgentHandler` with a fake `ISubAgent` verifies registry lookup, error path, output binding.

---

## Out of Scope (Future Work)

- **Nested orchestration** (subagent declaring its own subagents). Task 8 rejects this. Future task: replace the recursion guard with explicit cycle detection.
- **Subagent token-budget aggregation** into parent's `ctx.usage`. Today the subagent's `usage` is logged but not summed into the parent's totals.
- **Streaming subagent output** through the parent's SSE channel. Today subagent results are awaited fully before the stage returns.
- **`parallel` fan-out with shared input templating**. The example uses `repeat`; a sibling example for `parallel` fanout can be added once the basic flow is proven.
