#!/usr/bin/env bash
# Launch the mindmap studio: install deps if needed, start the dev server, open a browser.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required (https://pnpm.io). Aborting." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  pnpm install
fi

exec pnpm --filter @mindmap/studio dev --open
