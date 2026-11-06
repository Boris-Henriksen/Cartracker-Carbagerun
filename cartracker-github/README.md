# CarTracker

Live GPS tracking for a car with a MikroTik LtAP, with a photo/video gallery and an optional phone system (Asterisk) so people can call the car.

- **Tracking:** live map, routes per day, speed and distance. Public, so friends and family can follow along.
- **Gallery:** photos and videos, uploaded by admins.
- **Phone (PBX):** one phone number with a welcome menu, waiting line with hold music, a party line, and call history.
- **Admin:** overview with setup checklist, phone settings, wrong-code blocking and admin code.

## Install on a server

Requirements: Ubuntu Server 24.04 or newer, and for public access a domain plus a router you can forward ports on.

```bash
git clone https://github.com/<you>/cartracker.git
cd cartracker
sudo bash deploy/install.sh
```

The installer asks a few server questions (public with domain + Let's Encrypt, or local network only; time zone; phone system and its ports; backups) and sets up Node.js, nginx, HTTPS, Asterisk, firewall, fail2ban, automatic updates and daily backups. It ends by printing a **setup address and a one-time setup code**: open it in a browser to choose the admin code, site name, tracking settings, phone and security settings, and to get a ready-made script for the MikroTik. Every setup screen can be skipped and configured later under **Admin**.

Lost the setup code, or it expired after 24 hours? `sudo bash deploy/install.sh --setup-code`

Update later:

```bash
git pull
sudo bash deploy/install.sh                # keeps your answers
sudo bash deploy/install.sh --reconfigure  # ask the questions again
```

### Before going public

- DNS: an A record for your domain pointing to your public IP.
- Router: forward TCP 80 and 443 to the server; with the phone system also UDP 5060 and the voice port range shown in **Admin → Overview**.
- Give the server a fixed LAN IP (DHCP reservation).

## Connect the car

See [docs/mikrotik.md](docs/mikrotik.md). **Admin \u2192 MikroTik** generates the complete RouterOS script (paste it into the MikroTik terminal) and reminds you when a settings change means the router needs the new script.

## Development

Node.js 20+ is required.

```bash
npm ci
cp .env.example .env.local   # set the codes
npm run dev
```

Open http://localhost:3000. Data is stored in `./data` unless `DATA_DIR` is set.

## Project map

- `src/app/` - pages (tracking, gallery, admin) and API routes
- `src/lib/telemetry.ts` - route storage and statistics
- `src/lib/pbx.ts`, `src/lib/pbx-events.ts` - Asterisk config generation, live call state and history
- `src/lib/admin-auth.ts` - admin code and wrong-code blocking
- `deploy/install.sh` - server installer