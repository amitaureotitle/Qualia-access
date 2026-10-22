/**
 * Bridge driver -- local testing only (DRIVER=bridge). Forwards every
 * Driver call over a WebSocket (ws://localhost:<API_PORT>/bridge) to the
 * Workflow Runner Chrome extension, which performs it in the user's own
 * Qualia tab: it outlines the target, shows the label, waits (2s by
 * default), then acts -- and can pause, stop, or ask for approval.
 *
 * Wire protocol (JSON, one object per message):
 *   server -> extension  {id, method, params}   method = a Driver method name
 *   extension -> server  {id, result} | {id, error: {name, message}}
 *   server -> extension  {event: "note" | "run", ...}   one-way, no reply
 *   extension -> server  {hello: {version}}            on connect
 * An error named "StoppedError" is re-thrown here as StoppedError, which
 * the /closeout/* routes report as {status: "stopped"}.
 */
import type { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Driver, StoppedError } from "./driver";

const BASE_URL = process.env.QUALIA_BASE_URL ?? "https://aureotitle.qualia.io/";
const REQUEST_TIMEOUT_MS = 30 * 60_000; // approvals can take a while

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

class BridgeHub {
  private socket: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  extensionVersion: string | null = null;

  attach(server: Server): void {
    const wss = new WebSocketServer({ server, path: "/bridge" });
    wss.on("connection", (ws, req) => {
      // Local tool: only accept the extension, from this machine.
      const origin = req.headers.origin ?? "";
      const remote = req.socket.remoteAddress ?? "";
      if (!origin.startsWith("chrome-extension://") || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
        ws.close(1008, "bridge accepts the local extension only");
        return;
      }
      if (this.socket) this.socket.close(1000, "replaced by a newer connection");
      this.socket = ws;
      console.log(`[bridge] extension connected (${origin})`);
      ws.on("message", (raw) => this.onMessage(raw.toString()));
      ws.on("close", () => {
        if (this.socket !== ws) return;
        this.socket = null;
        console.log("[bridge] extension disconnected");
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("Extension disconnected mid-step"));
          this.pending.delete(id);
        }
      });
    });
    console.log("[bridge] listening on /bridge -- open the Workflow Runner extension to connect");
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.hello) {
      this.extensionVersion = msg.hello.version ?? null;
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      p.reject(msg.error.name === "StoppedError" ? new StoppedError(msg.error.message) : new Error(msg.error.message));
    } else {
      p.resolve(msg.result);
    }
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.connected) {
      return Promise.reject(new Error("Workflow Runner extension is not connected (open its side panel)"));
    }
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }

  event(event: string, payload: Record<string, unknown>): void {
    if (this.connected) this.socket!.send(JSON.stringify({ event, ...payload }));
  }
}

export const bridge = new BridgeHub();

/** A Driver whose every call runs in the extension's attached tab. */
export function bridgeDriver(context: { step: string; orderNumber?: string }): Driver {
  bridge.event("run", { step: context.step, orderNumber: context.orderNumber ?? null });
  return {
    baseUrl: BASE_URL,
    goto: (url) => bridge.request("goto", { url }),
    evaluate: (expression) => bridge.request("evaluate", { expression }),
    waitFor: (predicate, timeoutMs) => bridge.request("waitFor", { predicate, timeoutMs }),
    click: (selector, opts) => bridge.request("click", { selector, via: opts?.via ?? "mouse", label: opts?.label ?? null }),
    type: (text, label) => bridge.request("type", { text, label: label ?? null }),
    press: (key) => bridge.request("press", { key }),
    show: (selector, label) => bridge.request("show", { selector, label }),
    // Plain sleeps stay local -- nothing to show, and pause is honoured at the next action.
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    screenshot: (selector) => bridge.request("screenshot", { selector }),
    note: (message) => bridge.event("note", { message }),
    commit: (label) => bridge.request("commit", { label }),
  };
}
