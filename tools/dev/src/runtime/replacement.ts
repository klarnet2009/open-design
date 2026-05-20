import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { resolveBundleArtifact, type BundleArtifact } from "@open-design/bundle";
import { APP_KEYS, type DaemonStatusSnapshot, type SidecarImplementationSnapshot, type WebStatusSnapshot } from "@open-design/sidecar-proto";

import type { ToolDevAppName, ToolDevConfig } from "../config.js";
import { ensure } from "../lib/ensure.js";
import { ToolDevError } from "../lib/errors.js";
import {
  inspectDaemonRuntime,
  inspectWebRuntime,
} from "../sidecar-client.js";
import type { CliOptions } from "./options.js";
import {
  runtimeLookup,
  urlPort,
} from "./processes.js";
import {
  startDaemon,
  startWeb,
  stopApp,
} from "./lifecycle.js";

type ImplementationSummary =
  | {
      bundlePath: string;
      entryPath?: string;
      source: "bundle";
    }
  | {
      source: "workspace";
    };

type WebBundleReplacementRuntime = {
  appendWebLog(lines: readonly string[]): Promise<void>;
  inspectDaemon(): Promise<DaemonStatusSnapshot | null>;
  inspectWeb(): Promise<WebStatusSnapshot | null>;
  resolveBundle(bundlePath: string): Promise<BundleArtifact>;
  startWeb(config: ToolDevConfig, options: CliOptions): Promise<unknown>;
  stopWeb(config: ToolDevConfig): Promise<unknown>;
};

type DaemonBundleReplacementRuntime = {
  appendDaemonLog(lines: readonly string[]): Promise<void>;
  inspectDaemon(): Promise<DaemonStatusSnapshot | null>;
  inspectWeb(): Promise<WebStatusSnapshot | null>;
  resolveBundle(bundlePath: string): Promise<BundleArtifact>;
  startDaemon(
    config: ToolDevConfig,
    options: CliOptions,
    startOptions: { implementation?: BundleArtifact; requireDesktopAuth?: boolean },
  ): Promise<unknown>;
  stopDaemon(config: ToolDevConfig): Promise<unknown>;
};

function configWithBundlePath(config: ToolDevConfig, bundlePath: string | null): ToolDevConfig {
  return { ...config, bundlePath };
}

function summarizeImplementation(implementation: SidecarImplementationSnapshot | undefined): ImplementationSummary {
  if (implementation?.source === "bundle") {
    return {
      bundlePath: implementation.bundlePath,
      ...(implementation.entryPath == null ? {} : { entryPath: implementation.entryPath }),
      source: "bundle",
    };
  }
  return { source: "workspace" };
}

function formatImplementation(summary: ImplementationSummary): string {
  if (summary.source === "workspace") return "workspace";
  return `bundle ${summary.bundlePath}${summary.entryPath == null ? "" : ` entry ${summary.entryPath}`}`;
}

function requireRunningUrl(status: { url: string | null }, appName: ToolDevAppName, namespace: string): string {
  return ensure.defined(status.url)
    .or(() => ToolDevError.runtimeUnavailable(appName, namespace));
}

