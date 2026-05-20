import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { SIDECAR_ENV } from '@open-design/sidecar-proto';
import { describe, expect, it } from 'vitest';

import {
  configureWebSidecarDevRuntimeEnv,
  prepareWebSidecarDevRuntime,
  resolveWebDevTsconfigPath,
  resolveWebRuntimeRoot,
} from '../sidecar/dev-runtime';

function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

describe('prepareWebSidecarDevRuntime', () => {
  it('prepares the configured Next.js runtime root from inside the web sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-design-web-dev-runtime-'));
    const webRoot = join(root, 'workspace', 'apps', 'web');
    const runtimeRoot = join(root, 'runtime', 'web');
    const runtimeNodeModules = join(runtimeRoot, 'node_modules');
    const webNodeModules = join(webRoot, 'node_modules');
    const sourceTsconfig = join(webRoot, 'tsconfig.json');
    const runtimeTsconfig = join(runtimeRoot, 'tsconfig.json');

    try {
      await mkdir(webNodeModules, { recursive: true });
      await writeFile(sourceTsconfig, '{}\n', 'utf8');

      await prepareWebSidecarDevRuntime({
        env: {
          [SIDECAR_ENV.WEB_DIST_DIR]: join(runtimeRoot, 'next'),
          [SIDECAR_ENV.WEB_TSCONFIG_PATH]: runtimeTsconfig,
        },
        webRoot,
      });

      const nodeModules = await lstat(runtimeNodeModules);
      expect(nodeModules.isSymbolicLink()).toBe(true);
      expect(await realpath(runtimeNodeModules)).toBe(await realpath(webNodeModules));
      expect(JSON.parse(await readFile(runtimeTsconfig, 'utf8'))).toEqual({
        extends: toPosixPath(relative(runtimeRoot, sourceTsconfig)),
        compilerOptions: {
          plugins: [{ name: 'next' }],
        },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('sets tools-dev runtime defaults from the sidecar runtime identity', () => {
    const root = join(tmpdir(), 'open-design-web-dev-runtime-defaults');
    const env: Record<string, string | undefined> = {};

    configureWebSidecarDevRuntimeEnv({
      env,
      runtime: {
        base: join(root, 'tools-dev'),
        mode: 'dev',
        namespace: 'web-defaults',
        source: 'tools-dev',
      },
    });

    expect(env[SIDECAR_ENV.WEB_DIST_DIR]).toBe(join(root, 'tools-dev', 'web-defaults', 'web', 'next'));
    expect(env[SIDECAR_ENV.WEB_TSCONFIG_PATH]).toBe(join(root, 'tools-dev', 'web-defaults', 'web', 'tsconfig.json'));
  });

  it('resolves relative runtime paths from the web package root', () => {
    const webRoot = join(tmpdir(), 'open-design-web-root');
    const env = {
      [SIDECAR_ENV.WEB_DIST_DIR]: '.tmp/next',
      [SIDECAR_ENV.WEB_TSCONFIG_PATH]: '.tmp/tsconfig.json',
    };

    expect(resolveWebRuntimeRoot({ env, webRoot })).toBe(join(webRoot, '.tmp'));
    expect(resolveWebDevTsconfigPath({ env, webRoot })).toBe(join(webRoot, '.tmp', 'tsconfig.json'));
  });
});
