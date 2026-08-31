# Neocities → Hetzner Migration Design

**Status:** design approved section-by-section in chat; pending final review of this written spec

## Goal

Move quaint-lab from Neocities hosting to a self-hosted Hetzner VPS with zero
visible downtime during the DNS cutover, and add secure remote access to the
Studio admin tool (currently `localhost:3001`-only) via Tailscale, without
exposing it to the public internet.

## Non-goals

- No change to the Eleventy build process, content authoring workflow, or
  Studio's feature set.
- No CI/CD pipeline. Builds stay local; only the deploy transport changes.
- No custom domain registration — the existing domain (currently pointed at
  Neocities) is reused as-is.
- No multi-server / load-balanced setup. A single small VPS is sufficient
  for a personal static site.

## Current state

- Static site built locally via `npm run build` (thumbnail generation +
  Eleventy) and pushed to Neocities via `npm run push`, which calls the
  Neocities API using a key stored in a gitignored `.env`.
- Custom domain already owned, DNS currently pointed at Neocities.
- Studio (`studio/server.js`) is a zero-dependency Node `http` server used
  locally as a private admin tool. It has no authentication — it has only
  ever been reachable at `localhost:3001`, which was an adequate boundary
  because nothing else could reach it.
- `studio/server.js:719` calls `.listen(PORT, ...)` with no explicit host,
  which binds to all interfaces (`0.0.0.0`). This is harmless on a laptop
  but would expose Studio to the public internet if run as-is on a VPS —
  this must be fixed as part of this migration, not left as a follow-up.

## Architecture overview

```
                     ┌─────────────────────────────┐
  Public internet ───┼──► Caddy :443 ──► dist/ (static files)
  (yourdomain.com)    │                              │
                     │   Hetzner VPS (Ubuntu LTS)    │
                     │                              │
  Tailscale-only ────┼──► Caddy (tailnet IP) :8443   │
  (100.x.y.z:8443)    │        │                     │
                     │        ▼                     │
                     │   Studio (127.0.0.1:3001)     │
                     └─────────────────────────────┘

  Local dev machine ──rsync over SSH──► /var/www/quaint-lab on the VPS
```

Two independent traffic paths through the same Caddy instance:
1. Public HTTPS on the real domain → static files. This is the entire
   public-facing surface.
2. Tailscale-only HTTPS on the server's tailnet IP → reverse-proxied to
   Studio, which itself only listens on `127.0.0.1`. This path is
   unreachable from the public internet even if Tailscale were somehow
   bypassed, because Studio's own bind address rejects non-local
   connections, and the server firewall never opens the relevant ports
   publicly either. Three independent layers (bind address, firewall,
   Tailscale-only network) back each other up.

## Components

### 1. Hetzner VPS provisioning

- CX22 tier (2 vCPU / 4GB RAM) — comfortably enough for a static site plus
  Studio, with headroom.
- Ubuntu LTS.
- Initial hardening:
  - Create a non-root sudo user; disable root SSH login.
  - SSH key-only auth; disable password auth.
  - `ufw` firewall: allow only 22 (SSH), 80 and 443 (HTTP/S). Nothing else
    is ever opened publicly — Studio's ports are reachable only over
    Tailscale's own encrypted interface, never through `ufw`-opened ports.

### 2. Caddy — public static site

- Installed as a system package (not Docker — keeps the "no unnecessary
  moving parts" philosophy already established by Studio's zero-dependency
  design).
- `/etc/caddy/Caddyfile` public site block:
  ```
  yourdomain.com {
      root * /var/www/quaint-lab
      file_server
  }
  ```
- Caddy obtains and renews the Let's Encrypt certificate automatically on
  first request to that domain — no certbot, no manual renewal cron.

### 3. Deploy transport

- Local build workflow is unchanged: `npm run build` (thumbnails +
  Eleventy) still produces `dist/`.
- `npm run push`'s final step changes from the Neocities API call to two
  rsync targets — the built static site, and the source tree Studio needs
  to operate on (it reads/writes `src/posts/**`, `src/images/**`, etc.
  directly, so `dist/` alone isn't enough for it to function on the
  server):
  ```
  rsync -avz --delete dist/ deploy@yourserver:/var/www/quaint-lab/
  rsync -avz --delete \
    --exclude .git --exclude node_modules --exclude dist \
    ./ deploy@yourserver:/srv/quaint-lab-src/
  ```
- `--delete` on both keeps the server an exact mirror of what's local, so
  removed files don't linger as orphans on either side. A plain second
  rsync call was chosen over installing git + running `git pull` on the
  server: one deploy mechanism (rsync over SSH) for everything, no git
  auth/config to maintain server-side, and it's already exactly what the
  `dist/` push does today.
- Auth: a dedicated SSH keypair for deploys, added to the `deploy` user's
  `authorized_keys` on the server. The Neocities API key in `.env` is
  removed once Neocities is retired (Cutover step 6).

### 4. Studio bind-address fix

