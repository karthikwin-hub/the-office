#!/usr/bin/env sh
# Builds, migrates and deploys to the Snilld account, with no quoting to get wrong. Run it through Infisical:
#
#   infisical run --env=dev --silent -- sh tools/admin/deploy.sh          the live app (Part 5, step 2)
#   infisical run --env=dev --silent -- sh tools/admin/deploy.sh demo     the demo, then rebuilds the live app
set -eu
if [ -z "${CLOUDFLARE_API_TOKEN_SNILLD_OFFICE:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN_SNILLD_OFFICE is not in Infisical (project for The Office, environment dev). Add it there, then run this again." >&2
  exit 1
fi
cd "$(dirname "$0")/../.."
if ! command -v pnpm >/dev/null 2>&1; then
  for d in "$HOME"/.local/share/mise/installs/node/*/bin; do [ -x "$d/pnpm" ] && PATH="$d:$PATH"; done
  export PATH
fi
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is not installed. Install Node 22 with mise (mise install), then run this again." >&2; exit 1; }
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_SNILLD_OFFICE"
if [ "${1:-}" = "demo" ]; then
  pnpm run deploy:mock
  pnpm build
else
  pnpm run deploy
fi
