import type { HanaClient } from '../hana-vector-rag.js';

/**
 * A HANA client that stores the rows of the `shared` layout's two tables and
 * evaluates the statements HanaVectorRag and HanaVectorRagProvider emit for
 * it the way HANA does: an unquoted identifier is folded to upper case and a
 * quoted one is taken as written, so a column or table spelled in the wrong
 * case is an "invalid column/table name" here as it is there; the startup
 * check's SELECTs against SYS.TABLES and SYS.TABLE_COLUMNS find both tables,
 * with the configured vector dimension; `COSINE_SIMILARITY` scores, `ORDER BY
 * ... DESC` and `LIMIT` cut; `UPSERT ... WITH PRIMARY KEY` replaces by the
 * key and `INSERT` refuses a second row for one. It parses only the shapes
 * those statements use — `SELECT [DISTINCT] ... FROM ... [WHERE a = b | a > b | a IN (?, ...)
 * AND ...] [ORDER BY ...] [LIMIT n]`, `UPSERT`, `INSERT INTO`, `DELETE FROM`, `UPDATE ... SET c = [COALESCE(?, c)] ... WHERE` — and
 * throws on anything else, DDL included, so a store change that emits new SQL
 * fails loudly here instead of being silently mis-evaluated.
 */
export interface StoringHana {
  readonly client: HanaClient;
  /** Every statement received, in order. */
  readonly statements: string[];
  /** Orphan setup: a row written past the store; `table` as HANA names it. */
  insertRow(table: string, row: Record<string, Value>): void;
  /** Setup: the table a `per-collection` store reads and writes, as its owner created it. */
  createCollectionTable(name: string): void;
}

export type Value = string | number | null | number[];
type Row = Record<string, Value>;

interface Table {
  columns: string[];
  key: string[];
  /** Declared length of a column (the `REAL_VECTOR` dimension). */
  lengths: Record<string, number>;
  rows: Row[];
}

// --------------------------------------------------------------------------
// Tokens
// --------------------------------------------------------------------------

type Token =
  | { kind: 'word'; text: string }
  | { kind: 'quoted'; text: string }
  | { kind: 'string'; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'punct'; text: string };

function tokenize(sql: string): Token[] {
  // TO_BINARY preserves the fake's existing binary string comparison on ids.
  sql = sql.replace(/TO_BINARY\(("ID"|\?)\)/g, '$1');
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end === -1) throw unsupported(sql);
      out.push({ kind: 'quoted', text: sql.slice(i + 1, end) });
      i = end + 1;
    } else if (ch === "'") {
      let text = '';
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw unsupported(sql);
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            text += "'";
            j += 2;
            continue;
          }
          break;
        }
        text += sql[j++];
      }
      out.push({ kind: 'string', text });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
      const text = m ? m[0] : ch;
      out.push({ kind: 'word', text });
      i += text.length;
    } else if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+/.exec(sql.slice(i));
      const text = m ? m[0] : ch;
      out.push({ kind: 'number', text });
      i += text.length;
    } else if ('(),.*=?>'.includes(ch)) {
      out.push({ kind: 'punct', text: ch });
      i++;
    } else {
      throw unsupported(sql);
    }
  }
  return out;
}

function unsupported(sql: string): Error {
  return new Error(`storing-hana: unsupported statement: ${sql.slice(0, 100)}`);
}

// --------------------------------------------------------------------------
// Parser
// --------------------------------------------------------------------------

type Operand =
  | { kind: 'column'; name: string }
  | { kind: 'param'; index: number }
  | { kind: 'currentSchema' }
  | { kind: 'literal'; value: Value };

type Expr =
  | { kind: 'column'; name: string }
  | { kind: 'count' }
  | { kind: 'cosine'; column: string; vector: number[] }
  | { kind: 'literal'; value: Value };

