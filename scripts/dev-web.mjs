import { spawn } from "node:child_process";
import { createServer } from "node:net";

const npmCommand = "npm";
const children = new Set();

function canListen(port, host) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, host);
  });
}

async function findPort(preferredPort) {
  for (let port = preferredPort; port < preferredPort + 20; port += 1) {
    if ((await canListen(port, "0.0.0.0")) && (await canListen(port, "::"))) {
      return port;
    }
  }
  throw new Error(`No available port found from ${preferredPort}.`);
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    });
    return;
  }
  child.kill("SIGTERM");
}

function startProcess(name, args, env) {
  const child = spawn(npmCommand, args, {
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...env,
    },
  });
  children.add(child);
  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (children.size > 0 && code !== 0 && signal !== "SIGTERM") {
      stopAll();
      process.exit(code ?? 1);
    }
  });
  return child;
}

function stopAll() {
  for (const child of children) {
    stopChild(child);
  }
}

process.on("SIGINT", () => {
  stopAll();
});

process.on("SIGTERM", () => {
  stopAll();
});

const serverPort = await findPort(8787);
const webPort = await findPort(5173);
const webOrigin = `http://localhost:${webPort}`;
const serverHttpUrl = `http://127.0.0.1:${serverPort}`;

console.log(`[dev] Server: http://localhost:${serverPort}`);
console.log(`[dev] Web:    ${webOrigin}`);

startProcess(
  "server",
  ["run", "dev", "-w", "@bili-syncplay/server"],
  {
    PORT: String(serverPort),
    ALLOWED_ORIGINS: webOrigin,
    MAX_MEMBERS_PER_ROOM: "2",
  },
);

startProcess(
  "web",
  [
    "run",
    "dev",
    "-w",
    "@bili-syncplay/web",
    "--",
    "--port",
    String(webPort),
    "--strictPort",
  ],
  {
    VITE_SERVER_HTTP_URL: serverHttpUrl,
    VITE_WS_URL: `ws://localhost:${serverPort}`,
  },
);
