#!/usr/bin/env bash
# CarTracker installer for Ubuntu 24.04+. Run from a clone of the repository:
#   sudo bash deploy/install.sh               first install, or update with saved answers
#   sudo bash deploy/install.sh --reconfigure ask all questions again
set -euo pipefail

CONF_DIR=/etc/cartracker
CONF_FILE=$CONF_DIR/install.conf
ENV_FILE=$CONF_DIR/cartracker.env
SERVICE_USER=cartracker
APP_PORT=3000
ACME_ROOT=/var/www/certbot
BACKUP_DIR=/var/backups/cartracker
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RECONFIGURE=no
for arg in "$@"; do
  case "$arg" in
    --reconfigure) RECONFIGURE=yes ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

ask() { # ask VAR "Question" [default]
  local answer
  read -rp "$2${3:+ [$3]}: " answer
  printf -v "$1" '%s' "${answer:-${3-}}"
}

ask_yes_no() { # ask_yes_no VAR "Question" y|n
  local answer hint
  [[ $3 == y ]] && hint="Y/n" || hint="y/N"
  while true; do
    read -rp "$2 [$hint]: " answer
    answer=${answer:-$3}
    case "${answer,,}" in
      y|yes) printf -v "$1" yes; return ;;
      n|no) printf -v "$1" no; return ;;
    esac
  done
}

random_secret() { openssl rand -base64 "$1" | tr -d '/+=\n' | cut -c1-"$2"; }

# Reads KEY from the env file so re-runs keep existing secrets.
env_value() { [[ -f $ENV_FILE ]] && sed -n "s/^$1=//p" "$ENV_FILE" | head -n1 || true; }

lan_address() {
  hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | head -n1 || true
}

# --- Preconditions -----------------------------------------------------------

[[ $EUID -eq 0 ]] || fail "Run with sudo: sudo $0"
. /etc/os-release
[[ ${ID:-} == ubuntu ]] || fail "Only Ubuntu is supported (found ${PRETTY_NAME:-unknown})."
dpkg --compare-versions "$VERSION_ID" ge 24.04 || fail "Ubuntu 24.04 or newer is required (found $VERSION_ID)."
[[ -f $SRC_DIR/package.json ]] || fail "Run this script from inside the CarTracker repository."

ram_mb=$(awk '/MemTotal|SwapTotal/ {sum += $2} END {print int(sum / 1024)}' /proc/meminfo)
(( ram_mb >= 2000 )) || warn "Only ${ram_mb} MB of RAM + swap: building the app may fail. Add swap if it does."
free_mb=$(df -Pm / | awk 'NR == 2 {print $4}')
(( free_mb >= 3000 )) || warn "Only ${free_mb} MB free disk space: photos, videos and backups need room."

# --- Questions -----------------------------------------------------------------

if [[ -f $CONF_FILE && $RECONFIGURE == no ]]; then
  # shellcheck source=/dev/null
  . "$CONF_FILE"
  step "Updating the existing installation (use --reconfigure to change settings)"
  ADMIN_CODE=""
