#!/usr/bin/env bash
# scripts/start-tui.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Source .env if it exists
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

cd tui
uv run nanoclaw-tui "$@"
