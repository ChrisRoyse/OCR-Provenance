#!/bin/sh
# Docker health check for OCR Provenance MCP Server.
# In HTTP mode: curl the /health endpoint.
# In stdio mode: always report healthy (no HTTP endpoint available).

set -e

# If MCP_TRANSPORT is not "http", always report healthy
if [ "${MCP_TRANSPORT}" != "http" ]; then
  exit 0
fi

RESPONSE=$(curl -sf http://localhost:${MCP_HTTP_PORT:-3100}/health) || exit 1

echo "$RESPONSE" | grep -q '"status":"ok"' || exit 1

exit 0
