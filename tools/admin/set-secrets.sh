#!/usr/bin/env sh
# Creates a Worker's required secrets in Infisical (if they are missing) and puts them on the Worker.
# Values are generated here and never printed. Run it yourself, from the repository root:
#
#   sh tools/admin/set-secrets.sh live            Infisical environment prod, the live Worker
#   sh tools/admin/set-secrets.sh live --rotate   the same, and makes new values for a required secret missing from prod
#   sh tools/admin/set-secrets.sh staging         Infisical environment staging, the staging Worker (--env staging)
#
# Needs: infisical login, openssl, and the target's Cloudflare token in that Infisical environment
# (CLOUDFLARE_API_TOKEN_SNILLD_OFFICE in prod, CLOUDFLARE_API_TOKEN_OFFICE_STAGING in staging).
# Setting BETTER_AUTH_SECRET for the first time signs everyone out once.
set -eu

case "${1:-}" in
  live) ENV=prod TOKEN=CLOUDFLARE_API_TOKEN_SNILLD_OFFICE WRANGLER_ENV= ;;
  staging) ENV=staging TOKEN=CLOUDFLARE_API_TOKEN_OFFICE_STAGING WRANGLER_ENV=staging ;;
  *) echo "Usage: sh tools/admin/set-secrets.sh live|staging" >&2; exit 2 ;;
esac
NAMES="BETTER_AUTH_SECRET SOCIAL_TOKEN_KEY"
cd "$(dirname "$0")/../../apps/api"

for name in $NAMES; do
  present=$(infisical run --env="$ENV" --silent -- sh -c "[ -n \"\${$name:-}\" ] && echo yes || echo no")
  if [ "$present" = "yes" ]; then
    echo "$name: already in Infisical ($ENV)"
  elif [ "$1" = live ] && [ "${2:-}" != --rotate ]; then
    # A new value on live signs everyone out, makes enrolled authenticators and sealed platform tokens unreadable.
    echo "$name is not in Infisical ($ENV). Copy live's value there from dev first, or run again with --rotate to make a new one (signs everyone out; owners enrol two-step sign-in again; platforms reconnect)." >&2
    exit 1
  else
    infisical secrets set --env="$ENV" "$name=$(openssl rand -hex 32)" >/dev/null
    echo "$name: created in Infisical ($ENV)"
  fi
done

put() {
  infisical run --env="$ENV" --silent -- sh -c "printf %s \"\$$1\" | CLOUDFLARE_API_TOKEN=\"\$$TOKEN\" ./node_modules/.bin/wrangler secret put $1 --env '$WRANGLER_ENV'" >/dev/null
  echo "$1: put on the $2 Worker"
}

for name in $NAMES; do put "$name" "$1"; done

# Not generated, put when present in Infisical. RESEND_API_KEY sends all mail through Resend (from MAIL_FROM); staging
# has a sending-only key of its own, never live's.
# TURNSTILE_SECRET comes from the Turnstile widget in the Cloudflare dashboard; add TURNSTILE_SITE_KEY to wrangler.jsonc vars with it.
for name in RESEND_API_KEY TURNSTILE_SECRET; do
  present=$(infisical run --env="$ENV" --silent -- sh -c "[ -n \"\${$name:-}\" ] && echo yes || echo no")
  if [ "$present" = "yes" ]; then
    put "$name" "$1"
  else
    echo "$name: not in Infisical ($ENV), skipped (optional)"
  fi
done

echo "Secrets on the $1 Worker now:"
infisical run --env="$ENV" --silent -- sh -c "CLOUDFLARE_API_TOKEN=\"\$$TOKEN\" ./node_modules/.bin/wrangler secret list --env '$WRANGLER_ENV'" | grep -o '"name": "[A-Z_]*"'
