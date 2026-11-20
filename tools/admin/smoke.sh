#!/usr/bin/env sh
# The checks after every release (docs/security/README.md, "How it is checked"), against one address. Reads only; needs
# no secret. Exits 1 if any check fails. .github/workflows/deploy.yml runs it after each deploy.
#
#   sh tools/admin/smoke.sh https://app.office.snilld.in
#   sh tools/admin/smoke.sh https://the-office-staging.<subdomain>.workers.dev
set -eu
base=${1:-}
case "$base" in
  https://* | http://localhost:* | http://127.0.0.1:*) base=${base%/} ;;
  *) echo "Usage: sh tools/admin/smoke.sh https://<host>" >&2; exit 2 ;;
esac
tries=${SMOKE_TRIES:-12}
failed=0

status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$@" 2>/dev/null || echo 000
}
check() {
  if [ "$3" = "$2" ]; then echo "ok    $1"; else echo "FAIL  $1: expected $2, got $3"; failed=1; fi
}

# A new version can take a few seconds to answer everywhere.
i=1
while [ "$(status "$base/api/health")" != 200 ] && [ "$i" -lt "$tries" ]; do
  sleep 5
  i=$((i + 1))
done
check "health" 200 "$(status "$base/api/health")"
check "office without a session" 401 "$(status "$base/api/office")"
check "forged media link" 404 "$(status "$base/media/off_aaaaaaaaaaaaaaaa/none?exp=1&sig=forged")"
check "POST from another origin" 403 "$(status -X POST -H 'content-type: application/json' -H 'origin: https://example.com' -d '{}' "$base/api/offices")"
headers=$(curl -sS -D - -o /dev/null --max-time 20 "$base/" 2>/dev/null || true)
for h in content-security-policy strict-transport-security x-frame-options x-content-type-options; do
  if printf '%s\n' "$headers" | grep -qi "^$h:"; then echo "ok    header $h"; else echo "FAIL  header $h missing on /"; failed=1; fi
done
exit "$failed"
