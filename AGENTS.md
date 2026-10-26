# ruflo-local

Local-first tiered LLM routing: most traffic goes to open-weight models on this machine, the rest to
budget-capped frontier APIs, behind a pluggable gateway (LiteLLM, Bifrost, Helicone) with Grafana dashboards.
See `README.md` and `docs/guide/`.

## Build & Test

No build step or `package.json` scripts — the JS is plain ESM run directly, and
tests use Node's built-in runner:

```bash
node --test 'scripts/lib/__tests__/*.test.mjs' 'scripts/__tests__/*.test.mjs'   # full unit suite (262): routing/promotion overlay + live gateway wiring
make render                                       # regenerate gateway configs from templates (before `docker compose up`)
./smoke-test.sh                                   # end-to-end: tiers answer, fall-through, privacy pin, metrics
```

CI (`.github/workflows/autopilot-gate.yml`) also runs yamllint, shellcheck, `jq -e` on the JSON configs,
`node --check` on `scripts/lib/`, `RUFLO_MODEL_VARIANT=ci node scripts/render-configs.mjs` with
`docker compose config -q`, and the smoke test per gateway profile.

## Rules

- Do what was asked; nothing more. Read a file before editing it.
- Report the checks you actually ran and their limits; never invent tests, coverage or results.
- Keep credentials out of source (`.env` is ignored; `.env.example` is the template). Respect the configured
  providers and spending limits.
- `.autopilot/` holds the record of past autopilot pipelines; edit it only through autopilot.
- Commits, pushes, publishing and destructive cleanup need the owner's explicit approval.
- Keep shared instructions here; `CLAUDE.md` is exactly `@AGENTS.md`.
