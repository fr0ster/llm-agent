# Migrating to v29.0.0

## TL;DR

Two changes can need an edit; nothing else moved.

1. **Sampling knobs you do not set are no longer sent.** An `llm:` entry without `temperature`
   used to run at 0.7 (`main`) or 0.1 (classifier, helper); without `maxTokens`, the SAP AI Core
   provider sent 16384. Now none is sent and the model applies its own default.
2. **A global install ships only `llm-agent`.** `llm-agent-check` and `claude-via-agent` are
   repository tools now: `npm run models:check` and `npm run claude:via-agent` from a checkout.

## 1. Unset sampling knobs

**Why.** `gpt-5*`, `o1`/`o3`/`o4-mini` and `anthropic--claude-4.7-opus`/`4.8-opus` accept only
temperature 1. With a temperature forced on every call, the server could not use them at all —
every call failed with HTTP 400 (`gpt-5 models don't support temperature=0.7`). A value you set is
still sent as is; a model that rejects it answers with that error.

| Where | Before v29 | v29 |
|---|---|---|
| `llm.temperature` / `llm.main.temperature` unset | 0.7 | not sent |
| `llm.classifierTemperature` unset (classifier derived from main) | 0.1 | not sent |
| `llm.helper.temperature` unset | 0.1 | not sent |
| SAP AI Core `maxTokens` unset | 16384 | not sent |
| OpenAI / DeepSeek / Ollama `temperature`, `maxTokens` unset | 0.7, 4096 | not sent |
| Anthropic `temperature` unset | 0.7 | not sent |
| Anthropic `maxTokens` unset | 4096 | 4096 (the Messages API requires it) |
| `SapCoreAIProvider` with `temperature: 0` | sent 0.7 (`\|\|` swallowed 0) | sends 0 |

**What you do.** To keep the old behaviour, write the old values into your config:

```yaml
llm:
  main:
    provider: sap-ai-sdk
    model: gpt-4o
    temperature: 0.7
    classifierTemperature: 0.1   # only when the classifier derives from main
  helper:
    provider: sap-ai-sdk
    model: gpt-4o-mini
    temperature: 0.1
```

Do **not** set a temperature other than 1 for the models above. A library consumer that builds a
provider directly (`new SapCoreAIProvider({...})`, `new OpenAIProvider({...})`) gets the same rule:
pass `temperature` / `maxTokens` to have them sent.

`IServerPipelineContext.mainTemp` is now `number | undefined`: `undefined` means the config set no
temperature.

## 2. Commands of the published package

`npm install -g @mcp-abap-adt/llm-agent-server` puts only `llm-agent` on your PATH. The other two
commands never worked from a global install — `claude-via-agent` looked for `.env` and
`pipelines/` next to the installed package, where neither exists — so they moved to the
repository:

| Before | Now (from a repo checkout) |
|---|---|
| `llm-agent-check` | `npm run models:check` |
| `llm-agent-check gpt-4o` | `npm run models:check -- gpt-4o` |
| `llm-agent-check --config smart-server.yaml` | `npm run models:check -- --config smart-server.yaml` |
| `claude-via-agent` | `npm run claude:via-agent` |

`models:check` reads the account the way the server does: `--credential-ref <REF>` →
`<REF>_SERVICE_KEY`, default `LLM_SERVICE_KEY`. It used to rely on the SAP AI SDK's implicit
`AICORE_SERVICE_KEY`; if that is the variable you have, pass `--credential-ref AICORE`. See the
[server package README](../packages/llm-agent-server/README.md#repository-tools-not-published) for
all options.

## Fixed along the way (no edit needed)

- `SapCoreAIProvider.getModels()` queried the catalog with the SDK's implicit
  `AICORE_SERVICE_KEY` instead of the configured credential, and fell back to a one-model list
  without it.
- `SapCoreAIProvider.getEmbeddingModels()` matched the capability `embeddings`; the catalog says
  `embedding`, so it returned nothing.
- SAP AI Core errors now carry AI Core's reason instead of only `Request failed with status code 400`.
