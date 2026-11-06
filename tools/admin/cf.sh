#!/usr/bin/env sh
# Runs wrangler in apps/api with the Snilld account's deploy token, without quoting. Run it through Infisical:
#
#   infisical run --env=dev --silent -- sh tools/admin/cf.sh whoami
#   infisical run --env=dev --silent -- sh tools/admin/cf.sh d1 create office --location apac
set -eu
if [ -z "${CLOUDFLARE_API_TOKEN_SNILLD_OFFICE:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN_SNILLD_OFFICE is not in Infisical (project for The Office, environment dev). Add it there, then run this again." >&2
  exit 1
fi
cd "$(dirname "$0")/../../apps/api"
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_SNILLD_OFFICE" exec ./node_modules/.bin/wrangler "$@"
