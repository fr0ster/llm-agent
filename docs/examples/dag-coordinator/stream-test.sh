#!/usr/bin/env bash
# Streaming test client + per-component token breakdown.
#
# Usage:
#   ./stream-test.sh <port> <label> <prompt>
#
# Example:
#   ./stream-test.sh 4017 full 'Review program zexample, check security'
#
# Behaviour:
#   1. POSTs the prompt to /v1/chat/completions with stream:true and pipes
#      live content deltas to stdout (you see the answer as it is written).
#   2. After [DONE], fetches /v1/usage with the session cookie and prints
#      totals + byComponent breakdown.
#
# /v1/usage.byComponent is the per-role breakdown set up by Task 1 of this PR:
#   { planner, reviewer, finalizer, oracle, tool-loop, classifier, … }
#
# Requires: bash 4+, curl, jq.

set -u

PORT="${1:?usage: $0 <port> <label> <prompt>}"
LABEL="${2:?missing label}"
PROMPT="${3:?missing prompt}"
JAR="/tmp/dag-stream-cookies-${LABEL}.txt"
rm -f "$JAR"
START=$(date +%s)

printf '── [%s :%s] %s\n' "$LABEL" "$PORT" "$PROMPT" >&2
printf -- '─%.0s' {1..80} >&2; echo >&2

curl -sN -c "$JAR" -X POST "http://localhost:${PORT}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg p "$PROMPT" \
        '{messages:[{role:"user",content:$p}],stream:true}')" \
| while IFS= read -r line; do
    [[ "$line" =~ ^data:\ (.*) ]] || continue
    payload="${BASH_REMATCH[1]}"
    [[ "$payload" == "[DONE]" ]] && break
    delta=$(echo "$payload" | jq -r '.choices[0].delta.content // empty' 2>/dev/null)
    [[ -n "$delta" ]] && printf '%s' "$delta"
  done

END=$(date +%s)
echo; echo
printf -- '─%.0s' {1..80}; echo
printf '[%s] elapsed: %ds — fetching /v1/usage\n' "$LABEL" "$((END - START))"

curl -sb "$JAR" "http://localhost:${PORT}/v1/usage" \
  | jq '{
      totals: { promptTokens, completionTokens, totalTokens, requestCount },
      byComponent
    }'
