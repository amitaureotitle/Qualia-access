/**
 * Workflow Runner side panel -- one generic extension for every workflow.
 *
 * It knows no workflow. Workflows live in Pipeline-dashboard
 * (workflows/registry.py) and are listed, fetched and started through its
 * local dev API; while a run is going, the workflow's real code (the same
 * as on GitHub) sends each browser action over the bridge WebSocket from a
 * local Qualia-access (DRIVER=bridge), and this panel performs it in your
 * tab: outline + label, a pause (2s by default), then the action.
 *
 * Start both local servers with Pipeline-dashboard's scripts/dev_workflows.sh.
 */
import { BridgeClient, BridgeState } from "./bridge-client";
import { DevApi, LogEvent, Mode, PlanStep, Section, Settings, WorkflowSummary, loadSettings, saveSettings } from "./dev-api";
import { StoppedError, TabController } from "./tab-controller";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;
let api: DevApi;
let bridge: BridgeClient;
let workflows: WorkflowSummary[] = [];
let mode: Mode = "compose";
let detected: { tabId: number; qualiaId: string } | null = null;
let controller: TabController | null = null;
let approval: ((ok: boolean) => void) | null = null;
let shownEvents: LogEvent[] = [];

const run = {
  id: null as string | null,
  active: false,
  paused: false,
  stopRequested: false,
  lastSeq: 0,
  failureCaptured: false,
  pendingBrowserLog: [] as object[],
  poll: null as ReturnType<typeof setInterval> | null,
};

// ── small DOM helpers ────────────────────────────────────────────────────────

function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string | null | undefined)[]) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(c));
  return node;
}

function setStatus(text: string, kind: "idle" | "run" | "pause" | "ok" | "warn" | "err" = "idle") {
  const s = $("status");
  s.textContent = text;
  s.className = `status ${kind}`;
}

function dot(id: string, state: "ok" | "warn" | "err", title: string) {
  const d = $(id);
  d.className = `dot ${state}`;
  d.title = title;
}

function showDebug(): boolean {
  return ($("show-debug") as HTMLInputElement).checked;
}

// ── log ──────────────────────────────────────────────────────────────────────

function renderEvent(e: LogEvent) {
  if (e.level === "debug" && !showDebug()) return;
  const time = new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const line = el("div", { class: `log-line ${e.level}` },
    el("span", { class: "t" }, time), " ",
    el("span", { class: `src ${e.src ?? "workflow"}` }, e.src === "browser" ? "tab" : "wf"), " ",
    e.msg);
  if (e.data !== undefined && (e.level === "debug" || e.level === "err")) {
    line.append(el("span", { class: "data" }, ` ${JSON.stringify(e.data)}`));
  }
  const box = $("log");
  box.append(line);
  box.scrollTop = box.scrollHeight;
}

function rerenderLog() {
  $("log").replaceChildren();
  shownEvents.forEach(renderEvent);
}

function localNote(level: LogEvent["level"], msg: string) {
  const e: LogEvent = { seq: 0, t: new Date().toISOString(), level, msg, src: "browser" };
  shownEvents.push(e);
  renderEvent(e);
}

/** Browser-side entry: shown via the server stream once uploaded (single source of truth). */
function browserLog(level: string, msg: string, data?: unknown) {
  if (!run.id) {
    localNote(level as LogEvent["level"], msg);
    return;
  }
  run.pendingBrowserLog.push({ t: new Date().toISOString(), level, msg, data });
}

async function flushBrowserLog(screenshot?: string) {
  if (!run.id || (!run.pendingBrowserLog.length && !screenshot)) return;
  const entries = run.pendingBrowserLog.splice(0);
  await api.log(run.id, entries, screenshot).catch(() => {
    run.pendingBrowserLog.unshift(...entries); // retry next tick
  });
}

// ── data rendering ──────────────────────────────────────────────────────────

function renderSections(problems: string[], sections: Section[]) {
  const box = $("data");
  box.replaceChildren();
  for (const p of problems) box.append(el("div", { class: "callout err" }, p));
  for (const s of sections) {
    const d = el("details", s.open ? { open: "" } : {}, el("summary", {}, s.title));
    for (const [k, v] of s.fields) {
      d.append(el("div", { class: "kv" }, el("span", { class: "k" }, k), el("span", { class: "v" }, v == null || v === "" ? "—" : String(v))));
    }
    if (s.text) d.append(el("pre", { class: "body" }, s.text));
    if (s.json !== undefined) d.append(el("pre", { class: "body" }, JSON.stringify(s.json, null, 2)));
    box.append(d);
  }
}

