#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
# Bili-SyncPlay Deployment Script
# ─────────────────────────────────────────────
# Run on the production server after `git pull`.
#
# Prerequisites:
#   - Node.js >= 22.5.0 (check: node -v)
#   - PM2 installed globally (npm install -g pm2)
#   - Nginx installed
#   - Project cloned to /opt/bilisync (or symlinked)
#
# Usage:
#   cd /opt/bilisync
#   git pull origin main
#   bash deploy/deploy.sh
# ─────────────────────────────────────────────

# ── Config ──
DEPLOY_DIR="/opt/bilisync"
PM2_APP_NAME="bilisync"
LOG_DIR="${DEPLOY_DIR}/logs"

echo "=========================================="
echo " Bili-SyncPlay Deployment"
echo "=========================================="

# ── Step 0: Pre-flight checks ──
echo "[0/6] Pre-flight checks..."

NODE_VERSION=$(node -v 2>/dev/null || echo "not found")
if [ "$NODE_VERSION" = "not found" ]; then
  echo "  ERROR: Node.js is not installed."
  echo "  Install: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  exit 1
fi
echo "  Node.js: $NODE_VERSION"

if ! command -v pm2 &>/dev/null; then
  echo "  ERROR: PM2 is not installed."
  echo "  Install: sudo npm install -g pm2"
  exit 1
fi
echo "  PM2: $(pm2 --version)"

if ! command -v nginx &>/dev/null; then
  echo "  WARNING: Nginx is not installed."
  echo "  Install: sudo apt-get install -y nginx"
fi

# ── Step 1: Install dependencies ──
echo ""
echo "[1/6] Installing dependencies..."
npm ci --omit=dev || npm install
echo "  Dependencies installed."

# ── Step 2: Build all packages ──
echo ""
echo "[2/6] Building all packages (protocol → server → web)..."
npm run build
echo "  Build complete."

# ── Step 3: Create log directory ──
echo ""
echo "[3/6] Preparing directories..."
mkdir -p "$LOG_DIR"
echo "  Log directory: $LOG_DIR"

# ── Step 4: Load environment ──
echo ""
echo "[4/6] Loading environment..."
if [ -f "${DEPLOY_DIR}/deploy/.env.production" ]; then
  set -a
  # shellcheck disable=SC1091
  source "${DEPLOY_DIR}/deploy/.env.production"
  set +a
  echo "  Environment loaded from deploy/.env.production"
else
  echo "  WARNING: deploy/.env.production not found. Using existing environment."
fi

# ── Step 5: Restart PM2 process ──
echo ""
echo "[5/6] Restarting PM2 process..."
if pm2 describe "$PM2_APP_NAME" &>/dev/null; then
  pm2 restart "$PM2_APP_NAME" --update-env
  echo "  PM2 process restarted."
else
  pm2 start "${DEPLOY_DIR}/deploy/ecosystem.config.cjs" --env production
  pm2 save
  echo "  PM2 process started (first time)."
fi

# ── Step 6: Reload Nginx ──
echo ""
echo "[6/6] Reloading Nginx..."
if [ -f /etc/nginx/sites-enabled/bilisync ]; then
  nginx -t && sudo systemctl reload nginx
  echo "  Nginx reloaded."
else
  echo "  Nginx config not found at /etc/nginx/sites-enabled/bilisync"
  echo "  Run: sudo cp ${DEPLOY_DIR}/deploy/nginx.conf /etc/nginx/sites-available/bilisync"
  echo "  Run: sudo ln -s /etc/nginx/sites-available/bilisync /etc/nginx/sites-enabled/bilisync"
fi

# ── Health check ──
echo ""
echo "=========================================="
echo " Verifying deployment..."
echo "=========================================="
sleep 2

HEALTH_URL="http://127.0.0.1:${PORT:-8787}/healthz"
if curl -sf "$HEALTH_URL" | grep -q '"ok":true' 2>/dev/null; then
  echo "  Health check PASSED ($HEALTH_URL)"
else
  echo "  Health check FAILED ($HEALTH_URL)"
  echo "  Check logs: pm2 logs $PM2_APP_NAME --lines 50"
  exit 1
fi

echo ""
echo "=========================================="
echo " Deployment complete!"
echo "=========================================="
echo ""
echo "  App:        $PM2_APP_NAME"
echo "  Port:       ${PORT:-8787}"
echo "  Logs:       pm2 logs $PM2_APP_NAME"
echo "  Status:     pm2 status $PM2_APP_NAME"
echo "  Monitor:    pm2 monit"
echo ""
