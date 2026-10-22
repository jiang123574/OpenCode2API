#!/usr/bin/env bash
# Smoke test for the Zen-direct lane (OPENCODE_ZEN_DIRECT=true).
# Usage: API_KEY=sk-test PORT=18000 bash tests/manual/test-zen-direct.sh
set -u

BASE="${BASE:-http://127.0.0.1:${PORT:-10000}}"
KEY="${API_KEY:-}"
MODEL="${MODEL:-opencode/deepseek-v4.1-flash-free}"
AUTH=()
[ -n "$KEY" ] && AUTH=(-H "Authorization: Bearer $KEY")

fail() { echo "FAIL: $1"; exit 1; }

echo "== /v1/models =="
MODELS=$(curl -s -m 30 "${AUTH[@]}" "$BASE/v1/models")
echo "$MODELS" | head -c 300; echo
echo "$MODELS" | grep -q '"opencode/' || fail "models list missing opencode/ ids"
echo "$MODELS" | grep -q 'claude-opus' && fail "paid model leaked into the free-lane catalog"

echo "== /v1/chat/completions (non-stream, native tool call) =="
BODY=$(cat <<JSON
{
  "model": "$MODEL",
  "stream": false,
  "messages": [{"role":"user","content":"Use the bash tool to run ls -la, then stop."}],
  "tools": [
    {"type":"function","function":{"name":"bash","description":"Run a shell command","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}},
    {"type":"function","function":{"name":"read","description":"Read a file","parameters":{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}}}
  ]
}
JSON
)
RESP=$(curl -s -m 120 "${AUTH[@]}" -H 'Content-Type: application/json' -d "$BODY" "$BASE/v1/chat/completions")
echo "$RESP" | head -c 500; echo
echo "$RESP" | grep -q '"tool_calls"' || fail "no tool_calls in response (free-lane 429? retry in a minute)"
echo "$RESP" | grep -q '"finish_reason":"tool_calls"\|"finish_reason": "tool_calls"' || fail "finish_reason is not tool_calls"

echo "== /v1/chat/completions (stream) =="
SSE=$(curl -sN -m 120 "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: ok\"}]}" \
  "$BASE/v1/chat/completions")
echo "$SSE" | head -c 300; echo
echo "$SSE" | grep -q 'data:' || fail "no SSE frames"

echo "PASS: zen-direct lane serves models, native tool_calls, and streaming"
