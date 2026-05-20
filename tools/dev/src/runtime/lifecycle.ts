import { APP_KEYS, SIDECAR_MESSAGES } from "@open-design/sidecar-proto";
import { requestJsonIpc } from "@open-design/sidecar";
import {
  readLogTail,
  stopProcesses,
  type StopProcessesResult,
} from "@open-design/platform";

import type { CliOptions } from "./options.js";
import {
  DEFAULT_START_APPS,
  DEFAULT_STOP_APPS,
  parsePortOption,
  resolveRunApps,
  resolveStartApps,
  resolveStopApps,
  resolveTargetApps,
  type ToolDevAppName,
  type ToolDevConfig,
} from "../config.js";
import {
  appendStartupLogDiagnostics,
  createStartupLogDiagnostics,
  detectLogDiagnostics,
  type LogDiagnostic,
} from "../diagnostics.js";
import { ensureDesktopGate } from "../desktop-auth-gate.js";
import { ToolDevError } from "../lib/errors.js";
import { inspectAppStatus } from "./inspect.js";
import {
  appConfig,
  assertNoStaleProcess,
  findAppProcessTree,
  runtimeLookup,
  spawnDaemonRuntime,
  spawnDesktopRuntime,
  spawnWebRuntime,
  statusMatchesForcedPort,
  urlPort,
  waitForExit,
} from "./processes.js";
import {
  inspectDaemonRuntime,
  inspectDesktopRuntime,
  inspectWebRuntime,
  waitForDaemonRuntime,
  waitForDesktopRuntime,
  waitForWebRuntime,
} from "../sidecar-client.js";
import { printRunForegroundResult, type LogResult } from "./output.js";

async function startDaemon(
  config: ToolDevConfig,
  options: CliOptions,
  startOptions: { requireDesktopAuth?: boolean } = {},
) {
  const daemonPort = parsePortOption(options.daemonPort, "--daemon-port");
  const existing = await inspectDaemonRuntime(runtimeLookup(config));
  if (existing?.url != null && statusMatchesForcedPort(existing.url, daemonPort)) {
    return { app: APP_KEYS.DAEMON, created: false, logPath: config.apps.daemon.latestLogPath, status: existing };
  }
  if (existing?.url != null) {
    throw ToolDevError.runtimeAlreadyRunning(APP_KEYS.DAEMON, config.namespace, existing.url);
  }
  await assertNoStaleProcess(config, APP_KEYS.DAEMON);

  const desktopAlreadyRunning = await inspectDesktopRuntime(runtimeLookup(config));
  const requireDesktopAuth =
    (startOptions.requireDesktopAuth ?? false) || desktopAlreadyRunning != null;

  const spawned = await spawnDaemonRuntime(config, options, { requireDesktopAuth });
  try {
    const status = await waitForDaemonRuntime(runtimeLookup(config));
    return {
      app: APP_KEYS.DAEMON,
      created: true,
      logPath: config.apps.daemon.latestLogPath,
      pid: spawned.pid,
      status,
    };
  } catch (error) {
    const logPath = config.apps.daemon.latestLogPath;
    const lines = await readLogTail(logPath, 80).catch(() => []);
    await stopApp(config, APP_KEYS.DAEMON).catch(() => undefined);
    throw appendStartupLogDiagnostics(error, APP_KEYS.DAEMON, createStartupLogDiagnostics(logPath, lines));
  }
}

async function startWeb(config: ToolDevConfig, options: CliOptions) {
  const webPort = parsePortOption(options.webPort, "--web-port");
  const existing = await inspectWebRuntime(runtimeLookup(config));
  if (existing?.url != null && statusMatchesForcedPort(existing.url, webPort)) {
    return { app: APP_KEYS.WEB, created: false, logPath: config.apps.web.latestLogPath, status: existing };
  }
  if (existing?.url != null) {
    throw ToolDevError.runtimeAlreadyRunning(APP_KEYS.WEB, config.namespace, existing.url);
  }
  await assertNoStaleProcess(config, APP_KEYS.WEB);

  const spawned = await spawnWebRuntime(config, options);
  try {
    const status = await waitForWebRuntime(runtimeLookup(config));
    return {
      app: APP_KEYS.WEB,
      created: true,
      logPath: config.apps.web.latestLogPath,
      pid: spawned.pid,
      status,
    };
  } catch (error) {
    const logPath = config.apps.web.latestLogPath;
    const lines = await readLogTail(logPath, 80).catch(() => []);
    await stopApp(config, APP_KEYS.WEB).catch(() => undefined);
    throw appendStartupLogDiagnostics(error, APP_KEYS.WEB, createStartupLogDiagnostics(logPath, lines));
  }
}

