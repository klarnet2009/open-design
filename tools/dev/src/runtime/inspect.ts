import {
  APP_KEYS,
  SIDECAR_EVENTS,
  SIDECAR_MESSAGES,
  type DaemonStatusSnapshot,
  type DesktopStatusSnapshot,
  type SidecarEventKey,
  type WebStatusSnapshot,
} from "@open-design/sidecar-proto";
import { requestJsonIpc } from "@open-design/sidecar";

import type { CliOptions } from "./options.js";
import type { ToolDevAppName, ToolDevConfig } from "../config.js";
import { findAppProcessTree, runtimeLookup } from "./processes.js";
import {
  inspectDaemonRuntime,
  inspectDesktopRuntime,
  inspectWebRuntime,
} from "../sidecar-client.js";

function parseTimeoutMs(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--timeout must be a positive number of seconds");
  return seconds * 1000;
}

function parsePayload(value: string | undefined): unknown {
  if (value == null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`inspect payload must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function targetToEventKey(appName: ToolDevAppName, target: string | undefined): SidecarEventKey {
  const operation = target ?? "status";
  if (operation.includes(".")) return operation as SidecarEventKey;
  if (operation === "status") return SIDECAR_EVENTS.INSPECT_STATUS;
  if (operation === "eval") return SIDECAR_EVENTS.INSPECT_EVAL;
  if (operation === "screenshot") return SIDECAR_EVENTS.INSPECT_SCREENSHOT;
  if (operation === "console") return SIDECAR_EVENTS.INSPECT_CONSOLE;
  if (operation === "click") return SIDECAR_EVENTS.INSPECT_CLICK;
  if (operation === "update") return SIDECAR_EVENTS.INSPECT_UPDATE;
  throw new Error(`unsupported ${appName} inspect target: ${operation}`);
}

function payloadFromOptions(eventKey: SidecarEventKey, payload: unknown, options: CliOptions): unknown {
  if (payload != null) return payload;
  if (eventKey === SIDECAR_EVENTS.INSPECT_EVAL) {
    if (options.expr == null) throw new Error("--expr or JSON payload is required for inspect eval");
    return { expression: options.expr };
  }
  if (eventKey === SIDECAR_EVENTS.INSPECT_SCREENSHOT) {
    if (options.path == null) throw new Error("--path or JSON payload is required for inspect screenshot");
    return { path: options.path };
  }
  if (eventKey === SIDECAR_EVENTS.INSPECT_CLICK) {
    if (options.selector == null) throw new Error("--selector or JSON payload is required for inspect click");
    return { selector: options.selector };
  }
  if (eventKey === SIDECAR_EVENTS.INSPECT_UPDATE) {
    if (options.updateAction != null && !["status", "check", "download", "install"].includes(options.updateAction)) {
      throw new Error("--update-action must be status, check, download, or install");
    }
    return { action: options.updateAction ?? "status" };
  }
  return undefined;
}

async function requestInspectEvent(
  config: ToolDevConfig,
  appName: ToolDevAppName,
  eventKey: SidecarEventKey,
  payload: unknown,
  timeoutMs: number,
) {
  const message = {
    key: eventKey,
    ...(payload == null ? {} : { payload }),
    type: SIDECAR_MESSAGES.EVENT,
  };

  try {
    return await requestJsonIpc<unknown>(config.apps[appName].ipcPath, message, { timeoutMs });
  } catch (error) {
    const active = await findAppProcessTree(config, appName);
    if (active.pids.length === 0) {
      throw new Error(`${appName} sidecar is not running in namespace ${config.namespace}; inspect requires a reachable IPC server`);
    }
    throw error;
  }
}

export async function inspectAppStatus(config: ToolDevConfig, appName: ToolDevAppName) {
  if (appName === APP_KEYS.DAEMON) {
    const status = await inspectDaemonRuntime(runtimeLookup(config));
    if (status != null) return status;
    const active = await findAppProcessTree(config, appName);
    return {
      desktopAuthGateActive: false,
      pid: active.rootPids[0] ?? null,
      state: active.pids.length > 0 ? "starting" : "idle",
      url: null,
    } satisfies DaemonStatusSnapshot;
  }
  if (appName === APP_KEYS.WEB) {
    const status = await inspectWebRuntime(runtimeLookup(config));
    if (status != null) return status;
    const active = await findAppProcessTree(config, appName);
    return { pid: active.rootPids[0] ?? null, state: active.pids.length > 0 ? "starting" : "idle", url: null } satisfies WebStatusSnapshot;
  }

  const status = await inspectDesktopRuntime(runtimeLookup(config));
  if (status != null) return status;
  const active = await findAppProcessTree(config, appName);
  return { pid: active.rootPids[0] ?? null, state: active.pids.length > 0 ? "unknown" : "idle", url: null };
}

export async function inspect(
  config: ToolDevConfig,
  appName: string,
  target: string | undefined,
  payloadJson: string | undefined,
  options: CliOptions,
) {
  if (appName !== APP_KEYS.DAEMON && appName !== APP_KEYS.WEB && appName !== APP_KEYS.DESKTOP) {
    throw new Error(`unsupported tools-dev app: ${appName}`);
  }

  const eventKey = targetToEventKey(appName, target);
  const timeoutMs = parseTimeoutMs(options.timeout) ?? 30000;
  const payload = payloadFromOptions(eventKey, parsePayload(payloadJson), options);
  return await requestInspectEvent(config, appName, eventKey, payload, timeoutMs);
}
