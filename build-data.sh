#!/bin/bash
#
# Fetch the NordVPN WireGuard server list and trim it into the static JSON that
# the page consumes.
#
# Why this exists: api.nordvpn.com sends no CORS headers (verified: no
# Access-Control-Allow-Origin on any endpoint, OPTIONS preflight returns 405).
# A browser therefore cannot read a response from it. Baking the data into the
# repo at build time makes it same-origin, which sidesteps CORS entirely.
#
# Run by .github/workflows/refresh-data.yml on a schedule, but it is an ordinary
# script -- run it locally any time to refresh data/.
#
# Requires: curl, jq.

set -euo pipefail

API='https://api.nordvpn.com'
WG='wireguard_udp'
# One call returns everything: 8559 servers as of writing, and limit=10000
# returns all of them. If Nord ever exceeds this, the sanity check below fails
# loudly rather than silently shipping a truncated list.
LIMIT=10000

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/data"
mkdir -p "$OUT"

say() { printf '%s\n' "$*" >&2; }
die() { printf 'BUILD FAILED: %s\n' "$*" >&2; exit 1; }

for tool in curl jq; do
	command -v "$tool" >/dev/null || die "missing required tool: $tool"
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- 1. how many should we get? -------------------------------------------
# Ask first, so we can tell "the API returned fewer" from "our limit truncated".
say '==> asking how many WireGuard servers exist'
expected="$(curl -sS --max-time 30 --retry 3 --retry-delay 2 \
	"$API/v1/servers/count?filters%5Bservers_technologies%5D%5Bidentifier%5D=$WG" \
	| jq -r '.count // empty')"
[[ "$expected" =~ ^[0-9]+$ ]] || die "count endpoint did not return a number (API changed?)"
[ "$expected" -gt 0 ] || die "count endpoint reports 0 servers"
say "    expected: $expected"

# --- 2. fetch ---------------------------------------------------------------
say '==> fetching server list'
curl -sS --max-time 180 --retry 3 --retry-delay 5 \
	"$API/v1/servers?filters%5Bservers_technologies%5D%5Bidentifier%5D=$WG&limit=$LIMIT" \
	-o "$tmp/raw.json" || die 'fetch failed'

jq -e 'type == "array"' "$tmp/raw.json" >/dev/null 2>&1 \
	|| die 'response is not a JSON array (API changed?)'
got="$(jq 'length' "$tmp/raw.json")"
say "    received: $got"

# Fail loudly on truncation or a collapsed response. A silently-empty commit is
# the failure mode that turns "stale data" into "site is broken and nobody
# noticed", so treat anything below 90% of expected as fatal.
[ "$got" -gt 0 ] || die 'server list is empty'
if [ "$got" -lt $(( expected * 90 / 100 )) ]; then
	die "got $got servers but expected ~$expected -- refusing to publish a truncated list"
fi
if [ "$got" -ge "$LIMIT" ]; then
	die "hit the limit of $LIMIT; raise LIMIT or add pagination"
fi

# --- 3. trim ----------------------------------------------------------------
# Only the fields the page needs. Full response is ~30 MB; this is ~1 MB, which
# GitHub Pages serves gzipped at roughly 91 KB.
#
#   h = hostname          s = station (endpoint IP -- what goes in Endpoint=)
#   k = server public key  c = ISO country code     n = city
#   p = allows P2P         l = load percentage (volatile; see meta.generated_at)
say '==> trimming'
jq -c '
  [ .[]
    | select(.station != null and .station != "")
    | { h: .hostname,
        s: .station,
        k: ( [ .technologies[]
               | select(.identifier == "wireguard_udp")
               | .metadata[] | select(.name == "public_key") | .value ][0] ),
        c: .locations[0].country.code,
        n: .locations[0].country.city.name,
        p: ( [ .groups[].identifier ] | index("legacy_p2p") != null ),
        l: .load }
    | select(.k != null and .c != null) ]
  | sort_by(.c, .n, .h)
' "$tmp/raw.json" > "$tmp/servers.json"

trimmed="$(jq 'length' "$tmp/servers.json")"
say "    kept:     $trimmed"
[ "$trimmed" -ge $(( got * 90 / 100 )) ] \
	|| die "trim dropped too many records ($got -> $trimmed); field names probably changed"

# --- 4. derive the country list --------------------------------------------
# Derived from the servers we actually kept, not fetched separately, so the
# dropdown can never offer a country with zero servers.
say '==> deriving country list'
curl -sS --max-time 30 --retry 3 "$API/v1/servers/countries" -o "$tmp/countries-raw.json" \
	|| die 'country fetch failed'
jq -e 'type == "array" and length > 0' "$tmp/countries-raw.json" >/dev/null 2>&1 \
	|| die 'country list malformed'

jq -c --slurpfile names "$tmp/countries-raw.json" '
  ( $names[0] | map({ (.code): .name }) | add ) as $lookup
  | group_by(.c)
  | map({ c: .[0].c,
          name: ( $lookup[.[0].c] // .[0].c ),
          count: length,
          p2p: ( map(select(.p)) | length ) })
  | sort_by(.name)
' "$tmp/servers.json" > "$tmp/countries.json"

say "    countries: $(jq 'length' "$tmp/countries.json")"

# --- 5. metadata ------------------------------------------------------------
# generated_at is shown in the UI. Baked data means load figures are only as
# fresh as this timestamp, and users deserve to know that.
jq -n \
	--arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	--argjson servers "$trimmed" \
	--argjson countries "$(jq 'length' "$tmp/countries.json")" \
	'{ generated_at: $at,
	   servers: $servers,
	   countries: $countries,
	   source: "https://api.nordvpn.com/v1/servers" }' > "$tmp/meta.json"

# --- 6. publish -------------------------------------------------------------
# Move into place only after every check passed, so a failed run leaves the
# previous good data intact rather than half-overwriting it.
mv "$tmp/servers.json" "$tmp/countries.json" "$tmp/meta.json" "$OUT/"
say "==> wrote $OUT/{servers,countries,meta}.json"
