#!/bin/sh
# Throwaway self-signed certificate for E2E over HTTPS (like production behind Caddy). Made per run, never committed.
set -e
dir="$(dirname "$0")/.tls"
mkdir -p "$dir"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj /CN=localhost \
  -addext subjectAltName=DNS:localhost -keyout "$dir/key.pem" -out "$dir/cert.pem" 2>/dev/null
