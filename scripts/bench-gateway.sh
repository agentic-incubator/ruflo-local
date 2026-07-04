#!/usr/bin/env bash
exec node "$(dirname "$0")/lib/bench-gateway.mjs" "$@"
