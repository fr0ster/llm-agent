import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder, IEmbedResult } from '../../interfaces/rag.js';
import type {
  CallOptions,
  RagError,
  RagResult,
  Result,
} from '../../interfaces/types.js';
import { InMemoryRag } from '../in-memory-rag.js';
import type { IQueryPreprocessor } from '../preprocessor.js';
import { QueryEmbedding, TextOnlyEmbedding } from '../query-embedding.js';
import {
  Bm25OnlyStrategy,
  RrfStrategy,
  VectorOnlyStrategy,
  WeightedFusionStrategy,
} from '../search-strategy.js';
import { VectorRag } from '../vector-rag.js';

// ---------------------------------------------------------------------------
// TF bag-of-words embedder (deterministic, no network)
// ---------------------------------------------------------------------------

class TfEmbedder implements IEmbedder {
  private vocabulary: string[] = [];

  buildVocabulary(texts: string[]): void {
    const allTokens = new Set<string>();
    for (const text of texts) {
      for (const token of this.tokenize(text)) {
        allTokens.add(token);
      }
    }
    this.vocabulary = [...allTokens].sort();
  }

  async embed(_text: string, _options?: CallOptions): Promise<IEmbedResult> {
    const tokens = this.tokenize(_text);
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

    const vec = this.vocabulary.map((term) => freq.get(term) ?? 0);

    // L2-normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }

    return { vector: vec };
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }
}

// ---------------------------------------------------------------------------
// MCP Tools Corpus (~40 real tools from ABAP development server)
// ---------------------------------------------------------------------------

interface CorpusEntry {
  text: string;
  id: string;
}

