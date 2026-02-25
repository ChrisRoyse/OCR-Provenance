# ==============================================================================
# OCR Provenance MCP Server -- Unified Dockerfile
#
# Build variants:
#   CPU (default):  docker build -t ocr-provenance-mcp:cpu .
#   GPU (CUDA 12.4): docker build --build-arg COMPUTE=cu124 \
#                       --build-arg RUNTIME_BASE=nvidia/cuda:12.4.1-runtime-ubuntu22.04 \
#                       -t ocr-provenance-mcp:gpu .
# ==============================================================================

# Build args -- override for GPU
ARG COMPUTE=cpu
ARG RUNTIME_BASE=python:3.12-slim-bookworm

# ==============================================================================
# Stage 1: Python dependencies (installed into a portable venv)
# ==============================================================================
FROM python:3.12-slim-bookworm AS python-deps

ARG COMPUTE=cpu

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Create a venv so the entire Python environment is portable across base images.
# This avoids site-packages path mismatches between python:3.12-slim and nvidia/cuda.
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY python/requirements.txt /tmp/requirements.txt

# On arm64, nvidia-ml-py has no wheels and fails to install. Filter it out.
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then \
      sed -i '/nvidia-ml-py/d' /tmp/requirements.txt; \
    fi

# Install PyTorch from the variant-specific wheel index.
# CPU: https://download.pytorch.org/whl/cpu (~200MB)
# cu124: https://download.pytorch.org/whl/cu124 (~2.5GB)
RUN pip install --no-cache-dir \
    torch --index-url https://download.pytorch.org/whl/${COMPUTE}

# Install remaining Python deps (skips torch since already installed)
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Pre-download the embedding model to a fixed path that the worker expects.
# The embedding_worker.py resolves MODEL_PATH from EMBEDDING_MODEL_PATH env var,
# then falls back to ../models/nomic-embed-text-v1.5 (relative to worker script),
# then ~/.ocr-provenance/models/nomic-embed-text-v1.5.
# We download to /opt/models/ and set the env var in the runtime stage.
RUN python3 -c "\
from huggingface_hub import snapshot_download; \
snapshot_download('nomic-ai/nomic-embed-text-v1.5', local_dir='/opt/models/nomic-embed-text-v1.5')" && \
    python3 -c "\
from sentence_transformers import SentenceTransformer; \
SentenceTransformer('/opt/models/nomic-embed-text-v1.5', trust_remote_code=True); \
print('Model pre-loaded successfully')"

# ==============================================================================
# Stage 2: Node.js build (TypeScript compilation + native addons)
# ==============================================================================
FROM node:20-bookworm-slim AS node-build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy package files first for better layer caching
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for tsc)
RUN npm ci

# Copy source and compile TypeScript
COPY src/ src/
COPY tsconfig.json ./
RUN npm run build

# Verify native addons compiled correctly (fail-fast if broken).
# NOTE: node -e uses CJS by default (not ESM), so require() works fine here
# even though the project's package.json has "type": "module".
RUN node -e "\
const bs3 = require('better-sqlite3'); \
const sv = require('sqlite-vec'); \
const db = new bs3(':memory:'); \
sv.load(db); \
const v = db.prepare('SELECT vec_version()').pluck().get(); \
db.close(); \
console.log('Native addon check: better-sqlite3 OK, sqlite-vec ' + v);"

# Prune devDependencies for a smaller runtime copy
RUN npm prune --production

# ==============================================================================
# Stage 3: Runtime
# ==============================================================================
FROM ${RUNTIME_BASE} AS runtime

ARG RUNTIME_BASE=python:3.12-slim-bookworm

# Install system deps needed at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 from official tarball (neither base image includes it)
ARG NODE_VERSION=20.18.1
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then NODE_ARCH=x64; \
    elif [ "$ARCH" = "arm64" ]; then NODE_ARCH=arm64; \
    else NODE_ARCH=$ARCH; fi && \
    curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz \
    | tar -xz -C /usr/local --strip-components=1 && \
    node --version && npm --version

# For nvidia/cuda base (Ubuntu 22.04): install Python 3.12 from deadsnakes PPA.
# For python:3.12-slim-bookworm: Python 3.12 is already present, this is a no-op.
RUN if ! python3 --version 2>/dev/null | grep -q "3.12"; then \
    apt-get update && apt-get install -y --no-install-recommends \
      software-properties-common && \
    add-apt-repository ppa:deadsnakes/ppa && \
    apt-get update && apt-get install -y --no-install-recommends \
      python3.12 python3.12-venv python3.12-distutils && \
    ln -sf /usr/bin/python3.12 /usr/bin/python3 && \
    rm -rf /var/lib/apt/lists/*; \
  fi

# Create non-root user
RUN groupadd -r mcp && useradd -r -g mcp -m -d /home/mcp mcp

WORKDIR /app

# Copy the portable Python venv from Stage 1
COPY --from=python-deps /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy the pre-downloaded embedding model to the path the worker expects
COPY --from=python-deps /opt/models/nomic-embed-text-v1.5 /opt/models/nomic-embed-text-v1.5

# Copy Node.js production dependencies and compiled output from Stage 2
COPY --from=node-build /build/node_modules ./node_modules
COPY --from=node-build /build/dist ./dist
COPY --from=node-build /build/package.json ./

# Copy Python worker scripts
COPY python/ ./python/

# Copy .env.example as reference
COPY .env.example ./

# Create data directory for SQLite databases
RUN mkdir -p /data && chown mcp:mcp /data

# Fix ownership of the model directory
RUN chown -R mcp:mcp /opt/models

# Copy healthcheck script
COPY scripts/docker-healthcheck.sh /usr/local/bin/docker-healthcheck.sh
RUN chmod +x /usr/local/bin/docker-healthcheck.sh

# Environment defaults
ENV NODE_ENV=production
ENV MCP_HTTP_PORT=3100
ENV OCR_PROVENANCE_DATABASES_PATH=/data
ENV OCR_PROVENANCE_ALLOWED_DIRS=/host,/data
ENV EMBEDDING_DEVICE=cpu
ENV EMBEDDING_MODEL_PATH=/opt/models/nomic-embed-text-v1.5

# Expose MCP HTTP port (used only when MCP_TRANSPORT=http)
EXPOSE 3100

# Health check (meaningful in HTTP mode; passes trivially in stdio mode via healthcheck.sh)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD /usr/local/bin/docker-healthcheck.sh

# Switch to non-root user
USER mcp

# Default: stdio mode (for AI clients using "docker run -i --rm")
# Override with: -e MCP_TRANSPORT=http for persistent HTTP server
CMD ["node", "--max-semi-space-size=64", "dist/bin-http.js"]
