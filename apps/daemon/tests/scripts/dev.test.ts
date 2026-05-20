import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  APP_KEYS,
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
} from '@open-design/sidecar-proto';
import { createProcessStampArgs } from '@open-design/platform';
import { describe, expect, it, vi } from 'vitest';

import {
  checkDaemonBuild,
  resolveDaemonSidecarEntryPath,
  runDaemonDev,
} from '../../scripts/dev.js';

async function makeDaemonPackageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'open-design-daemon-scripts-dev-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'sidecar'), { recursive: true });
  await mkdir(join(root, 'dist', 'sidecar'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"@open-design/daemon"}\n', 'utf8');
  await writeFile(join(root, 'tsconfig.json'), '{}\n', 'utf8');
  await writeFile(join(root, 'tsconfig.sidecar.json'), '{}\n', 'utf8');
  await writeFile(join(root, 'src', 'index.ts'), 'export {};\n', 'utf8');
  await writeFile(join(root, 'sidecar', 'index.ts'), 'export {};\n', 'utf8');
  return root;
}

function createDaemonStampArgs(ipcPath: string): string[] {
  return createProcessStampArgs(
    {
      app: APP_KEYS.DAEMON,
      ipc: ipcPath,
      mode: SIDECAR_MODES.DEV,
      namespace: 'daemon-scripts-dev-test',
      source: SIDECAR_SOURCES.TOOLS_DEV,
    },
    OPEN_DESIGN_SIDECAR_CONTRACT,
  );
}

async function setMtime(path: string, seconds: number): Promise<void> {
  const date = new Date(seconds * 1000);
  await utimes(path, date, date);
}

async function setSourceMtime(root: string, seconds: number): Promise<void> {
  await setMtime(join(root, 'src', 'index.ts'), seconds);
  await setMtime(join(root, 'sidecar', 'index.ts'), seconds);
  await setMtime(join(root, 'src'), seconds);
  await setMtime(join(root, 'sidecar'), seconds);
  await setMtime(join(root, 'package.json'), seconds);
  await setMtime(join(root, 'tsconfig.json'), seconds);
  await setMtime(join(root, 'tsconfig.sidecar.json'), seconds);
}

async function writeDistOutputs(root: string): Promise<void> {
  await writeFile(join(root, 'dist', 'cli.js'), 'export {};\n', 'utf8');
  await writeFile(resolveDaemonSidecarEntryPath(root), 'export {};\n', 'utf8');
}

async function setDistMtime(root: string, seconds: number): Promise<void> {
  await setMtime(join(root, 'dist', 'cli.js'), seconds);
  await setMtime(resolveDaemonSidecarEntryPath(root), seconds);
}

describe('daemon dev script', () => {
  it('requires a daemon build when dist/cli.js is missing', async () => {
    const root = await makeDaemonPackageRoot();

    try {
      const check = await checkDaemonBuild(root);

      expect(check.required).toBe(true);
      expect(check.reason).toBe('apps/daemon/dist/cli.js is missing');
      expect(check.distCliPath).toBe(join(root, 'dist', 'cli.js'));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('requires a daemon build when dist/sidecar/index.js is missing', async () => {
    const root = await makeDaemonPackageRoot();

    try {
      await writeFile(join(root, 'dist', 'cli.js'), 'export {};\n', 'utf8');

      const check = await checkDaemonBuild(root);

      expect(check.required).toBe(true);
      expect(check.reason).toBe('apps/daemon/dist/sidecar/index.js is missing');
      expect(check.distSidecarPath).toBe(resolveDaemonSidecarEntryPath(root));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('requires a daemon build when sidecar source is newer than dist/sidecar/index.js', async () => {
    const root = await makeDaemonPackageRoot();

    try {
      await writeDistOutputs(root);
      await setDistMtime(root, 100);
      await setSourceMtime(root, 200);

      const check = await checkDaemonBuild(root);

      expect(check.required).toBe(true);
      expect(check.reason).toBe('source is newer than apps/daemon/dist/cli.js');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('skips the daemon build when dist outputs are current', async () => {
    const root = await makeDaemonPackageRoot();

    try {
      await writeDistOutputs(root);
      await setSourceMtime(root, 100);
      await setDistMtime(root, 200);

      const check = await checkDaemonBuild(root);

      expect(check.required).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('builds when needed and launches the built daemon sidecar with the same stamp args', async () => {
    const root = await makeDaemonPackageRoot();
    const workspaceRoot = join(root, '..', '..');
    const stampArgs = createDaemonStampArgs(join(root, 'daemon.sock'));
    const runBuild = vi.fn(async () => undefined);
    const spawnSidecar = vi.fn(async () => ({ code: 0, pid: 321, signal: null }));
    const log = vi.fn();

    try {
      const exit = await runDaemonDev({
        env: { KEEP: 'yes' },
        log,
        packageRoot: root,
        runBuild,
        spawnSidecar,
        stampArgs,
        workspaceRoot,
      });

      expect(exit.pid).toBe(321);
      expect(runBuild).toHaveBeenCalledWith({
        env: { KEEP: 'yes' },
        workspaceRoot,
      });
      expect(spawnSidecar).toHaveBeenCalledWith({
        args: [resolveDaemonSidecarEntryPath(root), ...stampArgs],
        command: process.execPath,
        cwd: workspaceRoot,
        env: { KEEP: 'yes' },
      });
      expect(log.mock.calls[0]?.[0]).toContain('apps/daemon/dist/cli.js is missing');
      expect(log.mock.calls[1]?.[0]).toContain('launching daemon sidecar');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects non-daemon sidecar stamps', async () => {
    const stampArgs = createProcessStampArgs(
      {
        app: APP_KEYS.WEB,
        ipc: '/tmp/web.sock',
        mode: SIDECAR_MODES.DEV,
        namespace: 'daemon-scripts-dev-test',
        source: SIDECAR_SOURCES.TOOLS_DEV,
      },
      OPEN_DESIGN_SIDECAR_CONTRACT,
    );

    await expect(runDaemonDev({ stampArgs })).rejects.toThrow(/requires daemon stamp/);
  });
});
