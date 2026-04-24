#!/usr/bin/env bash
# Publish all @mcp-abap-adt/* workspaces to npm in dependency order.
#
# Usage: npm run release:publish
#
# On the first `npm publish` a browser window opens for 2FA. Check the
# "trust this device for 5 minutes" option; subsequent publishes in the
# same run go through without further prompts.
set -euo pipefail

cd "$(dirname "$0")/.."

PACKAGES=(
  llm-agent
  openai-llm
  anthropic-llm
  deepseek-llm
  sap-aicore-llm
  openai-embedder
  ollama-embedder
  sap-aicore-embedder
  qdrant-rag
  hana-vector-rag
  pg-vector-rag
  llm-agent-server
)

for pkg in "${PACKAGES[@]}"; do
  echo
  echo ">>> Publishing @mcp-abap-adt/$pkg"
  npm publish --workspace "@mcp-abap-adt/$pkg" --access public
done

echo
echo "All ${#PACKAGES[@]} packages published."
