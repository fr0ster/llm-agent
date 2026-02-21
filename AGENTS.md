# Repository Guidelines

## Language Rules
- Write all repository artifacts in English (source code, comments, docs, commit messages, PR text).
- Communicate with the user in the same language the user uses in the conversation.

## Project Structure & Module Organization
- `src/` contains all TypeScript source code.
- `src/agents/` implements agent variants (`BaseAgent`, SAP Core AI, provider-specific agents).
- `src/llm-providers/` contains provider adapters and shared provider base logic.
- `src/mcp/` contains MCP client integration and transport behavior.
- `src/types.ts` defines shared contracts used across modules.
- `dist/` is generated build output (JS, `.d.ts`, source maps); do not edit manually.
- `docs/ARCHITECTURE.md` and `README.md` describe architecture and usage.

## Build, Test, and Development Commands
- `npm run build` compiles TypeScript (`src/`) into `dist/`.
- `npm run dev` runs the CLI via `tsx` with MCP integration.
- `npm run dev:llm` runs CLI in LLM-only mode.
- `npm run start` runs compiled CLI from `dist/`.
- `npm run lint` runs Biome checks with auto-fixes.
- `npm run lint:check` runs Biome checks without writing changes.
- `npm run format` formats source files with Biome.
- `npm run test` currently performs a build + CLI smoke run (not a unit-test suite).

## Coding Style & Naming Conventions
- Language: TypeScript (ES modules, strict mode enabled).
- Indentation: 2 spaces (`.editorconfig`, `biome.json`).
- Strings: single quotes; semicolons required (Biome formatter).
- Naming: `camelCase` for variables/functions, `PascalCase` for classes/types, kebab-case for file names where applicable (for example `sap-core-ai-agent.ts`).
- Keep public interfaces typed; avoid `any` (Biome warns on explicit `any`).

## Testing Guidelines
- There is no dedicated unit-test framework configured yet.
- Validate changes with:
  - `npm run lint:check`
  - `npm run build`
  - `npm run test` (smoke behavior)
- For feature work, include manual verification notes in PRs (input, expected behavior, and actual behavior).

## Commit & Pull Request Guidelines
- Follow Conventional Commits, as used in history: `feat:`, `fix:`, `refactor:`, `chore:`.
- Keep commits focused and descriptive (example: `fix: handle missing MCP toolCallHandler in embedded mode`).
- PRs should include:
  - clear summary and motivation,
  - linked issue (if available),
  - testing evidence (commands run and results),
  - config/env updates (`.env.template`, docs) when behavior changes.

## Security & Configuration Tips
- Never commit secrets; use `.env` (from `.env.template`) for local credentials.
- Prefer documenting new environment variables in both `README.md` and `.env.template`.