let lastPlan: PlanStep[] = [];

function renderPlan(plan: PlanStep[]) {
  lastPlan = plan;
  const ol = $("plan");
  ol.replaceChildren();
  // Dry runs can start from any step ("Run from here"): earlier steps are
  // skipped, saved data from earlier runs (e.g. recording dates) is reused.
  const canJump = !run.active && mode === "compose" && !!currentWorkflow() && !!orderRef() && bridge?.state === "connected";
  plan.forEach((p, i) => {
    const st = p.status || "";
    const li = el("li", {}, el("span", { class: "label" }, p.label));
    const right = el("span", { class: "plan-right" }, el("span", { class: `badge ${st.replace(/\s/g, "-")}` }, st || "—"));
    if (canJump && i > 0 && st !== "n/a") {
      const btn = el("button", { class: "secondary small", title: "Dry run starting at this step" }, "▶ from here");
      btn.addEventListener("click", () => startRun(p.key));
      right.append(btn);
    }
    li.append(right);
    ol.append(li);
  });
}

// ── controls ────────────────────────────────────────────────────────────────

function currentWorkflow(): WorkflowSummary | undefined {
  return workflows.find((w) => w.id === ($("workflow") as HTMLSelectElement).value);
}

function orderRef(): { order_number?: string; qualia_id?: string } | null {
  const typed = ($("order-input") as HTMLInputElement).value.trim();
  if (typed) return { order_number: typed };
  return detected ? { qualia_id: detected.qualiaId } : null;
}

function renderControls() {
  const ready = !!currentWorkflow() && !!orderRef();
  ($("run") as HTMLButtonElement).disabled = run.active || !ready || bridge.state !== "connected";
  ($("pause") as HTMLButtonElement).disabled = !run.active;
  ($("pause") as HTMLButtonElement).textContent = run.paused ? "Resume" : "Pause";
  ($("stop") as HTMLButtonElement).disabled = !run.active;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".mode button")) {
    b.disabled = run.active;
    b.classList.toggle("on", b.dataset.mode === mode);
  }
  document.body.classList.toggle("live", mode === "live");
  ($("order-input") as HTMLInputElement).disabled = run.active;
  if (lastPlan.length) renderPlan(lastPlan);
  ($("workflow") as HTMLSelectElement).disabled = run.active;
}

