import { CopilotProvider } from '../src/index.js';

const apiKey = process.env.COPILOT_TOKEN;
if (!apiKey) throw new Error('Set COPILOT_TOKEN before running the probe');

const llm = new CopilotProvider();
try {
  const models = await llm.getModels({ apiKey });
  if (!models.ok) throw models.error;
  if (!models.value.length) throw new Error('No Copilot models returned');

  const first = await llm.chat(
    [
      {
        role: 'user',
        content: 'Remember the code TULIP-24 and reply with OK.',
      },
    ],
    [],
    { apiKey },
  );
  if (!first.ok) throw first.error;

  const second = await llm.chat(
    [
      {
        role: 'user',
        content:
          'What code did I ask you to remember? Reply UNKNOWN if no code is available.',
      },
    ],
    [],
    { apiKey },
  );
  if (!second.ok) throw second.error;
  if (second.value.content.includes('TULIP-24'))
    throw new Error('The second turn still sees the first turn');

  const tools = [
    {
      name: 'lookup_code',
      description: 'Returns the secret code of a project.',
      inputSchema: {
        type: 'object',
        properties: { project: { type: 'string' } },
        required: ['project'],
      },
    },
  ];
  const ask = {
    role: 'user' as const,
    content: 'Use lookup_code for project "rose" and tell me the code.',
  };
  const request = await llm.chat([ask], tools, { apiKey });
  if (!request.ok) throw request.error;
  const call = request.value.toolCalls?.[0];
  if (request.value.finishReason !== 'tool_calls' || !call)
    throw new Error('No tool call on the tool turn');
  const answer = await llm.chat(
    [
      ask,
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: call.id, content: 'ORCHID-7' },
    ],
    tools,
    { apiKey },
  );
  if (!answer.ok) throw answer.error;
  if (!answer.value.content.includes('ORCHID-7'))
    throw new Error('The tool result did not reach the answer');
  console.log(
    `Copilot probe passed with ${models.value.length} available models`,
  );
} finally {
  await llm.dispose();
}
