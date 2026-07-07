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

// The "ci" variant points Bifrost/Helicone's hardcoded ollama base_url at fake-upstream
// (scripts/lib/fake-upstream-server.mjs) instead of real Ollama — see docker-compose.ci.yml.
// LiteLLM needs no substitution here: its template already reads os.environ/OLLAMA_API_BASE.
// Deliberately NOT in config/model-sets.json — that file's own _note documents it as
// bare-tag-only; this is render-time plumbing, not a model tag.
// Two forms: Helicone's openai-compatible custom provider wants the /v1 suffix;
// Bifrost's ollama_key_config.url is the bare host (Bifrost's own OpenAI-compat
// translation lives internally — confirmed against its docs' own Ollama example).
const ollamaBaseUrlBare = variant === "ci" ? "http://fake-upstream:9100" : "http://ollama:11434";
const ollamaBaseUrl = `${ollamaBaseUrlBare}/v1`;

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
// {{TIER_*_MODEL}} is the per-gateway-prefixed form (e.g. "ollama-local/qwen2.5:0.5b"
// for Helicone's routers), used for REFERENCING a tier from elsewhere. {{TIER_*_MODEL_BARE}}
// is the raw tag with no provider prefix — needed where a gateway's OWN provider block
// declares which model IDs it exposes (e.g. Helicone's providers.ollama-local.models),
// as opposed to referencing one.
function render(templateText, prefix) {
  return templateText
    .split("{{TIER_FAST_MODEL_BARE}}").join(fast)
    .split("{{TIER_HEAVY_MODEL_BARE}}").join(heavy)
    .split("{{TIER_PRIVATE_MODEL_BARE}}").join(priv)
    .split("{{TIER_FAST_MODEL}}").join(prefix(fast))
    .split("{{TIER_HEAVY_MODEL}}").join(prefix(heavy))
    .split("{{TIER_PRIVATE_MODEL}}").join(prefix(priv))
    .split("{{OLLAMA_BASE_URL_BARE}}").join(ollamaBaseUrlBare) // Bifrost only
    .split("{{OLLAMA_BASE_URL}}").join(ollamaBaseUrl); // Helicone only (litellm's template has neither token — env-driven)
}

// Bifrost's schema is strict (additionalProperties: false almost everywhere), so the
// "_meta"/"_note" documentation-key convention used elsewhere in this repo's generated
// configs fails its validator. JSON has no native comments (unlike the YAML templates),
// so bifrost-config.json.tmpl carries whole-line `//` comments instead, stripped here
// before the rendered output ever reaches Bifrost. Whole-line only (a trimmed line
// starting with `//`) — never strips inline, so a URL value is never touched.
function stripJsonComments(text) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const resolved = {};
for (const gw of gateways) {
  const prefix = prefixers[gw.name];
  const tmplText = readFileSync(join(repoRoot, gw.tmpl), "utf8");
  let rendered = render(tmplText, prefix);
  if (gw.out.endsWith(".json")) rendered = stripJsonComments(rendered);
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
