#!/usr/bin/env bash
# Thin shim — the FrugalGPT verify-then-escalate judge is now a portable Node module
# (scripts/lib/verify-escalate.mjs). This entry point is kept so existing callers/CI
# that invoke ./scripts/verify-escalate.sh still resolve. Same CLI, same JSON output.
exec node "$(dirname "$0")/lib/verify-escalate.mjs" "$@"