async function startDesktop(config: ToolDevConfig, options: CliOptions) {
  const existing = await inspectDesktopRuntime(runtimeLookup(config));
  if (existing != null) {
    return { app: APP_KEYS.DESKTOP, created: false, logPath: config.apps.desktop.latestLogPath, status: existing };
  }
  await assertNoStaleProcess(config, APP_KEYS.DESKTOP);

  const spawned = await spawnDesktopRuntime(config, options);
  try {
    const status = await waitForDesktopRuntime(runtimeLookup(config));
    return {
      app: APP_KEYS.DESKTOP,
      created: true,
      logPath: config.apps.desktop.latestLogPath,
      pid: spawned.pid,
      status,
    };
  } catch (error) {
    await stopApp(config, APP_KEYS.DESKTOP).catch(() => undefined);
    throw error;
  }
}

async function startDesktopApp(config: ToolDevConfig, options: CliOptions) {
  await ensureDesktopGate({
    inspectDaemon: () => inspectDaemonRuntime(runtimeLookup(config)),
    inspectWeb: () => inspectWebRuntime(runtimeLookup(config)),
    stopApp: async (app) => {
      await stopApp(config, app);
    },
    startDaemonGated: async ({ port }) => {
      const portedOptions: CliOptions = port != null ? { ...options, daemonPort: port } : options;
      await startDaemon(config, portedOptions, { requireDesktopAuth: true });
    },
    startWeb: async ({ port }) => {
      const portedOptions: CliOptions = port != null ? { ...options, webPort: port } : options;
      await startWeb(config, portedOptions);
    },
    log: (msg) => process.stderr.write(`${msg}\n`),
  });
  return await startDesktop(config, options);
}

async function startApp(
  config: ToolDevConfig,
  appName: ToolDevAppName,
  options: CliOptions,
  context: { targets?: readonly ToolDevAppName[] } = {},
) {
  switch (appName) {
    case APP_KEYS.DAEMON:
      return await startDaemon(config, options, {
        requireDesktopAuth: context.targets?.includes(APP_KEYS.DESKTOP) === true,
      });
    case APP_KEYS.WEB:
      return await startWeb(config, options);
    case APP_KEYS.DESKTOP:
      return await startDesktopApp(config, options);
  }
}

async function requestAppShutdown(config: ToolDevConfig, appName: ToolDevAppName): Promise<boolean> {
  try {
    await requestJsonIpc(appConfig(config, appName).ipcPath, { type: SIDECAR_MESSAGES.SHUTDOWN }, { timeoutMs: 1500 });
    return true;
  } catch {
    return false;
  }
}

function stoppedByGracefulResult(matchedPids: number[]): StopProcessesResult {
  return {
    alreadyStopped: matchedPids.length === 0,
    forcedPids: [],
    matchedPids,
    remainingPids: [],
    stoppedPids: matchedPids,
  };
}

async function stopApp(config: ToolDevConfig, appName: ToolDevAppName) {
  const before = await findAppProcessTree(config, appName);
  const gracefulRequested = await requestAppShutdown(config, appName);
  const remainingAfterGraceful = gracefulRequested
    ? await waitForExit(config, appName)
    : before.pids;

  if (remainingAfterGraceful.length === 0) {
    return {
      app: appName,
      status: before.pids.length === 0 ? "not-running" : "stopped",
      stop: stoppedByGracefulResult(before.pids),
      via: gracefulRequested ? "ipc" : "process-scan",
    };
  }

  const stop = await stopProcesses(remainingAfterGraceful);
  return {
    app: appName,
    status: stop.remainingPids.length === 0 ? "stopped" : "partial",
    stop,
    via: gracefulRequested ? "ipc+fallback" : "fallback",
  };
}

