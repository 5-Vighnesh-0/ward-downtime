# RB-NET: ward server network isolation (SEC-26, SEC-28)

The ward server talks only to the ward's tablets, the IT jump host, the hospital NTP server and the backup target.
No inbound internet, and outbound blocked by default (design.md §11.1). Do this when the server is set up, before
any outage, and check it at every quarterly drill.

## What the rules do

`deploy/nftables-ward.conf` adds one table, `inet wdb`, that runs before Docker's own rules:

| Direction | Allowed | Everything else |
|---|---|---|
| Into the host | SSH (22) from the jump host; ping from the ward VLAN; replies to the host's own connections | dropped |
| Into the app (published 443 and 80) | from the ward VLAN, IPv4 | dropped |
| Out of the containers | replies only; no container starts a connection out | dropped |
| Out of the host | NTP (UDP 123) to the hospital NTP server; SSH (22) to the backup target | dropped, including DNS and the internet |

Why rules on the host input chain are not enough: Docker diverts traffic for published ports before it reaches the
`INPUT` chain ([Docker: packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/)).
The table therefore filters the `forward` hook too, at a lower priority than Docker's chains, as Docker documents for
its nftables backend ([Docker with nftables](https://docs.docker.com/engine/network/firewall-nftables/)). A drop in
any chain is final, so the table only adds drops and leaves Docker's own accept rules alone. It works the same with
Docker's default iptables backend, which on current distributions is iptables-nft over the same netfilter hooks
(**NOT VERIFIED** on every distribution: run the checks below on the real host).

Also set `WDB_BIND` to the server's LAN address (RB-TLS), so Compose publishes 443 and 80 on that address only.

## Steps

1. Fill in the five values at the top of `deploy/nftables-ward.conf`: the LAN interface (`ip -br link`), the ward
   VLAN, the jump host, the NTP server and the backup target. Use IP addresses: the host has no DNS once this is on.
2. Check the syntax: `sudo nft -c -f deploy/nftables-ward.conf`.
3. Load it with a way back, from a console session (not only over SSH):

   ```bash
   sudo nft -f deploy/nftables-ward.conf && sleep 120 && sudo nft delete table inet wdb
   ```

   If SSH from the jump host still works, press Ctrl-C during the 2 minutes to keep the rules. If you are locked
   out, the table removes itself.
4. Make it survive a reboot: copy the file to `/etc/nftables.d/` (or wherever your distribution's `nftables`
   service reads), include it from `/etc/nftables.conf`, and enable the service. Reboot once and run the checks.
5. Time sync (SEC-28): point chrony or systemd-timesyncd at the NTP server's address. The app also measures each
   tablet's clock offset and alerts on a large one, but ordering never depends on clocks.

## Checks (record the date and result)

- From a tablet on the ward VLAN: `https://<WARD_HOST>/` loads and syncs.
- From a machine on another VLAN: `curl -m 5 https://<WARD_HOST>/` times out.
- From the jump host: SSH works. From any other machine: SSH times out.
- On the ward server: `curl -m 5 https://example.com` fails; `chronyc tracking` (or `timedatectl`) shows the
  clock synchronised; a backup copy to the backup target succeeds.
- Inside a container: `docker compose exec server node -e "fetch('https://example.com').then(()=>console.log('open'),()=>console.log('blocked'))"`
  prints `blocked`.
- `sudo nft list table inet wdb` shows the counters moving on the drop rules you expect.

## Maintenance (updates, image pulls)

The host cannot reach the internet. Either pull and scan images on another machine and move them with
`docker save` / `docker load`, or open outbound HTTPS to the registry for the length of a maintenance window and
remove the rule afterwards. Record either in the change log.

## As tested

2026-11-13, in a throwaway container network namespace (not a ward server): the file parses, loads twice without
duplicating the table, and blocks outbound connections from the host. The inbound, forward and NTP rules need a real
LAN and are checked with the list above.
