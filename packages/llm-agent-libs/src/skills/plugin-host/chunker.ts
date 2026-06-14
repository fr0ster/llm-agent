import type { SkillRecord } from '@mcp-abap-adt/llm-agent';

export interface SkillIdentity {
  source: string;
  plugin: string;
  version: string;
  skill: string;
  group: string;
  description: string;
  body: string;
}

/** Split a skill body into bounded chunks by top-level H2; over-long sections split on blank
 *  lines, bounded to maxChars. Each chunk → a SkillRecord with a deterministic id and a
 *  DISTINCT retrievalText (description + heading + chunk content). FS-free, pure. */
export function chunkSkill(
  s: SkillIdentity,
  opts: { maxChars: number },
): SkillRecord[] {
  const sections = splitByH2(s.body);
  const out: SkillRecord[] = [];
  let ix = 0;
  for (const sec of sections) {
    for (const piece of boundSection(sec.content, opts.maxChars)) {
      out.push({
        id: `${s.source}:${s.plugin}@${s.version}/${s.skill}#${ix}`,
        sourceId: s.source,
        group: s.group,
        name: sec.heading
          ? `${s.plugin}/${s.skill}#${sec.heading}`
          : `${s.plugin}/${s.skill}`,
        retrievalText: `${s.description}\n## ${sec.heading ?? s.skill}\n${piece}`,
        content: piece,
        provenance: `${s.plugin}@${s.version}/${s.skill}#${sec.heading ?? ''}`,
      });
      ix++;
    }
  }
  return out;
}

function splitByH2(body: string): Array<{ heading?: string; content: string }> {
  const lines = body.split('\n');
  const out: Array<{ heading?: string; content: string }> = [];
  let cur: { heading?: string; content: string } | null = null;
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { heading: m[1].trim(), content: '' };
    } else if (line.startsWith('# ')) {
      if (!cur) cur = { content: '' }; // top-level title → preamble section
    } else {
      if (!cur) cur = { content: '' };
      cur.content += (cur.content ? '\n' : '') + line;
    }
  }
  if (cur) out.push(cur);
  return out.filter((sec) => sec.content.trim().length > 0 || sec.heading);
}

function boundSection(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) return [content];
  const paras = content.split(/\n\s*\n/);
  const out: string[] = [];
  let buf = '';
  for (const p of paras) {
    if (`${buf}\n\n${p}`.length > maxChars && buf) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) out.push(buf);
  return out.flatMap((sec) =>
    sec.length <= maxChars
      ? [sec]
      : (sec.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g')) ?? [sec]),
  );
}
