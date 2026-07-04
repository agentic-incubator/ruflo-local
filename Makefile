# ruflo-local — gateway config rendering
#
# The committed gateway configs (litellm-config.yaml, bifrost-config.json,
# helicone-config.yaml) are GENERATED from config/templates/*.tmpl by
# scripts/render-configs.mjs, which picks OS/arch-appropriate local model tags
# (Apple Silicon => MLX builds, else plain) from config/model-sets.json.
#
# ALWAYS run `make render` before `docker compose up` so the active gateway
# serves the hardware-correct local tags. Override auto-detection with
# RUFLO_MODEL_VARIANT=mlx|gguf (e.g. `make render RUFLO_MODEL_VARIANT=gguf`).

.PHONY: render

render:
	node scripts/render-configs.mjs
