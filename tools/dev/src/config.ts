import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  APP_KEYS,
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_ENV,
  SIDECAR_SOURCES,
} from "@open-design/sidecar-proto";
import {
  resolveAppIpcPath,
  resolveLogFilePath,
  resolveNamespace,
  resolveNamespaceRoot,
  resolveSidecarBase,
  resolveSourceRuntimeRoot,
} from "@open-design/sidecar";

import { ToolDevError } from "./lib/errors.js";
import { ensure } from "./lib/ensure.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const WORKSPACE_ROOT = path.resolve(__dirname, "../../..");

export const ALL_APPS = [APP_KEYS.DAEMON, APP_KEYS.WEB, APP_KEYS.DESKTOP] as const;
export const DEFAULT_START_APPS = [APP_KEYS.DAEMON, APP_KEYS.WEB, APP_KEYS.DESKTOP] as const;
export const DEFAULT_RUN_APPS = [APP_KEYS.DAEMON, APP_KEYS.WEB] as const;
export const DEFAULT_STOP_APPS = [APP_KEYS.DESKTOP, APP_KEYS.WEB, APP_KEYS.DAEMON] as const;

export type ToolDevAppName = (typeof ALL_APPS)[number];

export type ToolDevOptions = {
  bundlePath?: string | null;
  daemonPort?: number | string | null;
  json?: boolean;
  namespace?: string;
  prod?: boolean;
  toolsDevRoot?: string;
  webPort?: number | string | null;
};

export type ToolDevAppConfig = {
  app: ToolDevAppName;
  ipcPath: string;
  latestLogPath: string;
  logDir: string;
};

export type ToolDevConfig = {
  apps: {
    daemon: ToolDevAppConfig & {
      launchEntryPath: string;
    };
    desktop: ToolDevAppConfig & {
      launchEntryPath: string;
    };
    web: ToolDevAppConfig & {
      launchEntryPath: string;
    };
  };
  bundlePath: string | null;
  dataRoot: string;
  namespace: string;
  namespaceRoot: string;
  toolsDevRoot: string;
  tsxCliPath: string;
  workspaceRoot: string;
};

function resolveTsxCliPath(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("tsx/cli");
}

function resolveAppConfig(options: {
  app: ToolDevAppName;
  namespace: string;
  namespaceRoot: string;
  toolsDevRoot: string;
}): ToolDevAppConfig {
  return {
    app: options.app,
    ipcPath: resolveAppIpcPath({
      app: options.app,
      contract: OPEN_DESIGN_SIDECAR_CONTRACT,
      namespace: options.namespace,
    }),
    latestLogPath: resolveLogFilePath({ runtimeRoot: options.namespaceRoot, app: options.app, contract: OPEN_DESIGN_SIDECAR_CONTRACT }),
    logDir: path.dirname(resolveLogFilePath({ runtimeRoot: options.namespaceRoot, app: options.app, contract: OPEN_DESIGN_SIDECAR_CONTRACT })),
  };
}

export function isAppName(value: string): value is ToolDevAppName {
  return ALL_APPS.includes(value as ToolDevAppName);
}

function unsupportedAppError(value: string): Error {
  return ToolDevError.unsupportedApp(value, ALL_APPS);
}

export function resolveTargetApps(appName: string | undefined, defaults: readonly ToolDevAppName[]): ToolDevAppName[] {
  if (appName == null) return [...defaults];
  if (!isAppName(appName)) throw unsupportedAppError(appName);
  return [appName];
}

export function resolveStartApps(appName: string | undefined): ToolDevAppName[] {
  if (appName == null) return [...DEFAULT_START_APPS];
  if (!isAppName(appName)) throw unsupportedAppError(appName);
  if (appName === APP_KEYS.WEB) return [APP_KEYS.DAEMON, APP_KEYS.WEB];
  if (appName === APP_KEYS.DESKTOP) return [APP_KEYS.DAEMON, APP_KEYS.WEB, APP_KEYS.DESKTOP];
  return [APP_KEYS.DAEMON];
}

export function resolveRunApps(appName: string | undefined): ToolDevAppName[] {
  if (appName == null) return [...DEFAULT_RUN_APPS];
  return resolveStartApps(appName);
}

export function resolveStopApps(appName: string | undefined): ToolDevAppName[] {
  if (appName == null) return [...DEFAULT_STOP_APPS];
  if (!isAppName(appName)) throw unsupportedAppError(appName);
  if (appName === APP_KEYS.WEB) return [APP_KEYS.WEB, APP_KEYS.DAEMON];
  if (appName === APP_KEYS.DESKTOP) return [APP_KEYS.DESKTOP];
  return [APP_KEYS.DAEMON];
}

export function parsePortOption(value: number | string | null | undefined, optionName: string): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  ensure(Number.isInteger(parsed) && parsed > 0 && parsed <= 65535)
    .or(() => ToolDevError.invalidOption(optionName, "must be an integer between 1 and 65535"));
  return parsed;
}

export function resolveToolDevConfig(options: ToolDevOptions = {}): ToolDevConfig {
  const namespace = resolveNamespace({ namespace: options.namespace, env: process.env, contract: OPEN_DESIGN_SIDECAR_CONTRACT });
  const toolsDevRoot = resolveSidecarBase({
    base: options.toolsDevRoot ?? process.env[SIDECAR_ENV.BASE] ?? resolveSourceRuntimeRoot({
      contract: OPEN_DESIGN_SIDECAR_CONTRACT,
      projectRoot: WORKSPACE_ROOT,
      source: SIDECAR_SOURCES.TOOLS_DEV,
    }),
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    env: process.env,
    projectRoot: WORKSPACE_ROOT,
    source: SIDECAR_SOURCES.TOOLS_DEV,
  });
  const namespaceRoot = resolveNamespaceRoot({ base: toolsDevRoot, namespace, contract: OPEN_DESIGN_SIDECAR_CONTRACT });
  const dataRoot = path.join(namespaceRoot, "data");
  const daemon = resolveAppConfig({ app: APP_KEYS.DAEMON, namespace, namespaceRoot, toolsDevRoot });
  const desktop = resolveAppConfig({ app: APP_KEYS.DESKTOP, namespace, namespaceRoot, toolsDevRoot });
  const web = resolveAppConfig({ app: APP_KEYS.WEB, namespace, namespaceRoot, toolsDevRoot });
  return {
    apps: {
      daemon: {
        ...daemon,
        launchEntryPath: path.join(WORKSPACE_ROOT, "apps/daemon/scripts/dev.ts"),
      },
      desktop: {
        ...desktop,
        launchEntryPath: path.join(WORKSPACE_ROOT, "apps/desktop/scripts/dev.ts"),
      },
      web: {
        ...web,
        launchEntryPath: path.join(WORKSPACE_ROOT, "apps/web/sidecar/index.ts"),
      },
    },
    bundlePath: options.bundlePath == null || options.bundlePath.length === 0 ? null : path.resolve(options.bundlePath),
    dataRoot,
    namespace,
    namespaceRoot,
    toolsDevRoot,
    tsxCliPath: resolveTsxCliPath(),
    workspaceRoot: WORKSPACE_ROOT,
  };
}
