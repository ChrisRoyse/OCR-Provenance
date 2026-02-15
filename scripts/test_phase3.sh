#!/bin/bash
# Phase 3 Test Script - OCR Processing Pipeline
# Sends MCP JSON-RPC requests to the server

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="node ${SCRIPT_DIR}/dist/index.js"
DB="test-legal-docs"

# Helper: send a sequence of JSON-RPC messages to the MCP server
run_mcp() {
  local messages="$1"
  echo "$messages" | $SERVER 2>/tmp/mcp-stderr.log
}

# Build the init + request messages
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
INIT_NOTIFY='{"jsonrpc":"2.0","method":"notifications/initialized"}'

call_tool() {
  local tool_name="$1"
  local args="$2"
  local id="$3"

  # Send init + notification + tool call
  local request='{"jsonrpc":"2.0","id":'"$id"',"method":"tools/call","params":{"name":"'"$tool_name"'","arguments":'"$args"'}}'

  printf '%s\n%s\n%s\n' "$INIT" "$INIT_NOTIFY" "$request" | $SERVER 2>/tmp/mcp-stderr.log
}

echo "=== TEST 3.1: Select database and process single pending document ==="

# First select the database
echo "--- Selecting database ---"
call_tool "ocr_db_select" '{"name":"test-legal-docs"}' 2

echo ""
echo "--- DONE ---"