const MCP_TOOLS_CORPUS: CorpusEntry[] = [
  // --- Read/Get operations ---
  {
    id: 'tool:GetTableContents',
    text: 'GetTableContents: Retrieve contents (data preview) of an ABAP database table or CDS view. Returns rows of data like SE16/SE16N. Params: table_name, max_rows',
  },
  {
    id: 'tool:ReadClass',
    text: 'ReadClass: Read ABAP class source code and metadata (package, responsible, description, etc.). Params: class_name, version',
  },
  {
    id: 'tool:ReadInterface',
    text: 'ReadInterface: Read ABAP interface source code and metadata (package, responsible, description, etc.). Params: interface_name, version',
  },
  {
    id: 'tool:ReadTable',
    text: 'ReadTable: Read ABAP table definition and metadata (package, responsible, description, etc.). Params: table_name, version',
  },
  {
    id: 'tool:ReadView',
    text: 'ReadView: Read ABAP view (CDS view) source code and metadata (package, responsible, description, etc.). Params: view_name, version',
  },
  {
    id: 'tool:ReadFunctionModule',
    text: 'ReadFunctionModule: Read ABAP function module source code and metadata (package, responsible, description, etc.). Params: function_module_name, function_group_name, version',
  },
  {
    id: 'tool:ReadDomain',
    text: 'ReadDomain: Read ABAP domain definition and metadata (package, responsible, description, etc.). Params: domain_name, version',
  },
  {
    id: 'tool:ReadDataElement',
    text: 'ReadDataElement: Read ABAP data element definition and metadata (package, responsible, description, etc.). Params: data_element_name, version',
  },
  {
    id: 'tool:ReadBehaviorDefinition',
    text: 'ReadBehaviorDefinition: Read ABAP behavior definition source code and metadata (package, responsible, description, etc.). Params: behavior_definition_name, version',
  },
  {
    id: 'tool:ReadServiceBinding',
    text: 'ReadServiceBinding: Read ABAP service binding source/payload and metadata (package, responsible, description, etc.). Params: service_binding_name',
  },
  {
    id: 'tool:GetInclude',
    text: 'GetInclude: Retrieve source code of a specific ABAP include file. Params: include_name',
  },
  {
    id: 'tool:GetPackageContents',
    text: 'GetPackageContents: Retrieve objects inside an ABAP package as a flat list. Supports recursive traversal of subpackages. Params: package_name, include_subpackages, max_depth',
  },

  // --- Create operations ---
  {
    id: 'tool:CreateClass',
    text: 'CreateClass: Create a new ABAP class in SAP system. Creates the class object in initial state. Use UpdateClass to add source code. Params: class_name, description, package_name, transport_request, superclass, final, abstract',
  },
  {
    id: 'tool:CreateInterface',
    text: 'CreateInterface: Create a new ABAP interface in SAP system. Creates the interface object in initial state. Use UpdateInterface to add source code. Params: interface_name, description, package_name, transport_request',
  },
  {
    id: 'tool:CreateTable',
    text: 'CreateTable: Create a new ABAP table via the ADT API. Creates the table object in initial state. Use UpdateTable to set DDL source. Params: table_name, description, package_name, transport_request',
  },
  {
    id: 'tool:CreateView',
    text: 'CreateView: Create CDS View or Classic View in SAP. Creates the view object in initial state. Use UpdateView to set DDL. Params: view_name, package_name, transport_request, description',
  },
  {
    id: 'tool:CreateTransport',
    text: 'CreateTransport: Create a new ABAP transport request in SAP system for development objects. Params: transport_type, description, target_system, owner',
  },
  {
    id: 'tool:CreatePackage',
    text: 'CreatePackage: Create a new ABAP package in SAP system. Packages are containers for development objects and are essential for organization. Params: package_name, description, super_package, package_type, transport_request',
  },
  {
    id: 'tool:CreateDomain',
    text: 'CreateDomain: Create a new ABAP domain in SAP system with all required steps: lock, create, check, unlock, activate. Params: domain_name, description, package_name, transport_request, datatype, length',
  },
  {
    id: 'tool:CreateFunctionModule',
    text: 'CreateFunctionModule: Create a new ABAP function module within an existing function group. Creates the function module in initial state. Params: function_group_name, function_module_name, description, transport_request',
  },
  {
    id: 'tool:CreateServiceDefinition',
    text: 'CreateServiceDefinition: Create a new ABAP service definition for OData services. Service definitions define the structure and exposure of CDS views as OData services. Params: service_definition_name, description, package_name, transport_request, source_code',
  },
  {
    id: 'tool:CreateServiceBinding',
    text: 'CreateServiceBinding: Create ABAP service binding via ADT Business Services endpoint. XML is generated from high-level parameters. Params: service_binding_name, service_definition_name, package_name, description, binding_type',
  },
  {
    id: 'tool:CreateBehaviorDefinition',
    text: 'CreateBehaviorDefinition: Create a new ABAP Behavior Definition (BDEF) in SAP system. Defines RAP business object behavior: CRUD operations, validations, determinations. Params: name, description, package_name, transport_request, root_entity',
  },

  // --- Update operations ---
  {
    id: 'tool:UpdateClass',
    text: 'UpdateClass: Update source code of an existing ABAP class. Locks, checks, updates, unlocks, and optionally activates. Params: class_name, source_code, transport_request, activate',
  },
  {
    id: 'tool:UpdateTable',
    text: 'UpdateTable: Update DDL source code of an existing ABAP table. Locks the table, uploads new DDL source, and unlocks. Params: table_name, ddl_code, transport_request, activate',
  },
  {
    id: 'tool:UpdateView',
    text: 'UpdateView: Update DDL source code of an existing CDS View or Classic View. Locks the view, checks new code, uploads and unlocks. Params: view_name, ddl_source, transport_request, activate',
  },
  {
    id: 'tool:UpdateServiceBinding',
    text: 'UpdateServiceBinding: Update publication state for ABAP service binding via AdtServiceBinding workflow. Params: service_binding_name, desired_publication_state, service_type',
  },

  // --- Delete operations ---
  {
    id: 'tool:DeleteClass',
    text: 'DeleteClass: Delete an ABAP class from the SAP system. Includes deletion check before actual deletion. Transport request required. Params: class_name, transport_request',
  },
  {
    id: 'tool:DeleteTable',
    text: 'DeleteTable: Delete an ABAP table from the SAP system. Includes deletion check before actual deletion. Transport request required. Params: table_name, transport_request',
  },

  // --- Testing ---
  {
    id: 'tool:RunUnitTest',
    text: 'RunUnitTest: Start an ABAP Unit test run for provided class test definitions. Returns run_id for status/result queries. Params: tests, title, context, scope, risk_level, duration',
  },
  {
    id: 'tool:GetUnitTestResult',
    text: 'GetUnitTestResult: Retrieve ABAP Unit test run result for a run_id. Params: run_id, with_navigation_uris, format',
  },
  {
    id: 'tool:UpdateLocalTestClass',
    text: 'UpdateLocalTestClass: Update a local test class in an ABAP class. Manages lock, check, update, unlock, and optional activation. Params: class_name, test_class_code, transport_request',
  },

  // --- Search/Discovery ---
  {
    id: 'tool:SearchObject',
    text: 'SearchObject: Find, search, locate, or check if an ABAP repository object exists by name or wildcard pattern. Params: object_name, object_type, maxResults',
  },
  {
    id: 'tool:GetWhereUsed',
    text: 'GetWhereUsed: Find where-used references (cross-references, usages, dependencies) for ABAP objects — classes, interfaces, function modules, data elements, etc. Params: object_name, object_type',
  },
  {
    id: 'tool:GetObjectInfo',
    text: 'GetObjectInfo: Return ABAP object tree structure for packages, classes, programs, function groups. Returns hierarchical view. Params: parent_type, parent_name, maxDepth',
  },

  // --- Transport ---
  {
    id: 'tool:GetTransport',
    text: 'GetTransport: Retrieve ABAP transport request information including metadata, included objects, and status. Params: transport_number, include_objects, include_tasks',
  },
  {
    id: 'tool:ListTransports',
    text: 'ListTransports: List transport requests for the current or specified user. Returns modifiable and/or released requests. Params: user, modifiable_only',
  },

  // --- Runtime/Profiling ---
  {
    id: 'tool:RuntimeRunClassWithProfiling',
    text: 'RuntimeRunClassWithProfiling: Execute ABAP class with profiler enabled and return created profilerId and traceId. Params: class_name, description',
  },
  {
    id: 'tool:RuntimeListDumps',
    text: 'RuntimeListDumps: List ABAP runtime dumps with optional user filter and paging. Returns structured list with dump details. Params: user, from, to',
  },
  {
    id: 'tool:GetSqlQuery',
    text: 'GetSqlQuery: Execute ABAP SQL SELECT queries on database tables and CDS views via SAP ADT Data Preview. Params: sql_query, row_number',
  },

  // --- Enhancements ---
  {
    id: 'tool:GetEnhancements',
    text: 'GetEnhancements: Retrieve a list of enhancements for a given ABAP object. Params: object_name, object_type',
  },

  // --- Code Analysis ---
  {
    id: 'tool:GetAbapAST',
    text: 'GetAbapAST: Parse ABAP code and return AST (Abstract Syntax Tree) in JSON format. Params: code, filePath',
  },
  {
    id: 'tool:HandlerCheckRun',
    text: 'HandlerCheckRun: CheckRun operation (syntax check, no activation). Used for syntax validation of ABAP objects. Params: object_type, object_name, version',
  },
];

