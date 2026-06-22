/**
 * plan-analysis.ts — DEV EVAL HARNESS (NOT shipped, NOT a unit test).
 * =====================================================================
 *
 * Runs the controller PLANNER (smart-executor + weak-executor) over a fixed set of
 * SAP create/review prompts, TWICE:
 *   - WITHOUT skills (agnostic baseline — no `skillsRecall`), and
 *   - WITH skills    (a `skillsRecall` built from an in-memory skill plugin-host).
 * It prints a side-by-side comparison so the user can SEE whether injecting a
 * "Relevant skills" block changes the plan / step sequence the planner emits.
 *
 * This file is excluded from the shipped build (see package tsconfig `exclude`)
 * and is imported by NO barrel/index.ts. It is run directly via tsx.
 *
 * ---------------------------------------------------------------------
 * STUB MODE (default — what CI / this environment runs, NO network):
 * ---------------------------------------------------------------------
 *   cd packages/llm-agent-server-libs
 *   node --import tsx/esm src/smart-agent/controller/plan-analysis.ts
 *
 *   With `EVAL_LIVE` unset, the planner LLM is a DETERMINISTIC STUB that returns
 *   canned plan JSON. No API credentials are needed. The stub records whether a
 *   "Relevant skills" block reached its prompt, so the harness PROVES the WITH
 *   path is wired (skillsRecall invoked → block reaches the planner) without a
 *   live model. The embedder for the in-memory skill host is also a deterministic
 *   hash→vector stub, so the WITH path needs no embedder creds either.
 *
 * ---------------------------------------------------------------------
 * LIVE MODE (the REAL measurement — the USER runs this, not the agent):
 * ---------------------------------------------------------------------
 *   1. Copy `.env.template` → `.env` at the repo root and fill provider creds
 *      (e.g. LLM_PROVIDER=sap-ai-sdk + AICORE_SERVICE_KEY + SAP_AI_MODEL, or
 *      LLM_PROVIDER=openai + OPENAI_API_KEY, etc.).
 *   2. (Optional, for the WITH path) clone a local skill set and point at it:
 *        git clone <sap-skills repo> /tmp/sap-skills     # never commit this
 *        export EVAL_SKILLS_DIR=/tmp/sap-skills
 *      EVAL_SKILLS_DIR may be either a directory of `<plugin>/SKILL.md` files or a
 *      directory of `*.md` skill files. When UNSET, the harness uses the small
 *      inline FIXTURE_SKILLS below (generic, NOT GPL sap-skills content).
 *   3. Run with the live flag (from the repo root so `.env` resolves):
 *        EVAL_LIVE=1 node --import tsx/esm \
 *          packages/llm-agent-server-libs/src/smart-agent/controller/plan-analysis.ts
 *      Optionally embed the WITH-host with a REAL embedder (LLM provider that has
 *      one, e.g. ollama / openai / sap-ai-core) by setting EVAL_EMBEDDER=1 — else
 *      the deterministic stub embedder is used even in live mode (the live LLM is
 *      what matters for the plan comparison; the embedder only ranks skills).
 *
 * The 5 prompts below include the ABAP review, the CDS-composition, and the
 * compound dependency-chain (compound-create) cases. Adjust freely for your run.
 *
 * Env contract:
 *   EVAL_LIVE=1        → build the real planner LLM from .env (default: stub).
 *   EVAL_SKILLS_DIR    → local skill dir for the WITH path (default: inline fixture).
 *   EVAL_EMBEDDER=1    → use a real embedder for the WITH host (default: stub embed).
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CallOptions,
  IEmbedder,
  IEmbedResult,
  SkillIngestResult,
} from '@mcp-abap-adt/llm-agent';
import {
  buildIngestResult,
  makeInMemoryStoreProvider,
  makeLlm,
  makeSkillPluginHost,
} from '@mcp-abap-adt/llm-agent-libs';
import { makeControllerPlanner } from './planner.js';
import { type ISubagentClient, makeSubagentClient } from './subagent-client.js';
import type { PlannerKind, SessionBundle, SubagentResult } from './types.js';

const MAX_STEPS = 12;
const EVAL_GROUP = 'eval-skills';
const SKILLS_MARKER = 'Relevant skills'; // the block the recall hook injects.

// --------------------------------------------------------------------------
// Minimal .env loader (no dotenv dependency at this scope).
// --------------------------------------------------------------------------
function loadEnv(path = '.env'): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv();

// --------------------------------------------------------------------------
// The 5 evaluation prompts (review + cds-composition + compound-create + others).
// --------------------------------------------------------------------------
const PROMPTS: Record<string, string> = {
  'abap-review':
    'Review ABAP program ZDAZ_R_DELAYED_UPDATE, check security, performance, CleanCore, maintainability.',
  'class-with-code':
    "Create an ABAP class ZCL_CTRL_DEMO in package $TMP and fill it with a public method GET_GREETING that returns the string 'Hello from the controller'.",
  'compound-create':
    'In package $TMP create three dependent ABAP Dictionary objects in the correct dependency order: a domain ZDOM_CTRL (CHAR length 10), a data element ZDTE_CTRL that uses domain ZDOM_CTRL, and a transparent table ZTAB_CTRL with a key field KEY_ID typed by data element ZDTE_CTRL.',
  'cds-composition':
    'In package $TMP create two CDS views in a composition relationship in the correct order: a root entity ZI_CTRL_HEAD that defines a composition to a child entity ZI_CTRL_ITEM, and the child entity ZI_CTRL_ITEM with an association to parent back to ZI_CTRL_HEAD.',
  'table-read': 'Read the structure of table T100 and list its key fields.',
};

// --------------------------------------------------------------------------
// Inline skill fixture — GENERIC, NOT real GPL sap-skills content. Each entry is
// a SKILL.md string (frontmatter + body). Override with EVAL_SKILLS_DIR.
// --------------------------------------------------------------------------
const FIXTURE_SKILLS: ReadonlyArray<{ plugin: string; skillMd: string }> = [
  {
    plugin: 'abap-review',
    skillMd: `---
name: abap-review
description: How to review an ABAP program for security, performance, Clean Core and maintainability.
---
# Reviewing an ABAP program

1. First fetch the program source.
2. Check for SQL injection, authority checks, and hardcoded credentials (security).
3. Look for SELECT inside LOOP, missing WHERE, full table scans (performance).
4. Flag direct access to non-released SAP objects (Clean Core).
5. Summarise findings grouped by category with severity.
`,
  },
  {
    plugin: 'ddic-objects',
    skillMd: `---
name: ddic-objects
description: How to create dependent ABAP Dictionary objects (domain, data element, table) in the correct dependency order.
---
# Creating dependent DDIC objects

Create the domain FIRST, then the data element that references it, then the
transparent table whose key field is typed by that data element. Activate each
object before the dependent one is created.
`,
  },
  {
    plugin: 'cds-composition',
    skillMd: `---
name: cds-composition
description: How to create CDS views in a composition/association relationship in the correct order.
---
# CDS composition relationships

Create the CHILD entity first (it carries the association back to the parent),
then the ROOT entity that declares the composition to the child. Define the
parent association on the child and the composition on the root.
`,
  },
];

// --------------------------------------------------------------------------
// Deterministic stub embedder (hash → fixed-dim vector). No creds needed.
// --------------------------------------------------------------------------
const EMBED_DIM = 64;
function hashVector(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  // Spread byte energy of a sha256 digest across the dimensions.
  const digest = createHash('sha256').update(text.toLowerCase()).digest();
  for (let i = 0; i < digest.length; i++) {
    v[i % EMBED_DIM] += digest[i] / 255;
  }
  // L2-normalise so cosine is meaningful.
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
const stubEmbedder: IEmbedder = {
  async embed(text: string, _options?: CallOptions): Promise<IEmbedResult> {
    return { vector: hashVector(text) };
  },
};

// --------------------------------------------------------------------------
// Build the SkillIngestResult (one group per run, one-group-per-plugin merged
// under EVAL_GROUP so every fixture skill is co-located in a single collection).
// --------------------------------------------------------------------------
function loadSkillsFromDir(
  dir: string,
): ReadonlyArray<{ plugin: string; skillMd: string }> {
  const out: { plugin: string; skillMd: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // <plugin>/SKILL.md layout
      try {
        const md = readFileSync(join(full, 'SKILL.md'), 'utf8');
        out.push({ plugin: entry, skillMd: md });
      } catch {
        // no SKILL.md — skip
      }
    } else if (entry.toLowerCase().endsWith('.md')) {
      out.push({
        plugin: entry.replace(/\.md$/i, ''),
        skillMd: readFileSync(full, 'utf8'),
      });
    }
  }
  return out;
}

function buildEvalIngest(): SkillIngestResult {
  const dir = process.env.EVAL_SKILLS_DIR;
  const skills = dir ? loadSkillsFromDir(dir) : FIXTURE_SKILLS;
  if (skills.length === 0) {
    throw new Error(
      `EVAL_SKILLS_DIR='${dir}' yielded no skills (expected <plugin>/SKILL.md or *.md files)`,
    );
  }
  return buildIngestResult({
    source: 'eval',
    plugins: skills.map((s) => ({
      plugin: s.plugin,
      version: '0.0.0',
      skills: [{ skill: s.plugin, skillMd: s.skillMd }],
    })),
    chunk: { maxChars: 1200 },
    // Place EVERY plugin into ONE eval group (one-group-per-plugin merged).
    placement: () => ({
      group: EVAL_GROUP,
      description: 'Evaluation skill set (dev harness)',
    }),
  });
}

// --------------------------------------------------------------------------
// Build the WITH-skills recall hook from an in-memory skill plugin-host.
// --------------------------------------------------------------------------
async function buildSkillsRecall(): Promise<(goal: string) => Promise<string>> {
  const ingest = buildEvalIngest();
  const useRealEmbedder = process.env.EVAL_EMBEDDER === '1';
  const embedder: IEmbedder = useRealEmbedder
    ? await makeRealEmbedder()
    : stubEmbedder;

  const storeProvider = makeInMemoryStoreProvider({
    embed: async (text, options) =>
      (await embedder.embed(text, options)).vector,
  });
  const host = makeSkillPluginHost({
    sources: [
      {
        id: 'eval',
        source: {
          async acquire() {
            return ingest;
          },
        },
      },
    ],
    storeProvider,
    embedder,
    embeddingSpaceId: 'eval',
    retrievalSchemaVersion: 1,
  });
  await host.load();

  const k = 3;
  const threshold = 0; // stub vectors are weakly separated; keep the gate open.
  return async (goal: string): Promise<string> => {
    const hits = await host.rag(EVAL_GROUP).query(goal, { k, threshold });
    if (hits.length === 0) return '';
    const body = hits
      .map((h, i) => `${i + 1}. (${h.record.name}) ${h.record.content.trim()}`)
      .join('\n');
    return `${SKILLS_MARKER} (consult before planning):\n${body}`;
  };
}

async function makeRealEmbedder(): Promise<IEmbedder> {
  // Lazy import to keep the stub path free of RAG deps. The user opts in via
  // EVAL_EMBEDDER=1; provider/model come from .env.
  const rag = await import('@mcp-abap-adt/llm-agent-rag');
  rag.prefetchEmbedderFactories?.();
  return rag.resolveEmbedder({
    provider: process.env.LLM_PROVIDER ?? 'ollama',
    model: process.env.EMBEDDING_MODEL,
    apiKey: process.env.OPENAI_API_KEY,
    url: process.env.OLLAMA_URL,
  } as never);
}

// --------------------------------------------------------------------------
// STUB subagent client — deterministic canned planner output (NO network).
// Branches on the SYSTEM prompt: create-plan → {plan:[...]}, finalize → done,
// plan-first next-step → step from plan then done. Records whether the injected
// "Relevant skills" block reached the prompt (proves the WITH wiring).
// --------------------------------------------------------------------------
interface StubProbe {
  sawSkillsBlock: boolean;
  calls: number;
}
function makeStubClient(probe: StubProbe): ISubagentClient {
  // A canned 2-step plan keyed loosely off the GOAL LINE only (deterministic).
  // Keying off the "Goal:" line (not the whole user message) keeps the canned plan
  // identical WITH vs WITHOUT — the injected skills block must NOT skew the stub,
  // so the comparison table reflects WIRING, not stub-text artefacts. The REAL
  // plan divergence is the user's live measurement.
  function cannedPlan(userMessage: string): string {
    const goal = userMessage.match(/^Goal:.*$/m)?.[0] ?? userMessage;
    const steps = /review/i.test(goal)
      ? [
          { name: 'fetch-source', instructions: 'Fetch the program source.' },
          {
            name: 'review-findings',
            instructions: 'Analyse and summarise findings.',
          },
        ]
      : /create/i.test(goal)
        ? [
            {
              name: 'create-prereq',
              instructions: 'Create the prerequisite object.',
            },
            {
              name: 'create-target',
              instructions: 'Create the dependent object.',
            },
          ]
        : [{ name: 'fetch-data', instructions: 'Fetch the requested data.' }];
    return JSON.stringify({ plan: steps });
  }

  return {
    async send(messages): Promise<SubagentResult> {
      probe.calls++;
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      if (typeof user === 'string' && user.includes(SKILLS_MARKER)) {
        probe.sawSkillsBlock = true;
      }
      const sys = String(system);
      const goal = String(user);

      // Discriminate on the EXACT controller system prompts (robust substrings):
      //  - FINALIZE_SYSTEM starts "All planned steps are complete." → plain answer.
      //  - CREATE_PLAN / REPLAN / EXTERNAL_RESULT_REPLAN ask for {"plan":[...]}.
      // Both smart-executor and weak-executor are plan-first — no single-step shape.
      if (sys.startsWith('All planned steps are complete.')) {
        return { kind: 'content', content: 'Done (stub finalizer answer).' };
      }
      return { kind: 'content', content: cannedPlan(goal) };
    },
  };
}

// --------------------------------------------------------------------------
// Drive ONE planner over ONE prompt; return a compact summary row.
// --------------------------------------------------------------------------
interface RunRow {
  steps: string[];
  done: boolean;
  plannerCalls: number;
  failed?: string;
}

function freshBundle(goal: string): SessionBundle {
  return {
    goal,
    plannerPrivate: '',
    budgets: { stepsUsed: 0, rewindsUsed: 0 },
    nextSeq: 0,
  } as unknown as SessionBundle;
}

async function analyze(
  mode: PlannerKind,
  prompt: string,
  client: ISubagentClient,
  skillsRecall?: (goal: string) => Promise<string>,
): Promise<RunRow> {
  const planner = makeControllerPlanner(mode, client, undefined, skillsRecall);
  const bundle = freshBundle(prompt);
  const steps: string[] = [];
  let lastOutcome: 'advanced' | 'failed' | 'partial' | undefined;
  let plannerCalls = 0;

  for (let i = 0; i < MAX_STEPS; i++) {
    let next: Awaited<ReturnType<typeof planner.next>>;
    try {
      next = await planner.next({
        bundle,
        prompt,
        lastOutcome,
        retrying: false,
      });
    } catch (e) {
      return { steps, done: false, plannerCalls, failed: String(e) };
    }
    plannerCalls++;
    if (next === null) {
      return {
        steps,
        done: false,
        plannerCalls,
        failed: 'planner returned null (parse-fail)',
      };
    }
    if (next.kind === 'done') {
      return { steps, done: true, plannerCalls };
    }
    if (next.kind === 'rewind') {
      bundle.plannerPrivate += `\n[rewind] ${next.reason}`;
      lastOutcome = undefined;
      continue;
    }
    steps.push(next.step.name);
    planner.commit?.(bundle, 'advanced');
    lastOutcome = 'advanced';
    bundle.lastOutcome = 'advanced';
    bundle.nextSeq = (bundle.nextSeq ?? 0) + 1;
    bundle.budgets.stepsUsed++;
    bundle.plannerPrivate += `\n[step ${next.step.name}] OK — completed successfully (stub executor).`;
  }
  return { steps, done: false, plannerCalls, failed: 'exceeded MAX_STEPS' };
}

function fmtRow(r: RunRow): string {
  const status = r.failed
    ? `FAIL(${r.failed})`
    : r.done
      ? 'done'
      : 'incomplete';
  return `${r.steps.length} steps [${r.steps.join(' → ')}] ${status} (calls=${r.plannerCalls})`;
}

// --------------------------------------------------------------------------
async function main(): Promise<void> {
  const live = process.env.EVAL_LIVE === '1';
  console.log(
    `\nplan-analysis harness — mode=${live ? 'LIVE (real LLM from .env)' : 'STUB (no network)'}\n`,
  );

  let client: ISubagentClient;
  const probe: StubProbe = { sawSkillsBlock: false, calls: 0 };
  if (live) {
    const provider = process.env.LLM_PROVIDER ?? 'sap-ai-sdk';
    const model = process.env.SAP_AI_MODEL ?? process.env.LLM_MODEL;
    const llm = await makeLlm(
      { provider, ...(model ? { model } : {}) } as never,
      0.7,
    );
    client = makeSubagentClient(llm);
  } else {
    client = makeStubClient(probe);
  }

  console.log(
    'Building WITH-skills recall hook (in-memory skill plugin-host)...',
  );
  const skillsRecall = await buildSkillsRecall();
  // Demonstrate the hook returns a non-empty block for a representative goal.
  const sample = await skillsRecall(PROMPTS['abap-review']);
  const preview = sample
    ? `${sample.slice(0, 80).replace(/\n/g, ' ')}…`
    : '(empty)';
  console.log(
    `  recall sample for abap-review (${sample.length} chars): ${preview}\n`,
  );

  const modes: PlannerKind[] = ['smart-executor', 'weak-executor'];
  const bar = '═'.repeat(100);
  for (const [label, prompt] of Object.entries(PROMPTS)) {
    console.log(`${bar}\n${label}: ${prompt}\n${bar}`);
    for (const mode of modes) {
      const without = await analyze(mode, prompt, client);
      const withSkills = await analyze(mode, prompt, client, skillsRecall);
      console.log(`  [${mode}] WITHOUT skills: ${fmtRow(without)}`);
      console.log(`  [${mode}] WITH    skills: ${fmtRow(withSkills)}`);
    }
    console.log('');
  }

  if (!live) {
    console.log(
      `STUB-MODE WIRING CHECK: skillsRecall block reached the planner prompt → ` +
        `${probe.sawSkillsBlock ? 'YES ✔ (WITH path verified)' : 'NO ✖ (WIRING BROKEN)'}`,
    );
    if (!probe.sawSkillsBlock) process.exit(1);
  } else {
    console.log(
      'LIVE run complete — compare the WITH vs WITHOUT rows above to see the skill effect.',
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
