<!-- Full ruflo CLI reference: see machine-wide ruflo reference at ~/.claude/CLAUDE.md -->

# ruflo-local

## Build & Test

No build step or `package.json` scripts — the JS is plain ESM run directly, and
tests use Node's built-in runner:

```bash
node --test 'scripts/lib/__tests__/*.test.mjs' 'scripts/__tests__/*.test.mjs'   # full unit suite (248): routing/promotion overlay + live gateway wiring
make render                                       # regenerate gateway configs from templates (before `docker compose up`)
./smoke-test.sh                                   # end-to-end: tiers answer, fall-through, privacy pin, metrics
```

No literal `ruflo swarm` has ever been run in this repo — every phase in git history is
single-session autopilot work, not multi-agent swarm coordination. See the machine-wide
`~/.claude/CLAUDE.md` for swarm defaults if that changes.

## Agentic QE v3
<!-- managed by ruflo-setup-aqe — aqe init skips regeneration when this sentinel is present -->
<!-- see ~/.claude/CLAUDE.md for full AQE operating guidance -->
