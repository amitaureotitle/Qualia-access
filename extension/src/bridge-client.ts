/**
 * WebSocket client for Qualia-access's bridge (src/steps/bridge-driver.ts).
 * Reconnects automatically; each request {id, method, params} is answered
 * with {id, result} or {id, error: {name, message}}. One-way events
 * ({event: "note" | "run", ...}) are passed to onEvent.
 */

export type BridgeState = "connecting" | "connected" | "disconnected";

export class BridgeClient {
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  state: BridgeState = "disconnected";

  constructor(
    private url: string,
    private readonly handlers: {
      onRequest(method: string, params: any): Promise<unknown>;
      onEvent(event: any): void;
      onState(state: BridgeState): void;
    }
  ) {}

  setUrl(url: string): void {
    if (url === this.url) return;
    this.url = url;
    this.ws?.close();
  }

  connect(): void {
    if (this.retry) clearTimeout(this.retry);
    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.setState("connected");
      ws.send(JSON.stringify({ hello: { version: chrome.runtime.getManifest().version } }));
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.setState("disconnected");
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => this.onMessage(ws, String(ev.data));
  }

  private scheduleReconnect(): void {
    this.retry = setTimeout(() => this.connect(), 2_000);
  }

  private setState(state: BridgeState): void {
    this.state = state;
    this.handlers.onState(state);
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.event) {
      this.handlers.onEvent(msg);
      return;
    }
    if (typeof msg.id !== "number") return;
    try {
      const result = await this.handlers.onRequest(msg.method, msg.params ?? {});
      ws.send(JSON.stringify({ id: msg.id, result: result === undefined ? null : result }));
    } catch (e: any) {
      ws.send(JSON.stringify({ id: msg.id, error: { name: e?.name || "Error", message: e?.message || String(e) } }));
    }
  }
}
