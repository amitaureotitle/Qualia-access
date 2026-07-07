import Browserbase from "@browserbasehq/sdk";
import { chromium, type Page, type Browser } from "playwright-core";
import { createReadStream } from "fs";
import { toFile } from "@browserbasehq/sdk";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.BROWSERBASE_API_KEY;
const projectId = process.env.BROWSERBASE_PROJECT_ID;

if (!apiKey) throw new Error("BROWSERBASE_API_KEY is required");
if (!projectId) throw new Error("BROWSERBASE_PROJECT_ID is required");

export const bb = new Browserbase({ apiKey });

export interface SessionOptions {
  /** Reuse stored cookies/auth across sessions (e.g. Qualia login) */
  contextId?: string;
  /** Save new auth/cookies back into the context after this session */
  persistContext?: boolean;
  /** Keep session alive across disconnects — must call releaseSession() when done */
  keepAlive?: boolean;
  /** Session duration in seconds (max 21600 = 6h) */
  timeout?: number;
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

export async function createSession(opts: SessionOptions = {}) {
  return bb.sessions.create({
    projectId,
    keepAlive: opts.keepAlive ?? false,
    timeout: opts.timeout,
    browserSettings: {
      solveCaptchas: true,
      recordSession: true,
      ...(opts.contextId
        ? { context: { id: opts.contextId, persist: opts.persistContext ?? true } }
        : {}),
    },
  });
}

/** Connect Playwright to an existing session via its connectUrl (from session creation). */
export async function connectToBrowser(connectUrl: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(connectUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No browser context in session");
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser, page };
}

/** Stop a keep-alive session explicitly to avoid extra charges. */
export async function releaseSession(sessionId: string) {
  await bb.sessions.update(sessionId, { status: "REQUEST_RELEASE" });
}

// ─── Context (persistent auth) ───────────────────────────────────────────────

/** Create a new persistent context. Store the returned ID in QUALIA_CONTEXT_ID env var. */
export async function createContext(): Promise<string> {
  const context = await bb.contexts.create({ projectId });
  return context.id;
}

export async function deleteContext(contextId: string) {
  await bb.contexts.delete(contextId);
}

// ─── File transfer ───────────────────────────────────────────────────────────

/**
 * Upload a local file into a running Browserbase session.
 * The file becomes available for browser file-picker inputs.
 */
export async function uploadFileToSession(sessionId: string, filePath: string) {
  const file = await toFile(createReadStream(filePath));
  return bb.sessions.uploads.create(sessionId, { file });
}

/**
 * Download all files produced in a session (e.g. files saved by the browser).
 * Returns a raw Response — call .arrayBuffer() or pipe it to disk.
 */
export async function downloadSessionFiles(sessionId: string) {
  return bb.sessions.downloads.list(sessionId);
}

// ─── Main helper ─────────────────────────────────────────────────────────────

/**
 * Run a browser task, then close the session.
 *
 * - Defaults persistContext to FALSE so action sessions never overwrite stored login cookies.
 * - Auto-detects if the session lands on the login page and re-authenticates using
 *   email/password. The context's trusted-device cookie should let this skip MFA.
 *   If MFA is required anyway, throws a clear error asking the user to run setup-context.ts.
 */
export async function withSession<T>(
  fn: (page: Page, sessionId: string) => Promise<T>,
  opts: SessionOptions = {}
): Promise<T> {
  // Don't persist context changes during normal action sessions
  const sessionOpts: SessionOptions = { persistContext: false, ...opts };

  const session = await createSession(sessionOpts);
  const { browser, page } = await connectToBrowser(session.connectUrl);
  try {
    // Auto-relogin if the context session has expired (handles MFA via TOTP automatically)
    if (page.url().includes("/signin") || page.url() === "about:blank") {
      const { login } = await import("./actions/login");
      await login(page);
    }

    return await fn(page, session.id);
  } finally {
    await browser.close();
    if (opts.keepAlive) {
      await releaseSession(session.id);
    }
  }
}
