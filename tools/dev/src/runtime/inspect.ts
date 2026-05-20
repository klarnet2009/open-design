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
import { ALL_APPS, isAppName, type ToolDevAppName, type ToolDevConfig } from "../config.js";
import { ToolDevError } from "../lib/errors.js";
import { ensure } from "../lib/ensure.js";
import { findAppProcessTree, runtimeLookup } from "./processes.js";
import {
  inspectDaemonRuntime,
  inspectDesktopRuntime,
  inspectWebRuntime,
} from "../sidecar-client.js";

function parseTimeoutMs(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const seconds = Number(value);
  ensure(Number.isFinite(seconds) && seconds > 0)
    .or(() => ToolDevError.invalidOption("--timeout", "must be a positive number of seconds"));
  return seconds * 1000;
}

function parsePayload(value: string | undefined): unknown {
  if (value == null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw ToolDevError.invalidJsonPayload("inspect payload", error);
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
  throw ToolDevError.unsupportedInspectTarget(appName, operation);
}

function payloadFromOptions(eventKey: SidecarEventKey, payload: unknown, options: CliOptions): unknown {
  if (payload != null) return payload;
  if (eventKey === SIDECAR_EVENTS.INSPECT_EVAL) {
    const expression = ensure.defined(options.expr)
      .or(() => ToolDevError.missingInspectPayload("eval", "--expr or JSON payload"));
    return { expression };
  }
  if (eventKey === SIDECAR_EVENTS.INSPECT_SCREENSHOT) {
    const screenshotPath = ensure.defined(options.path)
      .or(() => ToolDevError.missingInspectPayload("screenshot", "--path or JSON payload"));
    return { path: screenshotPath };
  }
  if (eventKey === SIDECAR_EVENTS.INSPECT_CLICK) {
    const selector = ensure.defined(options.selector)
      .or(() => ToolDevError.missingInspectPayload("click", "--selector or JSON payload"));
    return { selector };
  }
  if (eventKey === SIDECAR_EVENTS.INSPECT_UPDATE) {
    ensure(options.updateAction == null || ["status", "check", "download", "install"].includes(options.updateAction))
      .or(() => ToolDevError.invalidOption("--update-action", "must be status, check, download, or install"));
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
      throw ToolDevError.runtimeUnavailable(appName, config.namespace);
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
  ensure(isAppName(appName)).or(() => ToolDevError.unsupportedApp(appName, ALL_APPS));
  const targetAppName = appName as ToolDevAppName;

  const eventKey = targetToEventKey(targetAppName, target);
  const timeoutMs = parseTimeoutMs(options.timeout) ?? 30000;
  const payload = payloadFromOptions(eventKey, parsePayload(payloadJson), options);
  return await requestInspectEvent(config, targetAppName, eventKey, payload, timeoutMs);
}
