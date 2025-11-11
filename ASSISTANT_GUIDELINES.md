# Assistant Interaction Guidelines

## Core Rules

### Language Requirements

- **All repository artifacts authored by the assistant** (source code, documentation, comments, commit messages, etc.) **must be written in English**.
- **Direct communication with the user** must follow the language used by the user in the current conversation.
- **Code comments and documentation** must be in English, regardless of conversation language.

### Key Principles

1. **Keep repository artifacts in English** while mirroring the user's language in conversation.
2. **Capture essential project context** so new sessions recover quickly.
3. **Maintain consistency** across all code, documentation, and repository artifacts.

## Project Snapshot

- **Name:** LLM Agent – Minimal LLM agent orchestrating MCP tools through SAP AI Core.
- **Purpose:** Acts as an orchestrator between LLM providers and MCP (Model Context Protocol) servers, allowing LLMs to interact with external tools and services.
- **Key Architecture:**
  - All LLM providers are accessed through SAP AI Core (not directly)
  - OpenAI models → SAP AI Core → OpenAI
  - Anthropic models → SAP AI Core → Anthropic
  - DeepSeek models → SAP AI Core → DeepSeek
  - The model name determines which underlying provider SAP AI Core routes to
- **Key Modules:**
  - `src/agents/` - Agent implementations (SapCoreAIAgent, OpenAIAgent, etc.)
  - `src/llm-providers/` - LLM provider implementations (SapCoreAI, OpenAI, Anthropic, DeepSeek)
  - `src/mcp/` - MCP client wrapper with multiple transport protocols
  - `src/types.ts` - TypeScript type definitions
- **Primary Commands:**
  - `npm install` - Install dependencies
  - `npm run build` - Build TypeScript to `dist/`
  - `npm test` - Run tests (if available)
- **Build Output:** Compiled JavaScript and type definitions in `dist/`
- **Usage:** 
  - Embedded in application (imported as module)
  - Standalone service (separate process)
  - Both modes connect to MCP servers via transport protocols (HTTP/SSE/stdio)

Use this snapshot to rehydrate context quickly when a new chat session starts.

## Code and Documentation Standards

### Code Artifacts

- **Source code** (`.ts`, `.js` files): English only
- **Comments**: English only, explain "why" not "what"
- **Variable/function/class names**: English only, use camelCase for variables/functions, PascalCase for classes
- **Error messages**: English only
- **Log messages**: English only

### Documentation

- **README files**: English only
- **API documentation**: English only
- **Code examples**: English only
- **Commit messages**: English only, follow conventional commits format
- **CHANGELOG entries**: English only

### User Communication

- **Conversation responses**: Match user's language (Ukrainian, English, etc.)
- **Explanations**: Match user's language
- **Questions**: Match user's language
- **Error explanations**: Match user's language

## Architecture Notes

### LLM Provider Integration

- **SAP AI Core** is the primary gateway for all LLM providers
- Providers are accessed via `SapCoreAIProvider` which routes to underlying providers based on model name
- Direct provider access (OpenAI, Anthropic, DeepSeek) is available but not recommended for production

### MCP Client Integration

- Supports multiple transport protocols:
  - **Stdio**: For local processes
  - **SSE**: Server-Sent Events
  - **Streamable HTTP**: Bidirectional NDJSON
- Auto-detection of transport from URL
- Tool orchestration with proper tool result handling

### Agent Types

- **SapCoreAIAgent**: Primary agent for SAP AI Core integration
- **OpenAIAgent**: Direct OpenAI integration (for testing/development)
- **AnthropicAgent**: Direct Anthropic integration (for testing/development)
- **DeepSeekAgent**: Direct DeepSeek integration (for testing/development)
- **PromptBasedAgent**: Generic prompt-based agent

## Error Handling

- **Error messages**: English only
- **Log messages**: English only
- **User-facing errors**: Can be translated based on user's language preference
- **Technical errors**: Always in English for debugging

## Code Review Checklist

When reviewing code or documentation:

- [ ] All code comments are in English
- [ ] All variable/function/class names are in English
- [ ] All documentation is in English
- [ ] All commit messages are in English
- [ ] Error messages are in English
- [ ] Log messages are in English
- [ ] Code follows TypeScript best practices
- [ ] No hardcoded credentials or secrets
- [ ] Types are properly defined (avoid `any`)

## Integration with cloud-llm-hub

This submodule is used by the main `cloud-llm-hub` project:

- **Import path**: `@cloud-llm-hub/llm-agent`
- **Build output**: `dist/` directory
- **Usage**: Imported in `srv/agent-manager.ts` and `srv/agent-service.ts`
- **Configuration**: Agent configuration is managed in `cloud-llm-hub/srv/agent-config.ts`

When making changes:
1. Build the submodule: `npm run build`
2. Changes are automatically picked up by the main project (if using `file:` dependency)
3. For production, the main project's build process handles submodule compilation