async function appendReplaceLog(logPath: string, lines: readonly string[]): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${lines.join("\n")}\n`, "utf8");
}

function replacementOptions(options: CliOptions, bundlePath: string | null, ports: { daemon: string; web?: string }): CliOptions {
  return {
    ...options,
    bundlePath,
    daemonPort: ports.daemon,
    ...(ports.web == null ? {} : { webPort: ports.web }),
  };
}

export async function replaceWebBundleCore(
  config: ToolDevConfig,
  options: CliOptions,
  runtime: WebBundleReplacementRuntime,
) {
  const nextBundlePath = ensure.defined(config.bundlePath)
    .or(() => ToolDevError.invalidOption("--bundle-path", "is required for replace web"));
  const nextArtifact = await runtime.resolveBundle(nextBundlePath);
  const [daemonBefore, webBefore] = await Promise.all([runtime.inspectDaemon(), runtime.inspectWeb()]);
  const daemonStatus = ensure.defined(daemonBefore)
    .or(() => ToolDevError.runtimeUnavailable(APP_KEYS.DAEMON, config.namespace));
  const webStatus = ensure.defined(webBefore)
    .or(() => ToolDevError.runtimeUnavailable(APP_KEYS.WEB, config.namespace));
  const daemonUrl = requireRunningUrl(daemonStatus, APP_KEYS.DAEMON, config.namespace);
  const webUrl = requireRunningUrl(webStatus, APP_KEYS.WEB, config.namespace);
  const ports = { daemon: urlPort(daemonUrl), web: urlPort(webUrl) };
  const previousImplementation = summarizeImplementation(webStatus.implementation);
  const previousBundlePath = previousImplementation.source === "bundle" ? previousImplementation.bundlePath : null;

  await runtime.appendWebLog([
    "",
    `[tools-dev] replacing web bundle at ${new Date().toISOString()}`,
    `[tools-dev] replacement previous implementation: ${formatImplementation(previousImplementation)}`,
    `[tools-dev] replacement next bundle: ${nextArtifact.bundlePath}`,
    `[tools-dev] replacement preserving daemon port ${ports.daemon} web port ${ports.web}`,
  ]);

  const stop = await runtime.stopWeb(config);
  await runtime.appendWebLog([`[tools-dev] replacement stopped web before launching ${nextArtifact.bundlePath}`]);

  try {
    const startConfig = configWithBundlePath(config, nextArtifact.bundlePath);
    const start = await runtime.startWeb(startConfig, replacementOptions(options, nextArtifact.bundlePath, ports));
    const [daemonAfter, webAfter] = await Promise.all([runtime.inspectDaemon(), runtime.inspectWeb()]);
    await runtime.appendWebLog([`[tools-dev] replacement completed with bundle ${nextArtifact.bundlePath}`]);
    return {
      app: APP_KEYS.WEB,
      after: { daemon: daemonAfter, web: webAfter },
      before: { daemon: daemonStatus, web: webStatus },
      next: {
        bundlePath: nextArtifact.bundlePath,
        descriptorPath: nextArtifact.descriptorPath,
        entryPath: nextArtifact.entryPath,
      },
      ports,
      previous: previousImplementation,
      rollback: null,
      start,
      stop,
    };
  } catch (error) {
    await runtime.appendWebLog([`[tools-dev] replacement failed; attempting rollback to ${formatImplementation(previousImplementation)}`]);
    let rollback: unknown;
    try {
      const rollbackConfig = configWithBundlePath(config, previousBundlePath);
      rollback = await runtime.startWeb(rollbackConfig, replacementOptions(options, previousBundlePath, ports));
      await runtime.appendWebLog([`[tools-dev] replacement rollback completed to ${formatImplementation(previousImplementation)}`]);
    } catch (rollbackError) {
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      rollback = {
        error: rollbackMessage,
        status: "failed",
      };
      await runtime.appendWebLog([`[tools-dev] replacement rollback failed: ${rollbackMessage}`]);
    }
    throw ToolDevError.webReplacementFailed(error, rollback);
  }
}

export async function replaceDaemonBundleCore(
  config: ToolDevConfig,
  options: CliOptions,
  runtime: DaemonBundleReplacementRuntime,
) {
  const nextBundlePath = ensure.defined(config.bundlePath)
    .or(() => ToolDevError.invalidOption("--bundle-path", "is required for replace daemon"));
  const nextArtifact = await runtime.resolveBundle(nextBundlePath);
  const [daemonBefore, webBefore] = await Promise.all([runtime.inspectDaemon(), runtime.inspectWeb()]);
  const daemonStatus = ensure.defined(daemonBefore)
    .or(() => ToolDevError.runtimeUnavailable(APP_KEYS.DAEMON, config.namespace));
  const daemonUrl = requireRunningUrl(daemonStatus, APP_KEYS.DAEMON, config.namespace);
  const ports = {
    daemon: urlPort(daemonUrl),
    ...(webBefore?.url == null ? {} : { web: urlPort(webBefore.url) }),
  };
  const previousImplementation = summarizeImplementation(daemonStatus.implementation);
  const previousBundlePath = previousImplementation.source === "bundle" ? previousImplementation.bundlePath : null;

  await runtime.appendDaemonLog([
    "",
    `[tools-dev] replacing daemon bundle at ${new Date().toISOString()}`,
    `[tools-dev] replacement previous implementation: ${formatImplementation(previousImplementation)}`,
    `[tools-dev] replacement next bundle: ${nextArtifact.bundlePath}`,
    `[tools-dev] replacement preserving daemon port ${ports.daemon}${ports.web == null ? "" : ` web port ${ports.web}`}`,
  ]);

  const stop = await runtime.stopDaemon(config);
  await runtime.appendDaemonLog([`[tools-dev] replacement stopped daemon before launching ${nextArtifact.bundlePath}`]);

  try {
    const startConfig = configWithBundlePath(config, nextArtifact.bundlePath);
    const start = await runtime.startDaemon(startConfig, replacementOptions(options, nextArtifact.bundlePath, ports), {
      implementation: nextArtifact,
      requireDesktopAuth: daemonStatus.desktopAuthGateActive,
    });
    const [daemonAfter, webAfter] = await Promise.all([runtime.inspectDaemon(), runtime.inspectWeb()]);
    await runtime.appendDaemonLog([`[tools-dev] replacement completed with bundle ${nextArtifact.bundlePath}`]);
    return {
      app: APP_KEYS.DAEMON,
      after: { daemon: daemonAfter, web: webAfter },
      before: { daemon: daemonStatus, web: webBefore },
      next: {
        bundlePath: nextArtifact.bundlePath,
        descriptorPath: nextArtifact.descriptorPath,
        entryPath: nextArtifact.entryPath,
      },
      ports,
      previous: previousImplementation,
      rollback: null,
      start,
      stop,
    };
  } catch (error) {
    await runtime.appendDaemonLog([`[tools-dev] replacement failed; attempting rollback to ${formatImplementation(previousImplementation)}`]);
    let rollback: unknown;
    try {
      const rollbackConfig = configWithBundlePath(config, previousBundlePath);
      const previousArtifact = previousBundlePath == null ? undefined : await runtime.resolveBundle(previousBundlePath);
      rollback = await runtime.startDaemon(rollbackConfig, replacementOptions(options, previousBundlePath, ports), {
        implementation: previousArtifact,
        requireDesktopAuth: daemonStatus.desktopAuthGateActive,
      });
      await runtime.appendDaemonLog([`[tools-dev] replacement rollback completed to ${formatImplementation(previousImplementation)}`]);
    } catch (rollbackError) {
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      rollback = {
        error: rollbackMessage,
        status: "failed",
      };
      await runtime.appendDaemonLog([`[tools-dev] replacement rollback failed: ${rollbackMessage}`]);
    }
    throw ToolDevError.daemonReplacementFailed(error, rollback);
  }
}

export async function replaceBundle(config: ToolDevConfig, appName: string, options: CliOptions) {
  if (appName === APP_KEYS.DAEMON) {
    return await replaceDaemonBundleCore(config, options, {
      appendDaemonLog: async (lines) => {
        await appendReplaceLog(config.apps.daemon.latestLogPath, lines);
      },
      inspectDaemon: async () => await inspectDaemonRuntime(runtimeLookup(config)),
      inspectWeb: async () => await inspectWebRuntime(runtimeLookup(config)),
      resolveBundle: async (bundlePath) => await resolveBundleArtifact(bundlePath),
      startDaemon,
      stopDaemon: async (targetConfig) => await stopApp(targetConfig, APP_KEYS.DAEMON),
    });
  }

  ensure(appName === APP_KEYS.WEB).or(() => ToolDevError.unsupportedApp(appName, [APP_KEYS.DAEMON, APP_KEYS.WEB]));
  return await replaceWebBundleCore(config, options, {
    appendWebLog: async (lines) => {
      await appendReplaceLog(config.apps.web.latestLogPath, lines);
    },
    inspectDaemon: async () => await inspectDaemonRuntime(runtimeLookup(config)),
    inspectWeb: async () => await inspectWebRuntime(runtimeLookup(config)),
    resolveBundle: async (bundlePath) => await resolveBundleArtifact(bundlePath),
    startWeb,
    stopWeb: async (targetConfig) => await stopApp(targetConfig, APP_KEYS.WEB),
  });
}
