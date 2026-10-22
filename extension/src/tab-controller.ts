/**
 * Performs Driver calls (from Qualia-access's bridge-driver.ts) in one
 * Chrome tab via chrome.debugger -- real mouse and key events, the same CDP
 * commands Playwright sends.
 *
 * Every *visible* action (goto, click, type, press, show) first draws an
 * outline + label on the page and waits `delayMs` (2s by default) so you can
 * see what's about to happen, then acts. Every call passes the gate first:
 * it waits while paused and throws StoppedError once stopped -- except after
 * commit() (an irreversible click was approved), so a step is never left
 * half-verified. The server marks each new step with a "run" event, which
 * resets that.
 */

export class StoppedError extends Error {
  constructor(message = "Stopped by user") {
    super(message);
    this.name = "StoppedError";
  }
}

export interface ControllerHooks {
  gate(): Promise<void>;
  /** One visible action is about to happen (label) -- panel shows it with a countdown. */
  announce(label: string, delayMs: number): void;
  /** Log one browser-side entry (goes into the run log). */
  log(level: "debug" | "info" | "warn" | "err", msg: string, data?: unknown): void;
  /** Resolve true to continue past an irreversible click, false to stop. */
  approve(label: string): Promise<boolean>;
  screenshotTaken(base64: string): void;
  delayMs(): number;
  confirmIrreversible(): boolean;
}

type Rect = { x: number; y: number; width: number; height: number };

const OVERLAY_ID = "__wf_runner_overlay";

export class TabController {
  committed = false;
  private attached = false;

  constructor(readonly tabId: number, private readonly hooks: ControllerHooks) {}

  // ── plumbing ────────────────────────────────────────────────────────────

  async attach(): Promise<void> {
    if (this.attached) return;
    await chrome.debugger.attach({ tabId: this.tabId }, "1.3");
    this.attached = true;
    this.hooks.log("debug", `Debugger attached to tab ${this.tabId}`);
  }

  async detach(): Promise<void> {
    if (!this.attached) return;
    this.attached = false;
    await this.raw(`(function(){ var o = document.getElementById('${OVERLAY_ID}'); if (o) o.remove(); })()`).catch(() => {});
    await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
  }

  markDetached(): void {
    this.attached = false;
  }

  newStep(): void {
    this.committed = false;
  }

  private async gate(): Promise<void> {
    if (!this.committed) await this.hooks.gate();
  }