async function runSequential<T>(targets: readonly ToolDevAppName[], operation: (target: ToolDevAppName) => Promise<T>) {
  const result: Partial<Record<ToolDevAppName, T>> = {};
  for (const target of targets) result[target] = await operation(target);
  return result;
}

function summarizeStatus(apps: Record<ToolDevAppName, any>): string {
  const states = Object.values(apps).map((entry) => entry?.state);
  if (states.every((state) => state === "idle")) return "not-running";
  if (states.every((state) => state === "running")) return "running";
  return "partial";
}

export async function startTargets(config: ToolDevConfig, appName: string | undefined, options: CliOptions) {
  const targets = resolveStartApps(appName);
  return await runSequential(targets, (target) => startApp(config, target, options, { targets }));
}

export async function stopTargets(config: ToolDevConfig, appName: string | undefined) {
  const targets = resolveStopApps(appName);
  return await runSequential(targets, (target) => stopApp(config, target));
}

export async function status(config: ToolDevConfig, appName: string | undefined) {
  const targets = resolveTargetApps(appName, DEFAULT_START_APPS);
  if (targets.length === 1) return await inspectAppStatus(config, targets[0]);

  const apps = Object.fromEntries(
    await Promise.all(targets.map(async (target) => [target, await inspectAppStatus(config, target)] as const)),
  ) as Record<ToolDevAppName, unknown>;
  return { apps, namespace: config.namespace, status: summarizeStatus(apps) };
}

export async function restartTargets(config: ToolDevConfig, appName: string | undefined, options: CliOptions) {
  const stopTargets = resolveStopApps(appName);
  const startTargets = resolveStartApps(appName);
  return {
    stop: await runSequential(stopTargets, (target) => stopApp(config, target)),
    start: await runSequential(startTargets, (target) => startApp(config, target, options, { targets: startTargets })),
  };
}

export async function readLogs(config: ToolDevConfig, appName: ToolDevAppName): Promise<LogResult> {
  const logPath = appConfig(config, appName).latestLogPath;
  return { app: appName, lines: await readLogTail(logPath, 200), logPath };
}

function createLogDiagnostics(logs: Record<string, LogResult>): Record<string, LogDiagnostic[]> {
  return Object.fromEntries(
    Object.entries(logs).map(([appName, log]) => [appName, detectLogDiagnostics(log.lines)] as const),
  );
}

export async function logs(config: ToolDevConfig, appName: string | undefined) {
  const targets = resolveTargetApps(appName, DEFAULT_START_APPS);
  return targets.length === 1
    ? await readLogs(config, targets[0])
    : Object.fromEntries(await Promise.all(targets.map(async (target) => [target, await readLogs(config, target)] as const)));
}

export async function check(config: ToolDevConfig, appName: string | undefined) {
  const targets = resolveTargetApps(appName, DEFAULT_START_APPS);
  const apps = Object.fromEntries(
    await Promise.all(targets.map(async (target) => [target, await inspectAppStatus(config, target)] as const)),
  );
  const appLogs = Object.fromEntries(
    await Promise.all(targets.map(async (target) => [target, await readLogs(config, target)] as const)),
  );
  return { apps, diagnostics: createLogDiagnostics(appLogs), logs: appLogs, namespace: config.namespace };
}

function stopOrderFor(targets: readonly ToolDevAppName[]): ToolDevAppName[] {
  const selected = new Set(targets);
  return DEFAULT_STOP_APPS.filter((target) => selected.has(target));
}

export async function runForeground(config: ToolDevConfig, appName: string | undefined, options: CliOptions) {
  const targets = resolveRunApps(appName);
  const foregroundOptions = { ...options, parentPid: process.pid };
  const started = await runSequential(targets, (target) => startApp(config, target, foregroundOptions, { targets }));
  printRunForegroundResult(started, options);

  let shuttingDown = false;
  const keepAlive = setInterval(() => undefined, 60_000);
  await new Promise<void>((resolveDone) => {
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(keepAlive);
      process.stderr.write("\nStopping Open Design dev server...\n");
      void runSequential(stopOrderFor(targets), (target) => stopApp(config, target)).finally(() => {
        for (const sig of ["SIGINT", "SIGTERM"] as const) {
          process.off(sig, shutdown);
        }
        process.exitCode = 0;
        resolveDone();
      });
    };
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, shutdown);
    }
  });
}
