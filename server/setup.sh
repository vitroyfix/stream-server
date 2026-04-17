#!/bin/bash
# setup.sh — Run ONCE on a fresh Ubuntu 22.04 EC2 instance
# Usage: bash setup.sh
set -e

echo "═══════════════════════════════════════════"
echo "  StreamApp EC2 Setup"
echo "═══════════════════════════════════════════"

# ── 1. System update ──────────────────────────────────────────────────────────
echo "[1/8] Updating system packages…"
sudo apt update && sudo apt upgrade -y

# ── 2. Node.js 20 ─────────────────────────────────────────────────────────────
echo "[2/8] Installing Node.js 20…"
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v

# ── 3. Google Chrome stable ───────────────────────────────────────────────────
echo "[3/8] Installing Google Chrome…"
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | \
  sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] \
  http://dl.google.com/linux/chrome/deb/ stable main" | \
  sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update && sudo apt install -y google-chrome-stable

# Chrome system dependencies (needed in headless server environment)
sudo apt install -y \
  libgbm-dev libxkbcommon-dev libx11-xcb1 \
  libxss1 libasound2 libatk-bridge2.0-0 \
  libgtk-3-0 libdrm2 libxcomposite1 \
  fonts-liberation xdg-utils

google-chrome-stable --version

# ── 4. Nginx ──────────────────────────────────────────────────────────────────
echo "[4/8] Installing Nginx…"
sudo apt install -y nginx
sudo systemctl enable nginx

# ── 5. PM2 ────────────────────────────────────────────────────────────────────
echo "[5/8] Installing PM2…"
sudo npm install -g pm2
pm2 -v

# ── 6. Certbot ────────────────────────────────────────────────────────────────
echo "[6/8] Installing Certbot…"
sudo apt install -y certbot python3-certbot-nginx

# ── 7. App directory ──────────────────────────────────────────────────────────
echo "[7/8] Creating app directory…"
mkdir -p /home/ubuntu/app/{logs,dist,server}
cd /home/ubuntu/app

# ── 8. Git ────────────────────────────────────────────────────────────────────
echo "[8/8] Installing Git…"
sudo apt install -y git

echo ""
echo "═══════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Next steps:"
echo "  1. Clone your repo:  git clone <your-repo-url> /home/ubuntu/app"
echo "  2. Create .env:      nano /home/ubuntu/app/.env"
echo "  3. Install deps:     cd /home/ubuntu/app && npm ci --omit=dev"
echo "  4. Copy nginx conf:  sudo cp nginx/streamapp.conf /etc/nginx/sites-available/"
echo "  5. Enable nginx:     sudo ln -s /etc/nginx/sites-available/streamapp /etc/nginx/sites-enabled/"
echo "  6. Get SSL cert:     sudo certbot --nginx -d your-domain.com"
echo "  7. Start app:        pm2 start ecosystem.config.cjs && pm2 save && pm2 startup"
echo "═══════════════════════════════════════════"