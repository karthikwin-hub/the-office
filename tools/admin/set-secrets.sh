#!/usr/bin/env sh
# Creates the live Worker's required secrets in Infisical (if they are missing) and puts them on the Worker.
# Values are generated here and never printed. Run it yourself, from the repository root:
#
#   sh tools/admin/set-secrets.sh
#
# Needs: infisical login, openssl, and the Cloudflare token in Infisical as CLOUDFLARE_API_TOKEN_OFFICE_AGENTS.
# Setting BETTER_AUTH_SECRET for the first time signs everyone out once.
set -eu

ENV=dev
NAMES="BETTER_AUTH_SECRET SOCIAL_TOKEN_KEY"
cd "$(dirname "$0")/../../apps/api"

for name in $NAMES; do
  present=$(infisical run --env="$ENV" --silent -- sh -c "[ -n \"\${$name:-}\" ] && echo yes || echo no")
  if [ "$present" = "yes" ]; then
    echo "$name: already in Infisical"
  else
    infisical secrets set --env="$ENV" "$name=$(openssl rand -hex 32)" >/dev/null
    echo "$name: created in Infisical"
  fi
done

for name in $NAMES; do
  infisical run --env="$ENV" --silent -- sh -c "printf %s \"\$$name\" | CLOUDFLARE_API_TOKEN=\"\$CLOUDFLARE_API_TOKEN_OFFICE_AGENTS\" ./node_modules/.bin/wrangler secret put $name" >/dev/null
  echo "$name: put on the live Worker"
done

echo "Secrets on the live Worker now:"
infisical run --env="$ENV" --silent -- sh -c 'CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_OFFICE_AGENTS" ./node_modules/.bin/wrangler secret list' | grep -o '"name": "[A-Z_]*"'
