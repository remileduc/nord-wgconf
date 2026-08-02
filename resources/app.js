/*
 * NordVPN -> WireGuard config generator.
 *
 * Vanilla JS, no dependencies, no network calls except to fetch the static JSON
 * committed alongside this file. Nothing entered here is transmitted anywhere:
 * there is no backend to transmit it to.
 */
'use strict';

const NORD_DNS = '103.86.96.100, 103.86.99.100';
const WG_PORT = 51820;
const TUNNEL_ADDR = '10.5.0.2/32';   // NordVPN assigns every client this address
const MAX_SERVERS = 5;

const state = {
  servers: [],
  countries: [],
  meta: null,
  country: null,     // ISO code, or null for "any"
  server: null,
  key: '',
};

/* ---------------------------------------------------------- preferences -- */

const PREFS_KEY = 'wgconf.prefs.v1';
const PREF_CHECKBOXES = ['p2p', 'opt-dns', 'opt-v6', 'opt-keepalive', 'opt-table'];

/* Only non-secret UI state is persisted: the chosen country and the checkboxes.
 *
 * The private key is deliberately NOT stored, and this is not an oversight.
 * localStorage is plaintext on disk, has no expiry, and is scoped to the ORIGIN
 * rather than the path -- so on GitHub Pages every project page under the same
 * username.github.io shares this storage and could read it back. See the README
 * section "Why the private key is not saved". */

function savePrefs() {
  const prefs = { country: state.country };
  for (const id of PREF_CHECKBOXES) prefs[id] = document.getElementById(id).checked;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {
    // Private browsing, storage disabled, or quota exceeded. Preferences are a
    // convenience; failing to save one must never break the page.
  }
}

function readPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;   // unreadable or corrupt -- fall back to defaults
  }
}

function forgetPrefs() {
  try {
    localStorage.removeItem(PREFS_KEY);
  } catch (e) {
    // nothing useful to do; the next save will overwrite anyway
  }
}

/* Restore saved settings, falling back to defaults for anything missing or no
   longer valid. Returns true if something was restored. */
function applyPrefs() {
  const prefs = readPrefs();
  if (!prefs) {
    preselectFromLocale();
    return false;
  }

  // Checkboxes first: the country list is filtered by the P2P flag, so that
  // filter has to be in place before the saved country is validated against it.
  for (const id of PREF_CHECKBOXES) {
    if (typeof prefs[id] === 'boolean') document.getElementById(id).checked = prefs[id];
  }

  if (prefs.country === null) {
    // "Any country" was an explicit choice. Honour it rather than re-guessing
    // from the locale, which would silently override the user.
    renderCountryHint();
  } else if (typeof prefs.country === 'string') {
    // A saved country can stop being valid: NordVPN retires locations, and the
    // P2P filter may now exclude it.
    const saved = state.countries.find((c) => c.c === prefs.country);
    const usable = saved && (!document.getElementById('p2p').checked || saved.p2p > 0);
    if (usable) selectCountry(saved, false);
    else preselectFromLocale();
  } else {
    preselectFromLocale();
  }
  return true;
}

/* ------------------------------------------------------------------ data -- */

async function load() {
  const metaLine = document.getElementById('meta');
  try {
    const [servers, countries, meta] = await Promise.all(
      ['data/servers.json', 'data/countries.json', 'data/meta.json'].map(async (p) => {
        const r = await fetch(p);
        if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
        return r.json();
      })
    );
    state.servers = servers;
    state.countries = countries;
    state.meta = meta;

    metaLine.textContent =
      `${meta.servers.toLocaleString()} WireGuard servers in ${meta.countries} countries. ` +
      `Snapshot taken ${new Date(meta.generated_at).toLocaleString()}.`;

    initCombo();
    applyPrefs();      // falls back to preselectFromLocale() when nothing is saved
    renderServers();
  } catch (e) {
    metaLine.textContent = `Could not load server data (${e.message}). ` +
      'If you opened this file directly, serve it over HTTP instead: python3 -m http.server';
  }
}

/* Guess a sensible default country from the browser locale. This is a hint, not
   geolocation -- no network call, nothing leaves the page, and the user can
   override it. navigator.language is often "fr-FR"; the region subtag is what
   we want. */
function preselectFromLocale() {
  const tags = navigator.languages && navigator.languages.length
    ? navigator.languages : [navigator.language || ''];
  for (const tag of tags) {
    const region = (tag.split('-')[1] || '').toUpperCase();
    const hit = state.countries.find((c) => c.c === region);
    if (hit) { selectCountry(hit, false); return; }
  }
  renderCountryHint();
}

/* ------------------------------------------------------------- combobox -- */

let comboIndex = -1;

