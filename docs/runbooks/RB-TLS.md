# RB-TLS: ward server, TLS and first setup

Do this before any outage (design.md §11.2). Commands run from the repo root on the ward server.

## Demo or development (one machine)

1. `./deploy/init-secrets.sh` creates the three secrets in `deploy/secrets/` (never committed).
2. `docker compose up -d --build`. The demo step-ca creates its own root on first start, and Caddy gets a
   TLS 1.3 certificate for `WDB_HOST` (default `wdb.localhost`) from it.
   Other ports: `WDB_HTTPS_PORT=8443 WDB_HTTP_PORT=8080 WDB_ORIGIN_PORT=:8443 docker compose up -d`.
3. Trust the root on the test machine (it is public):
   `docker run --rm -v warddowntime_ca_root:/p alpine cat /p/root_ca.crt > root_ca.crt`
4. First admin (the PIN is read from stdin, never typed on the command line):
   `read -rs PIN && printf '%s' "$PIN" | docker compose run --rm -T --no-deps migrate node src/admin-cli.ts add-staff --id S-0001 --role admin --name "First Admin"`
5. Open the app on the first tablet, enroll it, then approve it:
   `docker compose run --rm -T --no-deps migrate node src/admin-cli.ts approve-device --id <deviceId>`
   (the device ID is in `docker compose logs server`, or `SELECT device_id, fingerprint FROM devices`). Compare the
   fingerprint with the code on the tablet. Every later tablet is approved in Admin → Devices.

## Production differences

- The root CA is made on an offline laptop (`step ca init`), and its key stays offline. Only the intermediate key
  and its password go on the server. Replace the demo `step-ca` volume with that setup before go-live.
- Set `WDB_HOST` to the ward name (e.g. `wdb.ward-a.hospital.internal`, a placeholder), `WDB_BIND` to the
  server's LAN address, and keep secrets in `/etc/wdb/secrets` (mode 0400) via `WDB_SECRETS_DIR`.
- DNS: an A record in hospital DNS **and** a hosts entry or MDM DNS override on every tablet.
- Push the root to tablets with MDM. On iPadOS install the profile **and** turn on full trust in
  Settings → General → About → Certificate Trust Settings.
- Postgres data lives on the host's encrypted (LUKS) disk (§9.9). Host firewall rules: §11.1.

## Check (every quarterly drill)

- `curl --cacert root_ca.crt https://<host>/` returns 200 with the CSP and HSTS headers.
- `openssl s_client -connect <host>:443 -tls1_2` **fails** with `protocol version`; `-tls1_3` succeeds.
- On a tablet: padlock shown, `isSecureContext` is true, the app works with the hospital uplink unplugged.
- Root expires in 10 years and the intermediate in 1 year: check both dates.
