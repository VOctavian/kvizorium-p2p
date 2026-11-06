#!/usr/bin/env bash
# Installs or updates Kvizorium on an Ubuntu server (Oracle Cloud Always Free, ARM or x86).
#   sudo bash setup.sh <domain> [release.tgz]
# Safe to run again: each run puts the new release in place and restarts the game server.
# Rooms and players survive the restart (they are kept in /var/lib/kvizorium).
set -euo pipefail

DOMAIN="${1:?Укажите домен, например: sudo bash setup.sh kvizorium.duckdns.org}"
RELEASE="${2:-/tmp/kvizorium.tgz}"
APP=/opt/kvizorium
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

say "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

say "Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  apt-get update
  apt-get install -y caddy
fi

say "Firewall: ports 80 and 443"
# Oracle's Ubuntu images reject everything but SSH in iptables; open the web ports before that rule.
for port in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
    at=$(iptables -L INPUT --line-numbers | awk '/REJECT/ { print $1; exit }')
    if [ -n "$at" ]; then iptables -I INPUT "$at" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    else iptables -A INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT; fi
  fi
done
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; fi

say "Game files"
id kvz >/dev/null 2>&1 || useradd --system --home /var/lib/kvizorium --shell /usr/sbin/nologin kvz
rm -rf "$APP.new" && mkdir -p "$APP.new"
tar -xzf "$RELEASE" -C "$APP.new"
rm -rf "$APP.old"
if [ -d "$APP" ]; then mv "$APP" "$APP.old"; fi
mv "$APP.new" "$APP"

say "Game server service"
sed 's/\r$//' "$APP/deploy/kvizorium.service" > /etc/systemd/system/kvizorium.service
systemctl daemon-reload
systemctl enable kvizorium >/dev/null
systemctl restart kvizorium

say "Caddy for $DOMAIN"
sed -e 's/\r$//' -e "s/{{DOMAIN}}/$DOMAIN/" "$APP/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Check"
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8787/api/health && echo
echo
echo "Готово. Откройте https://$DOMAIN (сертификат появляется за минуту при первом запуске)."
echo "Журнал игры:  sudo journalctl -u kvizorium -f"
echo "Журнал HTTPS: sudo journalctl -u caddy -f"
