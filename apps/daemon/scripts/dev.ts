import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPackageManagerInvocation,
  readProcessStamp,
} from "@open-design/platform";
import {
  APP_KEYS,
  OPEN_DESIGN_SIDECAR_CONTRACT,
} from "@open-design/sidecar-proto";

type DaemonBuildOutput = {
  label: string;
  mtime: number;
  path: string;
};

export type DaemonBuildCheck = {
  distCliPath: string;
  distMtime: number;
  distSidecarPath: string;
  reason?: string;
  required: boolean;
  sourceMtime: number;
};

export type DaemonBuildRequest = {
  env?: NodeJS.ProcessEnv;
  workspaceRoot: string;
};

export type DaemonSidecarLaunchRequest = {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type DaemonSidecarExit = {
  code: number | null;
  pid: number;
  signal: NodeJS.Signals | null;
};

async function latestMtimeMs(filePath: string): Promise<number> {
  const entry = await lstat(filePath).catch(() => null);
  if (entry == null) return 0;
  if (!entry.isDirectory()) return entry.mtimeMs;

  const children = await readdir(filePath, { withFileTypes: true }).catch(() => []);
  let latest = entry.mtimeMs;
  for (const child of children) {
    if (child.name === "node_modules" || child.name === "dist" || child.name === ".tmp") continue;
    latest = Math.max(latest, await latestMtimeMs(join(filePath, child.name)));
  }
  return latest;
}

function readPackageName(directory: string): string | null {
  try {
    const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: unknown };
    return typeof packageJson.name === "string" ? packageJson.name : null;
  } catch {
    return null;
  }
}

export function resolveDaemonPackageRoot(moduleUrl = import.meta.url): string {
  let current = dirname(fileURLToPath(moduleUrl));

  for (let depth = 0; depth < 8; depth += 1) {
    if (readPackageName(current) === "@open-design/daemon") return current;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error("failed to resolve @open-design/daemon package root");
}

export function resolveDaemonWorkspaceRoot(packageRoot: string): string {
  return dirname(dirname(packageRoot));
}

export function resolveDaemonSidecarEntryPath(packageRoot: string): string {
  return join(packageRoot, "dist", "sidecar", "index.js");
}

async function resolveDaemonBuildOutputs(packageRoot: string): Promise<DaemonBuildOutput[]> {
  const outputs = [
    { label: "apps/daemon/dist/cli.js", path: join(packageRoot, "dist", "cli.js") },
    { label: "apps/daemon/dist/sidecar/index.js", path: resolveDaemonSidecarEntryPath(packageRoot) },
  ];

  return await Promise.all(
    outputs.map(async (output) => ({
      ...output,
      mtime: await latestMtimeMs(output.path),
    })),
  );
}

export async function checkDaemonBuild(packageRoot: string): Promise<DaemonBuildCheck> {
  const outputs = await resolveDaemonBuildOutputs(packageRoot);
  const cliOutput = outputs[0];
  const sidecarOutput = outputs[1];
  if (cliOutput == null || sidecarOutput == null) {
    throw new Error("daemon build output list is incomplete");
  }

  const sourceMtime = Math.max(
    await latestMtimeMs(join(packageRoot, "src")),
    await latestMtimeMs(join(packageRoot, "sidecar")),
    await latestMtimeMs(join(packageRoot, "package.json")),
    await latestMtimeMs(join(packageRoot, "tsconfig.json")),
    await latestMtimeMs(join(packageRoot, "tsconfig.sidecar.json")),
  );
  const missing = outputs.find((output) => output.mtime <= 0);
  const oldest = outputs.reduce((currentOldest, output) => output.mtime < currentOldest.mtime ? output : currentOldest);
  const base = {
    distCliPath: cliOutput.path,
    distMtime: oldest.mtime,
    distSidecarPath: sidecarOutput.path,
    sourceMtime,
  };

  if (missing != null) {
    return {
      ...base,
      distMtime: missing.mtime,
      reason: `${missing.label} is missing`,
      required: true,
    };
  }

  if (oldest.mtime >= sourceMtime) {
    return { ...base, required: false };
  }

  return {
    ...base,
    reason: `source is newer than ${oldest.label}`,
    required: true,
  };
}

export async function runDaemonBuild(request: DaemonBuildRequest): Promise<void> {
  const invocation = createPackageManagerInvocation(
    ["--filter", "@open-design/daemon", "build"],
    request.env ?? process.env,
  );
  const child = spawn(invocation.command, invocation.args, {
    cwd: request.workspaceRoot,
    env: request.env ?? process.env,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: process.platform === "win32",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });

  await new Promise<void>((resolveRun, rejectRun) => {
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`command failed: ${invocation.command} ${invocation.args.join(" ")} (${signal ?? code})`));
    });
  });
}

export async function spawnDaemonSidecar(request: DaemonSidecarLaunchRequest): Promise<DaemonSidecarExit> {
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: process.platform === "win32",
  });

  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("error", rejectSpawn);
    child.once("spawn", resolveSpawn);
  });

  const forwardSignal = (signal: NodeJS.Signals) => {
    if (child.exitCode != null || child.signalCode != null) return;
    child.kill(signal);
  };
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => forwardSignal(signal);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    return await new Promise<DaemonSidecarExit>((resolveExit) => {
      child.once("exit", (code, signal) => {
        resolveExit({ code, pid: child.pid ?? 0, signal });
      });
    });
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = signalHandlers.get(signal);
      if (handler != null) process.off(signal, handler);
    }
  }
}

export async function runDaemonDev(options: {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  packageRoot?: string;
  runBuild?: (request: DaemonBuildRequest) => Promise<void>;
  spawnSidecar?: (request: DaemonSidecarLaunchRequest) => Promise<DaemonSidecarExit>;
  stampArgs?: string[];
  workspaceRoot?: string;
} = {}): Promise<DaemonSidecarExit> {
  const stampArgs = options.stampArgs ?? process.argv.slice(2);
  const stamp = readProcessStamp(stampArgs, OPEN_DESIGN_SIDECAR_CONTRACT);
  if (stamp == null) throw new Error("sidecar stamp is required");
  if (stamp.app !== APP_KEYS.DAEMON) {
    throw new Error(`daemon dev script requires daemon stamp, received ${stamp.app}`);
  }

  const packageRoot = options.packageRoot ?? resolveDaemonPackageRoot();
  const workspaceRoot = options.workspaceRoot ?? resolveDaemonWorkspaceRoot(packageRoot);
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const check = await checkDaemonBuild(packageRoot);

  if (check.required) {
    log(`[open-design daemon] building @open-design/daemon because ${check.reason} at ${new Date().toISOString()}`);
    await (options.runBuild ?? runDaemonBuild)({
      workspaceRoot,
      ...(options.env == null ? {} : { env: options.env }),
    });
  }

  const request: DaemonSidecarLaunchRequest = {
    args: [resolveDaemonSidecarEntryPath(packageRoot), ...stampArgs],
    command: process.execPath,
    cwd: workspaceRoot,
    env,
  };
  log(`[open-design daemon] launching daemon sidecar at ${new Date().toISOString()}`);
  const exit = await (options.spawnSidecar ?? spawnDaemonSidecar)(request);
  if (exit.code != null && exit.code !== 0) {
    throw new Error(`daemon sidecar exited with code ${exit.code}`);
  }
  return exit;
}

function isDirectEntry(): boolean {
  const entryPath = process.argv[1];
  if (entryPath == null || entryPath.length === 0 || entryPath.startsWith("--")) return false;

  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  void runDaemonDev().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
