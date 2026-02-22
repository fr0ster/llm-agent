# Smart Orchestrated Agent — Roadmap реалізації

Черновий roadmap на основі [`SMART_AGENT_ARCHITECTURE.md`](./SMART_AGENT_ARCHITECTURE.md).

---

## Фаза 1 — Контракти (`src/smart-agent/interfaces/`)

- [ ] `ILlm` — chat/completion: `chat(messages, tools?) → LLMResponse`
- [ ] `IMcpClient` — `listTools() → Tool[]`, `callTool(name, args) → ToolResult`
- [ ] `IRag` — `upsert(text, metadata)`, `query(text, k) → RagResult[]`
- [ ] `ISubpromptClassifier` — `classify(text) → Subprompt[]` (типи: `fact | feedback | state | action`)
- [ ] `IContextAssembler` — `assemble(action, retrieved, toolResults) → ContextFrame`
- [ ] Спільні типи: `Subprompt`, `ContextFrame`, `RagResult`, `AgentConfig`

---

## Фаза 2 — Адаптери існуючого коду (`src/smart-agent/adapters/`)

- [ ] `LlmAdapter` — обертає існуючі `BaseAgent`-підкласи в `ILlm`
- [ ] `McpClientAdapter` — обертає `MCPClientWrapper` в `IMcpClient`

Ціль: нова архітектура не дублює HTTP-логіку провайдерів, а перевикористовує існуючий шар.

---

## Фаза 3 — Еталонна реалізація `IRag` (`src/smart-agent/rag/`)

- [ ] In-memory vector store з cosine similarity (для fact/feedback/state/tools — окремі екземпляри)
- [ ] Семантична дедуплікація при `upsert`: якщо схожий запис вже є — оновлює, не дублює
- [ ] TTL-поле в metadata; `query` відфільтровує прострочені записи

---

## Фаза 4 — `ISubpromptClassifier` (`src/smart-agent/classifier/`)

- [ ] LLM-based classifier: системний промпт з таксономією, низька температура
- [ ] Вхід: одне повідомлення користувача → масив `Subprompt` з типом і текстом
- [ ] Кешування результату для ідентичного тексту в межах запиту

---

## Фаза 5 — `IContextAssembler` (`src/smart-agent/context/`)

- [ ] Збирає `ContextFrame`: `action` + retrieved `facts` + `feedback` + `state` + `tools` + `toolResults`
- [ ] Формує фінальний масив `messages[]` для `mainLlm.chat()`
- [ ] Токен-ліміт: відкидає найменш релевантні записи якщо фрейм перевищує ліміт

---

## Фаза 6 — Оркестратор `SmartAgent` (`src/smart-agent/agent.ts`)

- [ ] DI-конструктор: `mainLlm`, `helperLlm`, `mcpClients[]`, `ragStores`, `classifier`, `assembler`, `config`
- [ ] Pipeline на один запит:
  - [ ] Класифікація → масив subprompts
  - [ ] `fact/feedback/state` → `IRag.upsert()` у відповідні сховища
  - [ ] `action` → `IRag.query()` для facts/feedback/state/tools → `IContextAssembler.assemble()`
  - [ ] Виклик `mainLlm.chat()` → tool loop (max `config.maxIterations`)
  - [ ] Повертає фінальну текстову відповідь
- [ ] Bounded tool loop: `maxIterations`, timeout — завершує запит навіть якщо LLM продовжує запитувати tools

---

## Фаза 7 — OpenAI-compatible HTTP сервер (`src/smart-agent/server.ts`)

- [ ] `POST /v1/chat/completions` — приймає стандартний OpenAI-формат, повертає `SmartAgent.process()`
- [ ] Підтримка `stream: false` (MVP); streaming — окремо після стабілізації

---

## Фаза 8 — Observability

- [ ] Структурований лог на кожному кроці: класифікація, RAG hits/misses, tool calls, підсумок
- [ ] `DEBUG_SMART_AGENT=true` у `.env` вмикає детальний вивід
- [ ] Не блокує реліз — мінімальна реалізація достатня для налагодження

---

## Фаза 9 — Тести

- [ ] Test doubles для кожного інтерфейсу (детерміновані відповіді)
- [ ] Тест ізоляції кожного компонента: підміняється лише одна реальна реалізація, решта — test doubles
- [ ] Smoke-тест pipeline end-to-end через embedded MCP + stub LLM
