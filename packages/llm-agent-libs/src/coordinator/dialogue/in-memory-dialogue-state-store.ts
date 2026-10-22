import type {
  DialogueState,
  IDialogueStateStore,
} from '@mcp-abap-adt/llm-agent';

export class InMemoryDialogueStateStore implements IDialogueStateStore {
  private readonly states = new Map<string, DialogueState>();
  async load(id: string): Promise<DialogueState | undefined> {
    const state = this.states.get(id);
    return state && structuredClone(state);
  }
  async save(id: string, state: DialogueState): Promise<void> {
    this.states.set(id, structuredClone(state));
  }
  async delete(id: string): Promise<void> {
    this.states.delete(id);
  }
}
