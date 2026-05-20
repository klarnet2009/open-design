import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { BundleArtifact } from "@open-design/bundle";
import type { DaemonStatusSnapshot, WebStatusSnapshot } from "@open-design/sidecar-proto";

import type { ToolDevConfig } from "../src/config.js";
import { ToolDevError } from "../src/lib/errors.js";
import { replaceDaemonBundleCore, replaceWebBundleCore } from "../src/runtime/replacement.js";

async function makeTempConfig(bundlePath: string | null): Promise<ToolDevConfig> {
  const root = await mkdtemp(path.join(tmpdir(), "od-tools-dev-replace-"));
  return {
    apps: {
      daemon: {
        app: "daemon",
        ipcPath: path.join(root, "daemon.sock"),
        latestLogPath: path.join(root, "logs", "daemon", "latest.log"),
        launchEntryPath: path.join(root, "daemon-sidecar.ts"),
        logDir: path.join(root, "logs", "daemon"),
      },
      desktop: {
        app: "desktop",
        ipcPath: path.join(root, "desktop.sock"),
        latestLogPath: path.join(root, "logs", "desktop", "latest.log"),
        launchEntryPath: path.join(root, "desktop", "scripts", "dev.ts"),
        logDir: path.join(root, "logs", "desktop"),
      },
      web: {
        app: "web",
        ipcPath: path.join(root, "web.sock"),
        latestLogPath: path.join(root, "logs", "web", "latest.log"),
        launchEntryPath: path.join(root, "workspace", "apps", "web", "sidecar", "index.ts"),
        logDir: path.join(root, "logs", "web"),
      },
    },
    bundlePath,
    dataRoot: path.join(root, "data"),
    namespace: "replace-test",
    namespaceRoot: root,
    toolsDevRoot: root,
    tsxCliPath: "tsx",
    workspaceRoot: path.join(root, "workspace"),
  };
}

function artifact(bundlePath: string): BundleArtifact {
  return {
    bundlePath,
    descriptor: { entry: { kind: "js", path: "sidecar/index.mjs" }, schemaVersion: 1 },
    descriptorPath: path.join(bundlePath, "bundle.json"),
    entryPath: path.join(bundlePath, "sidecar", "index.mjs"),
  };
}

describe("tools-dev replace web", () => {
  it("preserves daemon/web ports while replacing the web bundle", async () => {
    const nextBundle = "/tmp/od-bundle-next";
    const config = await makeTempConfig(nextBundle);
    const daemon: DaemonStatusSnapshot = {
      desktopAuthGateActive: false,
      pid: 11,
      state: "running",
      url: "http://127.0.0.1:18001",
    };
    const webBefore: WebStatusSnapshot = {
      implementation: {
        bundlePath: "/tmp/od-bundle-prev",
        entryPath: "/tmp/od-bundle-prev/sidecar/index.mjs",
        source: "bundle",
      },
      pid: 21,
      state: "running",
      url: "http://127.0.0.1:18002",
    };
    const webAfter: WebStatusSnapshot = {
      implementation: {
        bundlePath: nextBundle,
        entryPath: path.join(nextBundle, "sidecar", "index.mjs"),
        source: "bundle",
      },
      pid: 22,
      state: "running",
      url: "http://127.0.0.1:18002",
    };
    let webInspectCount = 0;
    const startCalls: Array<{ bundlePath: string | null; daemonPort: unknown; webPort: unknown }> = [];
    const logLines: string[] = [];

    const result = await replaceWebBundleCore(config, {}, {
      appendWebLog: async (lines) => {
        logLines.push(...lines);
      },
      inspectDaemon: async () => daemon,
      inspectWeb: async () => webInspectCount++ === 0 ? webBefore : webAfter,
      resolveBundle: async (bundlePath) => artifact(bundlePath),
      startWeb: async (startConfig, options) => {
        startCalls.push({ bundlePath: startConfig.bundlePath, daemonPort: options.daemonPort, webPort: options.webPort });
        return { created: true, status: webAfter };
      },
      stopWeb: async () => ({ status: "stopped" }),
    });

    assert.deepEqual(result.ports, { daemon: "18001", web: "18002" });
    assert.equal(result.before.web.pid, 21);
    assert.equal(result.after.web?.pid, 22);
    assert.deepEqual(startCalls, [{ bundlePath: nextBundle, daemonPort: "18001", webPort: "18002" }]);
    assert.match(logLines.join("\n"), /replacement previous implementation: bundle \/tmp\/od-bundle-prev/);
    assert.match(logLines.join("\n"), /replacement next bundle: \/tmp\/od-bundle-next/);
  });

  it("rolls back to the previous bundle when replacement start fails", async () => {
    const nextBundle = "/tmp/od-bundle-next";
    const previousBundle = "/tmp/od-bundle-prev";
    const config = await makeTempConfig(nextBundle);
    const daemon: DaemonStatusSnapshot = {
      desktopAuthGateActive: false,
      pid: 11,
      state: "running",
      url: "http://127.0.0.1:18001",
    };
    const webBefore: WebStatusSnapshot = {
      implementation: {
        bundlePath: previousBundle,
        entryPath: path.join(previousBundle, "sidecar", "index.mjs"),
        source: "bundle",
      },
      pid: 21,
      state: "running",
      url: "http://127.0.0.1:18002",
    };
    const startBundles: Array<string | null> = [];
    const logLines: string[] = [];

    await assert.rejects(
      replaceWebBundleCore(config, {}, {
        appendWebLog: async (lines) => {
          logLines.push(...lines);
        },
        inspectDaemon: async () => daemon,
        inspectWeb: async () => webBefore,
        resolveBundle: async (bundlePath) => artifact(bundlePath),
        startWeb: async (startConfig) => {
          startBundles.push(startConfig.bundlePath);
          if (startConfig.bundlePath === nextBundle) throw new Error("candidate failed");
          return { created: true, status: webBefore };
        },
        stopWeb: async () => ({ status: "stopped" }),
      }),
      (error) => {
        assert.ok(error instanceof ToolDevError);
        assert.equal(error.code, "web-replacement-failed");
        assert.deepEqual(startBundles, [nextBundle, previousBundle]);
        return true;
      },
    );

    assert.match(logLines.join("\n"), /replacement failed; attempting rollback/);
    assert.match(logLines.join("\n"), /replacement rollback completed/);
  });
});

