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

echo ">>> Clean + rebuild before publish"
npm run clean
npm run build

PACKAGES=(
  llm-agent
  llm-agent-mcp
  llm-agent-rag
  openai-llm
  ollama-llm
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

  # Publish in dependency order. Abort immediately on ANY failure. A single
  # failed publish (404/401/403 because the npm login / 2FA session dropped, or
  # a network error) means continuing would publish dependents on top of an
  # unpublished dependency — producing a broken, uninstallable release set
  # (the #142 class of bug). Fail fast instead of collecting failures.
  npm publish --workspace "$name" --access public
  status=$?
  if [ "$status" -ne 0 ]; then
    echo >&2
    echo "ERROR: 'npm publish' failed for $name@$version (exit $status)." >&2
    echo "Aborting: the remaining packages will NOT be published." >&2
    echo "A 404/401/403 here usually means the npm login / 2FA session dropped —" >&2
    echo "re-authenticate ('npm whoami' to check, 'npm login' to renew) and re-run." >&2
    echo "Already-published packages are detected and skipped on the next run." >&2
    echo >&2
    echo "Published before failure: $PUBLISHED  Skipped: $SKIPPED" >&2
    exit "$status"
  fi
  PUBLISHED=$((PUBLISHED + 1))
done

echo
echo "Published: $PUBLISHED  Skipped: $SKIPPED"