function initCombo() {
  const input = document.getElementById('country');
  const list = document.getElementById('country-list');

  input.addEventListener('input', () => { state.country = null; openCombo(); renderServers(); });
  input.addEventListener('focus', openCombo);
  input.addEventListener('blur', () => setTimeout(closeCombo, 150)); // let clicks land
  input.addEventListener('keydown', onComboKey);
  document.getElementById('country-clear').addEventListener('click', () => {
    input.value = ''; state.country = null; closeCombo(); renderCountryHint(); renderServers();
    savePrefs();   // clearing is an explicit "any country", worth remembering
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-code]');
    if (li) selectCountry(state.countries.find((c) => c.c === li.dataset.code));
  });
}

function matches() {
  const q = document.getElementById('country').value.trim().toLowerCase();
  const p2pOnly = document.getElementById('p2p').checked;
  const pool = p2pOnly ? state.countries.filter((c) => c.p2p > 0) : state.countries;
  if (!q) return pool;
  // Prefix matches first -- typing "in" should offer India before Argentina.
  const starts = [], contains = [];
  for (const c of pool) {
    const n = c.name.toLowerCase();
    if (n.startsWith(q) || c.c.toLowerCase() === q) starts.push(c);
    else if (n.includes(q)) contains.push(c);
  }
  return starts.concat(contains);
}

function openCombo() {
  const list = document.getElementById('country-list');
  const p2pOnly = document.getElementById('p2p').checked;
  const items = matches();
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<li class="empty" role="presentation">No match</li>';
  } else {
    for (const c of items) {
      const li = document.createElement('li');
      li.role = 'option';
      li.dataset.code = c.c;
      const n = p2pOnly ? c.p2p : c.count;
      li.innerHTML = `<span>${esc(c.name)}</span><span class="count">${n}</span>`;
      list.append(li);
    }
  }
  comboIndex = -1;
  list.hidden = false;
  document.getElementById('country').setAttribute('aria-expanded', 'true');
}

function closeCombo() {
  document.getElementById('country-list').hidden = true;
  document.getElementById('country').setAttribute('aria-expanded', 'false');
  comboIndex = -1;
}

function onComboKey(e) {
  const list = document.getElementById('country-list');
  const opts = [...list.querySelectorAll('li[data-code]')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (list.hidden) return openCombo();
    comboIndex += e.key === 'ArrowDown' ? 1 : -1;
    if (comboIndex < 0) comboIndex = opts.length - 1;
    if (comboIndex >= opts.length) comboIndex = 0;
    opts.forEach((o, i) => o.classList.toggle('active', i === comboIndex));
    if (opts[comboIndex]) opts[comboIndex].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const pick = opts[comboIndex] || (opts.length === 1 ? opts[0] : null);
    if (pick) selectCountry(state.countries.find((c) => c.c === pick.dataset.code));
  } else if (e.key === 'Escape') {
    closeCombo();
  }
}

/* persist=false is used when restoring or guessing, so that merely loading the
   page never writes storage the user did not ask for. */
function selectCountry(c, persist = true) {
  if (!c) return;
  state.country = c.c;
  document.getElementById('country').value = c.name;
  closeCombo();
  renderCountryHint();
  renderServers();
  if (persist) savePrefs();
}

function renderCountryHint() {
  const hint = document.getElementById('country-hint');
  if (state.country) {
    const c = state.countries.find((x) => x.c === state.country);
    hint.textContent = `${c.count} servers, ${c.p2p} allow P2P.`;
  } else {
    // Honest about the limitation: NordVPN's real "recommended" endpoint scores
    // by proximity too, and we cannot call it from a static page.
    hint.textContent = 'No country selected — showing the least-loaded servers worldwide, ' +
      'which may be far from you.';
  }
}

/* -------------------------------------------------------------- servers -- */

function renderServers() {
  const box = document.getElementById('servers');
  let pool = state.servers;
  if (state.country) pool = pool.filter((s) => s.c === state.country);
  if (document.getElementById('p2p').checked) pool = pool.filter((s) => s.p);

  const top = pool.slice().sort((a, b) => a.l - b.l || a.h.localeCompare(b.h)).slice(0, MAX_SERVERS);

  if (!top.length) {
    box.innerHTML = '<p class="hint">No servers match. Try clearing the P2P filter.</p>';
    state.server = null;
    return build();
  }

  box.innerHTML = '';
  for (const s of top) {
    const id = `srv-${s.h}`;
    const el = document.createElement('label');
    el.className = 'server';
    el.innerHTML =
      `<input type="radio" name="server" id="${esc(id)}" value="${esc(s.h)}">
       <span class="name">${esc(s.h)}</span>
       <span class="where">${esc(s.n)}, ${esc(s.c)}</span>
       <span class="ip">${esc(s.s)}</span>
       <span class="load" title="Load at snapshot time">${s.l}%</span>
       ${s.p ? '<span class="tag">P2P</span>' : ''}`;
    box.append(el);
  }
  // Preselect the least loaded so the page is useful with one click.
  const first = box.querySelector('input[type=radio]');
  if (first) { first.checked = true; state.server = top[0]; }
  build();
}