describe("tools-dev replace daemon", () => {
  it("preserves the daemon port and running web trust port", async () => {
    const nextBundle = "/tmp/od-daemon-next";
    const config = await makeTempConfig(nextBundle);
    const daemonBefore: DaemonStatusSnapshot = {
      desktopAuthGateActive: true,
      implementation: {
        bundlePath: "/tmp/od-daemon-prev",
        entryPath: "/tmp/od-daemon-prev/sidecar/index.mjs",
        source: "bundle",
      },
      pid: 31,
      state: "running",
      url: "http://127.0.0.1:18011",
    };
    const daemonAfter: DaemonStatusSnapshot = {
      desktopAuthGateActive: true,
      implementation: {
        bundlePath: nextBundle,
        entryPath: path.join(nextBundle, "sidecar", "index.mjs"),
        source: "bundle",
      },
      pid: 32,
      state: "running",
      url: "http://127.0.0.1:18011",
    };
    const web: WebStatusSnapshot = {
      pid: 41,
      state: "running",
      url: "http://127.0.0.1:18012",
    };
    let daemonInspectCount = 0;
    const startCalls: Array<{
      bundlePath: string | null;
      daemonPort: unknown;
      implementationPath: string | null;
      requireDesktopAuth: boolean | undefined;
      webPort: unknown;
    }> = [];

    const result = await replaceDaemonBundleCore(config, {}, {
      appendDaemonLog: async () => undefined,
      inspectDaemon: async () => daemonInspectCount++ === 0 ? daemonBefore : daemonAfter,
      inspectWeb: async () => web,
      resolveBundle: async (bundlePath) => artifact(bundlePath),
      startDaemon: async (startConfig, options, startOptions) => {
        startCalls.push({
          bundlePath: startConfig.bundlePath,
          daemonPort: options.daemonPort,
          implementationPath: startOptions.implementation?.bundlePath ?? null,
          requireDesktopAuth: startOptions.requireDesktopAuth,
          webPort: options.webPort,
        });
        return { created: true, status: daemonAfter };
      },
      stopDaemon: async () => ({ status: "stopped" }),
    });

    assert.deepEqual(result.ports, { daemon: "18011", web: "18012" });
    assert.equal(result.before.daemon.pid, 31);
    assert.equal(result.after.daemon?.pid, 32);
    assert.deepEqual(startCalls, [{
      bundlePath: nextBundle,
      daemonPort: "18011",
      implementationPath: nextBundle,
      requireDesktopAuth: true,
      webPort: "18012",
    }]);
  });

  it("rolls back to workspace daemon when candidate start fails", async () => {
    const nextBundle = "/tmp/od-daemon-next";
    const config = await makeTempConfig(nextBundle);
    const daemon: DaemonStatusSnapshot = {
      desktopAuthGateActive: false,
      pid: 31,
      state: "running",
      url: "http://127.0.0.1:18011",
    };
    const startBundles: Array<string | null> = [];

    await assert.rejects(
      replaceDaemonBundleCore(config, {}, {
        appendDaemonLog: async () => undefined,
        inspectDaemon: async () => daemon,
        inspectWeb: async () => null,
        resolveBundle: async (bundlePath) => artifact(bundlePath),
        startDaemon: async (startConfig) => {
          startBundles.push(startConfig.bundlePath);
          if (startConfig.bundlePath === nextBundle) throw new Error("candidate failed");
          return { created: true, status: daemon };
        },
        stopDaemon: async () => ({ status: "stopped" }),
      }),
      (error) => {
        assert.ok(error instanceof ToolDevError);
        assert.equal(error.code, "daemon-replacement-failed");
        assert.deepEqual(startBundles, [nextBundle, null]);
        return true;
      },
    );
  });
});
