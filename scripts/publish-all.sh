#!/usr/bin/env bash
# Publish all @mcp-abap-adt/* workspaces to npm in dependency order.
#
# Usage: npm run release:publish
#
# On the first `npm publish` a browser window opens for 2FA. Check the
# "trust this device for 5 minutes" option; subsequent publishes in the
# same run go through without further prompts.
set -uo pipefail

cd "$(dirname "$0")/.."

PACKAGES=(
  llm-agent
  llm-agent-mcp
  llm-agent-rag
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
  llm-agent-libs
  llm-agent-server
)

PUBLISHED=0
SKIPPED=0
FAILED=()

for pkg in "${PACKAGES[@]}"; do
  echo
  name="@mcp-abap-adt/$pkg"
  version="$(node -p "require('./packages/$pkg/package.json').version")"
  echo ">>> $name@$version"

  # Check if this exact version is already published
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "    already on npm — skipping"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if npm publish --workspace "$name" --access public; then
    PUBLISHED=$((PUBLISHED + 1))
  else
    FAILED+=("$name@$version")
  fi
done

echo
echo "Published: $PUBLISHED  Skipped: $SKIPPED  Failed: ${#FAILED[@]}"
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '  - %s\n' "${FAILED[@]}"
  exit 1
fi