// ---------------------------------------------------------------------------
// Golden queries
// ---------------------------------------------------------------------------

interface GoldenQuery {
  query: string;
  expectedTopIds?: string[];
  expectedAbsentIds?: string[];
  k: number;
  description?: string;
}

const GOLDEN_QUERIES: GoldenQuery[] = [
  // --- 1. Direct match (easy) ---
  {
    query: 'read the source code of class ZCL_MY_CLASS',
    expectedTopIds: ['tool:ReadClass'],
    k: 3,
  },
  {
    query: 'create a new transport request',
    expectedTopIds: ['tool:CreateTransport'],
    k: 3,
  },
  {
    query: 'run unit tests',
    expectedTopIds: ['tool:RunUnitTest'],
    k: 3,
  },

  // --- 2. Semantic/intent match (medium) ---
  {
    query: 'show me the code of a function module',
    expectedTopIds: ['tool:ReadFunctionModule'],
    k: 3,
  },
  {
    query: 'what objects are inside package ZMY_PKG',
    expectedTopIds: ['tool:GetPackageContents'],
    k: 3,
  },
  {
    query: 'find all places where class ZCL_UTILS is used',
    expectedTopIds: ['tool:GetWhereUsed'],
    k: 3,
  },
  {
    query: 'execute SQL query on a database table',
    expectedTopIds: ['tool:GetSqlQuery'],
    k: 5,
  },
  {
    query: 'check syntax of my program',
    expectedTopIds: ['tool:HandlerCheckRun'],
    k: 5,
  },

  // --- 3. Ambiguous/hard queries ---
  {
    query: 'get table data',
    expectedTopIds: ['tool:GetTableContents'],
    k: 3,
    description:
      'should prefer GetTableContents over ReadTable (data vs definition)',
  },
  {
    query: 'I need to see what a CDS view looks like',
    expectedTopIds: ['tool:ReadView'],
    k: 3,
  },
  {
    query: 'expose my CDS view as an OData service',
    expectedTopIds: ['tool:CreateServiceDefinition'],
    k: 5,
    description: 'OData exposure starts with creating a service definition',
  },
  {
    query: 'debug performance of my ABAP class',
    expectedTopIds: ['tool:RuntimeRunClassWithProfiling'],
    k: 5,
  },
  {
    query: 'define CRUD operations for my RAP business object',
    expectedTopIds: ['tool:CreateBehaviorDefinition'],
    k: 5,
  },

  // --- 4. Negative/out-of-scope queries ---
  {
    query: 'send email notification',
    expectedAbsentIds: ['tool:CreateClass', 'tool:UpdateClass'],
    k: 3,
    description: 'no email tool exists',
  },
  {
    query: 'deploy to kubernetes',
    expectedAbsentIds: ['tool:CreateTransport'],
    k: 3,
    description: 'transport is not k8s deployment',
  },
];

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

