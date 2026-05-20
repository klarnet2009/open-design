import type { ToolDevAppName } from "../config.js";

export type ToolDevErrorCode =
  | "daemon-required"
  | "daemon-replacement-failed"
  | "invalid-json-payload"
  | "invalid-option"
  | "missing-inspect-payload"
  | "runtime-already-running"
  | "runtime-startup-timeout"
  | "runtime-unavailable"
  | "stale-stamped-process"
  | "startup-diagnostics"
  | "web-replacement-failed"
  | "unsupported-app"
  | "unsupported-inspect-target";

export type ToolDevErrorDetails = Record<string, unknown>;

export type ToolDevErrorOptions = {
  cause?: unknown;
  details?: ToolDevErrorDetails;
  hint?: string;
};

export class ToolDevError extends Error {
  readonly code: ToolDevErrorCode;
  readonly details: ToolDevErrorDetails;
  readonly hint?: string;

  private constructor(code: ToolDevErrorCode, message: string, options: ToolDevErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ToolDevError";
    this.code = code;
    this.details = options.details ?? {};
    if (options.hint !== undefined) this.hint = options.hint;
  }

  static daemonRequired(): ToolDevError {
    return new ToolDevError("daemon-required", "daemon must be running before web starts");
  }

  static daemonReplacementFailed(cause: unknown, rollback: unknown): ToolDevError {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    return new ToolDevError("daemon-replacement-failed", `daemon bundle replacement failed: ${causeMessage}`, {
      cause,
      details: { rollback },
    });
  }

  static invalidJsonPayload(context: string, cause: unknown): ToolDevError {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    return new ToolDevError("invalid-json-payload", `${context} must be valid JSON: ${causeMessage}`, {
      cause,
      details: { context },
    });
  }

  static invalidOption(optionName: string, expectation: string, details: ToolDevErrorDetails = {}): ToolDevError {
    return new ToolDevError("invalid-option", `${optionName} ${expectation}`, {
      details: { optionName, ...details },
    });
  }

  static missingInspectPayload(target: string, requirement: string): ToolDevError {
    return new ToolDevError("missing-inspect-payload", `${requirement} is required for inspect ${target}`, {
      details: { requirement, target },
    });
  }

  static runtimeAlreadyRunning(appName: ToolDevAppName, namespace: string, url: string): ToolDevError {
    return new ToolDevError(
      "runtime-already-running",
      `${appName} is already running in namespace ${namespace} at ${url}; stop it or choose another namespace`,
      { details: { appName, namespace, url } },
    );
  }

  static runtimeStartupTimeout(appName: ToolDevAppName): ToolDevError {
    return new ToolDevError("runtime-startup-timeout", `${appName} did not expose status in time`, {
      details: { appName },
    });
  }

  static runtimeUnavailable(appName: ToolDevAppName, namespace: string): ToolDevError {
    return new ToolDevError(
      "runtime-unavailable",
      `${appName} sidecar is not running in namespace ${namespace}; inspect requires a reachable IPC server`,
      { details: { appName, namespace } },
    );
  }

  static staleStampedProcess(appName: ToolDevAppName): ToolDevError {
    return new ToolDevError(
      "stale-stamped-process",
      `${appName} has active stamped processes but no reachable IPC status; run tools-dev stop ${appName} first`,
      {
        details: { appName },
        hint: `run tools-dev stop ${appName} first`,
      },
    );
  }

  static startupDiagnostics(message: string, cause: unknown): ToolDevError {
    return new ToolDevError("startup-diagnostics", message, { cause });
  }

  static webReplacementFailed(cause: unknown, rollback: unknown): ToolDevError {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    return new ToolDevError("web-replacement-failed", `web bundle replacement failed: ${causeMessage}`, {
      cause,
      details: { rollback },
    });
  }

  static unsupportedApp(value: string, expected: readonly string[]): ToolDevError {
    return new ToolDevError(
      "unsupported-app",
      `unsupported tools-dev app: ${value} (expected one of: ${expected.join(", ")})`,
      { details: { expected: [...expected], value } },
    );
  }

  static unsupportedInspectTarget(appName: ToolDevAppName, target: string): ToolDevError {
    return new ToolDevError("unsupported-inspect-target", `unsupported ${appName} inspect target: ${target}`, {
      details: { appName, target },
    });
  }
}
