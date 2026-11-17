import type { Message } from '@mcp-abap-adt/llm-agent';

/** JSON signatures survive serialization; following copies distinguish repeats. */
export interface ControlMessageAnchor {
  key: string;
  following: number;
}

/** Keep durable corrections between the same tool rounds across resumes. */
export class ControllerControlHistory {
  constructor(
    private readonly messages: Message[],
    private readonly anchors: Array<ControlMessageAnchor | null>,
    private readonly prefixLength: number,
  ) {}

  append(preceding: Message[], message: Message): void {
    this.anchors.push(this.anchor(preceding));
    this.messages.push(message);
  }

  record(messages: Message[]): void {
    for (const anchor of this.anchors) {
      if (!anchor) continue;
      anchor.following += messages.filter(
        (message) => JSON.stringify(message) === anchor.key,
      ).length;
    }
  }

  /** Old bundles stored only a tail. Anchor it before recording newer rounds. */
  migrate(formed: Message[]): void {
    const preceding = [...formed];
    for (const [index, message] of this.messages.entries()) {
      if (index >= this.anchors.length)
        this.anchors.push(this.anchor(preceding));
      preceding.push(message);
    }
  }

  restore(formed: Message[]): Message[] {
    const out = [...formed];
    let earliest = this.prefixLength;
    for (const [index, message] of this.messages.entries()) {
      const anchor = this.anchors[index];
      let insertAt = earliest;
      if (anchor) {
        const matches = out.flatMap((candidate, position) =>
          JSON.stringify(candidate) === anchor.key ? [position] : [],
        );
        const position = matches[matches.length - anchor.following - 1];
        if (position !== undefined) insertAt = Math.max(earliest, position + 1);
      }
      // An explicitly selected strategy may omit the predecessor. Keep the
      // correction before its newer retained rounds and after earlier corrections.
      out.splice(insertAt, 0, message);
      earliest = insertAt + 1;
    }
    return out;
  }

  private anchor(preceding: Message[]): ControlMessageAnchor | null {
    if (preceding.length <= this.prefixLength) return null;
    const key = JSON.stringify(preceding[preceding.length - 1]);
    return { key, following: 0 };
  }
}
