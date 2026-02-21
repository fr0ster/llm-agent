# Streaming та ітеративний Tool Loop: аналіз

## Де приймається рішення

Streaming — це рішення pipeline, а не архітектури. Pipeline визначає:
- **Чи використовувати streaming** — деякі сценарії (batch, внутрішні виклики) не потребують streaming взагалі
- **Який тип streaming** — текстові chunks, типізовані події, або комбінація
- **Що стримити** — лише фінальний текст, або також tool call events і subprompt-рівні відповіді

SSE вже є в стеку через MCP транспорт. OpenAI-compatible протокол визначає формат: відправляєш готовий chunk, закриваєш з'єднання коли все завершено. Pipeline просто вирішує, що і коли кидати в цей потік.

---

## Суть проблеми

В ітеративному tool loop агент не знає наперед, яка ітерація буде останньою. Кожна відповідь LLM може містити `tool_call` (цикл продовжується) або фінальний текст (цикл завершується). Питання: що і коли стримити?

```
Iteration 1: LLM → tool_call("search", {...})
Iteration 2: LLM → tool_call("read_file", {...})
Iteration 3: LLM → "Ось результат: ..."   ← тільки тут є що стримити?
```

**Важливо:** паралельність виконання tool calls не вирішує цю проблему. Tool loop є послідовним — кожен наступний виклик LLM залежить від результату попереднього. Паралелізувати можна кілька `tool_call` в межах однієї відповіді LLM, але не самі ітерації.

## Чому це не архітектурний конфлікт

Протокол вже вирішує це питання. OpenAI-compatible streaming працює просто: відправляєш готовий chunk як тільки він готовий, закриваєш з'єднання коли все завершено. SSE при цьому вже є в стеку — MCP використовує його як один з транспортів (поряд зі stdio та HTTP). Окремого транспортного рівня вигадувати не потрібно.

Агент просто стримить те, що готове в кожен момент:

```
→ chunk: "Запам'ятав: таблиці тепер UUID замість int id."   (fact оброблено)
→ chunk: [tool_call event: викликаю search(...)]             (почався action)
→ chunk: [tool_result event: результат search]
→ chunk: "Ось схема таблиці users: ..."                     (фінальна відповідь)
→ [connection closed]
```

## Часткове вирішення через subprompt decomposition

Subprompt decomposition дає конкретний виграш у perceived latency. Якщо повідомлення містить кілька subprompts — агент стримить результат кожного subprompt одразу після його завершення, не чекаючи решти:

```
Вхід: "До речі, зараз таблиці мають UUID замість int id.
       Покажи схему таблиці users."

Subprompt 1 (fact):   "До речі, зараз таблиці мають UUID замість int id"
Subprompt 2 (action): "Покажи схему таблиці users"

→ Стримимо одразу: "Запам'ятав: таблиці тепер UUID замість int id."
  (паралельно запускається tool loop для action)
→ Стримимо пізніше: результат зі схемою таблиці
→ [connection closed]
```

Користувач бачить відповідь частинами в міру обробки — без очікування завершення всього запиту. Це пряма перевага subprompt taxonomy, а не окрема оптимізація.

## Що стримити при tool call

При tool call агент не має тексту для streaming, але може емітувати типізовані події:

| Момент | Що стримити |
|--------|------------|
| Subprompt оброблено | Текстова відповідь по ньому |
| Tool call вирішено LLM | Подія з назвою інструменту і аргументами |
| Tool result отримано | Подія з результатом (або стислий текст) |
| Фінальна відповідь LLM | Текстові delta chunks |
| Все завершено | Close connection |

## Посилання

- [OpenAI Function Calling Guide](https://platform.openai.com/docs/guides/function-calling) — streaming з tool calls через `stream: true`, delta chunks з `tool_calls`
- [Anthropic Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming) — `content_block_start` / `content_block_delta` / `message_stop` для tool use
- [OpenAI Assistants Function Calling](https://platform.openai.com/docs/assistants/tools/function-calling) — event-based підхід: `tool_calls.created`, `tool_calls.delta`
- [AG-UI Protocol](https://docs.ag-ui.com/) — відкритий стандарт для agentic streaming між бекендом і UI
- [Microsoft Semantic Kernel — Agent Streaming](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-streaming) — `IAsyncEnumerable` з `FunctionCallContent` і `FunctionResultContent` як типи в потоці
