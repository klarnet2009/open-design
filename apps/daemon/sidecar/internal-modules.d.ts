declare module "#daemon-startup" {
  import type {
    DesktopExportPdfInput,
    DesktopExportPdfResult,
  } from "@open-design/sidecar-proto";

  export type StartedDaemonRuntime = {
    stop(): Promise<void>;
    url: string;
  };

  export function startDaemonRuntime(options?: {
    desktopPdfExporter?: (input: DesktopExportPdfInput) => Promise<DesktopExportPdfResult>;
    port?: number;
  }): Promise<StartedDaemonRuntime>;
}

declare module "#desktop-auth" {
  export function isDesktopAuthGateActive(): boolean;
  export function setDesktopAuthSecret(secret: Buffer | null): void;
}
