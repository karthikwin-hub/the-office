#!/usr/bin/env sh
# Builds, migrates and deploys one target, with no quoting to get wrong. Run it through Infisical, from the environment
# that holds that target's secrets (docs/handbook/05-configuration.md, section 3):
#
#   infisical run --env=staging --silent -- sh tools/admin/deploy.sh staging   the staging Worker, its own D1 and R2
#   infisical run --env=prod --silent -- sh tools/admin/deploy.sh live         the live app (Part 5, step 2)
#   infisical run --env=prod --silent -- sh tools/admin/deploy.sh demo         the demo, then rebuilds the live app
#
# .github/workflows/deploy.yml runs the same script, with the token from the GitHub environment's secrets.
set -eu

usage() {
  echo "Usage: sh tools/admin/deploy.sh staging|live|demo (run through infisical run --env=staging or --env=prod)" >&2
  exit 2
}

# Each target has its own token, so a token from the wrong Infisical environment deploys nothing.
case "${1:-}" in
  staging) token_name=CLOUDFLARE_API_TOKEN_OFFICE_STAGING infisical_env=staging env_name=staging ;;
  live) token_name=CLOUDFLARE_API_TOKEN_SNILLD_OFFICE infisical_env=prod env_name= ;;
  demo) token_name=CLOUDFLARE_API_TOKEN_SNILLD_OFFICE infisical_env=prod env_name= ;;
  *) usage ;;
esac
target=$1

token=$(printenv "$token_name" || true)
if [ -z "$token" ]; then
  echo "$token_name is not set. Run this through infisical run --env=$infisical_env (project for The Office), or add it there first." >&2
  exit 1
fi
cd "$(dirname "$0")/../.."
if [ "$target" = staging ] && grep -q REPLACE_WITH_ apps/api/wrangler.jsonc; then
  echo "env.staging in apps/api/wrangler.jsonc still has REPLACE_WITH_ placeholders. Fill them in first (docs/handbook/04-deployment.md, section 7)." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  for d in "$HOME"/.local/share/mise/installs/node/*/bin; do [ -x "$d/pnpm" ] && PATH="$d:$PATH"; done
  export PATH
fi
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is not installed. Install Node 22 with mise (mise install), then run this again." >&2; exit 1; }
export CLOUDFLARE_API_TOKEN="$token"

# Always names the environment: an empty one is the top level, live.
wrangler() {
  (cd apps/api && ./node_modules/.bin/wrangler "$@" --env "$env_name")
}

if [ "$target" = demo ]; then
  pnpm run deploy:mock
  pnpm build
  exit 0
fi

pnpm build
# DB is the binding, looked up in this target's own block: a database name would be looked up in the account.
wrangler d1 migrations apply DB --remote
wrangler deploy
