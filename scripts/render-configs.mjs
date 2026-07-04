#!/usr/bin/env node
// =============================================================================
// render-configs.mjs — OS/arch-aware model selection for the LLM-gateway configs
//
// Renders the three mutually-exclusive gateway configs (LiteLLM, Bifrost,
// Helicone) from their .tmpl templates, substituting the local tier model tags
// with the hardware-appropriate variant:
//
//   variant = RUFLO_MODEL_VARIANT if it is "mlx", "gguf", or "ci";
//             else os.arch() === "arm64" ? "mlx" : "gguf"  (Apple Silicon => mlx)
//   "ci" is a tiny stand-in variant (see config/model-sets.json) used by the
//   GitHub Actions local-smoke job, which cannot hold the real multi-GB models.
//
// Bare tags live in config/model-sets.json; each gateway gets its own provider
// prefix applied here. Idempotent: re-running produces byte-identical output.
//
// Usage:  node scripts/render-configs.mjs         (auto-detect from arch)
//         RUFLO_MODEL_VARIANT=gguf node scripts/render-configs.mjs
// =============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// ---- 1. Resolve the hardware variant ----------------------------------------
const arch = os.arch();
const envVariant = process.env.RUFLO_MODEL_VARIANT;
let variant;
if (envVariant === "mlx" || envVariant === "gguf" || envVariant === "ci") {
  variant = envVariant;
} else {
  variant = arch === "arm64" ? "mlx" : "gguf";
}

// ---- 2. Load the source-of-truth model set ----------------------------------
const modelSetsPath = join(repoRoot, "config", "model-sets.json");
const modelSets = JSON.parse(readFileSync(modelSetsPath, "utf8"));
const tags = modelSets.variants[variant];
if (!tags) {
  console.error(`render-configs: unknown variant "${variant}" (expected mlx|gguf|ci)`);
  process.exit(1);
}
const { fast, heavy, private: priv } = tags;

// ---- 3. Per-gateway provider prefixing --------------------------------------
// Each gateway names the local Ollama provider differently, so the same bare
// tag is prefixed per-gateway before it lands in the rendered config.
const prefixers = {
  litellm:  (tag) => `ollama_chat/${tag}`,   // LiteLLM: provider baked into model string
  bifrost:  (tag) => tag,                     // Bifrost: provider is a separate JSON field
  helicone: (tag) => `ollama-local/${tag}`,   // Helicone: custom provider name / model
};

const gateways = [
  { name: "litellm",  tmpl: "config/templates/litellm-config.yaml.tmpl",  out: "config/gateways/litellm-config.yaml" },
  { name: "bifrost",  tmpl: "config/templates/bifrost-config.json.tmpl",  out: "config/gateways/bifrost-config.json" },
  { name: "helicone", tmpl: "config/templates/helicone-config.yaml.tmpl", out: "config/gateways/helicone-config.yaml" },
];

// ---- 4. Render each gateway --------------------------------------------------
function render(templateText, prefix) {
  return templateText
    .split("{{TIER_FAST_MODEL}}").join(prefix(fast))
    .split("{{TIER_HEAVY_MODEL}}").join(prefix(heavy))
    .split("{{TIER_PRIVATE_MODEL}}").join(prefix(priv));
}

const resolved = {};
for (const gw of gateways) {
  const prefix = prefixers[gw.name];
  const tmplText = readFileSync(join(repoRoot, gw.tmpl), "utf8");
  const rendered = render(tmplText, prefix);
  writeFileSync(join(repoRoot, gw.out), rendered);
  resolved[gw.name] = {
    fast: prefix(fast),
    heavy: prefix(heavy),
    private: prefix(priv),
  };
}

// ---- 5. Report --------------------------------------------------------------
console.log(`render-configs: variant=${variant}  arch=${arch}` +
  (envVariant ? `  (RUFLO_MODEL_VARIANT=${envVariant})` : `  (auto-detected)`));
console.log(`  bare tags:  fast=${fast}  heavy=${heavy}  private=${priv}`);
for (const gw of gateways) {
  const r = resolved[gw.name];
  console.log(`  ${gw.out.padEnd(20)} fast=${r.fast}  heavy=${r.heavy}  private=${r.private}`);
}
