import type {
  ISkillSource,
  SkillGroupInfo,
  SkillIngestResult,
  SkillRecord,
} from '@mcp-abap-adt/llm-agent';

// Two collections; v1 has 5 records total, v2 has 6 (alpha gains one + edits one).
export const V1_POINTS = 5;
export const V2_POINTS = 6;
export const SOURCE_ID = 'itest';

const COLLECTIONS: SkillGroupInfo[] = [
  { group: 'alpha', description: 'Alpha test skills', collection: 'alpha' },
  { group: 'beta', description: 'Beta test skills', collection: 'beta' },
];

function rec(group: string, slug: string, text: string, body: string): SkillRecord {
  return {
    id: `${SOURCE_ID}:itest@1.0.0/${slug}#0`,
    sourceId: SOURCE_ID,
    group,
    name: `itest/${slug}`,
    retrievalText: text,
    content: body,
    provenance: `itest@1.0.0/${slug}#main`,
  };
}

function v1Records(): SkillRecord[] {
  return [
    rec('alpha', 'open-file', 'how to open and read a file', 'Open the file, then read its bytes.'),
    rec('alpha', 'list-dir', 'how to list a directory', 'List directory entries by name.'),
    rec('alpha', 'delete-file', 'how to delete a file safely', 'Confirm, then remove the file.'),
    rec('beta', 'parse-json', 'how to parse JSON text', 'Parse the JSON string into an object.'),
    rec('beta', 'format-date', 'how to format a date', 'Format the date as ISO-8601.'),
  ];
}

function v2Records(): SkillRecord[] {
  return [
    // edited retrievalText on open-file:
    rec('alpha', 'open-file', 'how to open, read, and close a file', 'Open the file, read its bytes, then close it.'),
    rec('alpha', 'list-dir', 'how to list a directory', 'List directory entries by name.'),
    rec('alpha', 'delete-file', 'how to delete a file safely', 'Confirm, then remove the file.'),
    // new record in alpha:
    rec('alpha', 'copy-file', 'how to copy a file', 'Copy the source file to the destination.'),
    rec('beta', 'parse-json', 'how to parse JSON text', 'Parse the JSON string into an object.'),
    rec('beta', 'format-date', 'how to format a date', 'Format the date as ISO-8601.'),
  ];
}

/** Mutable source: flip between v1 and v2 to drive the reload/retirement case. */
export function makeRevisionedSource(): ISkillSource & { setRevision(v: 'v1' | 'v2'): void } {
  let revision: 'v1' | 'v2' = 'v1';
  return {
    setRevision(v) {
      revision = v;
    },
    async acquire(): Promise<SkillIngestResult> {
      return {
        collections: COLLECTIONS,
        records: revision === 'v1' ? v1Records() : v2Records(),
      };
    },
  };
}