else
  [[ -t 0 ]] || fail "No saved settings found; run interactively to answer the setup questions."
  [[ -f $CONF_FILE ]] && . "$CONF_FILE"
  echo
  echo "CarTracker setup. Press Enter to accept the value in [brackets]."
  echo

  ask APP_DIR "Install folder" "${APP_DIR:-/opt/cartracker}"
  ask DATA_DIR "Data folder (routes, photos, settings)" "${DATA_DIR:-/var/lib/cartracker}"

  echo
  echo "How will the site be reached?"
  echo "  1) Public: through your own domain, with a free HTTPS certificate from Let's Encrypt"
  echo "  2) Local:  only on this network, by IP address (plain HTTP)"
  while true; do
    ask choice "Choose 1 or 2" "$([[ ${MODE:-public} == local ]] && echo 2 || echo 1)"
    case "$choice" in 1) MODE=public; break ;; 2) MODE=local; break ;; esac
  done

  if [[ $MODE == public ]]; then
    echo
    echo "Before continuing: the domain needs a DNS A record pointing to this network's public IP,"
    echo "and the router must forward TCP 80 and 443 to this server."
    while true; do
      ask DOMAIN "Domain for the site (e.g. track.example.com)" "${DOMAIN:-}"
      [[ $DOMAIN =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]] && break
      echo "That doesn't look like a domain name."
    done
    while true; do
      ask EMAIL "Email for certificate expiry notices" "${EMAIL:-}"
      [[ $EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] && break
      echo "That doesn't look like an email address."
    done
    ask_yes_no CLOUDFLARE "Is the domain proxied through Cloudflare (orange cloud)?" "$([[ ${CLOUDFLARE:-no} == yes ]] && echo y || echo n)"
  else
    DOMAIN=""; EMAIL=""; CLOUDFLARE=no
  fi

  echo
  if [[ -f ${DATA_DIR}/admin-code.json ]]; then
    echo "The admin code was changed on the website. Leave empty to keep it, or enter a new one to replace it."
  elif [[ -n $(env_value MEDIA_UPLOAD_TOKEN) ]]; then
    echo "An admin code already exists. Leave empty to keep it (it can also be changed on the site)."
  else
    echo "Admin code: used to log in to the gallery and admin pages. Leave empty to generate one."
  fi
  while true; do
    read -rsp "Admin code (min. 12 characters): " ADMIN_CODE; echo
    [[ -z $ADMIN_CODE ]] && break
    if (( ${#ADMIN_CODE} < 12 )); then echo "Too short."; continue; fi
    read -rsp "Repeat admin code: " repeat; echo
    [[ $ADMIN_CODE == "$repeat" ]] && break
    echo "The codes don't match."
  done

  echo
  ask_yes_no PBX "Install the phone system (Asterisk) for calls to the car?" "$([[ ${PBX:-yes} == no ]] && echo n || echo y)"
  while true; do
    ask BACKUP_DAYS "Keep daily backups for how many days" "${BACKUP_DAYS:-14}"
    [[ $BACKUP_DAYS =~ ^[0-9]+$ ]] && (( BACKUP_DAYS >= 1 )) && break
  done

  install -d -m 700 "$CONF_DIR"
  {
    printf 'APP_DIR=%q\nDATA_DIR=%q\nMODE=%q\nDOMAIN=%q\nEMAIL=%q\nCLOUDFLARE=%q\nPBX=%q\nBACKUP_DAYS=%q\n' \
      "$APP_DIR" "$DATA_DIR" "$MODE" "$DOMAIN" "$EMAIL" "$CLOUDFLARE" "$PBX" "$BACKUP_DAYS"
  } > "$CONF_FILE"
  chmod 600 "$CONF_FILE"
fi

# --- Packages ------------------------------------------------------------------

step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
packages=(ca-certificates curl gnupg openssl rsync nginx ufw fail2ban unattended-upgrades)
[[ $MODE == public ]] && packages+=(certbot)
[[ $PBX == yes ]] && packages+=(asterisk ffmpeg)
apt-get install -y -q "${packages[@]}"

node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if (( $(node_major) < 20 )); then
  step "Installing Node.js 22"
  candidate=$(apt-cache policy nodejs | sed -n 's/^ *Candidate: *\([0-9]*\).*/\1/p' | sed 's/^[0-9]*://')
  if [[ ${candidate:-0} =~ ^[0-9]+$ ]] && (( candidate >= 20 )); then
    apt-get install -y -q nodejs npm
  else
    install -d -m 755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -q
    apt-get install -y -q nodejs
  fi
fi
(( $(node_major) >= 20 )) || fail "Node.js 20 or newer could not be installed."
NODE_BIN=$(command -v node)

# --- App -------------------------------------------------------------------------

step "Setting up the app in $APP_DIR"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 "$DATA_DIR"
install -d -m 755 "$APP_DIR"
if [[ $(realpath "$SRC_DIR") != $(realpath "$APP_DIR") ]]; then
  rsync -a --delete --exclude .git --exclude node_modules --exclude .next --exclude data --exclude '.env*' \
    --exclude .npm-cache "$SRC_DIR"/ "$APP_DIR"/
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

step "Installing dependencies and building (this takes a few minutes)"
build() { sudo -u "$SERVICE_USER" env HOME="$DATA_DIR" npm_config_cache="$APP_DIR/.npm-cache" NEXT_TELEMETRY_DISABLED=1 "$@"; }
(cd "$APP_DIR" && build npm ci --no-audit --no-fund && build npm run build)
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$APP_DIR/.next/cache"

# --- Phone system ------------------------------------------------------------------

ASTERISK_DIRS=(/etc/asterisk/cartracker /var/lib/asterisk/moh/cartracker /var/lib/asterisk/sounds/cartracker)
if [[ $PBX == yes ]]; then
  step "Connecting the phone system (Asterisk)"
  install -d -o "$SERVICE_USER" -g asterisk -m 2750 "${ASTERISK_DIRS[@]}"
  rtp_value() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\([0-9]*\).*/\1/p" /etc/asterisk/rtp.conf 2>/dev/null | head -n1; }
  RTP_START=$(rtp_value rtpstart)
  RTP_END=$(rtp_value rtpend)
  RTP_START=${RTP_START:-10000}
  RTP_END=${RTP_END:-20000}
  for name in pjsip extensions musiconhold queues confbridge; do
    conf="/etc/asterisk/$name.conf"
    line="#tryinclude cartracker/cartracker-$name.conf"
    [[ -f $conf && ! -f $conf.orig ]] && cp -p "$conf" "$conf.orig"
    touch "$conf"
    grep -qxF "$line" "$conf" || printf '\n%s\n' "$line" >> "$conf"
  done

  AMI_SECRET=$(env_value ASTERISK_AMI_SECRET)
  [[ -n $AMI_SECRET ]] || AMI_SECRET=$(random_secret 32 40)
  [[ -f /etc/asterisk/manager.conf && ! -f /etc/asterisk/manager.conf.orig ]] && cp -p /etc/asterisk/manager.conf /etc/asterisk/manager.conf.orig
  cat > /etc/asterisk/manager.conf <<EOF
[general]
enabled = yes
port = 5038
bindaddr = 127.0.0.1

[cartracker]
secret = $AMI_SECRET
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read = system,call,reporting
write = system,command,reporting
EOF
  chown asterisk:asterisk /etc/asterisk/manager.conf
  chmod 640 /etc/asterisk/manager.conf
  systemctl enable --now asterisk
  systemctl restart asterisk
fi

# --- Settings for the app ------------------------------------------------------------

step "Writing app settings"
ADMIN_CODE_SHOWN=""
if [[ -n ${ADMIN_CODE:-} ]]; then
  # A code typed here replaces one that was changed on the website.
  rm -f "$DATA_DIR/admin-code.json"
else
  ADMIN_CODE=$(env_value MEDIA_UPLOAD_TOKEN)
  if [[ -z $ADMIN_CODE ]]; then
    ADMIN_CODE=$(random_secret 24 16)
    ADMIN_CODE_SHOWN=$ADMIN_CODE
  fi
fi
VEHICLE_TOKEN=$(env_value TELEMETRY_INGEST_TOKEN)
VEHICLE_TOKEN_NEW=no
if [[ -z $VEHICLE_TOKEN ]]; then
  VEHICLE_TOKEN=$(random_secret 36 32)
  VEHICLE_TOKEN_NEW=yes
fi

{
  echo "NODE_ENV=production"
  echo "NEXT_TELEMETRY_DISABLED=1"
  echo "DATA_DIR=$DATA_DIR"
  echo "MEDIA_UPLOAD_TOKEN=$ADMIN_CODE"
  echo "TELEMETRY_INGEST_TOKEN=$VEHICLE_TOKEN"
  if [[ $PBX == yes ]]; then
    echo "ASTERISK_AMI_USER=cartracker"
    echo "ASTERISK_AMI_SECRET=$AMI_SECRET"
    echo "ASTERISK_CONFIG_DIR=${ASTERISK_DIRS[0]}"
    echo "ASTERISK_MOH_DIR=${ASTERISK_DIRS[1]}"
    echo "ASTERISK_SOUNDS_DIR=${ASTERISK_DIRS[2]}"
  fi
} > "$ENV_FILE"
chown "root:$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# --- Service -----------------------------------------------------------------------------

step "Installing the cartracker service"
write_paths="$DATA_DIR $APP_DIR/.next"
[[ $PBX == yes ]] && write_paths+=" ${ASTERISK_DIRS[*]}"
cat > /etc/systemd/system/cartracker.service <<EOF
[Unit]
Description=CarTracker
After=network-online.target$([[ $PBX == yes ]] && echo " asterisk.service")
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port $APP_PORT
Restart=on-failure
RestartSec=5

NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
LockPersonality=yes
ReadWritePaths=$write_paths

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable cartracker >/dev/null
systemctl restart cartracker

# --- Web server ---------------------------------------------------------------------------

CERT_DIR=/etc/letsencrypt/live/$DOMAIN

write_nginx() { # write_nginx yes|no  (whether HTTPS is available)
  local https=$1 server_name="${DOMAIN:-_}" listen_default="" nginx_version listen_ssl http2_line=""
  [[ $MODE == local ]] && listen_default=" default_server"
  # "http2 on" exists from nginx 1.25.1; older versions (Ubuntu 24.04) need it on the listen line.
  nginx_version=$(nginx -v 2>&1 | sed -n 's|.*nginx/\([0-9.]*\).*|\1|p')
  if dpkg --compare-versions "${nginx_version:-0}" ge 1.25.1; then
    listen_ssl="ssl"
    http2_line="    http2 on;"
  else
    listen_ssl="ssl http2"
  fi

  cat > /etc/nginx/conf.d/cartracker-limits.conf <<'EOF'
# Writes (POST/PUT/DELETE) per client are limited harder than page loads.
map $request_method $cartracker_write_key {
    GET "";
    HEAD "";
    default $binary_remote_addr;
}
map $http_upgrade $cartracker_connection {
    default upgrade;
    "" "";
}
limit_req_zone $binary_remote_addr zone=cartracker_all:10m rate=20r/s;
limit_req_zone $cartracker_write_key zone=cartracker_write:10m rate=30r/m;
limit_req_status 429;
EOF

  # proxy_set_header, add_header and limit_req are only inherited by locations that set none of their own,
  # so headers live at server level and every API location repeats both limits.
  local api_limits="        limit_req zone=cartracker_all burst=100 nodelay;
        limit_req zone=cartracker_write burst=20 nodelay;"
  local app_location hsts_line=""
  [[ $https == yes ]] && hsts_line='    add_header Strict-Transport-Security "max-age=31536000" always;'
  IFS= read -r -d '' app_location <<EOF || true
    client_max_body_size 1m;
    limit_req zone=cartracker_all burst=100 nodelay;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
$hsts_line

    gzip on;
    gzip_types application/json text/css application/javascript image/svg+xml;

    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$cartracker_connection;

    location /api/media {
        client_max_body_size 100m;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
$api_limits
        proxy_pass http://127.0.0.1:$APP_PORT;
    }

    location ~ ^/api/pbx/(moh|greeting) {
        client_max_body_size 50m;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
$api_limits
        proxy_pass http://127.0.0.1:$APP_PORT;
    }

    location /api/ {
$api_limits
        proxy_pass http://127.0.0.1:$APP_PORT;
    }

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
    }
EOF

  {
    echo "server {"
    echo "    listen 80$listen_default;"
    echo "    listen [::]:80$listen_default;"
    echo "    server_name $server_name;"
    if [[ $MODE == public ]]; then
      echo "    location /.well-known/acme-challenge/ { root $ACME_ROOT; }"
    fi
    if [[ $https == yes ]]; then
      echo "    location / { return 301 https://\$host\$request_uri; }"
    else
      echo "$app_location"
    fi
    echo "}"
    if [[ $https == yes ]]; then
      echo
      echo "server {"
      echo "    listen 443 $listen_ssl;"
      echo "    listen [::]:443 $listen_ssl;"
      [[ -n $http2_line ]] && echo "$http2_line"
      echo "    server_name $server_name;"
      echo "    ssl_certificate $CERT_DIR/fullchain.pem;"
      echo "    ssl_certificate_key $CERT_DIR/privkey.pem;"
      echo "    ssl_protocols TLSv1.2 TLSv1.3;"
      echo "    ssl_session_cache shared:cartracker_ssl:10m;"
      echo "$app_location"
      echo "}"
    fi
  } > /etc/nginx/sites-available/cartracker

  ln -sf /etc/nginx/sites-available/cartracker /etc/nginx/sites-enabled/cartracker
  rm -f /etc/nginx/sites-enabled/default
  nginx -t -q
  systemctl reload nginx
}

step "Configuring nginx"
install -d -m 755 "$ACME_ROOT"
if [[ $CLOUDFLARE == yes ]]; then
  # Cloudflare connects on behalf of visitors; trust its ranges so the real visitor IP is used.
  {
    echo "# Generated by the CarTracker installer from https://www.cloudflare.com/ips/"
    for list in ips-v4 ips-v6; do
      curl -fsSL "https://www.cloudflare.com/$list" | sed '/^$/d; s/.*/set_real_ip_from &;/'
    done
    echo "real_ip_header CF-Connecting-IP;"
  } > /etc/nginx/conf.d/cartracker-cloudflare.conf
else
  rm -f /etc/nginx/conf.d/cartracker-cloudflare.conf
fi
systemctl enable --now nginx >/dev/null
write_nginx "$([[ $MODE == public && -f $CERT_DIR/fullchain.pem ]] && echo yes || echo no)"

HTTPS_OK=no
if [[ $MODE == public ]]; then
  if [[ -f $CERT_DIR/fullchain.pem ]]; then
    HTTPS_OK=yes
  else
    step "Getting an HTTPS certificate from Let's Encrypt for $DOMAIN"
    resolved=$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}' || true)
    echo "The domain currently points to: ${resolved:-nothing (no DNS record found)}"
    certbot_args=(certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" -m "$EMAIL" --agree-tos --no-eff-email -n
      --deploy-hook "systemctl reload nginx")
    # The trial run uses Let's Encrypt's test system, so mistakes don't count against the real rate limits.
    if certbot "${certbot_args[@]}" --dry-run; then
      certbot "${certbot_args[@]}" && HTTPS_OK=yes
    fi
    if [[ $HTTPS_OK == yes ]]; then
      write_nginx yes
    else
      warn "No certificate yet. The site runs on plain HTTP for now. Check that:"
      warn "  - $DOMAIN has an A record pointing to this network's public IP"
      warn "  - the router forwards TCP 80 and 443 to $(lan_address)"
      warn "Then run this installer again; it will retry automatically."
    fi
  fi
fi

# --- Firewall, fail2ban, updates ------------------------------------------------------------

step "Configuring the firewall"
ssh_port=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}' || true)
ufw allow "${ssh_port:-22}/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
[[ $MODE == public ]] && ufw allow 443/tcp >/dev/null
if [[ $PBX == yes ]]; then
  ufw allow 5060/udp >/dev/null
  ufw allow "$RTP_START:$RTP_END/udp" >/dev/null
fi
ufw --force enable >/dev/null

step "Configuring fail2ban"
{
  echo "[sshd]"
  echo "enabled = true"
  echo "port = ${ssh_port:-22}"
  if [[ $PBX == yes ]]; then
    log_name=$(grep -oE '^[[:space:]]*messages(\.log)?' /etc/asterisk/logger.conf 2>/dev/null | head -n1 | tr -d '[:space:]' || true)
    echo
    echo "[asterisk]"
    echo "enabled = true"
    echo "backend = auto"
    echo "logpath = /var/log/asterisk/${log_name:-messages.log}"
    echo "maxretry = 5"
    echo "bantime = 1h"
  fi
} > /etc/fail2ban/jail.d/cartracker.local
systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban

step "Turning on automatic security updates and time sync"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
# Certificates and backups depend on a correct clock.
timedatectl set-ntp true 2>/dev/null || warn "Could not turn on automatic time sync."

# --- Backups -----------------------------------------------------------------------------------

step "Setting up daily backups ($BACKUP_DAYS days kept in $BACKUP_DIR)"
cat > /usr/local/sbin/cartracker-backup <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
. /etc/cartracker/install.conf
dest=/var/backups/cartracker
install -d -m 700 "$dest"
paths=("${DATA_DIR#/}" etc/cartracker)
if [[ $PBX == yes ]]; then
  for dir in etc/asterisk/cartracker var/lib/asterisk/moh/cartracker var/lib/asterisk/sounds/cartracker; do
    [[ -d /$dir ]] && paths+=("$dir")
  done
fi
tar -czf "$dest/cartracker-$(date +%Y%m%d-%H%M%S).tar.gz" -C / "${paths[@]}"
find "$dest" -name 'cartracker-*.tar.gz' -mtime +"$BACKUP_DAYS" -delete
EOF
chmod 750 /usr/local/sbin/cartracker-backup
cat > /etc/systemd/system/cartracker-backup.service <<'EOF'
[Unit]
Description=CarTracker backup

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cartracker-backup
EOF
cat > /etc/systemd/system/cartracker-backup.timer <<'EOF'
[Unit]
Description=Daily CarTracker backup

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now cartracker-backup.timer >/dev/null

# --- Summary ---------------------------------------------------------------------------------------

lan=$(lan_address)
if [[ $MODE == public && $HTTPS_OK == yes ]]; then
  site_url="https://$DOMAIN"
elif [[ $MODE == public ]]; then
  site_url="http://$DOMAIN (HTTPS pending)"
else
  site_url="http://${lan:-SERVER-IP}"
fi

echo
echo "=================================================================="
echo " CarTracker is installed"
echo "=================================================================="
echo " Site:            $site_url"
echo " Admin pages:     ${site_url%% *}/admin"
if [[ -n $ADMIN_CODE_SHOWN ]]; then
  echo " Admin code:      $ADMIN_CODE_SHOWN   (generated, write it down)"
else
  echo " Admin code:      the one you entered (change it under Admin > Security)"
fi
if [[ $VEHICLE_TOKEN_NEW == yes ]]; then
  echo " Vehicle token:   $VEHICLE_TOKEN"
fi
echo "                  The token and MikroTik URL are also under Admin > Overview."
echo
if [[ $MODE == public ]]; then
  echo " Still to do outside this server:"
  echo "  - DNS: A record $DOMAIN -> this network's public IP$([[ $CLOUDFLARE == yes ]] && echo ' (proxied)')"
  [[ $CLOUDFLARE == yes ]] && echo "  - Cloudflare: set SSL/TLS mode to 'Full (strict)' (other modes cause a redirect loop)"
  echo "  - Router: forward TCP 80 and 443 to ${lan:-this server}"
  if [[ $PBX == yes ]]; then
    echo "  - Router: forward UDP 5060 and UDP $RTP_START-$RTP_END to ${lan:-this server} (phone calls)"
    [[ $CLOUDFLARE == yes ]] && echo "  - DNS: a separate, NOT proxied record (e.g. sip.$DOMAIN) for phones"
  fi
fi
echo " Update later:    git pull && sudo bash deploy/install.sh"
echo "=================================================================="
