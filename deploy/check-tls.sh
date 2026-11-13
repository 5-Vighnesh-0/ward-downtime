#!/bin/sh
# SEC-T-TLS and SEC-T-HDR (design.md §9.3, §12.6) against a running stack: TLS 1.3 only, a certificate from the
# ward CA, the security headers, HTTP redirected, the API reachable through Caddy.
# Usage: deploy/check-tls.sh [host] [https port] [http port] [root_ca.crt]
set -eu
host="${1:-wdb.localhost}"
https="${2:-443}"
http="${3:-80}"
root="${4:-root_ca.crt}"
url="https://$host:$https"
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
curl_() { curl -sS --max-time 10 --resolve "$host:$https:127.0.0.1" --resolve "$host:$http:127.0.0.1" --cacert "$root" "$@"; }

# Caddy may still be getting its first certificate.
i=0
until curl_ -o /dev/null "$url/" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -ge 60 ] && { echo "FAIL no verified HTTPS on $url after 60 s"; exit 1; }
  sleep 1
done

tls() { echo | openssl s_client -connect "127.0.0.1:$https" -servername "$host" -CAfile "$root" -verify_return_error "$@" >/dev/null 2>&1; }
if tls -tls1_3; then ok "TLS 1.3 handshake, certificate verified against the ward root"; else bad "TLS 1.3 handshake"; fi
if tls -tls1_2; then bad "TLS 1.2 was accepted"; else ok "TLS 1.2 refused"; fi

headers=$(curl_ -D - -o /dev/null "$url/" | tr -d '\r' | tr '[:upper:]' '[:lower:]')
has() { if printf '%s\n' "$headers" | grep -q "$1"; then ok "$2"; else bad "$2"; fi; }
has '^strict-transport-security: max-age=31536000' 'HSTS'
has "^content-security-policy: default-src 'self'; script-src 'self';" 'CSP default-src and script-src self'
has "^content-security-policy: .*frame-ancestors 'none'" 'CSP frame-ancestors none'
has "^content-security-policy: .*object-src 'none'" 'CSP object-src none'
has '^x-content-type-options: nosniff' 'X-Content-Type-Options'
has '^referrer-policy: no-referrer' 'Referrer-Policy'
has '^permissions-policy: camera=(), microphone=(), geolocation=()' 'Permissions-Policy'
has '^cross-origin-opener-policy: same-origin' 'COOP'
has '^cache-control: no-cache' 'app shell revalidated (Cache-Control no-cache)'
if printf '%s\n' "$headers" | grep -q '^server:'; then bad 'Server header hidden'; else ok 'Server header hidden'; fi
if printf '%s\n' "$headers" | grep -q "unsafe-inline\|unsafe-eval"; then bad 'CSP has no unsafe-*'; else ok 'CSP has no unsafe-*'; fi

sw=$(curl_ -D - -o /dev/null "$url/sw.js" | tr -d '\r' | tr '[:upper:]' '[:lower:]')
if printf '%s\n' "$sw" | grep -q '^cache-control: no-cache'; then ok 'service worker revalidated'; else bad 'service worker revalidated'; fi

code=$(curl_ -o /dev/null -w '%{http_code}' "$url/api/v1/stream")
if [ "$code" = 401 ]; then ok 'API behind Caddy answers (401 without a session)'; else bad "API behind Caddy answered $code, not 401"; fi

port=""; [ "$https" = 443 ] || port=":$https"
redirect=$(curl_ -o /dev/null -w '%{http_code} %{redirect_url}' "http://$host:$http/x")
case "$redirect" in
  "301 https://$host$port/x"|"308 https://$host$port/x") ok "HTTP redirected to HTTPS ($redirect)" ;;
  *) bad "HTTP not redirected to HTTPS ($redirect)" ;;
esac

exit "$fail"
