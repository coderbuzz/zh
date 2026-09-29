import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RunContext } from "@zcode/shared-types";

export interface WebCommandValues {
  host?: string;
  port?: number;
  workspace?: string;
  open?: boolean;
  "no-open"?: boolean;
  token?: string;
  "no-token"?: boolean;
}

interface WebLayout {
  serverEntry: string;
  webRoot: string;
}

const isLoopbackHost = (host: string): boolean =>
  host === "127.0.0.1" || host === "localhost" || host === "::1";

const isBunStandaloneExecutable = (): boolean => (process.argv[1] ?? "").includes("$bunfs");

const realAnchor = (): string => {
  const raw = isBunStandaloneExecutable() ? process.execPath : (process.argv[1] ?? process.execPath);
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
};

/** Walk up from the real entry anchor; the install root holds web/ and server/. */
function anchorDirs(): string[] {
  const dirs: string[] = [];
  let directory = dirname(realAnchor());
  for (let depth = 0; depth < 8; depth += 1) {
    dirs.push(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return dirs;
}

export const resolveWebLayout = (): WebLayout | undefined => {
  for (const dir of anchorDirs()) {
    const releaseEntry = join(dir, "server", "entry-http.js");
    const releaseWeb = join(dir, "web", "index.html");
    if (existsSync(releaseEntry) && existsSync(releaseWeb)) {
      return { serverEntry: releaseEntry, webRoot: join(dir, "web") };
    }
    const sourceEntry = join(dir, "packages", "server", "dist", "entry-http.js");
    const sourceWeb = join(dir, "packages", "web", "dist", "index.html");
    if (existsSync(sourceEntry) && existsSync(sourceWeb)) {
      return { serverEntry: sourceEntry, webRoot: join(dir, "packages", "web", "dist") };
    }
  }
  return undefined;
};

/**
 * Runtime pins written by install-remote.sh as ZH_RUNTIME_BUN="..." /
 * ZH_RUNTIME_NODE="..." lines. The file lives next to bin/zh and dist/.
 */
function readRuntimePin(name: "ZH_RUNTIME_BUN" | "ZH_RUNTIME_NODE"): string | undefined {
  for (const dir of anchorDirs()) {
    const pinFile = join(dir, ".zh-runtime");
    if (!existsSync(pinFile)) continue;
    try {
      const content = readFileSync(pinFile, "utf8");
      for (const line of content.split("\n")) {
        const match = line.match(new RegExp(`^${name}="([^"]+)"`));
        if (match) return match[1];
      }
    } catch {
      // unreadable pin file: fall through to PATH lookup
    }
  }
  return undefined;
}

function findOnPath(name: string): string | undefined {
  const PATH = process.env.PATH ?? "";
  for (const dir of PATH.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The web server runs under Node >= 22, not bun: node-pty native prebuilds are
 * validated against Node and the server bundle is a plain ESM Node artifact.
 */
export const resolveServerNode = (): string => {
  const override = process.env.ZH_WEB_NODE?.trim();
  if (override) return override;
  const pinned = readRuntimePin("ZH_RUNTIME_NODE");
  if (pinned && existsSync(pinned)) return pinned;
  const onPath = findOnPath("node");
  if (onPath) return onPath;
  throw new Error(
    "zh web needs Node >= 22 to run the web server (node-pty native addon). Install Node or set ZH_WEB_NODE.",
  );
};

const assertNodeVersion = (nodeBin: string): void => {
  const result = spawnSync(nodeBin, ["--version"], { encoding: "utf8" });
  const version = result.stdout?.trim() ?? "";
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(
      `zh web needs Node >= 22 (found ${version || "unknown"} at ${nodeBin}). Set ZH_WEB_NODE to override.`,
    );
  }
};

/** The agent child re-runs the entry zh itself is running: binary, bundle, or source. */
function agentCommand(): { command: string; args: string[] } {
  const override = process.env.ZCODE_AGENT_SERVER_COMMAND?.trim();
  if (override) {
    const args = process.env.ZCODE_AGENT_SERVER_ARGS_JSON?.trim();
    let parsed: unknown;
    try {
      parsed = args ? JSON.parse(args) : undefined;
    } catch {
      throw new Error("ZCODE_AGENT_SERVER_ARGS_JSON must be a JSON array when set.");
    }
    if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string")) {
      throw new Error("ZCODE_AGENT_SERVER_ARGS_JSON must be a JSON array of strings when set.");
    }
    return { command: override, args: parsed.length > 0 ? parsed : ["app-server", "--stdio"] };
  }
  if (isBunStandaloneExecutable()) {
    return { command: process.execPath, args: ["app-server", "--stdio"] };
  }
  return { command: process.execPath, args: [realAnchor(), "app-server", "--stdio"] };
}

function pickPort(host: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(port);
      });
    });
  });
}

