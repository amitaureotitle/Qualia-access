/** Client for Pipeline-dashboard's local workflow dev API (/api/dev/*, app.py). */

export type Mode = "compose" | "live";

export interface Settings {
  dashboardUrl: string;
  bridgeUrl: string;
  qualiaBaseUrl: string;
  delayMs: number;
  confirmIrreversible: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  dashboardUrl: "http://localhost:5001",
  bridgeUrl: "ws://localhost:3001/bridge",
  qualiaBaseUrl: "https://aureotitle.qualia.io/",
  delayMs: 2000,
  confirmIrreversible: true,
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ settings: s });
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  inputs: { name: string; label: string; from_qualia_tab?: boolean }[];
}

export interface Section {
  title: string;
  open?: boolean;
  fields: [string, unknown][];
  text?: string;
  json?: unknown;
}

export interface PlanStep {
  key: string;
  label: string;
  status: string;
}

export interface LogEvent {
  seq: number;
  t: string;
  level: "debug" | "info" | "ok" | "warn" | "err";
  msg: string;
  src?: "workflow" | "browser";
  data?: unknown;
}

export interface RunStatus {
  run_id: string;
  status: "running" | "finished";
  outcome: string | null;
  events: LogEvent[];
  plan: PlanStep[];
  sections?: Section[];
  entries?: LogEvent[];
  failure_screenshot?: string | null;
}

export class DevApi {
  constructor(private base: string) {}

  setBase(base: string): void {
    this.base = base;
  }

  private async req<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base.replace(/\/$/, "")}/api/dev/${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error(`Dashboard not reachable at ${this.base} -- is scripts/dev_workflows.sh running?`);
    }
    if (res.status === 404 && path === "health") {
      throw new Error("Dashboard is up but the dev API is off -- start it with scripts/dev_workflows.sh");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as any).error || `${path}: HTTP ${res.status}`);
    return data as T;
  }

  health() {
    return this.req<{ ok: boolean; qualia_api_url: string; active_run: string | null }>("GET", "health");
  }
  workflows() {
    return this.req<{ workflows: WorkflowSummary[] }>("GET", "workflows");
  }
  /** Saved data + plan for an order (read-only; every run fetches fresh data itself). */
  describe(workflow: string, order: object) {
    return this.req<{ order_number: string; sections: Section[]; plan: PlanStep[] }>(
      "POST", `workflows/${workflow}/describe`, { ...order });
  }
  run(workflow: string, order: object, mode: Mode, startAt?: string) {
    return this.req<{ run_id: string; order_number: string }>("POST", `workflows/${workflow}/run`,
      { ...order, mode, start_at: startAt ?? null });
  }
  status(runId: string, after: number) {
    return this.req<RunStatus>("GET", `runs/${runId}?after=${after}`);
  }
  stop(runId: string) {
    return this.req<{ ok: boolean }>("POST", `runs/${runId}/stop`, {});
  }
  log(runId: string, entries: object[], failureScreenshot?: string) {
    return this.req<{ ok: boolean }>("POST", `runs/${runId}/log`, { entries, failure_screenshot: failureScreenshot });
  }
  text(runId: string, debug: boolean) {
    return this.req<{ text: string }>("GET", `runs/${runId}/text${debug ? "?debug=1" : ""}`);
  }
  recent() {
    return this.req<{ runs: { run_id: string; workflow: string; order_number: string; mode: string; source: string; outcome: string | null; started_at: string }[] }>(
      "GET", "runs");
  }
}