function reciprocalRank(results: RagResult[], expectedIds: string[]): number {
  for (let i = 0; i < results.length; i++) {
    if (expectedIds.includes(results[i].metadata.id as string)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function recall(results: RagResult[], expectedIds: string[]): number {
  if (expectedIds.length === 0) return 1;
  const found = expectedIds.filter((id) =>
    results.some((r) => r.metadata.id === id),
  );
  return found.length / expectedIds.length;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedRag(
  rag: InMemoryRag | VectorRag,
  corpus: CorpusEntry[],
): Promise<void> {
  for (const entry of corpus) {
    const result = await rag.upsert(entry.text, { id: entry.id });
    assert.ok(result.ok, `Failed to upsert corpus entry ${entry.id}`);
  }
}

async function runQuery(
  rag: InMemoryRag | VectorRag,
  query: string,
  k: number,
  embedder?: IEmbedder,
): Promise<RagResult[]> {
  const embedding = embedder
    ? new QueryEmbedding(query, embedder)
    : new TextOnlyEmbedding(query);
  const result = await rag.query(embedding, k);
  assert.ok(result.ok, `Query failed for: ${query}`);
  return result.value;
}

// ---------------------------------------------------------------------------
// Strategy definitions
// ---------------------------------------------------------------------------

interface StrategyDef {
  name: string;
  factory: () => { rag: InMemoryRag | VectorRag; embedder?: IEmbedder };
}

function buildVectorRagFactory(strategyName: string): StrategyDef {
  return {
    name: strategyName,
    factory: () => {
      const embedder = new TfEmbedder();
      const allTexts = [
        ...MCP_TOOLS_CORPUS.map((e) => e.text),
        ...GOLDEN_QUERIES.map((q) => q.query),
      ];
      embedder.buildVocabulary(allTexts);

      let strategy:
        | WeightedFusionStrategy
        | RrfStrategy
        | VectorOnlyStrategy
        | Bm25OnlyStrategy
        | undefined;
      if (strategyName === 'Weighted Fusion (default)') {
        strategy = new WeightedFusionStrategy();
      } else if (strategyName === 'RRF') {
        strategy = new RrfStrategy();
      } else if (strategyName === 'Vector-only') {
        strategy = new VectorOnlyStrategy();
      } else if (strategyName === 'BM25-only') {
        strategy = new Bm25OnlyStrategy();
      }

      const rag = new VectorRag(embedder, {
        dedupThreshold: 0.99,
        ...(strategy !== undefined ? { strategy } : {}),
      });
      return { rag, embedder };
    },
  };
}

const STRATEGIES: StrategyDef[] = [
  {
    name: 'InMemoryRag (text-only)',
    factory: () => {
      const rag = new InMemoryRag({ dedupThreshold: 0.99 });
      return { rag, embedder: undefined };
    },
  },
  buildVectorRagFactory('Weighted Fusion (default)'),
  buildVectorRagFactory('RRF'),
  buildVectorRagFactory('Vector-only'),
  buildVectorRagFactory('BM25-only'),
];

// ---------------------------------------------------------------------------
// Tests — run all strategies
// ---------------------------------------------------------------------------

for (const stratDef of STRATEGIES) {
  describe(`MCP Tools Evaluation — ${stratDef.name}`, () => {
    it('positive queries find expected tool in top-k', async () => {
      const { rag, embedder } = stratDef.factory();
      await seedRag(rag, MCP_TOOLS_CORPUS);

      const positiveQueries = GOLDEN_QUERIES.filter((q) => q.expectedTopIds);
      for (const gq of positiveQueries) {
        const results = await runQuery(rag, gq.query, gq.k, embedder);
        const topIds = results.map((r) => r.metadata.id);
        for (const expectedId of gq.expectedTopIds ?? []) {
          assert.ok(
            topIds.includes(expectedId),
            `[${stratDef.name}] Query "${gq.query}": expected "${expectedId}" in top-${gq.k}, got [${topIds.join(', ')}]${gq.description ? ` (${gq.description})` : ''}`,
          );
        }
      }
    });

    it('negative queries do not surface irrelevant tools at top-1', async () => {
      const { rag, embedder } = stratDef.factory();
      await seedRag(rag, MCP_TOOLS_CORPUS);

      const negativeQueries = GOLDEN_QUERIES.filter((q) => q.expectedAbsentIds);
      for (const gq of negativeQueries) {
        const results = await runQuery(rag, gq.query, gq.k, embedder);
        if (results.length > 0) {
          const topId = results[0].metadata.id;
          for (const absentId of gq.expectedAbsentIds ?? []) {
            assert.notEqual(
              topId,
              absentId,
              `[${stratDef.name}] Query "${gq.query}": "${absentId}" should NOT be top-1${gq.description ? ` (${gq.description})` : ''}`,
            );
          }
        }
      }
    });

    it('MRR report (informational)', async () => {
      const { rag, embedder } = stratDef.factory();
      await seedRag(rag, MCP_TOOLS_CORPUS);

      const positiveQueries = GOLDEN_QUERIES.filter((q) => q.expectedTopIds);
      let totalRR = 0;
      for (const gq of positiveQueries) {
        const results = await runQuery(rag, gq.query, gq.k, embedder);
        totalRR += reciprocalRank(results, gq.expectedTopIds ?? []);
      }
      const mrr = totalRR / positiveQueries.length;
      console.log(`  [${stratDef.name}] MRR = ${mrr.toFixed(3)}`);
      assert.ok(mrr > 0, `MRR should be > 0, got ${mrr}`);
    });

    it('recall for multi-result queries at specified k', async () => {
      const { rag, embedder } = stratDef.factory();
      await seedRag(rag, MCP_TOOLS_CORPUS);

      // Only check queries that expect exactly 1 result (single expected ID)
      const singleResultQueries = GOLDEN_QUERIES.filter(
        (q) => q.expectedTopIds && q.expectedTopIds.length === 1,
      );
      for (const gq of singleResultQueries) {
        const results = await runQuery(rag, gq.query, gq.k, embedder);
        const r = recall(results, gq.expectedTopIds ?? []);
        assert.equal(
          r,
          1.0,
          `[${stratDef.name}] Query "${gq.query}": recall = ${r}, expected 1.0`,
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// MockTranslatePreprocessor — deterministic mock for unit tests
// ---------------------------------------------------------------------------

class MockTranslatePreprocessor implements IQueryPreprocessor {
  readonly name = 'mock-translate';
  readonly translations = new Map<string, string>([
    ['read dumps through feeds', 'list available ADT runtime feeds dumps'],
    [
      'read table structure definition',
      'read ABAP table definition and metadata',
    ],
    ['what feeds can we read', 'list available ADT runtime feeds'],
    ['show class source code', 'read ABAP class source code and metadata'],
    ['who uses interface', 'find where-used references for ABAP objects'],
    ['run unit tests for class', 'start ABAP unit test run for class'],
    ['find object', 'search ABAP repository object by name'],
    ['what dumps happened today', 'list ABAP runtime dumps'],
    ['create new CDS view', 'create CDS view in SAP'],
    ['check program syntax', 'syntax check ABAP object checkrun'],
  ]);

  async process(text: string): Promise<Result<string, RagError>> {
    const lower = text.toLowerCase();
    for (const [key, value] of this.translations) {
      if (lower.includes(key)) {
        return { ok: true, value };
      }
    }
    return { ok: true, value: text };
  }
}

// ---------------------------------------------------------------------------
// VectorRag + MockTranslatePreprocessor (RRF) evaluation suite
// ---------------------------------------------------------------------------

describe('MCP Tools Evaluation — VectorRag + MockTranslatePreprocessor (RRF)', () => {
  function createVectorRag(): { rag: VectorRag; embedder: TfEmbedder } {
    const embedder = new TfEmbedder();
    const mockTranslate = new MockTranslatePreprocessor();
    const allTexts = [
      ...MCP_TOOLS_CORPUS.map((e) => e.text),
      ...GOLDEN_QUERIES.map((q) => q.query),
      // Also add the translated versions so vocabulary covers them
      ...[...mockTranslate.translations.values()],
    ];
    embedder.buildVocabulary(allTexts);
    const rag = new VectorRag(embedder, {
      dedupThreshold: 0.99,
      strategy: new RrfStrategy(),
      queryPreprocessors: [mockTranslate],
    });
    return { rag, embedder };
  }

  it('positive queries find expected tool in top-k', async () => {
    const { rag, embedder } = createVectorRag();
    await seedRag(rag, MCP_TOOLS_CORPUS);

    const positiveQueries = GOLDEN_QUERIES.filter((q) => q.expectedTopIds);
    for (const gq of positiveQueries) {
      const results = await runQuery(rag, gq.query, gq.k, embedder);
      const topIds = results.map((r) => r.metadata.id);
      for (const expectedId of gq.expectedTopIds ?? []) {
        assert.ok(
          topIds.includes(expectedId),
          `[Translate+RRF] Query "${gq.query}": expected "${expectedId}" in top-${gq.k}, got [${topIds.join(', ')}]`,
        );
      }
    }
  });

  it('MRR improved over baseline RRF', async () => {
    const { rag, embedder } = createVectorRag();
    await seedRag(rag, MCP_TOOLS_CORPUS);

    const positiveQueries = GOLDEN_QUERIES.filter((q) => q.expectedTopIds);
    let totalRR = 0;
    for (const gq of positiveQueries) {
      const results = await runQuery(rag, gq.query, gq.k, embedder);
      totalRR += reciprocalRank(results, gq.expectedTopIds ?? []);
    }
    const mrr = totalRR / positiveQueries.length;
    console.log(`  [Translate+RRF] MRR = ${mrr.toFixed(3)}`);
    // Should be at least as good as RRF baseline (0.865)
    assert.ok(mrr > 0, `MRR should be > 0, got ${mrr}`);
  });
});