/* --------------------------------------------------------------- config -- */

function validKey(k) {
  // WireGuard keys are 32 bytes base64 -> 44 chars ending in '='.
  return /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw]=$/.test(k);
}

function build() {
  const key = document.getElementById('privkey').value.trim();
  const hint = document.getElementById('key-hint');
  if (!key) hint.textContent = '';
  else if (validKey(key)) hint.textContent = '✓ looks like a valid key';
  else hint.textContent = '⚠ that does not look like a 44-character WireGuard key';
  hint.className = 'hint ' + (!key ? '' : validKey(key) ? 'ok' : 'bad');

  const out = document.getElementById('config');
  const copyBtn = document.getElementById('copy-config');
  const downloadBtn = document.getElementById('download');

  if (!state.server || !key) {
    out.textContent = 'Choose a server and paste your private key.';
    copyBtn.disabled = true;
    downloadBtn.disabled = true;
    return;
  }

  const s = state.server;
  const allowed = document.getElementById('opt-v6').checked ? '0.0.0.0/0, ::/0' : '0.0.0.0/0';

  const lines = [
    '[Interface]',
    `PrivateKey = ${key}`,
    `Address = ${TUNNEL_ADDR}`,
  ];
  if (document.getElementById('opt-dns').checked) lines.push(`DNS = ${NORD_DNS}`);
  if (document.getElementById('opt-table').checked) lines.push('Table = off');
  lines.push(
    '',
    `# ${s.h} — ${s.n}, ${s.c}${s.p ? ' — P2P allowed' : ''}`,
    '[Peer]',
    `PublicKey = ${s.k}`,
    `AllowedIPs = ${allowed}`,
    `Endpoint = ${s.s}:${WG_PORT}`
  );
  if (document.getElementById('opt-keepalive').checked) lines.push('PersistentKeepalive = 25');

  out.textContent = lines.join('\n') + '\n';
  copyBtn.disabled = false;
  downloadBtn.disabled = false;
}

/* ----------------------------------------------------------------- misc -- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function copyText(text, btn) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Press Ctrl+C';
  }
  setTimeout(() => { btn.textContent = label; }, 1500);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('p2p').addEventListener('change', () => {
    // The country list is filtered by P2P too, so a stale selection may vanish.
    if (state.country) {
      const c = state.countries.find((x) => x.c === state.country);
      if (!c || !c.p2p) {
        state.country = null;
        document.getElementById('country').value = '';
      }
    }
    renderCountryHint();
    renderServers();
    savePrefs();
  });

  // Delegated once here rather than re-bound on every render: the radios are
  // replaced wholesale by renderServers(), and re-binding leaks listeners.
  // Hostnames are unique across the dataset, so they are a safe key.
  document.getElementById('servers').addEventListener('change', (e) => {
    if (e.target.name !== 'server') return;
    state.server = state.servers.find((s) => s.h === e.target.value) || null;
    build();
  });

  document.getElementById('privkey').addEventListener('input', build);

  // The only reason this form exists: browsers capture credentials on the
  // submit event and nowhere else. preventDefault() suppresses the navigation
  // but not the capture, which is how single-page forms opt in. Pressing Enter
  // in the key field lands here too.
  document.getElementById('key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    build();
  });

  document.getElementById('reveal').addEventListener('click', () => {
    const field = document.getElementById('privkey');
    field.type = field.type === 'password' ? 'text' : 'password';
    document.getElementById('reveal').textContent =
      field.type === 'password' ? 'Show' : 'Hide';
  });

  for (const id of ['opt-dns', 'opt-v6', 'opt-keepalive', 'opt-table']) {
    document.getElementById(id).addEventListener('change', () => { build(); savePrefs(); });
  }

  document.getElementById('forget-prefs').addEventListener('click', () => {
    forgetPrefs();
    document.getElementById('prefs-status').textContent =
      'Cleared. Defaults return on reload.';
  });

  document.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', () =>
      copyText(document.getElementById(b.dataset.copy).textContent, b)));

  document.getElementById('copy-config').addEventListener('click', (e) =>
    copyText(document.getElementById('config').textContent, e.target));

  document.getElementById('download').addEventListener('click', () => {
    const blob = new Blob([document.getElementById('config').textContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wg0.conf';
    a.click();
    // Revoke promptly: the blob holds a private key in memory.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  load();
});
