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

.PHONY: render gateway-up

render:
	node scripts/render-configs.mjs

# Map a gateway profile name to route-gateway's upstream URL, so switching
# gateways is one PROFILE= knob instead of two vars kept in sync by hand.
# See docs/guide/reference/gateway-variants.md → "Switching gateways".
GATEWAY_URL_litellm  := http://litellm:4000
GATEWAY_URL_bifrost  := http://bifrost:8080
GATEWAY_URL_helicone := http://helicone:8080

PROFILE ?= litellm

gateway-up:
	@url="$(GATEWAY_URL_$(PROFILE))"; \
	if [ -z "$$url" ]; then \
		echo "Unknown PROFILE '$(PROFILE)' — expected litellm, bifrost, or helicone" >&2; \
		exit 1; \
	fi; \
	echo "→ COMPOSE_PROFILES=$(PROFILE) GATEWAY_UPSTREAM_URL=$$url"; \
	COMPOSE_PROFILES=$(PROFILE) GATEWAY_UPSTREAM_URL=$$url docker compose up -d --remove-orphans