type Projection = { expr: Expr; alias?: string };
type Condition =
  | { kind: 'cmp'; op: '=' | '>'; left: Operand; right: Operand }
  | { kind: 'in'; left: Operand; items: Operand[] };
type TableRef = { schema?: string; name: string };

type Statement =
  | {
      kind: 'select';
      distinct: boolean;
      projections: Projection[];
      from: TableRef;
      where: Condition[];
      orderBy?: { name: string; desc: boolean };
      limit?: number;
    }
  | {
      kind: 'upsert' | 'insert';
      table: TableRef;
      columns: string[];
      values: Operand[];
    }
  | { kind: 'delete'; table: TableRef; where: Condition[] }
  | {
      kind: 'update';
      table: TableRef;
      sets: Array<{ column: string; value: Operand; fallback?: Operand }>;
      where: Condition[];
    };

class Parser {
  private pos = 0;
  private params = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly sql: string,
  ) {}

  parse(): Statement {
    const stmt = this.statement();
    if (this.pos !== this.tokens.length) throw unsupported(this.sql);
    return stmt;
  }

  private statement(): Statement {
    if (this.acceptWord('SELECT')) return this.select();
    if (this.acceptWord('UPSERT')) {
      const table = this.tableRef();
      const { columns, values } = this.columnsAndValues();
      this.expectWord('WITH');
      this.expectWord('PRIMARY');
      this.expectWord('KEY');
      return { kind: 'upsert', table, columns, values };
    }
    if (this.acceptWord('INSERT')) {
      this.expectWord('INTO');
      const table = this.tableRef();
      return { kind: 'insert', table, ...this.columnsAndValues() };
    }
    if (this.acceptWord('UPDATE')) {
      const table = this.tableRef();
      this.expectWord('SET');
      const sets: Array<{
        column: string;
        value: Operand;
        fallback?: Operand;
      }> = [];
      do {
        const column = this.identifier();
        this.expectPunct('=');
        if (this.acceptWord('COALESCE')) {
          this.expectPunct('(');
          const value = this.operand();
          this.expectPunct(',');
          const fallback = this.operand();
          this.expectPunct(')');
          sets.push({ column, value, fallback });
        } else {
          sets.push({ column, value: this.operand() });
        }
      } while (this.acceptPunct(','));
      return { kind: 'update', table, sets, where: this.where() };
    }
    if (this.acceptWord('DELETE')) {
      this.expectWord('FROM');
      const table = this.tableRef();
      return { kind: 'delete', table, where: this.where() };
    }
    throw unsupported(this.sql);
  }

  private select(): Statement {
    const distinct = this.acceptWord('DISTINCT');
    const projections: Projection[] = [];
    do {
      const expr = this.expr();
      const alias = this.acceptWord('AS') ? this.identifier() : undefined;
      projections.push({ expr, alias });
    } while (this.acceptPunct(','));
    this.expectWord('FROM');
    const from = this.tableRef();
    const where = this.where();
    let orderBy: { name: string; desc: boolean } | undefined;
    if (this.acceptWord('ORDER')) {
      this.expectWord('BY');
      const name = this.identifier();
      const desc = this.acceptWord('DESC');
      if (!desc) this.acceptWord('ASC');
      orderBy = { name, desc };
    }
    let limit: number | undefined;
    if (this.acceptWord('LIMIT')) limit = Number(this.expect('number').text);
    return {
      kind: 'select',
      distinct,
      projections,
      from,
      where,
      orderBy,
      limit,
    };
  }

  private where(): Condition[] {
    const conditions: Condition[] = [];
    if (!this.acceptWord('WHERE')) return conditions;
    do {
      const left = this.operand();
      if (this.acceptWord('IN')) {
        this.expectPunct('(');
        const items: Operand[] = [];
        do items.push(this.operand());
        while (this.acceptPunct(','));
        this.expectPunct(')');
        conditions.push({ kind: 'in', left, items });
      } else if (this.acceptPunct('>')) {
        conditions.push({ kind: 'cmp', op: '>', left, right: this.operand() });
      } else {
        this.expectPunct('=');
        conditions.push({ kind: 'cmp', op: '=', left, right: this.operand() });
      }
    } while (this.acceptWord('AND'));
    return conditions;
  }

  private columnsAndValues(): { columns: string[]; values: Operand[] } {
    this.expectPunct('(');
    const columns: string[] = [];
    do columns.push(this.identifier());
    while (this.acceptPunct(','));
    this.expectPunct(')');
    this.expectWord('VALUES');
    this.expectPunct('(');
    const values: Operand[] = [];
    do values.push(this.value());
    while (this.acceptPunct(','));
    this.expectPunct(')');
    if (columns.length !== values.length) throw unsupported(this.sql);
    return { columns, values };
  }

  private value(): Operand {
    if (this.peekWord('TO_REAL_VECTOR'))
      return { kind: 'literal', value: this.vectorLiteral() };
    if (this.acceptWord('NULL')) return { kind: 'literal', value: null };
    return this.operand();
  }

  private operand(): Operand {
    if (this.acceptPunct('?')) return { kind: 'param', index: this.params++ };
    if (this.acceptWord('CURRENT_SCHEMA')) return { kind: 'currentSchema' };
    const t = this.tokens[this.pos];
    if (t?.kind === 'string') {
      this.pos++;
      return { kind: 'literal', value: t.text };
    }
    if (t?.kind === 'number') {
      this.pos++;
      return { kind: 'literal', value: Number(t.text) };
    }
    return { kind: 'column', name: this.identifier() };
  }

  private expr(): Expr {
    if (this.acceptWord('COUNT')) {
      this.expectPunct('(');
      this.expectPunct('*');
      this.expectPunct(')');
      return { kind: 'count' };
    }
    if (this.acceptWord('COSINE_SIMILARITY')) {
      this.expectPunct('(');
      const column = this.identifier();
      this.expectPunct(',');
      const vector = this.vectorLiteral();
      this.expectPunct(')');
      return { kind: 'cosine', column, vector };
    }
    const t = this.tokens[this.pos];
    if (t?.kind === 'number') {
      this.pos++;
      return { kind: 'literal', value: Number(t.text) };
    }
    return { kind: 'column', name: this.identifier() };
  }

  private vectorLiteral(): number[] {
    this.expectWord('TO_REAL_VECTOR');
    this.expectPunct('(');
    const text = this.expect('string').text;
    this.expectPunct(')');
    const m = /^\[(.*)\]$/.exec(text);
    if (!m) throw unsupported(this.sql);
    return m[1] === '' ? [] : m[1].split(',').map(Number);
  }

  private tableRef(): TableRef {
    const first = this.identifier();
    if (this.acceptPunct('.'))
      return { schema: first, name: this.identifier() };
    return { name: first };
  }

  /** HANA's rule: an unquoted identifier is upper case, a quoted one is as written. */
  private identifier(): string {
    const t = this.tokens[this.pos];
    if (t?.kind === 'quoted') {
      this.pos++;
      return t.text;
    }
    if (t?.kind === 'word') {
      this.pos++;
      return t.text.toUpperCase();
    }
    throw unsupported(this.sql);
  }

  private peekWord(word: string): boolean {
    const t = this.tokens[this.pos];
    return t?.kind === 'word' && t.text.toUpperCase() === word;
  }

  private acceptWord(word: string): boolean {
    if (!this.peekWord(word)) return false;
    this.pos++;
    return true;
  }

  private expectWord(word: string): void {
    if (!this.acceptWord(word)) throw unsupported(this.sql);
  }

  private acceptPunct(p: string): boolean {
    const t = this.tokens[this.pos];
    if (t?.kind !== 'punct' || t.text !== p) return false;
    this.pos++;
    return true;
  }

  private expectPunct(p: string): void {
    if (!this.acceptPunct(p)) throw unsupported(this.sql);
  }

  private expect(kind: Token['kind']): Token {
    const t = this.tokens[this.pos];
    if (t?.kind !== kind) throw unsupported(this.sql);
    this.pos++;
    return t;
  }
}

