import { withSession, SessionOptions } from "../browserbase";
import { bridgeDriver } from "./bridge-driver";
import { Driver, StoppedError } from "./driver";
import { playwrightDriver } from "./playwright-driver";

/**
 * Run `fn` with a Driver: a Browserbase/Playwright session normally (the
 * robot, what production uses), or the user's own Chrome tab through the
 * Workflow Runner extension when Qualia-access runs locally with
 * DRIVER=bridge (see scripts/dev_workflows.sh in Pipeline-dashboard).
 *
 * A step that throws *before* its commit() (nothing irreversible happened
 * yet) comes back as {status: "error", detail} -- safe for the caller to
 * retry. A throw after commit() is re-thrown (HTTP 500 -> "outcome
 * unknown" on the Python side, which keeps the claim and blocks), and a
 * StoppedError is re-thrown for the route to report as "stopped".
 */
export async function withDriver<T>(
  fn: (d: Driver) => Promise<T>,
  opts: SessionOptions & { step: string; orderNumber?: string }
): Promise<T | { status: "error"; detail: string }> {
  let committed = false;
  const tracked = (d: Driver): Driver => ({
    ...d,
    commit: async (label: string) => {
      await d.commit(label);
      committed = true;
    },
  });
  const guarded = async (d: Driver) => {
    try {
      return await fn(tracked(d));
    } catch (err) {
      if (err instanceof StoppedError || committed) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error" as const, detail: `Failed before anything irreversible: ${message}` };
    }
  };
  if (process.env.DRIVER === "bridge") {
    return guarded(bridgeDriver({ step: opts.step, orderNumber: opts.orderNumber }));
  }
  const { step: _step, orderNumber: _order, ...sessionOpts } = opts;
  // sessionId rides along on every result and thrown error, so the Python
  // run log can link the Browserbase replay of whatever went wrong.
  return withSession(async (page, sessionId) => {
    try {
      const out = await guarded(playwrightDriver(page));
      return (out && typeof out === "object" ? { ...out, sessionId } : out) as typeof out;
    } catch (err) {
      if (err && typeof err === "object") (err as { sessionId?: string }).sessionId = sessionId;
      throw err;
    }
  }, sessionOpts);
}
