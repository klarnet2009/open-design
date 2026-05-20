import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  APP_KEYS,
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_ENV,
  SIDECAR_SOURCES,
} from "@open-design/sidecar-proto";
import { createSidecarLaunchEnv } from "@open-design/sidecar";
import {
  collectProcessTreePids,
  createProcessStampArgs,
  listProcessSnapshots,
  matchesStampedProcess,
  spawnBackgroundProcess,
} from "@open-design/platform";
import type { BundleEntryKind } from "@open-design/bundle";

import { parsePortOption, type ToolDevAppName, type ToolDevConfig } from "../config.js";
import { resolveWebImplementation, sidecarImplementationEnv, type ToolsDevWebSource } from "../bundles.js";
import { ToolDevError } from "../lib/errors.js";
import { waitForDaemonRuntime } from "../sidecar-client.js";
import type { CliOptions } from "./options.js";

const PARENT_PID_ENV = SIDECAR_ENV.TOOLS_DEV_PARENT_PID;
const WEB_STANDALONE_BUNDLE_ROOT = "web/standalone";

export function runtimeLookup(config: ToolDevConfig) {
  return { base: config.toolsDevRoot, namespace: config.namespace };
}

export function appConfig(config: ToolDevConfig, appName: ToolDevAppName) {
  return config.apps[appName];
}

export function urlPort(url: string): string {
  const parsed = new URL(url);
  if (parsed.port) return parsed.port;
  return parsed.protocol === "https:" ? "443" : "80";
}

function formatWebSource(source: ToolsDevWebSource): string {
  if (source.type === "workspace") return "workspace";
  return `bundle ${source.artifact.bundlePath} entry ${source.artifact.descriptor.entry.path}`;
}

export function statusMatchesForcedPort(url: string | null | undefined, forcedPort: number | null): boolean {
  return forcedPort == null || (url != null && urlPort(url) === String(forcedPort));
}

function prependNodePath(entries: string[], current = process.env.NODE_PATH): string {
  const existing = current == null || current.length === 0 ? [] : current.split(path.delimiter);
  return [...entries, ...existing].join(path.delimiter);
}

function webNodePathEntries(config: ToolDevConfig, source: ToolsDevWebSource): string[] {
  if (source.type === "workspace") {
    return [
      path.join(config.workspaceRoot, "apps/web/node_modules"),
      path.join(config.workspaceRoot, "node_modules"),
    ];
  }

  const standaloneRoot = path.join(source.artifact.bundlePath, ...WEB_STANDALONE_BUNDLE_ROOT.split("/"));
  return [
    path.join(standaloneRoot, "apps/web/node_modules"),
    path.join(standaloneRoot, "node_modules"),
  ];
}

function webBundleRuntimeEnv(source: ToolsDevWebSource): NodeJS.ProcessEnv {
  if (source.type !== "bundle") return {};
  return {
    NODE_ENV: "production",
    OD_WEB_OUTPUT_MODE: "standalone",
    OD_WEB_PROD: "1",
    OD_WEB_STANDALONE_ROOT: path.join(source.artifact.bundlePath, ...WEB_STANDALONE_BUNDLE_ROOT.split("/")),
  };
}

async function openAppLog(config: ToolDevConfig, appName: ToolDevAppName): Promise<FileHandle> {
  const logPath = appConfig(config, appName).latestLogPath;
  await mkdir(path.dirname(logPath), { recursive: true });
  return await open(logPath, "a");
}

function createAppStamp(config: ToolDevConfig, appName: ToolDevAppName) {
  const currentAppConfig = appConfig(config, appName);
  const stamp = {
    app: appName,
    ipc: currentAppConfig.ipcPath,
    mode: "dev" as const,
    namespace: config.namespace,
    source: SIDECAR_SOURCES.TOOLS_DEV,
  };

  return {
    args: createProcessStampArgs(stamp, OPEN_DESIGN_SIDECAR_CONTRACT),
    env: createSidecarLaunchEnv({
      base: config.toolsDevRoot,
      contract: OPEN_DESIGN_SIDECAR_CONTRACT,
      stamp,
    }),
    stamp,
  };
}

export async function findAppProcessTree(config: ToolDevConfig, appName: ToolDevAppName) {
  const processes = await listProcessSnapshots();
  const rootPids = processes
    .filter((processInfo) =>
      matchesStampedProcess(processInfo, {
        app: appName,
        mode: "dev",
        namespace: config.namespace,
        source: SIDECAR_SOURCES.TOOLS_DEV,
      }, OPEN_DESIGN_SIDECAR_CONTRACT),
    )
    .map((processInfo) => processInfo.pid);
  const pids = collectProcessTreePids(processes, rootPids);

  return { pids, rootPids };
}

export async function waitForExit(config: ToolDevConfig, appName: ToolDevAppName, timeoutMs = 5000): Promise<number[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await findAppProcessTree(config, appName);
    if (current.pids.length === 0) return [];
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  }
  return (await findAppProcessTree(config, appName)).pids;
}

export async function assertNoStaleProcess(config: ToolDevConfig, appName: ToolDevAppName): Promise<void> {
  const active = await findAppProcessTree(config, appName);
  if (active.pids.length > 0) {
    throw ToolDevError.staleStampedProcess(appName);
  }
}

