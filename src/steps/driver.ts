/**
 * The minimal browser surface the workflow steps (src/steps/*) need, so the
 * exact same step code runs in two places:
 * - the robot: Playwright on a Browserbase session (playwright-driver.ts) --
 *   what runs from GitHub Actions / Vercel;
 * - Amit's own Chrome tab, when Qualia-access runs locally with
 *   DRIVER=bridge: each call is forwarded over a WebSocket to the Workflow
 *   Runner extension (bridge-driver.ts, extension/), which outlines the
 *   target, waits (2s by default) so you can see what's about to happen,
 *   then performs it with real input events -- and can pause/stop.
 *
 * Step code must stay browser-agnostic: no playwright-core imports, no
 * Node APIs, DOM reads through evaluate() strings. Every click/keystroke
 * must go through click()/type()/press() (never el.click() inside an
 * evaluate) so the bridge can show it before it happens.
 */
export interface ClickOptions {
  /**
   * "mouse" (default): a real mouse click at the element's centre.
   * "dom": element.click() -- for Qualia's custom elements (<issuepolicy>,
   * <closeorder>, menu items) that ignore synthesized mouse events or
   * aren't reliably hit-testable; same effect as the original step code.
   */
  via?: "mouse" | "dom";
  /** Human label shown next to the outline, e.g. 'Click "Send Message"'. */
  label?: string;
}

export type Key = "Enter" | "Escape" | "Tab" | "Backspace";

export interface Driver {
  /** Qualia origin, e.g. "https://aureotitle.qualia.io/". */
  readonly baseUrl: string;
  /** Full navigation; resolves once the new document has parsed. */
  goto(url: string): Promise<void>;
  /** Evaluate an expression in the page's main world; returns its JSON value. Read-only by convention. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Poll a boolean expression until true; false on timeout (never throws). */
  waitFor(predicate: string, timeoutMs: number): Promise<boolean>;
  /** Click the first element matching `selector`. */
  click(selector: string, opts?: ClickOptions): Promise<void>;
  /** Real key events for each character, into whatever has focus. */
  type(text: string, label?: string): Promise<void>;
  press(key: Key): Promise<void>;
  /**
   * Outline an element with a label before a change made by script (e.g. a
   * value set through evaluate) so it's visible in the bridge. No-op for the robot.
   */
  show(selector: string, label: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** base64 PNG of the first element matching `selector` -- or of the visible page for ":viewport". */
  screenshot(selector: string): Promise<string | undefined>;
  /** Human-readable narration of what the step is doing. */
  note(message: string): void;
  /**
   * Called immediately before an irreversible click (Issue, Send, Close).
   * The robot resolves at once; the bridge may wait for the user to approve,
   * and throws StoppedError if they stop instead. After commit() resolves the
   * step runs to completion -- a stop is no longer honoured, so a click is
   * never left half-verified.
   */
  commit(label: string): Promise<void>;
}

/** Thrown by a driver when the user stops a run before commit(). */
export class StoppedError extends Error {
  constructor(message = "Stopped by user") {
    super(message);
    this.name = "StoppedError";
  }
}

export function orderUrl(d: Driver, orderId: string, section = "dashboard"): string {
  return new URL(`/orders/${orderId}/${section}`, d.baseUrl).href;
}

const MARK = "data-wf-target";
let markSeq = 0;

/**
 * Find an element with a page-side expression, tag it, then click it
 * through the driver (so the bridge can outline it first).
 * `findExpr` evaluates to the element, null (-> 'not found'), or a status
 * string explaining why it can't be clicked (returned as-is).
 */
export async function clickFound(d: Driver, findExpr: string, label: string, via: "mouse" | "dom" = "dom"): Promise<string> {
  const id = `t${Date.now().toString(36)}${(markSeq++).toString(36)}`;
  const res = await d.evaluate<string>(`
    (function() {
      var el = (${findExpr});
      if (el == null) return 'not found';
      if (typeof el === 'string') return el;
      el.setAttribute('${MARK}', '${id}');
      return 'found';
    })()
  `);
  if (res !== "found") return res;
  await d.click(`[${MARK}="${id}"]`, { via, label });
  return "clicked";
}

/** JS expression: first visible leaf element whose trimmed text is exactly `text`. */
export function leafTextExpr(text: string, scopeSelector?: string): string {
  return `(function() {
    var root = ${scopeSelector ? `document.querySelector(${JSON.stringify(scopeSelector)})` : "document"};
    if (!root) return 'no scope';
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var txt = el.children.length === 0 ? (el.textContent || '').trim() : '';
      if (txt === ${JSON.stringify(text)} && el.offsetParent !== null) return el;
    }
    return null;
  })()`;
}

/** Click the first visible leaf element whose trimmed text is exactly `text`. */
export function clickLeafText(d: Driver, text: string, scopeSelector?: string): Promise<string> {
  return clickFound(d, leafTextExpr(text, scopeSelector), `Click "${text}"`);
}

/**
 * Driver-based port of utils/dismiss-modals.ts (timezone prompt + Amplitude
 * "What's New" popup), same behaviour and timeouts.
 */
export async function dismissStartupModals(d: Driver): Promise<void> {
  const tz = await d.waitFor(
    `(function(){ var b = document.body; return !!b && b.innerText.indexOf('Different Timezone Detected') !== -1; })()`,
    3_000
  );
  if (tz) {
    d.note("Dismissing the timezone prompt");
    await clickFound(
      d,
      `(function(){ var l = document.querySelector('.ui.dimmer.modals.active .ui.checkbox label'); return l && l.offsetParent !== null ? l : 'no checkbox'; })()`,
      "Tick \"don't ask again\""
    );
    await clickLeafText(d, "No, keep time zone");
    await d.waitFor(`document.body.innerText.indexOf('Different Timezone Detected') === -1`, 5_000);
  }
  const amplitude = await d.waitFor(
    `(function(){ var e = document.querySelector('.amplitude-engagement-modal-container'); return !!e && e.offsetParent !== null; })()`,
    5_000
  );
  if (amplitude) {
    d.note("Removing the What's New popup");
    await d.evaluate(`
      (function() {
        var wrapper = document.getElementById("engagement-wrapper");
        if (wrapper) wrapper.remove();
        document.querySelectorAll(".amplitude-engagement-modal-container, .rc-dialog-wrap").forEach(function(el) { el.remove(); });
      })()
    `);
  }
}

export async function openOrder(d: Driver, orderId: string, section = "dashboard"): Promise<void> {
  d.note(`Opening ${section.replace(/_/g, " ")}`);
  await d.goto(orderUrl(d, orderId, section));
  await dismissStartupModals(d);
}
