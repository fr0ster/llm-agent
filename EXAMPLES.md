# LLM Proxy Usage Examples

## Quick Start Examples

### Example 0: Test LLM Only (Without MCP)

Test just the LLM provider without MCP integration.

#### OpenAI Example

```bash
cd submodules/llm-agent

# Basic usage - set API key and run
export OPENAI_API_KEY="sk-proj-your-actual-key-here"
npm run dev:llm

# Or inline (one-time use)
OPENAI_API_KEY="sk-proj-your-key" npm run dev:llm

# With custom message
export OPENAI_API_KEY="sk-proj-your-key"
npm run dev:llm "Hello! Can you introduce yourself?"

# With specific model
export OPENAI_API_KEY="sk-proj-your-key"
export OPENAI_MODEL="gpt-4o"  # Options: gpt-4o, gpt-4o-mini, gpt-4-turbo, etc.
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

#### Anthropic (Claude) Example

```bash
cd submodules/llm-agent

# Set provider type and API key
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY="sk-ant-your-actual-key-here"
npm run dev:llm

# With custom message
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY="sk-ant-your-key"
npm run dev:llm "What capabilities do you have?"

# With specific model
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY="sk-ant-your-key"
export ANTHROPIC_MODEL="claude-3-5-sonnet-20241022"  # or claude-3-opus-20240229, etc.
npm run dev:llm
```

#### DeepSeek Example

```bash
cd submodules/llm-agent

# Set provider type and API key
export LLM_PROVIDER=deepseek
export DEEPSEEK_API_KEY="sk-your-actual-key-here"
npm run dev:llm

# With custom message
export LLM_PROVIDER=deepseek
export DEEPSEEK_API_KEY="sk-your-key"
npm run dev:llm "Explain what you can do"

# With specific model
export LLM_PROVIDER=deepseek
export DEEPSEEK_API_KEY="sk-your-key"
export DEEPSEEK_MODEL="deepseek-chat"  # or deepseek-coder, etc.
npm run dev:llm
```

#### Quick Reference

**Environment Variables:**
- `LLM_PROVIDER` - Provider to use: `openai` (default), `anthropic`, or `deepseek`
- `OPENAI_API_KEY` - Required for OpenAI
- `OPENAI_MODEL` - Optional model name (default: `gpt-4o-mini`)
- `OPENAI_ORG` - Optional organization ID (for team accounts)
- `OPENAI_PROJECT` or `OPENAI_PRJ` - Optional project ID (for project billing)
- `ANTHROPIC_API_KEY` - Required for Anthropic
- `DEEPSEEK_API_KEY` - Required for DeepSeek
- `ANTHROPIC_MODEL` - Optional model name (default: `claude-3-5-sonnet-20241022`)
- `DEEPSEEK_MODEL` - Optional model name (default: `deepseek-chat`)

**Commands:**
```bash
# Method 1: Dedicated script (recommended)
npm run dev:llm

# Method 2: Using flag
npm run dev -- --llm-only

# Method 3: Using environment variable
export MCP_DISABLED=true
npm run dev
```

### Example 1: Basic OpenAI Test (With MCP)

```bash
cd submodules/llm-agent

# Set API key
export OPENAI_API_KEY="sk-proj-your-key-here"

# Set MCP endpoint (if cloud-llm-hub is running)
export MCP_ENDPOINT="http://localhost:4004/mcp/stream/http"

# Run test
npm run dev
```

### Example 2: With Custom Message

```bash
export OPENAI_API_KEY="sk-proj-your-key-here"
export MCP_ENDPOINT="http://localhost:4004/mcp/stream/http"

# Test with specific question
npm run dev "What ABAP programs are available in the system?"
```

### Example 3: With SAP Destination

```bash
export OPENAI_API_KEY="sk-proj-your-key-here"
export MCP_ENDPOINT="http://localhost:4004/mcp/stream/http"
export SAP_DESTINATION="SAP_DEV_DEST"

npm run dev "List all ABAP classes"
```

### Example 4: Using Different Models

```bash
export OPENAI_API_KEY="sk-proj-your-key-here"
export OPENAI_MODEL="gpt-4o"  # Use GPT-4o instead of default gpt-4o-mini
export MCP_ENDPOINT="http://localhost:4004/mcp/stream/http"

npm run dev
```

### Example 5: Testing with Anthropic (Claude)

```bash
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY="sk-ant-your-key-here"
export MCP_ENDPOINT="http://localhost:4004/mcp/stream/http"

npm run dev "What tools can you use?"
```

### Example 6: Testing with DeepSeek

```bash
export LLM_PROVIDER=deepseek
export DEEPSEEK_API_KEY="sk-your-key-here"
export MCP_ENDPOINT="http://localhost:4004/mcp/stream/http"

npm run dev
```

## Programmatic Usage Examples

### Example: Using in Your Own Code

```typescript
import { OpenAIAgent, OpenAIProvider, MCPClientWrapper } from '@mcp-abap-adt/llm-proxy';

// Create LLM provider
const llmProvider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
});

// Create MCP client
const mcpClient = new MCPClientWrapper({
  url: 'http://localhost:4004/mcp/stream/http',
  headers: {
    'Authorization': 'Basic YWxpY2U6',
    'X-SAP-Destination': 'SAP_DEV_DEST',
  },
});

// Create agent
const agent = new OpenAIAgent({
  llmProvider,
  mcpClient,
});

// Connect and use
await agent.connect();
const response = await agent.process('What tools are available?');
console.log(response.message);
```

## Environment Variables Reference

### OpenAI
- `OPENAI_API_KEY` - **Required** - Your OpenAI API key
- `OPENAI_MODEL` - Optional - Model name (default: `gpt-4o-mini`)
- `MCP_ENDPOINT` - Optional - MCP server endpoint (default: `http://localhost:4004/mcp/stream/http`)

### Anthropic
- `ANTHROPIC_API_KEY` - **Required** when using Anthropic
- `ANTHROPIC_MODEL` - Optional - Model name (default: `claude-3-5-sonnet-20241022`)
- `LLM_PROVIDER=anthropic` - Set to use Anthropic

### DeepSeek
- `DEEPSEEK_API_KEY` - **Required** when using DeepSeek
- `DEEPSEEK_MODEL` - Optional - Model name (default: `deepseek-chat`)
- `LLM_PROVIDER=deepseek` - Set to use DeepSeek

### MCP Configuration
- `MCP_ENDPOINT` - MCP server endpoint URL
- `MCP_AUTH_HEADER` - Authorization header (default: `Basic YWxpY2U6`)
- `SAP_DESTINATION` - SAP destination name (optional)

## Troubleshooting

### Error: "OPENAI_API_KEY environment variable is required"
**Solution:** Set the API key:
```bash
export OPENAI_API_KEY="sk-proj-your-key-here"
```

### Error: "Cannot connect to MCP server"
**Solution:** Make sure cloud-llm-hub is running:
```bash
# In cloud-llm-hub root
cds watch --profile development
```

### Error: "No tools available"
**Solution:** Check MCP endpoint and SAP destination:
```bash
export MCP_ENDPOINT="http://localhost:4004/mcp/stream/http"
export SAP_DESTINATION="SAP_DEV_DEST"
```