async function spawnStampedRuntime(request: {
  appName: typeof APP_KEYS.DAEMON | typeof APP_KEYS.DESKTOP | typeof APP_KEYS.WEB;
  config: ToolDevConfig;
  entryKind?: BundleEntryKind;
  entryPath?: string;
  env: NodeJS.ProcessEnv;
  logHandle: FileHandle;
}): Promise<{ pid: number }> {
  const { args: stampArgs, env } = createAppStamp(request.config, request.appName);
  const appLaunchConfig = request.config.apps[request.appName];
  const entryPath = request.entryPath ?? appLaunchConfig.launchEntryPath;
  const args = request.entryKind === "js"
    ? [entryPath, ...stampArgs]
    : [request.config.tsxCliPath, entryPath, ...stampArgs];
  const spawned = await spawnBackgroundProcess({
    args,
    command: process.execPath,
    cwd: request.config.workspaceRoot,
    detached: true,
    env: {
      ...process.env,
      ...env,
      ...request.env,
    },
    logFd: request.logHandle.fd,
  });
  return { pid: spawned.pid };
}

export async function spawnDaemonRuntime(
  config: ToolDevConfig,
  options: CliOptions,
  spawnOptions: { requireDesktopAuth?: boolean } = {},
): Promise<{ pid: number }> {
  const daemonPort = parsePortOption(options.daemonPort, "--daemon-port");
  const webPort = parsePortOption(options.webPort, "--web-port");
  const logHandle = await openAppLog(config, APP_KEYS.DAEMON);

  try {
    await logHandle.write(`\n[tools-dev] launching daemon at ${new Date().toISOString()}\n`);
    if (webPort != null) await logHandle.write(`[tools-dev] trusting web origin port ${webPort}\n`);
    if (spawnOptions.requireDesktopAuth) {
      await logHandle.write(`[tools-dev] requiring desktop auth on /api/import/folder\n`);
    }
    return await spawnStampedRuntime({
      appName: APP_KEYS.DAEMON,
      config,
      env: {
        [SIDECAR_ENV.DAEMON_PORT]: String(daemonPort ?? 0),
        ...(webPort == null ? {} : { [SIDECAR_ENV.WEB_PORT]: String(webPort) }),
        ...(options.parentPid == null ? {} : { [PARENT_PID_ENV]: String(options.parentPid) }),
        ...(spawnOptions.requireDesktopAuth ? { OD_REQUIRE_DESKTOP_AUTH: "1" } : {}),
      },
      logHandle,
    });
  } finally {
    await logHandle.close();
  }
}

export async function spawnWebRuntime(config: ToolDevConfig, options: CliOptions): Promise<{ pid: number }> {
  const daemonStatus = await waitForDaemonRuntime(runtimeLookup(config));
  if (daemonStatus.url == null) throw ToolDevError.daemonRequired();

  const webPort = parsePortOption(options.webPort, "--web-port");
  const daemonPort = urlPort(daemonStatus.url);
  const logHandle = await openAppLog(config, APP_KEYS.WEB);

  try {
    const webImplementation = await resolveWebImplementation(config);
    await logHandle.write(`\n[tools-dev] launching web at ${new Date().toISOString()}\n`);
    await logHandle.write(`[tools-dev] web implementation: ${formatWebSource(webImplementation.source)}\n`);
    await logHandle.write(`[tools-dev] proxying web API requests to daemon port ${daemonPort}\n`);
    return await spawnStampedRuntime({
      appName: APP_KEYS.WEB,
      config,
      entryKind: webImplementation.entryKind,
      entryPath: webImplementation.entryPath,
      env: {
        NODE_PATH: prependNodePath(webNodePathEntries(config, webImplementation.source)),
        [SIDECAR_ENV.DAEMON_PORT]: daemonPort,
        [SIDECAR_ENV.WEB_PORT]: String(webPort ?? 0),
        PORT: String(webPort ?? 0),
        ...sidecarImplementationEnv(webImplementation.implementation),
        ...(options.parentPid == null ? {} : { [PARENT_PID_ENV]: String(options.parentPid) }),
        ...(options.prod === true
          ? { NODE_ENV: "production", OD_WEB_OUTPUT_MODE: "server", OD_WEB_PROD: "1" }
          : {}),
        ...webBundleRuntimeEnv(webImplementation.source),
      },
      logHandle,
    });
  } finally {
    await logHandle.close();
  }
}

export async function spawnDesktopRuntime(config: ToolDevConfig, options: CliOptions): Promise<{ pid: number }> {
  const logHandle = await openAppLog(config, APP_KEYS.DESKTOP);

  try {
    await logHandle.write(`\n[tools-dev] launching desktop at ${new Date().toISOString()}\n`);
    return await spawnStampedRuntime({
      appName: APP_KEYS.DESKTOP,
      config,
      env: {
        ...(options.parentPid == null ? {} : { [PARENT_PID_ENV]: String(options.parentPid) }),
      },
      logHandle,
    });
  } finally {
    await logHandle.close();
  }
}
