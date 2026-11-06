#!/usr/bin/env sh
# Creates the live Worker's required secrets in Infisical (if they are missing) and puts them on the Worker.
# Values are generated here and never printed. Run it yourself, from the repository root:
#
#   sh tools/admin/set-secrets.sh
#
# Needs: infisical login, openssl, and the Cloudflare token in Infisical as CLOUDFLARE_API_TOKEN_SNILLD_OFFICE.
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
  infisical run --env="$ENV" --silent -- sh -c "printf %s \"\$$name\" | CLOUDFLARE_API_TOKEN=\"\$CLOUDFLARE_API_TOKEN_SNILLD_OFFICE\" ./node_modules/.bin/wrangler secret put $name" >/dev/null
  echo "$name: put on the live Worker"
done

# Optional, and not generated: TURNSTILE_SECRET comes from the Turnstile widget in the Cloudflare dashboard.
# Add it to Infisical yourself, and TURNSTILE_SITE_KEY to wrangler.jsonc vars; the website chat then asks for the check.
for name in TURNSTILE_SECRET; do
  present=$(infisical run --env="$ENV" --silent -- sh -c "[ -n \"\${$name:-}\" ] && echo yes || echo no")
  if [ "$present" = "yes" ]; then
    infisical run --env="$ENV" --silent -- sh -c "printf %s \"\$$name\" | CLOUDFLARE_API_TOKEN=\"\$CLOUDFLARE_API_TOKEN_SNILLD_OFFICE\" ./node_modules/.bin/wrangler secret put $name" >/dev/null
    echo "$name: put on the live Worker"
  else
    echo "$name: not in Infisical, skipped (optional)"
  fi
done

echo "Secrets on the live Worker now:"
infisical run --env="$ENV" --silent -- sh -c 'CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_SNILLD_OFFICE" ./node_modules/.bin/wrangler secret list' | grep -o '"name": "[A-Z_]*"'