async function detectTab() {
  if (run.active) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = new URL(settings.qualiaBaseUrl).host;
  const m = tab?.url?.match(/^https:\/\/([^/]+)\/orders\/([^/?#]+)/);
  const before = detected?.qualiaId;
  detected = tab?.id && m && m[1] === host ? { tabId: tab.id, qualiaId: m[2] } : null;
  if (detected?.qualiaId !== before && workflows.length) void loadSaved();
  $("detected").textContent = detected ? `Qualia order tab detected (${detected.qualiaId})` : "Open an order in Qualia, or type an order number";
  renderControls();
}

async function activeQualiaTabId(): Promise<number | null> {
  if (detected) return detected.tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = new URL(settings.qualiaBaseUrl).host;
  return tab?.id && tab.url && new URL(tab.url).host === host ? tab.id : null;
}

// ── gate / approval (used by TabController) ──────────────────────────────────

async function gate() {
  for (;;) {
    if (run.stopRequested) throw new StoppedError();
    if (!run.paused) return;
    await new Promise((r) => setTimeout(r, 120));
  }
}

let countdownTimer: ReturnType<typeof setInterval> | null = null;
function announce(label: string, delayMs: number) {
  $("now-action").textContent = label;
  if (countdownTimer) clearInterval(countdownTimer);
  const end = Date.now() + delayMs;
  const tick = () => {
    const left = Math.max(0, end - Date.now());
    $("now-count").textContent = left > 0 ? `in ${(left / 1000).toFixed(1)}s` : "now";
    if (left <= 0 && countdownTimer) clearInterval(countdownTimer);
  };
  tick();
  countdownTimer = setInterval(tick, 100);
}

function approve(label: string): Promise<boolean> {
  $("approve-label").textContent = label;
  $("approval").hidden = false;
  setStatus("Waiting for your approval", "pause");
  browserLog("warn", `Asking for approval: ${label}`);
  return new Promise((resolve) => {
    approval = (ok) => {
      $("approval").hidden = true;
      approval = null;
      browserLog(ok ? "info" : "warn", ok ? `Approved: ${label}` : `Declined: ${label}`);
      setStatus(ok ? "Running" : "Stopping", ok ? "run" : "warn");
      resolve(ok);
    };
  });
}

function makeController(tabId: number) {
  return new TabController(tabId, {
    gate,
    announce,
    log: (level, msg, data) => browserLog(level, msg, data),
    approve,
    screenshotTaken: (b64) => {
      ($("shot") as HTMLImageElement).src = `data:image/png;base64,${b64}`;
      $("shot-wrap").hidden = false;
    },
    delayMs: () => settings.delayMs,
    confirmIrreversible: () => settings.confirmIrreversible,
  });
}

async function captureFailure(reason: string) {
  if (run.failureCaptured || !controller) return;
  run.failureCaptured = true;
  const snap = await controller.snapshot();
  browserLog("err", `Failure context (${reason})`, { url: snap.url, title: snap.title, screenshotSaved: !!snap.screenshot });
  await flushBrowserLog(snap.screenshot);
}

// ── bridge ───────────────────────────────────────────────────────────────────

async function onBridgeRequest(method: string, params: any): Promise<unknown> {
  if (!controller) {
    // A run started outside the panel (e.g. the CLI against the local server): use the active Qualia tab.
    const tabId = await activeQualiaTabId();
    if (!tabId) throw new Error("No Qualia tab to drive -- open one and keep the Workflow Runner panel open");
    controller = makeController(tabId);
    browserLog("warn", "Bridge request without a panel-started run -- driving the active Qualia tab");
  }
  try {
    return await controller.handle(method, params);
  } catch (e: any) {
    if (e instanceof StoppedError) {
      browserLog("warn", `Stopped during ${method}`);
      throw e;
    }
    browserLog("err", `${method} failed: ${e?.message || e}`, { params: method === "evaluate" ? undefined : params });
    await captureFailure(`${method} failed`);
    throw e;
  }
}

function onBridgeEvent(ev: any) {
  if (ev.event === "run") {
    controller?.newStep();
    $("now-step").textContent = ev.step || "";
    browserLog("info", `Step started: ${ev.step}`);
  } else if (ev.event === "note") {
    $("now-note").textContent = ev.message;
    browserLog("debug", `· ${ev.message}`);
  }
}

function onBridgeState(state: BridgeState) {
  dot("dot-bridge", state === "connected" ? "ok" : state === "connecting" ? "warn" : "err",
    state === "connected" ? `Bridge connected (${settings.bridgeUrl})` : `Bridge ${state} -- is scripts/dev_workflows.sh running?`);
  renderControls();
}

// ── actions ──────────────────────────────────────────────────────────────────

async function refreshHealth() {
  try {
    const h = await api.health();
    dot("dot-dash", "ok", `Dashboard dev API ok -> Qualia-access ${h.qualia_api_url}`);
    if (!workflows.length) await loadWorkflows();
  } catch (e: any) {
    dot("dot-dash", "err", e.message);
  }
}

async function loadWorkflows() {
  const { workflows: list } = await api.workflows();
  workflows = list;
  const sel = $("workflow") as HTMLSelectElement;
  const prev = sel.value;
  sel.replaceChildren(...list.map((w) => el("option", { value: w.id }, w.name)));
  if (list.some((w) => w.id === prev)) sel.value = prev;
  $("workflow-desc").textContent = currentWorkflow()?.description ?? "";
  renderControls();
  void loadSaved();
}

let describeSeq = 0;

/** Show what's saved for this order (no Qualia calls) -- runs fetch fresh data themselves. */
async function loadSaved() {
  const wf = currentWorkflow();
  const ref = orderRef();
  if (!wf || !ref || run.active) return;
  const seq = ++describeSeq;
  try {
    const out = await api.describe(wf.id, ref);
    if (seq !== describeSeq || run.active) return;
    $("order-title").textContent = out.order_number;
    renderSections([], out.sections);
    renderPlan(out.plan);
    if (!out.sections.length) $("data").append(el("p", { class: "muted" }, "Nothing saved yet — the first run fetches everything."));
  } catch (e: any) {
    if (seq !== describeSeq) return;
    $("data").replaceChildren(el("p", { class: "muted" }, e.message));
    $("plan").replaceChildren();
  }
}

async function startRun(startAt?: string) {
  const wf = currentWorkflow();
  const ref = orderRef();
  if (!wf || !ref) return;
  if (mode === "live" && !confirm("LIVE: this does everything for real in Qualia (issue, send, close). Continue?")) return;
  const tabId = await activeQualiaTabId();
  if (!tabId) {
    setStatus("Switch to a Qualia tab first — the run happens in that tab", "err");
    return;
  }

  Object.assign(run, { id: null, active: true, paused: false, stopRequested: false, lastSeq: 0, failureCaptured: false, pendingBrowserLog: [] });
  controller = makeController(tabId);
  shownEvents = [];
  rerenderLog();
  $("shot-wrap").hidden = true;
  $("now").hidden = false;
  renderControls();
  setStatus("Starting — fetching the latest data first…", "run");

  try {
    const started = await api.run(wf.id, ref, mode, startAt);
    run.id = started.run_id;
    $("order-title").textContent = started.order_number;
    $("run-id").textContent = started.run_id;
    setStatus("Running", "run");
    run.poll = setInterval(pollRun, 1000);
  } catch (e: any) {
    setStatus(e.message, "err");
    await endRun();
  }
}

async function pollRun() {
  if (!run.id) return;
  await flushBrowserLog();
  let st;
  try {
    st = await api.status(run.id, run.lastSeq);
  } catch {
    return; // transient; try again next tick
  }
  for (const e of st.events) {
    run.lastSeq = Math.max(run.lastSeq, e.seq);
    shownEvents.push(e);
    renderEvent(e);
    if (e.level === "err" && e.src !== "browser") void captureFailure("step failed");
    const wait = (e.data as { wait?: number } | undefined)?.wait;
    if (typeof wait === "number") {
      $("now-step").textContent = "Waiting";
      announce(e.msg, wait * 1000);
    }
  }
  if (st.plan?.length) renderPlan(st.plan);
  if (st.sections?.length) renderSections([], st.sections);
  if (st.status === "finished") {
    const ok = st.outcome === "done" || st.outcome === "composed";
    setStatus(`Finished: ${st.outcome}`, ok ? "ok" : st.outcome === "stopped" ? "warn" : "err");
    await endRun();
  }
}

async function endRun() {
  if (run.poll) clearInterval(run.poll);
  run.poll = null;
  await flushBrowserLog();
  await controller?.detach();
  controller = null;
  if (countdownTimer) clearInterval(countdownTimer);
  $("now").hidden = true;
  Object.assign(run, { active: false, paused: false, stopRequested: false });
  renderControls();
  void loadRecent();
  void loadSaved();
}

async function loadRecent() {
  const list = $("history-list");
  try {
    const { runs } = await api.recent();
    list.replaceChildren();
    if (!runs.length) list.append(el("p", { class: "muted" }, "No runs yet."));
    for (const r of runs) {
      const when = new Date(r.started_at.replace(" ", "T") + "Z").toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const outcome = r.outcome ?? "running";
      const view = el("button", { class: "secondary small" }, "View");
      view.addEventListener("click", () => viewRun(r.run_id));
      const copy = el("button", { class: "secondary small" }, "Copy log");
      copy.addEventListener("click", async () => {
        const { text } = await api.text(r.run_id, showDebug());
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy log"), 1200);
      });
      list.append(el("div", { class: "history-item" },
        el("div", { class: "history-head" },
          el("span", { class: "history-order" }, `${r.order_number ?? "?"} · ${r.workflow}`),
          el("span", { class: `badge ${outcome}` }, outcome)),
        el("div", { class: "muted" }, `${when} · ${r.source} · ${r.mode === "live" ? "LIVE" : "dry run"}`),
        el("div", { class: "history-actions" }, view, copy),
        el("div", { class: "muted mono" }, r.run_id)));
    }
  } catch {
    list.replaceChildren(el("p", { class: "muted" }, "Start the dev servers to see runs."));
  }
}

async function viewRun(runId: string) {
  if (run.active) return;
  const st = await api.status(runId, 0);
  shownEvents = (st.events?.length ? st.events : st.entries) ?? [];
  $("run-id").textContent = runId;
  rerenderLog();
  if (st.failure_screenshot) {
    ($("shot") as HTMLImageElement).src = `data:image/png;base64,${st.failure_screenshot}`;
    $("shot-wrap").hidden = false;
  }
}

// ── wiring ───────────────────────────────────────────────────────────────────

function fillSettingsForm() {
  ($("s-dashboard") as HTMLInputElement).value = settings.dashboardUrl;
  ($("s-bridge") as HTMLInputElement).value = settings.bridgeUrl;
  ($("s-qualia") as HTMLInputElement).value = settings.qualiaBaseUrl;
  ($("s-delay") as HTMLSelectElement).value = String(settings.delayMs);
  ($("s-confirm") as HTMLInputElement).checked = settings.confirmIrreversible;
}

async function init() {
  settings = await loadSettings();
  fillSettingsForm();
  api = new DevApi(settings.dashboardUrl);
  bridge = new BridgeClient(settings.bridgeUrl, { onRequest: onBridgeRequest, onEvent: onBridgeEvent, onState: onBridgeState });
  bridge.connect();

  window.addEventListener("error", (ev) => browserLog("err", `Panel error: ${ev.message}`, { stack: ev.error?.stack }));
  window.addEventListener("unhandledrejection", (ev) => browserLog("err", `Panel error: ${ev.reason?.message || ev.reason}`));

  for (const b of document.querySelectorAll<HTMLButtonElement>(".mode button")) {
    b.addEventListener("click", () => {
      mode = b.dataset.mode as Mode;
      renderControls();
    });
  }
  $("workflow").addEventListener("change", () => {
    $("workflow-desc").textContent = currentWorkflow()?.description ?? "";
    $("data").replaceChildren();
    $("plan").replaceChildren();
    renderControls();
    void loadSaved();
  });
  let typing: ReturnType<typeof setTimeout> | null = null;
  $("order-input").addEventListener("input", () => {
    renderControls();
    if (typing) clearTimeout(typing);
    typing = setTimeout(loadSaved, 500);
  });
  $("run").addEventListener("click", () => startRun());
  $("pause").addEventListener("click", () => {
    run.paused = !run.paused;
    browserLog("warn", run.paused ? "Paused by user" : "Resumed by user");
    setStatus(run.paused ? "Paused" : "Running", run.paused ? "pause" : "run");
    renderControls();
  });
  $("stop").addEventListener("click", async () => {
    run.stopRequested = true;
    run.paused = false;
    browserLog("warn", "Stop requested by user");
    if (approval) approval(false);
    setStatus("Stopping…", "warn");
    if (run.id) await api.stop(run.id).catch(() => {});
  });
  $("approve-yes").addEventListener("click", () => approval?.(true));
  $("approve-no").addEventListener("click", () => {
    run.stopRequested = true;
    approval?.(false);
    if (run.id) void api.stop(run.id).catch(() => {});
  });
  $("show-debug").addEventListener("change", rerenderLog);
  $("refresh-history").addEventListener("click", loadRecent);
  $("save-settings").addEventListener("click", async () => {
    settings = {
      dashboardUrl: ($("s-dashboard") as HTMLInputElement).value.trim(),
      bridgeUrl: ($("s-bridge") as HTMLInputElement).value.trim(),
      qualiaBaseUrl: ($("s-qualia") as HTMLInputElement).value.trim(),
      delayMs: Number(($("s-delay") as HTMLSelectElement).value),
      confirmIrreversible: ($("s-confirm") as HTMLInputElement).checked,
    };
    await saveSettings(settings);
    api.setBase(settings.dashboardUrl);
    bridge.setUrl(settings.bridgeUrl);
    localNote("ok", "Settings saved");
    void refreshHealth();
    void detectTab();
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (controller && source.tabId === controller.tabId) {
      controller.markDetached();
      if (run.active) {
        run.stopRequested = true;
        browserLog("warn", `Debugger detached (${reason}) — stopping`);
        if (run.id) void api.stop(run.id).catch(() => {});
      }
    }
  });
  chrome.tabs.onActivated.addListener(() => detectTab());
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.url) detectTab();
  });

  await detectTab();
  await refreshHealth();
  setInterval(refreshHealth, 5000);
  await loadRecent();
  setStatus("Idle");
}

init();