- `studio/server.js:719`: change `.listen(PORT, ...)` to
  `.listen(PORT, '127.0.0.1', ...)`. This is a one-line change but a load-
  bearing one — without it, Studio would be reachable from the public
  internet on the VPS regardless of any firewall/Tailscale setup, since a
  process bound to `0.0.0.0` accepts connections on every interface
  including the public one.

### 5. Tailscale

- Installed on the VPS, joined to the user's existing personal tailnet.
  Server receives a stable tailnet IP (`100.x.y.z`) and, via MagicDNS, a
  friendly hostname (e.g. `hetzner-box`).
- Reachable only from other devices already authorized on that same
  tailnet (laptop, phone) — not from the public internet under any
  circumstance, by Tailscale's own design (WireGuard-based private mesh).

### 6. Caddy — Tailscale-only reverse proxy to Studio

- A second Caddy site block, bound specifically to the server's Tailscale
  interface IP (not the public one):
  ```
  100.x.y.z:8443 {
      reverse_proxy 127.0.0.1:3001
  }
  ```
- Accessed as `https://hetzner-box:8443` (via MagicDNS) from any tailnet
  device — no SSH session required to use Studio day-to-day.

### 7. Studio as an always-on service

- A systemd unit, e.g. `/etc/systemd/system/quaint-studio.service`:
  ```ini
  [Unit]
  Description=Quaint Lab Studio
  After=network.target

  [Service]
  ExecStart=/usr/bin/node /srv/quaint-lab-src/studio/server.js
  Restart=on-failure
  User=deploy
  WorkingDirectory=/srv/quaint-lab-src

  [Install]
  WantedBy=multi-user.target
  ```
- Enabled (`systemctl enable --now quaint-studio`), so it starts on boot
  and restarts automatically if it crashes. Studio is simply always
  available over Tailscale, matching how it's always available at
  `localhost:3001` today.
- `WorkingDirectory` and `ExecStart` point at `/srv/quaint-lab-src`, the
  second rsync target from section 3 — kept in sync on every deploy, since
  Studio reads/writes that source tree directly and is distinct from the
  public `dist/` webroot.

## Cutover sequence (zero-downtime)

1. **Pre-stage** everything above while DNS still points at Neocities.
   Verify the Hetzner setup works by hitting the server directly — either
   `curl -H "Host: yourdomain.com" http://<server-ip>` or a temporary
   `/etc/hosts` entry on the local machine pointing the domain at the
   server's IP, so the real site can be browsed normally before any public
   DNS change.
2. **Lower DNS TTL** at the registrar a day or so ahead of cutover (e.g. to
   300s), so the eventual record change propagates in minutes.
3. **Flip DNS**: update A/AAAA record(s) to the Hetzner server's IP,
   removing the Neocities-pointing record.
4. **Verify externally**: check propagation via a couple of DNS-checker
   services, then `curl -I https://yourdomain.com` from more than one
   network (e.g. phone on cellular, not just home wifi) to confirm both
   the certificate and the content are correct.
5. **Burn-in period**: leave the Neocities copy untouched for a few days
   after cutover as an instant rollback path. If anything is wrong with
   the new setup, reverting the DNS record instantly restores the old
   working site while the issue is debugged.
6. **Retire Neocities**: once confident (a week is ample), stop running
   the Neocities step of the deploy workflow and remove the Neocities API
   key from `.env`. Deleting the dormant Neocities site itself is optional
   and has no bearing on the new setup either way.

## Error handling / rollback

- **Before step 6**: rollback is "point DNS back at Neocities" — nothing
  destructive has happened to the Neocities copy, so this is instant and
  safe at any point in steps 3–5.
- **After step 6**: rollback would mean re-adding the Neocities API key
  and re-running the old push step against whatever `dist/` is current —
  slower, but still possible since nothing about Neocities' hosting
  capability is deleted by retiring the workflow (only by deleting the
  Neocities site itself, which step 6 treats as optional).
- **Studio service failure on the server**: systemd's `Restart=on-failure`
  handles crashes automatically; a full server failure just means Studio
  is briefly unreachable until manual intervention — it has no bearing on
  the public static site, which is served independently by Caddy from
  files already on disk.

## Testing / verification checklist

- [ ] Server reachable via raw IP + Host header before any DNS change.
- [ ] Caddy serves valid HTTPS for the real domain once DNS is flipped
      (verified from 2+ independent networks).
- [ ] `rsync` deploy round-trip: change a file locally, run the deploy
      step, confirm the change appears on the live site.
- [ ] Studio reachable at `https://hetzner-box:8443` from a Tailscale-
      joined device.
- [ ] Studio **not** reachable from a non-Tailscale network — verified by
      attempting `curl http://<server-public-ip>:3001` and
      `curl https://<server-public-ip>:8443` from an outside network and
      confirming both are refused/timeout (proves the firewall, not just
      the bind address, is doing its job).
- [ ] `systemctl status quaint-studio` shows active/enabled after a server
      reboot (confirms boot-start works, not just the initial manual
      start).
