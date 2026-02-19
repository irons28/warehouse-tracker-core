# Fixed Domain Setup (Cloudflare Tunnel)

This runbook configures a stable URL for Warehouse Tracker.

## Example URL
- `https://all4.collenlabs.uk`

## Prerequisites
- Domain is managed in Cloudflare DNS.
- `cloudflared` installed on host machine.
- App runs locally on `http://127.0.0.1:3000`.

## 1) Authenticate Cloudflare CLI
```bash
cloudflared tunnel login
```

## 2) Create or verify tunnel
```bash
cloudflared tunnel list
cloudflared tunnel create wt-all4
```
If tunnel already exists, do not recreate.

## 3) Create config file
Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /Users/<USER>/.cloudflared/<TUNNEL_UUID>.json
ingress:
  - hostname: <SUBDOMAIN>.<YOUR_DOMAIN>
    service: http://127.0.0.1:3000
  - service: http_status:404
```

## 4) Route DNS to tunnel
```bash
cloudflared tunnel route dns wt-all4 <SUBDOMAIN>.<YOUR_DOMAIN>
```

## 5) Start app (one-click)
```bash
./start-tracker.command
```

## 6) Validate
- Desktop: `https://localhost:3443` (or `http://localhost:3000`)
- Public/mobile: `https://<SUBDOMAIN>.<YOUR_DOMAIN>`

## Notes
- Fixed-domain config is machine-specific and is not committed to git.
- If URL fails after setup, wait 1-2 minutes for DNS propagation and retry.
- If startup fails, inspect logs:
  - `logs/server.log`
  - `logs/tunnel.log`
