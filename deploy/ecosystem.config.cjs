/**
 * PM2 Ecosystem Configuration for Bili-SyncPlay
 *
 * Usage:
 *   pm2 start deploy/ecosystem.config.cjs --env production
 *   pm2 restart bilisync
 *   pm2 logs bilisync
 *   pm2 stop bilisync
 *   pm2 delete bilisync
 *
 * Save process list (auto-restart on reboot):
 *   pm2 save
 *   pm2 startup (follow the printed instructions)
 */

module.exports = {
  apps: [
    {
      name: "bilisync",
      cwd: "/opt/bilisync",
      script: "server/dist/index.js",

      // ── Instances & mode ──
      // Single instance: WebSocket connections are stateful.
      // For multi-instance, use Redis (ROOM_STORE_PROVIDER=redis) and a load balancer with sticky sessions.
      instances: 1,
      exec_mode: "fork",

      // ── Environment ──
      env_production: {
        NODE_ENV: "production",
        // Load environment variables from .env.production
        // PM2 doesn't natively load .env files; use the dotenv path below or set vars here.
      },

      // ── Auto-restart ──
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 3000,

      // ── Graceful shutdown ──
      // Give the server time to close WebSocket connections before killing.
      kill_timeout: 10000,
      listen_timeout: 10000,

      // ── Logs ──
      out_file: "/opt/bilisync/logs/out.log",
      error_file: "/opt/bilisync/logs/error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      log_type: "json",

      // ── Memory threshold restart (auto-restart on memory leak) ──
      max_memory_restart: "512M",

      // ── Source maps ──
      source_map_support: true,
    },
  ],
};
