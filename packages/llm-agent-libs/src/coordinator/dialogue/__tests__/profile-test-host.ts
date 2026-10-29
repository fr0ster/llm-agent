import type {
  IAgentProfileRunner,
  IAgentProfileSource,
  ISubAgent,
  WorkerProfile,
} from '@mcp-abap-adt/llm-agent';

/** Exact-name host adapter for test workers; arbitrary verdict names use explicit roles. */
export function profileHost(workers: ReadonlyMap<string, ISubAgent>): {
  profileSource: IAgentProfileSource;
  profileRunner: IAgentProfileRunner;
} {
  const records: WorkerProfile[] = [...workers].map(([name, agent]) => ({
    name,
    description: agent.description ?? name,
    result: name === 'audit' || name === 'review' ? 'verdict' : 'report',
    systemPrompt: '',
    tools: 'all',
  }));
  return {
    profileSource: {
      async list() {
        return { ok: true, value: records };
      },
      async get(name) {
        const record = records.find((record) => record.name === name);
        return record
          ? { ok: true, value: record }
          : { ok: false, error: { code: 'missing', message: name } };
      },
      async getPrompts() {
        return { ok: true, value: {} };
      },
    },
    profileRunner: {
      async createWorker({ profile }) {
        const agent = workers.get(profile.name);
        return agent
          ? { ok: true, value: agent }
          : { ok: false, error: { code: 'missing', message: profile.name } };
      },
      async preparePlanner() {
        return {
          ok: false,
          error: {
            code: 'unavailable',
            message: 'No planner in worker fixture',
          },
        };
      },
    },
  };
}
