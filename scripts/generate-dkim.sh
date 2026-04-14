#!/usr/bin/env bash
# Generate a DKIM key pair for MailChannels.
# - Outputs the public key as a DNS TXT record you paste into Cloudflare.
# - Outputs the private key as a single-line string you feed to
#   `wrangler secret put DKIM_PRIVATE_KEY`.
#
# Usage: ./scripts/generate-dkim.sh [selector]
#   selector defaults to "mailchannels"
set -euo pipefail

SELECTOR="${1:-mailchannels}"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

openssl genrsa -out "$TMPDIR/private.pem" 2048 2>/dev/null
openssl rsa -in "$TMPDIR/private.pem" -pubout -out "$TMPDIR/public.pem" 2>/dev/null

PUB=$(grep -v '^-----' "$TMPDIR/public.pem" | tr -d '\n')
# Private key as single line for `wrangler secret put` stdin
PRIV=$(grep -v '^-----' "$TMPDIR/private.pem" | tr -d '\n')

cat <<EOF
============================================================
DNS record (add to Cloudflare, zone: jxnfilm.club)
------------------------------------------------------------
Type:   TXT
Name:   ${SELECTOR}._domainkey
Value:  v=DKIM1; k=rsa; p=${PUB}
TTL:    Auto
============================================================

Wrangler secret (production):
  npx wrangler secret put DKIM_PRIVATE_KEY
  # paste this (single line) when prompted:
  ${PRIV}

Wrangler secret (staging):
  npx wrangler secret put DKIM_PRIVATE_KEY --env staging
EOF
