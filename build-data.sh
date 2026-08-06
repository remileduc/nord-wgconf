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
# Only what a plain subscription can reach: dedicated IP is a paid add-on,
# double VPN and onion need more than our single-hop config. Repeating this
# filter ANDs, so ask for legacy_standard alone -- every legacy_p2p server is
# also legacy_standard, which §2 verifies.
GROUP='legacy_standard'
# One call returns everything: 7327 servers as of writing, and limit=10000
# returns all of them. If Nord ever exceeds this, the sanity check below fails
# loudly rather than silently shipping a truncated list.
LIMIT=10000

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
count_group() {
	curl -sS --max-time 30 --retry 3 --retry-delay 2 \
		-G "$API/v1/servers/count" \
		--data-urlencode "filters[servers_technologies][identifier]=$WG" \
		--data-urlencode "filters[servers_groups][identifier]=$1" \
		| jq -r '.count // empty'
}
expected="$(count_group "$GROUP")"
[[ "$expected" =~ ^[0-9]+$ ]] || die "count endpoint did not return a number (API changed?)"
[ "$expected" -gt 0 ] || die "count endpoint reports 0 servers in $GROUP"
say "    expected: $expected"

# --- 2. fetch ---------------------------------------------------------------
say '==> fetching server list'
curl -sS --max-time 180 --retry 3 --retry-delay 5 \
	-G "$API/v1/servers" \
	--data-urlencode "filters[servers_technologies][identifier]=$WG" \
	--data-urlencode "filters[servers_groups][identifier]=$GROUP" \
	--data-urlencode "limit=$LIMIT" \
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

# A retired group identifier is ignored, not rejected: the response is then the
# whole fleet, and every count check above still agrees with itself.
off="$(jq --arg g "$GROUP" '[ .[] | select(([ .groups[].identifier ] | index($g)) == null) ] | length' "$tmp/raw.json")"
[ "$off" -eq 0 ] \
	|| die "$off of $got servers are not in $GROUP -- the group filter was ignored (group retired?)"

# $GROUP covers every p2p server only while p2p stays a subset of it. Counted
# after the fetch so churn during those minutes does not read as a break.
expected_p2p="$(count_group legacy_p2p)"
[[ "$expected_p2p" =~ ^[0-9]+$ ]] || die "count endpoint did not return a number for legacy_p2p"
[ "$expected_p2p" -gt 0 ] || die "count endpoint reports 0 servers in legacy_p2p"
got_p2p="$(jq '[ .[] | select([.groups[].identifier] | index("legacy_p2p")) ] | length' "$tmp/raw.json")"
say "    p2p:      $got_p2p of $expected_p2p"
# Only a shortfall is a break; a surplus is the race.
if [ "$got_p2p" -lt "$expected_p2p" ]; then
	die "$GROUP contains $got_p2p p2p servers but the API reports $expected_p2p; p2p is no longer a subset of $GROUP -- fetch it separately and merge"
fi

# Groups are capabilities, not constraints: a server in $GROUP is reachable the
# standard way whatever else it carries, so extras are kept. Only worth a note --
# today it never fires, and if it starts to, someone should look at why.
extra="$(jq --arg g "$GROUP" '[ .[] | select(([ .groups[] | select(.type.identifier == "legacy_group_category") | .identifier ] - [$g, "legacy_p2p"]) != []) ] | length' "$tmp/raw.json")"
[ "$extra" -eq 0 ] || say "    note: $extra server(s) also in a group beyond standard/p2p -- kept"

# --- 3. trim ----------------------------------------------------------------
# Only the fields the page needs. Full response is ~29 MB; this is ~0.9 MB, which
# GitHub Pages serves gzipped at roughly 68 KB.
#
#   h = hostname          s = station (endpoint IP -- what goes in Endpoint=)
#   k = server public key  c = ISO country code     n = city
#   p = allows P2P
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
        p: ( [ .groups[].identifier ] | index("legacy_p2p") != null ) }
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
# generated_at is shown in the UI. Baked data means the server list is only as
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
