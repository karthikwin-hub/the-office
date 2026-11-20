#!/usr/bin/env sh
# Builds, backs up, migrates and deploys one target, with no quoting to get wrong. Run it through Infisical, from the environment
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
if [ "$target" = live ] && [ "${GITHUB_ACTIONS:-}" = true ] && [ -z "${BACKUP_AGE_RECIPIENT:-}" ]; then
  echo "BACKUP_AGE_RECIPIENT is not set: in CI the live backup must be encrypted before it is kept as an artifact. Add it as a variable of the live environment." >&2
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
# The control plane is backed up before any migration touches it, and nothing migrates if the backup fails.
# With BACKUP_AGE_RECIPIENT (an age public key) the copy is encrypted to it and the plain one removed; GitHub Actions
# always sets it for live, because a workflow's artifacts are readable by anyone who can read this public repository.
backup="backups/office-$target-$(date -u +%Y-%m-%d-%H-%M-%S).sql"
umask 077
node tools/admin/admin.mjs backup "$backup" --env "$env_name"
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$backup.age" "$backup"
  rm -f "$backup"
  echo "Backed up the control plane to $backup.age (encrypted)."
fi
# Migrations only add (docs/handbook/04-deployment.md, section 7): they run while the previous version still serves.
# DB is the binding, looked up in this target's own block: a database name would be looked up in the account.
wrangler d1 migrations apply DB --remote
wrangler deploy
