# Quick Start Guide

## Setup

1. Copy environment template:
   ```bash
   cd submodules/llm-agent
   cp .env.template .env
   ```

2. Edit `.env` with your API keys and settings

3. The agent will automatically load `.env` when running

## Test LLM Only (Without MCP)

### OpenAI

```bash
cd submodules/llm-agent

# Basic usage - set API key and run
export OPENAI_API_KEY="sk-proj-your-actual-key-here"
npm run dev:llm

# With custom message
npm run dev:llm "Hello! What can you do?"

# With specific model
export OPENAI_MODEL="gpt-4o"  # or gpt-4-turbo, gpt-4o-mini, etc.
npm run dev:llm

# With organization ID (for team accounts)
export OPENAI_API_KEY="sk-proj-your-key"
export OPENAI_ORG="org-your-org-id"
npm run dev:llm

# With project ID (for project-specific billing)
export OPENAI_API_KEY="sk-proj-your-key"
export OPENAI_PROJECT="proj-your-project-id"  # or OPENAI_PRJ
npm run dev:llm

# Full configuration
export OPENAI_API_KEY="sk-proj-your-key"
export OPENAI_MODEL="gpt-4o"
export OPENAI_ORG="org-your-org-id"
export OPENAI_PROJECT="proj-your-project-id"
npm run dev:llm
```

### Anthropic (Claude)

```bash
cd submodules/llm-agent

# Set provider and API key
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY="sk-ant-your-actual-key-here"

# Run test
npm run dev:llm

# With custom message
npm run dev:llm "Introduce yourself"

# With specific model
export ANTHROPIC_MODEL="claude-3-opus-20240229"
npm run dev:llm
```

### DeepSeek

```bash
cd submodules/llm-agent

# Set provider and API key
export LLM_PROVIDER=deepseek
export DEEPSEEK_API_KEY="sk-your-actual-key-here"

# Run test
npm run dev:llm

# With custom message
npm run dev:llm "What are your capabilities?"
```

## Test LLM + MCP (With MCP Integration)

### OpenAI with MCP

```bash
cd submodules/llm-agent

# Set API key and MCP endpoint
export OPENAI_API_KEY="sk-proj-your-actual-key-here"
export MCP_ENDPOINT="http://localhost:4004/mcp/stream/http"

# Run test
npm run dev

# With SAP destination
export SAP_DESTINATION="SAP_DEV_DEST"
npm run dev "What ABAP programs are available?"
```

## Environment Variables Summary

| Variable | Required For | Description |
|----------|-------------|-------------|
| `LLM_PROVIDER` | All | Provider: `openai` (default), `anthropic`, or `deepseek` |
| `OPENAI_API_KEY` | OpenAI | Your OpenAI API key |
| `OPENAI_MODEL` | OpenAI | Model name (default: `gpt-4o-mini`) |
| `OPENAI_ORG` | OpenAI | OpenAI organization ID (optional, for team accounts) |
| `OPENAI_PROJECT` or `OPENAI_PRJ` | OpenAI | OpenAI project ID (optional, for project billing) |
| `ANTHROPIC_API_KEY` | Anthropic | Your Anthropic API key |
| `DEEPSEEK_API_KEY` | DeepSeek | Your DeepSeek API key |
| `ANTHROPIC_MODEL` | Anthropic | Model name (default: `claude-3-5-sonnet-20241022`) |
| `DEEPSEEK_MODEL` | DeepSeek | Model name (default: `deepseek-chat`) |
| `MCP_ENDPOINT` | MCP mode | MCP server URL (default: `http://localhost:4004/mcp/stream/http`) |
| `MCP_DISABLED` | LLM-only | Set to `true` to disable MCP |
| `SAP_DESTINATION` | MCP mode | SAP destination name (optional) |

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev:llm` | Test LLM only (development) |
| `npm run start:llm` | Test LLM only (production) |
| `npm run dev` | Test LLM + MCP (development) |
| `npm run start` | Test LLM + MCP (production) |
| `npm run build` | Build TypeScript to JavaScript |

## Examples

### Example 1: Quick OpenAI Test

```bash
export OPENAI_API_KEY="sk-proj-abc123..."
npm run dev:llm
```

### Example 2: Test Claude with Custom Message

```bash
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY="sk-ant-xyz789..."
npm run dev:llm "What can you help me with?"
```

### Example 3: Test with MCP Integration

```bash
export OPENAI_API_KEY="sk-proj-abc123..."
export MCP_ENDPOINT="http://localhost:4004/mcp/stream/http"
export SAP_DESTINATION="SAP_DEV_DEST"
npm run dev "List all ABAP classes"
```

