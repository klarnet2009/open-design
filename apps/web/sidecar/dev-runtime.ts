import { lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import {
  APP_KEYS,
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_ENV,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
  type SidecarStamp,
} from "@open-design/sidecar-proto";
import {
  resolveAppRuntimePath,
  resolveNamespaceRoot,
  type SidecarRuntimeContext,
} from "@open-design/sidecar";

type WebSidecarRuntimeEnv = Record<string, string | undefined>;
type WebSidecarRuntimeIdentity = Pick<SidecarRuntimeContext<SidecarStamp>, "base" | "mode" | "namespace" | "source">;

function resolveConfiguredPath(configured: string | undefined, baseDir: string): string | null {
  if (configured == null || configured.length === 0) return null;
  return isAbsolute(configured) ? configured : join(baseDir, configured);
}

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function configureWebSidecarDevRuntimeEnv(options: {
  env?: WebSidecarRuntimeEnv;
  runtime: WebSidecarRuntimeIdentity;
}): WebSidecarRuntimeEnv {
  const env = options.env ?? process.env;
  if (options.runtime.mode !== SIDECAR_MODES.DEV || options.runtime.source !== SIDECAR_SOURCES.TOOLS_DEV) {
    return env;
  }

  const namespaceRoot = resolveNamespaceRoot({
    base: options.runtime.base,
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    namespace: options.runtime.namespace,
  });
  env[SIDECAR_ENV.WEB_DIST_DIR] ??= resolveAppRuntimePath({
    app: APP_KEYS.WEB,
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    fileName: "next",
    namespaceRoot,
  });
  env[SIDECAR_ENV.WEB_TSCONFIG_PATH] ??= resolveAppRuntimePath({
    app: APP_KEYS.WEB,
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    fileName: "tsconfig.json",
    namespaceRoot,
  });
  return env;
}

export function resolveWebRuntimeRoot(options: {
  env?: WebSidecarRuntimeEnv;
  webRoot: string;
}): string | null {
  const env = options.env ?? process.env;
  const distDir = resolveConfiguredPath(env[SIDECAR_ENV.WEB_DIST_DIR], options.webRoot);
  return distDir == null ? null : dirname(distDir);
}

export function resolveWebDevTsconfigPath(options: {
  env?: WebSidecarRuntimeEnv;
  webRoot: string;
}): string | null {
  const env = options.env ?? process.env;
  return resolveConfiguredPath(env[SIDECAR_ENV.WEB_TSCONFIG_PATH], options.webRoot);
}

async function ensureWebRuntimeModules(options: {
  runtimeRoot: string;
  webRoot: string;
}): Promise<void> {
  const runtimeNodeModules = join(options.runtimeRoot, "node_modules");
  const webNodeModules = join(options.webRoot, "node_modules");

  await mkdir(options.runtimeRoot, { recursive: true });
  const current = await lstat(runtimeNodeModules).catch(() => null);
  if (current?.isSymbolicLink()) {
    const currentTarget = await readlink(runtimeNodeModules).catch(() => null);
    if (currentTarget === webNodeModules) return;
  }
  if (current != null) await rm(runtimeNodeModules, { force: true, recursive: true });
  await symlink(webNodeModules, runtimeNodeModules, "junction");
}

async function writeWebDevTsconfig(options: {
  tsconfigPath: string;
  webRoot: string;
}): Promise<void> {
  const tsconfigDir = dirname(options.tsconfigPath);
  const sourceTsconfig = join(options.webRoot, "tsconfig.json");
  const relativeSourceTsconfig = toPosixPath(relative(tsconfigDir, sourceTsconfig) || "./tsconfig.json");

  await mkdir(tsconfigDir, { recursive: true });
  await writeFile(
    options.tsconfigPath,
    `${JSON.stringify({
      extends: relativeSourceTsconfig,
      compilerOptions: {
        plugins: [{ name: "next" }],
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

export async function prepareWebSidecarDevRuntime(options: {
  env?: WebSidecarRuntimeEnv;
  runtime?: WebSidecarRuntimeIdentity;
  webRoot: string;
}): Promise<void> {
  const env = options.runtime == null
    ? options.env
    : configureWebSidecarDevRuntimeEnv({ env: options.env, runtime: options.runtime });
  const runtimeRoot = resolveWebRuntimeRoot({ env, webRoot: options.webRoot });
  if (runtimeRoot != null) {
    await ensureWebRuntimeModules({ runtimeRoot, webRoot: options.webRoot });
  }

  const tsconfigPath = resolveWebDevTsconfigPath({ env, webRoot: options.webRoot });
  if (tsconfigPath != null) {
    await writeWebDevTsconfig({ tsconfigPath, webRoot: options.webRoot });
  }
}
