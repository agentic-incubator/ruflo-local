<!-- Full ruflo CLI reference: see machine-wide ruflo reference at ~/.claude/CLAUDE.md -->

# ruflo-local

## Swarm Config

- **Topology**: hierarchical-mesh (anti-drift)
- **Max Agents**: 15
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

```bash
ruflo swarm init --topology hierarchical --max-agents 8 --strategy specialized
```

## Build & Test

No build step or `package.json` scripts — the JS is plain ESM run directly, and
tests use Node's built-in runner:

```bash
node --test 'scripts/lib/__tests__/*.test.mjs'   # unit tests (191) for the routing/promotion overlay
make render                                       # regenerate gateway configs from templates (before `docker compose up`)
./smoke-test.sh                                   # end-to-end: tiers answer, fall-through, privacy pin, metrics
```

## Agentic QE v3
<!-- managed by ruflo-setup-aqe — aqe init skips regeneration when this sentinel is present -->
<!-- see ~/.claude/CLAUDE.md for full AQE operating guidance -->