  private send<T = any>(method: string, params?: object): Promise<T> {
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params) as Promise<T>;
  }

  private async raw<T>(expression: string): Promise<T> {
    const r = await this.send<any>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "evaluate failed");
    }
    return r.result?.value as T;
  }

  private async wait(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await this.gate();
      await new Promise((r) => setTimeout(r, Math.min(100, end - Date.now())));
    }
  }

  // ── overlay ─────────────────────────────────────────────────────────────

  /** Outline `selector` (or the focused element, or a top banner) with a label. */
  private async overlay(label: string, selector: string | null, target: "selector" | "focus" | "banner", tone = "#e8590c"): Promise<void> {
    await this.raw(`
      (function(sel, label, target, tone) {
        var old = document.getElementById('${OVERLAY_ID}');
        if (old) old.remove();
        var el = target === 'selector' ? document.querySelector(sel) : target === 'focus' ? document.activeElement : null;
        if (el === document.body) el = null;
        var box = document.createElement('div');
        box.id = '${OVERLAY_ID}';
        box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:3px solid ' + tone +
          ';border-radius:6px;box-shadow:0 0 0 5px ' + tone + '40;transition:all .12s;';
        var tag = document.createElement('div');
        tag.textContent = label;
        tag.style.cssText = 'position:absolute;left:-3px;bottom:100%;margin-bottom:6px;background:' + tone +
          ';color:#fff;font:600 13px/1.25 -apple-system,BlinkMacSystemFont,sans-serif;padding:6px 10px;' +
          'border-radius:6px;white-space:nowrap;max-width:70vw;overflow:hidden;text-overflow:ellipsis;';
        box.appendChild(tag);
        if (el) {
          el.scrollIntoView({ block: 'center', inline: 'center' });
          var r = el.getBoundingClientRect();
          box.style.left = (r.left - 4) + 'px'; box.style.top = (r.top - 4) + 'px';
          box.style.width = (r.width + 8) + 'px'; box.style.height = (r.height + 8) + 'px';
          if (r.top < 48) { tag.style.bottom = 'auto'; tag.style.top = '100%'; tag.style.marginTop = '6px'; }
        } else {
          box.style.left = '50%'; box.style.top = '12px'; box.style.transform = 'translateX(-50%)';
          box.style.border = '0'; box.style.boxShadow = 'none';
          tag.style.position = 'static'; tag.style.margin = '0';
        }
        document.documentElement.appendChild(box);
        return true;
      })(${JSON.stringify(selector)}, ${JSON.stringify(label)}, ${JSON.stringify(target)}, ${JSON.stringify(tone)})
    `).catch(() => false);
  }

  private async clearOverlay(): Promise<void> {
    await this.raw(`(function(){ var o = document.getElementById('${OVERLAY_ID}'); if (o) o.remove(); })()`).catch(() => {});
  }

  /** Show what's next, wait the configured delay (pausable), then let the caller act. */
  private async preview(label: string, selector: string | null, target: "selector" | "focus" | "banner"): Promise<void> {
    await this.gate();
    const delay = this.hooks.delayMs();
    this.hooks.log("info", label);
    this.hooks.announce(label, delay);
    await this.overlay(label, selector, target);
    await this.wait(delay);
  }

  // ── Driver methods (called by the bridge) ───────────────────────────────

  async goto(p: { url: string }): Promise<void> {
    const target = new URL(p.url);
    await this.preview(`Open ${target.pathname}`, null, "banner");
    const t0 = Date.now();
    await this.send("Page.navigate", { url: p.url });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const ok = await this.raw<boolean>(
        `location.pathname === ${JSON.stringify(target.pathname)} && document.readyState !== 'loading'`
      ).catch(() => false);
      if (ok) {
        this.hooks.log("debug", `Loaded ${target.pathname} in ${Date.now() - t0}ms`);
        return;
      }
    }
    throw new Error(`Navigation to ${p.url} did not finish in 30s`);
  }

  async evaluate(p: { expression: string }): Promise<unknown> {
    await this.gate();
    const value = await this.raw(p.expression);
    if (typeof value === "string" || typeof value === "boolean") {
      this.hooks.log("debug", `evaluate -> ${String(value).slice(0, 400)}`);
    }
    return value;
  }

  async waitFor(p: { predicate: string; timeoutMs: number }): Promise<boolean> {
    const t0 = Date.now();
    const what = p.predicate.replace(/\s+/g, " ").trim().slice(0, 140);
    for (;;) {
      await this.gate();
      const ok = await this.raw<boolean>(`!!(${p.predicate})`).catch(() => false);
      if (ok) {
        this.hooks.log("debug", `waitFor ok after ${Date.now() - t0}ms: ${what}`);
        return true;
      }
      if (Date.now() - t0 >= p.timeoutMs) {
        this.hooks.log("debug", `waitFor TIMED OUT after ${p.timeoutMs}ms: ${what}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async click(p: { selector: string; via: "mouse" | "dom"; label: string | null }): Promise<void> {
    const label = p.label || `Click ${p.selector}`;
    await this.preview(label, p.selector, "selector");
    if (p.via === "dom") {
      const r = await this.raw<string>(`
        (function(){ var el = document.querySelector(${JSON.stringify(p.selector)}); if (!el) return 'missing'; el.click(); return 'ok'; })()
      `);
      if (r !== "ok") throw new Error(`click: no element matches ${p.selector}`);
    } else {
      // Hit-test first: if something (an open date picker, a modal) covers
      // the target, a mouse click would land on that instead -- stop with a
      // clear reason rather than click the wrong thing (2026-10-22, MO-410).
      const rect = await this.raw<(Rect & { covered?: string }) | null>(`
        (function() {
          var el = document.querySelector(${JSON.stringify(p.selector)});
          if (!el) return null;
          var r = el.getBoundingClientRect();
          var x = r.left + r.width / 2, y = r.top + r.height / 2;
          var overlay = document.getElementById('${OVERLAY_ID}');
          if (overlay) overlay.style.display = 'none';
          var top = document.elementFromPoint(x, y);
          if (overlay) overlay.style.display = '';
          var covered = null;
          if (top && top !== el && !el.contains(top) && !top.contains(el)) {
            var cls = (top.className && typeof top.className === 'string') ? '.' + top.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
            covered = top.tagName.toLowerCase() + cls + ' "' + (top.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) + '"';
          }
          return { x: r.left, y: r.top, width: r.width, height: r.height, covered: covered };
        })()
      `);
      if (!rect) throw new Error(`click: no element matches ${p.selector}`);
      if (rect.covered) throw new Error(`click: "${label}" is covered by ${rect.covered} -- not clicking`);
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    }
    await this.clearOverlay();
  }

  async type(p: { text: string; label: string | null }): Promise<void> {
    await this.preview(p.label || `Type "${p.text}"`, null, "focus");
    await this.clearOverlay(); // the overlay must not sit on top of what's being typed into
    for (const ch of p.text) {
      await this.gate();
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async press(p: { key: "Enter" | "Escape" | "Tab" | "Backspace" }): Promise<void> {
    await this.preview(`Press ${p.key}`, null, "focus");
    await this.clearOverlay();
    const codes = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8 } as const;
    const vk = codes[p.key];
    const spec = { key: p.key, code: p.key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...spec, ...(p.key === "Enter" ? { text: "\r" } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...spec });
  }

  async show(p: { selector: string; label: string }): Promise<void> {
    await this.preview(p.label, p.selector, "selector");
    await this.clearOverlay();
  }

  async screenshot(p: { selector: string }): Promise<string | undefined> {
    if (p.selector === ":viewport") {
      await this.clearOverlay();
      const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      this.hooks.screenshotTaken(shot.data);
      return shot.data;
    }
    const rect = await this.raw<Rect | null>(`
      (function() {
        var el = document.querySelector(${JSON.stringify(p.selector)});
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
      })()
    `);
    if (!rect || rect.width === 0 || rect.height === 0) return undefined;
    const shot = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { ...rect, scale: 1 },
    });
    this.hooks.screenshotTaken(shot.data);
    return shot.data;
  }

  async commit(p: { label: string }): Promise<void> {
    await this.gate();
    if (this.hooks.confirmIrreversible()) {
      await this.overlay(`⚠ About to: ${p.label}`, null, "banner", "#c92a2a");
      const ok = await this.hooks.approve(p.label);
      await this.clearOverlay();
      if (!ok) throw new StoppedError(`Stopped before: ${p.label}`);
    }
    this.committed = true;
    this.hooks.log("warn", `Irreversible: ${p.label}`);
  }

  /** Where the tab is right now, plus a viewport screenshot -- for failure logs. Never throws. */
  async snapshot(): Promise<{ url?: string; title?: string; screenshot?: string }> {
    if (!this.attached) return {};
    const info = await this.raw<{ url: string; title: string }>(`({ url: location.href, title: document.title })`).catch(() => undefined);
    const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" }).catch(() => undefined);
    return { url: info?.url, title: info?.title, screenshot: shot?.data };
  }

  /** Dispatch a bridge request to the matching method. */
  async handle(method: string, params: any): Promise<unknown> {
    await this.attach();
    switch (method) {
      case "goto": return this.goto(params);
      case "evaluate": return this.evaluate(params);
      case "waitFor": return this.waitFor(params);
      case "click": return this.click(params);
      case "type": return this.type(params);
      case "press": return this.press(params);
      case "show": return this.show(params);
      case "screenshot": return this.screenshot(params);
      case "commit": return this.commit(params);
      default: throw new Error(`Unknown bridge method ${method}`);
    }
  }
}