// --------------------------------------------------------------------------
// Evaluation
// --------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length)
    throw new Error(
      `storing-hana: COSINE_SIMILARITY of vectors of length ${a.length} and ${b.length}`,
    );
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * `dimension`: the `REAL_VECTOR` length the documents table is deployed with.
 * `schema`: the connection's current schema, where both tables live.
 */
export function storingHana(opts: {
  dimension: number;
  database?: string;
  schema?: string;
  documentsTable?: string;
  catalogTable?: string;
}): StoringHana {
  const schema = opts.schema ?? 'APP';
  const tables = new Map<string, Table>([
    [
      `${schema}.${opts.documentsTable ?? 'RAG_DOCUMENTS'}`,
      {
        columns: [
          'COLLECTION',
          'ID',
          'TEXT',
          'VECTOR',
          'METADATA',
          'CREATED_AT',
        ],
        key: ['COLLECTION', 'ID'],
        lengths: { COLLECTION: 63, ID: 255, VECTOR: opts.dimension },
        rows: [],
      },
    ],
    [
      `${schema}.${opts.catalogTable ?? 'RAG_COLLECTIONS'}`,
      {
        columns: [
          'STORE_NAME',
          'COLLECTION_NAME',
          'SCOPE',
          'USER_ID',
          'SESSION_ID',
          'ATTRIBUTES_JSON',
          'CREATED_AT',
        ],
        key: ['STORE_NAME'],
        lengths: { STORE_NAME: 63, COLLECTION_NAME: 5000, SCOPE: 16 },
        rows: [],
      },
    ],
  ]);

  /** The system views the startup check reads, derived from the tables. */
  const systemView = (name: string): Table | undefined => {
    const all = [...tables.entries()].map(([k, t]) => {
      const dot = k.indexOf('.');
      return { schema: k.slice(0, dot), name: k.slice(dot + 1), table: t };
    });
    if (name === 'TABLES')
      return {
        columns: ['SCHEMA_NAME', 'TABLE_NAME'],
        key: [],
        lengths: {},
        rows: all.map((t) => ({ SCHEMA_NAME: t.schema, TABLE_NAME: t.name })),
      };
    if (name === 'TABLE_COLUMNS')
      return {
        columns: ['SCHEMA_NAME', 'TABLE_NAME', 'COLUMN_NAME', 'LENGTH'],
        key: [],
        lengths: {},
        rows: all.flatMap((t) =>
          t.table.columns.map((c) => ({
            SCHEMA_NAME: t.schema,
            TABLE_NAME: t.name,
            COLUMN_NAME: c,
            LENGTH: t.table.lengths[c] ?? null,
          })),
        ),
      };
    return undefined;
  };

  const resolve = (ref: TableRef): Table => {
    if (ref.schema === 'SYS') {
      const view = systemView(ref.name);
      if (view) return view;
    }
    if (ref.schema === undefined && ref.name === 'DUMMY')
      return {
        columns: ['DUMMY'],
        key: [],
        lengths: {},
        rows: [{ DUMMY: 'X' }],
      };
    const table = tables.get(`${ref.schema ?? schema}.${ref.name}`);
    if (!table)
      throw new Error(
        `storing-hana: invalid table name: ${ref.schema ?? schema}.${ref.name}`,
      );
    return table;
  };

  const column = (table: Table, name: string): string => {
    if (!table.columns.includes(name))
      throw new Error(`storing-hana: invalid column name: ${name}`);
    return name;
  };

  const operandValue = (
    op: Operand,
    table: Table,
    row: Row | undefined,
    params: readonly unknown[],
  ): Value => {
    switch (op.kind) {
      case 'param': {
        if (op.index >= params.length)
          throw new Error('storing-hana: not all parameters bound');
        return params[op.index] as Value;
      }
      case 'currentSchema':
        return schema;
      case 'literal':
        return op.value;
      case 'column': {
        if (!row) throw new Error('storing-hana: column in VALUES');
        return row[column(table, op.name)] ?? null;
      }
    }
  };

  /** Binary string order, as HANA compares NVARCHAR. */
  const compare = (x: Value, y: Value): number =>
    typeof x === 'number' && typeof y === 'number'
      ? x - y
      : String(x) < String(y)
        ? -1
        : String(x) > String(y)
          ? 1
          : 0;

  /** SQL comparison: NULL compares with nothing. */
  const matches = (
    table: Table,
    row: Row,
    where: Condition[],
    params: readonly unknown[],
  ): boolean =>
    where.every((c) => {
      const l = operandValue(c.left, table, row, params);
      if (l === null) return false;
      if (c.kind === 'in')
        return c.items.some((item) => {
          const r = operandValue(item, table, row, params);
          return r !== null && String(l) === String(r);
        });
      const r = operandValue(c.right, table, row, params);
      if (r === null) return false;
      return c.op === '>' ? compare(l, r) > 0 : String(l) === String(r);
    });

  const keyOf = (table: Table, row: Row): string =>
    JSON.stringify(table.key.map((k) => row[k] ?? null));

  const toRow = (table: Table, given: Record<string, Value>): Row => {
    const row: Row = {};
    for (const c of table.columns) row[c] = null;
    for (const [c, v] of Object.entries(given)) row[column(table, c)] = v;
    if (row.CREATED_AT === null && table.columns.includes('CREATED_AT'))
      row.CREATED_AT = new Date().toISOString();
    const dim = table.lengths.VECTOR;
    if (dim !== undefined && row.VECTOR !== null) {
      if (!Array.isArray(row.VECTOR) || row.VECTOR.length !== dim)
        throw new Error(
          `storing-hana: inserted value of VECTOR does not match REAL_VECTOR(${dim})`,
        );
    }
    for (const k of table.key)
      if (row[k] === null)
        throw new Error(`storing-hana: cannot insert NULL into ${k}`);
    return row;
  };

  const write = (table: Table, row: Row, mode: 'insert' | 'upsert'): void => {
    const key = keyOf(table, row);
    const at = table.rows.findIndex((r) => keyOf(table, r) === key);
    if (at === -1) {
      table.rows.push(row);
      return;
    }
    if (mode === 'insert')
      throw new Error('storing-hana: unique constraint violated');
    table.rows[at] = row;
  };

  const select = (
    stmt: Extract<Statement, { kind: 'select' }>,
    params: readonly unknown[],
  ): Row[] => {
    const table = resolve(stmt.from);
    const source = table.rows.filter((r) =>
      matches(table, r, stmt.where, params),
    );
    const name = (p: Projection, i: number): string =>
      p.alias ??
      (p.expr.kind === 'column' ? p.expr.name : `COLUMN_${String(i)}`);
    if (stmt.projections.some((p) => p.expr.kind === 'count')) {
      if (stmt.projections.length !== 1 || stmt.orderBy || stmt.distinct)
        throw new Error('storing-hana: unsupported aggregate');
      return [{ [name(stmt.projections[0], 0)]: source.length }];
    }
    let pairs = source.map((r) => {
      const out: Row = {};
      stmt.projections.forEach((p, i) => {
        const e = p.expr;
        out[name(p, i)] =
          e.kind === 'column'
            ? (r[column(table, e.name)] ?? null)
            : e.kind === 'literal'
              ? e.value
              : e.kind === 'cosine'
                ? cosineSimilarity(
                    r[column(table, e.column)] as number[],
                    e.vector,
                  )
                : null;
      });
      return { source: r, out };
    });
    if (stmt.distinct) {
      const seen = new Set<string>();
      pairs = pairs.filter((p) => {
        const k = JSON.stringify(p.out);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    const order = stmt.orderBy;
    if (order) {
      const value = (p: { source: Row; out: Row }): Value =>
        order.name in p.out
          ? p.out[order.name]
          : (p.source[column(table, order.name)] ?? null);
      pairs.sort((a, b) => {
        const x = value(a);
        const y = value(b);
        const cmp = compare(x, y);
        return order.desc ? -cmp : cmp;
      });
    }
    const rows = pairs.map((p) => p.out);
    return stmt.limit === undefined ? rows : rows.slice(0, stmt.limit);
  };

  /** Rows for a SELECT; the affected-row count for DML. */
  const run = (
    sql: string,
    params: readonly unknown[],
  ): { rows: Row[]; rowCount: number } => {
    statements.push(sql);
    const clearTable = sql.match(
      /^(TRUNCATE TABLE|DROP TABLE(?: IF EXISTS)?) "([^"]+)"$/,
    );
    if (clearTable) {
      const table = resolve({ name: clearTable[2] });
      table.rows = [];
      if (clearTable[1].startsWith('DROP TABLE'))
        tables.delete(`${schema}.${clearTable[2]}`);
      return { rows: [], rowCount: 0 };
    }
    const stmt = new Parser(tokenize(sql), sql).parse();
    switch (stmt.kind) {
      case 'select': {
        const rows = select(stmt, params);
        return { rows, rowCount: rows.length };
      }
      case 'insert':
      case 'upsert': {
        const table = resolve(stmt.table);
        const given: Record<string, Value> = {};
        stmt.columns.forEach((c, i) => {
          given[c] = operandValue(stmt.values[i], table, undefined, params);
        });
        write(table, toRow(table, given), stmt.kind);
        return { rows: [], rowCount: 1 };
      }
      case 'update': {
        const table = resolve(stmt.table);
        let n = 0;
        for (const r of table.rows) {
          if (!matches(table, r, stmt.where, params)) continue;
          const next: Row = { ...r };
          for (const set of stmt.sets) {
            const v = operandValue(set.value, table, r, params);
            next[column(table, set.column)] =
              set.fallback && v === null
                ? operandValue(set.fallback, table, r, params)
                : v;
          }
          // Key columns are never set here; a changed key would need a re-check.
          for (const k of table.key)
            if (next[k] !== r[k])
              throw new Error('storing-hana: UPDATE of a key column');
          Object.assign(r, next);
          n++;
        }
        return { rows: [], rowCount: n };
      }
      case 'delete': {
        const table = resolve(stmt.table);
        const before = table.rows.length;
        table.rows = table.rows.filter(
          (r) => !matches(table, r, stmt.where, params),
        );
        return { rows: [], rowCount: before - table.rows.length };
      }
    }
  };

  const statements: string[] = [];
  return {
    statements,
    client: {
      async exec(sql, params = []) {
        return { rowCount: run(sql, params).rowCount };
      },
      async query(sql, params = []) {
        if (sql.includes('AS "listDatabase"')) {
          statements.push(sql);
          return [
            {
              listDatabase: opts.database ?? 'catalog_a',
              listHost: 'localhost',
              listSchema: schema,
            },
          ];
        }
        return run(sql, params).rows;
      },
      async close() {},
    },
    createCollectionTable(name) {
      tables.set(`${schema}.${name}`, {
        columns: ['ID', 'TEXT', 'VECTOR', 'METADATA', 'CREATED_AT'],
        key: ['ID'],
        lengths: { ID: 255, VECTOR: opts.dimension },
        rows: [],
      });
    },
    insertRow(table, row) {
      const t = resolve({ name: table });
      write(t, toRow(t, row), 'insert');
    },
  };
}