function formatUrl(host: string, port: number, token: string): string {
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const base = `http://${displayHost}:${port}/`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

function networkUrls(port: number, token: string): string[] {
  const urls: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      urls.push(formatUrl(entry.address, port, token));
    }
  }
  return urls;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // best effort only; the URL is printed either way
  }
}

export const runWebCommand = async (
  ctx: RunContext,
  values: WebCommandValues,
): Promise<number> => {
  const layout = resolveWebLayout();
  if (!layout) {
    ctx.stderr.write(
      "zh web could not find the web runtime files.\n" +
        "Expected <install root>/server/entry-http.js and <install root>/web/ (release assets),\n" +
        "or packages/server/dist and packages/web/dist in a source checkout.\n" +
        "Install the web asset: install-remote.sh --web, or build them first.\n",
    );
    return 1;
  }

  const host = values.host ?? "127.0.0.1";
  const port = values.port && values.port > 0 ? values.port : await pickPort(host);
  const workspace = resolve(values.workspace ?? process.cwd());
  if (!existsSync(workspace)) {
    ctx.stderr.write(`Workspace does not exist: ${workspace}\n`);
    return 1;
  }

  let protect: boolean;
  if (values["no-token"]) {
    protect = false;
  } else if (values.token !== undefined) {
    protect = true;
  } else {
    protect = !isLoopbackHost(host);
  }
  const token = protect ? (values.token ?? randomBytes(24).toString("base64url")) : "";

  const nodeBin = resolveServerNode();
  assertNodeVersion(nodeBin);

  const agent = agentCommand();
  const localUrl = formatUrl(host, port, token);

  const child = spawn(nodeBin, [layout.serverEntry], {
    cwd: workspace,
    env: {
      ...process.env,
      PORT: String(port),
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify(agent.args),
      ZCODE_AGENT_SERVER_COMMAND: agent.command,
      ZCODE_SERVER_AUTH_TOKEN: token,
      ZCODE_SERVER_HOST: host,
      ZCODE_SERVER_WORKSPACE: workspace,
      ZCODE_WEB_STATIC_ROOT: layout.webRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("error", (error) => {
    ctx.stderr.write(`Unable to start the web server: ${error.message}\n`);
    process.exit(1);
  });

  ctx.stdout.write("\n");
  ctx.stdout.write("zh web is running\n");
  ctx.stdout.write(`Local:   ${localUrl}\n`);
  if (host === "0.0.0.0" || host === "::") {
    for (const url of networkUrls(port, token)) {
      ctx.stdout.write(`Network: ${url}\n`);
    }
  }
  ctx.stdout.write(`Agent:   ${basename(agent.command)} ${agent.args.join(" ")}\n`);
  ctx.stdout.write("Press Ctrl+C to stop.\n");
  ctx.stdout.write("\n");

  const open = values.open ?? (!values["no-open"] && isLoopbackHost(host));
  if (open) {
    setTimeout(() => openBrowser(localUrl), 500);
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Follow the server's exit code once it stops; signals resolve as failure.
  const exitCode = await new Promise<number>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit(signal ? 1 : (code ?? 0)));
  });
  return exitCode;
};
