#!/usr/bin/env bash
# Thin shim — the implementation moved to scripts/lib/quality-regression.mjs (Node port,
# no bash/jq/curl). Kept as a stable entry point for existing callers.
exec node "$(dirname "$0")/lib/quality-regression.mjs" "$@"
