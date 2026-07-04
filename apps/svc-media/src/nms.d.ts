// Minimal ambient types for node-media-server v2 (ships no TS types).
declare module "node-media-server" {
  interface NmsConfig {
    rtmp?: Record<string, unknown>;
    http?: Record<string, unknown>;
    trans?: Record<string, unknown>;
  }
  type NmsHandler = (id: string, streamPath: string, args: Record<string, string>) => void;
  export default class NodeMediaServer {
    constructor(config: NmsConfig);
    run(): void;
    stop(): void;
    on(event: string, handler: NmsHandler): void;
    getSession(id: string): { reject: () => void } | undefined;
  }
}
