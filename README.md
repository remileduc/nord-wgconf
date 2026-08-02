# NordVPN → WireGuard config generator

A static page that builds a WireGuard configuration for NordVPN. No backend, no
build step, no dependencies. Deployable to GitHub Pages as-is.

## Why this exists

NordVPN publishes OpenVPN config files but not WireGuard ones, even though their
"NordLynx" protocol *is* WireGuard. Every piece needed to assemble a config is
retrievable, just not in one place:

| Piece | Source |
|---|---|
| Server endpoint IP | `/v1/servers` → `.station` |
| Server public key | `/v1/servers` → `technologies[].metadata[]` |
| Client address | always `10.5.0.2/32` |
| Client private key | `/v1/users/services/credentials`, needs your account token |

This page handles the first three. It deliberately does **not** handle the fourth.

## It never asks for your NordVPN token

Your access token is a credential for your entire NordVPN account, not a
per-config secret. No website should ask you for it, including this one. In
order to get it, you first need to generate an access token through your account:
- connect to your NordVPN account on their website
  <https://my.nordaccount.com/dashboard/nordvpn>
- there you can generate an access token. Save it in a secret place as you can
  only see it once (but you can delete and / or regenerate it)
- use this token instead of `YOUR_TOKEN` in the command below

So step 2 shows you a command to run yourself:

```bash
curl -s -u token:YOUR_TOKEN https://api.nordvpn.com/v1/users/services/credentials \
  | jq -r .nordlynx_private_key
```

You paste the resulting key into the page. It stays in the tab — there is no
server here to send it to, which you can confirm by reading
[`resources/app.js`](./resources/app.js) (the only `fetch()` calls are for
the JSON files in `data/`).

This is not merely a policy choice. `api.nordvpn.com` sends **no CORS headers**
at all, and its preflight `OPTIONS` returns `405`, so browser JavaScript cannot
read a response from it under any circumstances. Any site that offers to do the
token step for you is necessarily routing your credential through a server. Be
wary of that.

## What is remembered, and what is not

Your **country and the Advanced checkboxes** are saved in `localStorage` under
`wgconf.prefs.v1` and restored on your next visit. If a saved country no longer
exists, or the P2P filter now excludes it, the page falls back to guessing from
your browser locale rather than showing an empty selection. "Forget saved
settings" under Advanced clears the lot.

### Why the private key is not saved

`localStorage` is the wrong place for a WireGuard private key as it is stored
as plain text by the browser. This matter much for a checkbox. All of them
matter for a key that authenticates you to a VPN.

### If you do not want to paste it every time

In rough order of preference:

- **Use a dedicated password manager** (KeePassXC, Bitwarden, `pass`). Encrypted
  at rest behind a key you actually have to supply, and it will fill the field.
  This is the recommended answer.
- **Your browser's built-in manager**, with one caveat that matters. The "Ask
  browser to remember" button submits the key field so the manager offers to
  save it. But Firefox's saved logins are recoverable straight from the profile
  directory unless a **Primary Password** is set — `logins.json` plus `key4.db`
  is all a local attacker needs. Set a Primary Password first, or this is barely
  an improvement on `localStorage`. Chrome on Linux is better placed by default,
  since it defers to kwallet or gnome-keyring.
- **Keep the tab open.** The key already persists in the field for the life of
  the page, so switching servers and regenerating costs nothing. The friction
  only appears on reload.
- **`sessionStorage` instead.** Same API, but scoped to the tab and dropped when
  it closes, so nothing is left on disk long-term. A middle ground if reloading
  is what annoys you — ask and it can be added behind an explicit,
  off-by-default checkbox.
- **Encrypting it with a passphrase** via WebCrypto is possible, and mostly
  theatre: the decryption runs in the same JavaScript that would be compromised
  in the scenarios above, and it invites a weak passphrase. Not recommended.

## Installing the result

The downloaded file contains your private key and lands in `~/Downloads` with
default permissions.

```bash
sudo install -m 600 -o root -g root ~/Downloads/wg0.conf /etc/wireguard/wg0.conf
sudo wg-quick up wg0
curl -s https://api.nordvpn.com/v1/helpers/ips/insights \
  | jq -r '"ip=\(.ip) country=\(.country) protected=\(.protected)"'
```

`protected` should flip to `true` and the country should be the server's, not
yours. Run it before bringing the tunnel up too, so you know what changed.

## Notes on the generated config

- **`AllowedIPs`** defaults to `0.0.0.0/0`. NordVPN carries no IPv6 (their API
  reports an empty `ipv6_station` for every server), so any working IPv6 on your
  machine bypasses the tunnel. The "Block IPv6" option adds `::/0` to black-hole
  it instead; that stops the leak but breaks IPv6-only destinations.
- **`Table = off`** is available under Advanced and is off by default. It stops
  `wg-quick` installing any routes at all, which is what you want for split
  tunnelling with your own `ip rule` setup.
- **`DNS`** uses NordVPN's resolvers. Without it your existing resolver keeps
  seeing every domain you look up, even though the traffic itself is tunnelled.
  Note this line requires `resolvconf` or `openresolv` to be installed;
  `wg-quick` shells out to it.

## How the server list gets here

Since the browser cannot call the API, the data is baked in at build time.
[`build-data.sh`](./build-data.sh) fetches and trims it; a scheduled GitHub
Action commits the result. The page reads static JSON from its own origin, so
CORS never enters into it.

```
data/servers.json     8,559 servers, ~1.1 MB (~83 KB gzipped)
data/countries.json   149 countries, derived from servers.json
data/meta.json        snapshot timestamp and counts
```

Trimmed record shape:

```json
{"h":"fr884.nordvpn.com","s":"178.249.212.154","k":"Vkrb…Bk=","c":"FR","n":"Marseille","p":true,"l":12}
```

`h`ostname, `s`tation (endpoint IP), public `k`ey, `c`ountry, city `n`ame,
`p`2p allowed, `l`oad.

**Load figures are a snapshot**, as fresh as `meta.generated_at` and no fresher.
Endpoint IPs and public keys change slowly — there are only ~224 distinct public
keys across all 8,559 servers — so a stale snapshot is unlikely to break a
config. If it does, the symptom is a tunnel that comes up and never handshakes.

For a genuinely live pick, straight from NordVPN with current load and their own
proximity scoring:

```bash
curl -s 'https://api.nordvpn.com/v1/servers/recommendations?filters%5Bservers_technologies%5D%5Bidentifier%5D=wireguard_udp&limit=5' \
  | jq -r '.[] | "\(.hostname)  \(.station)  load=\(.load)"'
```

## Running locally

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

Opening `index.html` via `file://` will not work: the browser blocks `fetch()`
of local files. Any static server will do.

To refresh the data yourself (needs `curl` and `jq`):

```bash
./build-data.sh
```

## Deploying

Push to GitHub, then Settings → Pages → deploy from branch, root. The workflow
in `.github/workflows/refresh-data.yml` keeps `data/` current.

Two caveats:

- Scheduled workflows are **disabled after 60 days of repository inactivity**.
  If the data goes stale, check that first.
- `build-data.sh` exits non-zero on a truncated, empty, or shape-changed
  response and only writes `data/` once all checks pass. A failed run leaves the
  previous good snapshot in place and turns the Actions tab red, rather than
  silently publishing a broken list.

## Data source

Server data comes from NordVPN's public, unauthenticated API at
`api.nordvpn.com/v1/servers` — the same endpoint their own clients use. This
repository redistributes a trimmed snapshot of it. Not affiliated with or
endorsed by NordVPN.

## License

MIT.
