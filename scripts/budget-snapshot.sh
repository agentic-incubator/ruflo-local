#!/usr/bin/env bash
# Thin shim — the implementation moved to scripts/lib/budget-snapshot.mjs (Node port,
# no bash/jq/curl). Kept as a stable entry point for existing callers.
exec node "$(dirname "$0")/lib/budget-snapshot.mjs" "$@"
