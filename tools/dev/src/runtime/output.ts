import { ALL_APPS, type ToolDevAppName } from "../config.js";
import { formatLogDiagnostics, type LogDiagnostic } from "../diagnostics.js";
import type { CliOptions } from "./options.js";

export type LogResult = {
  app: ToolDevAppName;
  lines: string[];
  logPath: string;
};

export function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function output(payload: unknown, options: CliOptions = {}): void {
  if (typeof payload === "string" && options.json !== true) {
    process.stdout.write(`${payload}\n`);
    return;
  }
  printJson(payload);
}

function normalizeDisplayUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function colorizeLink(url: string): string {
  if (process.env.NO_COLOR != null || process.stdout.isTTY !== true) return url;
  const reset = "\x1b[0m";
  const cyan = "\x1b[36m";
  const underline = "\x1b[4m";
  return `${cyan}${underline}${url}${reset}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberArrayField(record: Record<string, unknown> | null, key: string): number[] {
  const value = record?.[key];
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry)) : [];
}

function formatProcessList(pids: readonly number[]): string | null {
  if (pids.length === 0) return null;
  const visible = pids.slice(0, 5).join(", ");
  return pids.length > 5 ? `${visible}, +${pids.length - 5} more` : visible;
}

function formatStatusSummary(status: unknown): string {
  const record = asRecord(status);
  if (record == null) return "status unavailable";

  const parts = [stringField(record, "state") ?? "unknown"];
  const url = stringField(record, "url");
  const pid = numberField(record, "pid");
  const title = stringField(record, "title");
  const windowVisible = record.windowVisible;
  if (url != null) parts.push(url);
  if (pid != null) parts.push(`pid ${pid}`);
  if (title != null) parts.push(`title ${JSON.stringify(title)}`);
  if (typeof windowVisible === "boolean") parts.push(`window ${windowVisible ? "visible" : "hidden"}`);

  return parts.join(" · ");
}

function printStatusEntries(apps: Record<string, unknown>): void {
  for (const [appName, appStatus] of Object.entries(apps)) {
    process.stdout.write(`- ${appName}: ${formatStatusSummary(appStatus)}\n`);
  }
}

function printStartSection(result: Partial<Record<ToolDevAppName, unknown>>, heading: string): void {
  process.stdout.write(`${heading}\n`);
  const entries = Object.entries(result);
  if (entries.length === 0) {
    process.stdout.write("(no apps)\n");
    return;
  }

  for (const [appName, rawEntry] of entries) {
    const entry = asRecord(rawEntry);
    const created = entry?.created;
    const action = created === true ? "started" : created === false ? "already running" : "ready";
    process.stdout.write(`- ${appName}: ${action} · ${formatStatusSummary(entry?.status)}\n`);
    const logPath = entry == null ? null : stringField(entry, "logPath");
    if (logPath != null) process.stdout.write(`  log: ${logPath}\n`);
  }
}

export function printStartResult(result: Partial<Record<ToolDevAppName, unknown>>, options: CliOptions, heading = "tools-dev start"): void {
  if (options.json === true) {
    printJson(result);
    return;
  }
  printStartSection(result, heading);
}

function printStopSection(result: Partial<Record<ToolDevAppName, unknown>>, heading: string): void {
  process.stdout.write(`${heading}\n`);
  const entries = Object.entries(result);
  if (entries.length === 0) {
    process.stdout.write("(no apps)\n");
    return;
  }

  for (const [appName, rawEntry] of entries) {
    const entry = asRecord(rawEntry);
    const stop = asRecord(entry?.stop);
    const stoppedPids = formatProcessList(numberArrayField(stop, "stoppedPids"));
    const remainingPids = formatProcessList(numberArrayField(stop, "remainingPids"));
    const parts = [entry == null ? "unknown" : stringField(entry, "status") ?? "unknown"];
    const via = entry == null ? null : stringField(entry, "via");
    if (via != null) parts.push(`via ${via}`);
    if (stoppedPids != null) parts.push(`stopped pids ${stoppedPids}`);
    if (remainingPids != null) parts.push(`remaining pids ${remainingPids}`);
    process.stdout.write(`- ${appName}: ${parts.join(" · ")}\n`);
  }
}

export function printStopResult(result: Partial<Record<ToolDevAppName, unknown>>, options: CliOptions, heading = "tools-dev stop"): void {
  if (options.json === true) {
    printJson(result);
    return;
  }
  printStopSection(result, heading);
}

export function printRestartResult(result: unknown, options: CliOptions): void {
  if (options.json === true) {
    printJson(result);
    return;
  }

  const record = asRecord(result);
  process.stdout.write("tools-dev restart\n");
  printStopSection((asRecord(record?.stop) ?? {}) as Partial<Record<ToolDevAppName, unknown>>, "Stop");
  printStartSection((asRecord(record?.start) ?? {}) as Partial<Record<ToolDevAppName, unknown>>, "Start");
}

export function printReplaceResult(result: unknown, options: CliOptions): void {
  if (options.json === true) {
    printJson(result);
    return;
  }

  const record = asRecord(result);
  process.stdout.write("tools-dev replace\n");
  const previous = asRecord(record?.previous);
  const next = asRecord(record?.next);
  const ports = asRecord(record?.ports);
  const appName = stringField(record ?? {}, "app") ?? "app";
  const previousSource = stringField(previous ?? {}, "source") ?? "unknown";
  const previousBundle = stringField(previous ?? {}, "bundlePath");
  const nextBundle = stringField(next ?? {}, "bundlePath") ?? "unknown";
  const daemonPort = stringField(ports ?? {}, "daemon");
  const webPort = stringField(ports ?? {}, "web");
  process.stdout.write(`- ${appName}: replaced ${previousBundle ?? previousSource} -> ${nextBundle}\n`);
  if (daemonPort != null || webPort != null) {
    process.stdout.write(`  ports: daemon ${daemonPort ?? "unknown"} · web ${webPort ?? "unknown"}\n`);
  }
}

export function printStatusResult(result: unknown, options: CliOptions, appName: string | undefined): void {
  if (options.json === true) {
    printJson(result);
    return;
  }

  const record = asRecord(result);
  const apps = asRecord(record?.apps);
  if (apps != null) {
    const namespace = stringField(record ?? {}, "namespace");
    const statusLabel = stringField(record ?? {}, "status");
    const details = [namespace == null ? null : `namespace ${namespace}`, statusLabel].filter((entry): entry is string => entry != null);
    process.stdout.write(`tools-dev status${details.length > 0 ? ` (${details.join(" · ")})` : ""}\n`);
    printStatusEntries(apps);
    return;
  }

  process.stdout.write("tools-dev status\n");
  process.stdout.write(`- ${appName ?? ALL_APPS.join("/")}: ${formatStatusSummary(result)}\n`);
}

export function printRunForegroundResult(started: Partial<Record<ToolDevAppName, unknown>>, options: CliOptions): void {
  if (options.json === true) {
    printJson({ mode: "foreground", started });
    return;
  }

  const webStatus = asRecord(asRecord(started.web)?.status);
  const daemonStatus = asRecord(asRecord(started.daemon)?.status);
  const webUrl = stringField(webStatus ?? {}, "url");
  const daemonUrl = stringField(daemonStatus ?? {}, "url");

  if (webUrl != null || daemonUrl != null) {
    process.stdout.write("\n  Open Design dev server ready\n\n");
    if (webUrl != null) process.stdout.write(`  ➜  Web:    ${colorizeLink(normalizeDisplayUrl(webUrl))}\n`);
    if (daemonUrl != null) process.stdout.write(`  ➜  Daemon: ${colorizeLink(normalizeDisplayUrl(daemonUrl))}\n`);
    process.stdout.write("\n  Press Ctrl+C to stop\n\n");
    return;
  }

  printStartSection(started, "tools-dev run");
  process.stdout.write("Foreground loop is active. Press Ctrl+C to stop.\n");
}

function isLogResult(value: LogResult | Record<string, LogResult>): value is LogResult {
  return Array.isArray((value as LogResult).lines);
}

export function printLogs(result: LogResult | Record<string, LogResult>, options: CliOptions) {
  if (options.json === true) {
    printJson(result);
    return;
  }

  const entries: Array<[string, LogResult]> = isLogResult(result) ? [[result.app, result]] : Object.entries(result);
  for (const [appName, entry] of entries) {
    process.stdout.write(`[${appName}] ${entry.logPath}\n`);
    process.stdout.write(entry.lines.length > 0 ? `${entry.lines.join("\n")}\n` : "(no log lines)\n");
  }
}

export function printCheckResult(result: unknown, options: CliOptions): void {
  if (options.json === true) {
    printJson(result);
    return;
  }

  const record = asRecord(result);
  const namespace = record == null ? null : stringField(record, "namespace");
  process.stdout.write(`tools-dev check${namespace == null ? "" : ` (namespace ${namespace})`}\n`);

  const apps = asRecord(record?.apps);
  if (apps != null) {
    process.stdout.write("Status\n");
    printStatusEntries(apps);
  }

  const logs = asRecord(record?.logs);
  if (logs != null) {
    process.stdout.write("\nLogs\n");
    printLogs(logs as Record<string, LogResult>, options);
  }

  const diagnostics = asRecord(record?.diagnostics);
  if (diagnostics == null) return;
  const entries = Object.entries(diagnostics)
    .map(([appName, value]) => [appName, Array.isArray(value) ? formatLogDiagnostics(value as LogDiagnostic[]) : null] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] != null);
  if (entries.length === 0) return;

  process.stdout.write("\nDiagnostics\n");
  for (const [appName, message] of entries) {
    process.stdout.write(`[${appName}] ${message}\n`);
  }
}
