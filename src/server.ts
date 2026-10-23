/**
 * Qualia Access API server.
 * Exposes charge data over HTTP so other projects can query without
 * holding any Qualia or Browserbase credentials.
 *
 * Run: npx ts-node src/server.ts
 *
 * Required env:
 *   QUALIA_API_KEY  — shared secret the calling project uses as Bearer token
 *   (all other QUALIA_* / BROWSERBASE_* vars as normal)
 */
import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, basename } from "path";
import { getCharges, CdfSection } from "./scripts/read/get-charges";
import { mcpHandler } from "./mcp-server";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createOAuthProvider, loginHandler } from "./mcp-auth";
import { withSession } from "./browserbase";
import { fetchOrderByNumber } from "./utils/order-api";
import { sendTrailingDocuments, PolicyKind } from "./actions/send-trailing-documents";
import { closeOrder } from "./actions/close-order";
import { matchEmdWire } from "./actions/match-emd-wire";
import { uploadDocument } from "./actions/upload-document";
import { fillBorrower, BorrowerFields } from "./actions/fill-borrower";
import { createServer } from "http";
import { StoppedError } from "./steps/driver";
import { withDriver } from "./steps/session";
import { bridge } from "./steps/bridge-driver";
import { sendMessageStep, AttachmentRef } from "./steps/send-message";
import { issuePoliciesStep, PolicyPrep } from "./steps/issue-policies";
import { readRecordingStep } from "./steps/read-recording";
import { closeOrderStep } from "./steps/close-order";

dotenv.config();

const PORT = parseInt(process.env.API_PORT ?? "3001", 10);
const API_KEY = process.env.QUALIA_API_KEY;

if (!API_KEY) throw new Error("QUALIA_API_KEY env var is required");

const ISSUER = new URL(process.env.MCP_ISSUER_URL ?? "https://qualia-access.vercel.app");

const oauthProvider = createOAuthProvider();

const app = express();
// Default 100kb is too small for a base64-encoded PDF attachment (see
// /upload-document below). Vercel's own Function request-body cap is 4.5mb
// regardless of this setting -- raised from 4mb to 6mb (2026-10-12) so THIS
// limit stops being the binding constraint (4mb of base64 JSON was only
// ~3.0MiB of raw file bytes, tighter than Vercel's own cap); Vercel's 4.5mb
// is now the real ceiling, ~3.37MB of raw bytes. Pipeline-dashboard's buyer
// intake feature enforces its own 3MB-per-file product limit client-side,
// comfortably under that.
app.use(express.json({ limit: "6mb" }));

// ─── MCP OAuth endpoints ──────────────────────────────────────────────────────

app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl: ISSUER }));

// Login form submission (form action in mcp-auth.ts loginForm())
app.post("/oauth/login", express.urlencoded({ extended: false }), loginHandler);

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ─── MCP endpoint ─────────────────────────────────────────────────────────────

const mcpAuth = requireBearerAuth({ verifier: oauthProvider });
// POST handles tool calls; GET handles SSE stream for long-running tools
app.post("/mcp", mcpAuth, mcpHandler);
app.get("/mcp", mcpAuth, mcpHandler);

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /charges
 * Body: { orderNumber: string, section?: CdfSection }
 * Returns: { orderNumber, section, rows: ChargeRow[] }
 */
app.post("/charges", requireAuth, async (req: Request, res: Response) => {
  const { orderNumber, section } = req.body as {
    orderNumber?: string;
    section?: CdfSection;
  };

  if (!orderNumber || typeof orderNumber !== "string") {
    res.status(400).json({ error: "orderNumber is required" });
    return;
  }

  const resolvedSection: CdfSection = section ?? "services_not_shopped_for";

  const validSections: CdfSection[] = [
    "origination_charges",
    "services_not_shopped_for",
    "services_shopped_for",
    "taxes_and_fees",
    "prepaids",
    "escrows",
    "other_charges",
    "lender_credits",
  ];
  if (!validSections.includes(resolvedSection)) {
    res.status(400).json({ error: `Invalid section. Must be one of: ${validSections.join(", ")}` });
    return;
  }

  console.log(`[${new Date().toISOString()}] GET charges  order=${orderNumber}  section=${resolvedSection}`);

  try {
    const rows = await getCharges(orderNumber, resolvedSection);
    res.json({ orderNumber, section: resolvedSection, rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[error] ${message}`);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /post-closing/send-and-close
 * Body: { orderNumber: string, policies: PolicyKind[], ownerEmailOverride?: string }
 * ownerEmailOverride: for source-of-business entities with a designated
 * post-closing mailbox (config/policies/post_closing_recipients.json on
 * the Python side) instead of the on-order contact -- must already exist
 * as a Contact on the order (matched by email substring, not role text).
 * Destructive: opens Send Message, fills subject, selects the buyer (+
 * lender if present) as recipients, switches to "email with attachments",
 * attaches everything in the Recorded documents folder plus the issued
 * Full Owner/Lender Policy files, clicks Send -- then navigates to
 * dashboard/summary and sets order status to Closed. No idempotency guard
 * of its own; only ever called by the Python side after it holds the
 * send_trailing_documents claim.
 * Returns: { status: "sent"|"error", recipients?, attachments? } for the
 * email step, plus { closeStatus: "closed"|"error", closeDetail? } for the
 * close-order step (attempted even if the email step failed, so a
 * send-only failure doesn't also block closing -- Python decides how to
 * treat a partial result).
 */
app.post("/post-closing/send-and-close", requireAuth, async (req: Request, res: Response) => {
  const { orderNumber, policies, ownerEmailOverride } = req.body as {
    orderNumber?: string;
    policies?: PolicyKind[];
    ownerEmailOverride?: string;
  };
  if (!orderNumber || typeof orderNumber !== "string" || !Array.isArray(policies) || policies.length === 0) {
    res.status(400).json({ error: "orderNumber and a non-empty policies array are required" });
    return;
  }

  console.log(`[${new Date().toISOString()}] post-closing send-and-close  order=${orderNumber}  policies=${policies.join(",")}${ownerEmailOverride ? `  ownerEmailOverride=${ownerEmailOverride}` : ""}`);

  try {
    const order = await fetchOrderByNumber(orderNumber);
    if (!order) {
      res.status(404).json({ status: "error", detail: `Order ${orderNumber} not found` });
      return;
    }

    const result = await withSession(async (page) => {
      const sendResult = await sendTrailingDocuments(page, order.qualia_id, order.address1, policies, { ownerEmailOverride });
      const closeResult = await closeOrder(page, order.qualia_id);
      return {
        ...sendResult,
        closeStatus: closeResult.status,
        closeDetail: closeResult.detail,
      };
    }, { timeout: 600, contextId: process.env.QUALIA_CONTEXT_ID });

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[error] ${message}`);
    res.status(500).json({ status: "error", detail: message });
  }
});

/**
 * POST /upload-document
 * Body: { orderNumber: string, files: [{ name: string, content_base64: string }] }
 * Uploads one or more files to the Documents section of a Qualia order --
 * thin HTTP wrapper around the existing uploadDocument() Playwright action
 * (actions/upload-document.ts), previously only reachable via the MCP tool
 * or the standalone src/scripts/automation/process-labeled-emails.ts
 * automation. Built for Pipeline-dashboard's inbox triage agent
 * (receptors/triage_agent.py) so an email attachment can go straight to a
 * resolved order without a human doing it by hand.
 * Note: Vercel Functions cap request bodies at 4.5mb -- a base64-encoded
 * attachment larger than roughly that (after the ~33% base64 overhead)
 * will be rejected before this handler ever runs.
 * Returns: { uploaded: string[] } (filenames actually uploaded) or
 * { status: "error", detail } on failure.
 */
app.post("/upload-document", requireAuth, async (req: Request, res: Response) => {
  const { orderNumber, files } = req.body as {
    orderNumber?: string;
    files?: { name: string; content_base64: string }[];
  };
  if (!orderNumber || typeof orderNumber !== "string" || !Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: "orderNumber and a non-empty files array are required" });
    return;
  }

  console.log(`[${new Date().toISOString()}] upload-document  order=${orderNumber}  files=${files.map((f) => f.name).join(",")}`);

  try {
    const order = await fetchOrderByNumber(orderNumber);
    if (!order) {
      res.status(404).json({ status: "error", detail: `Order ${orderNumber} not found` });
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "qualia-upload-"));
    const uploaded: string[] = [];
    try {
      await withSession(async (page) => {
        for (const file of files) {
          // basename() is load-bearing, not cosmetic: file.name has always
          // come from a semi-trusted source (Gmail attachment names via the
          // triage agent), but the Pipeline-dashboard repo's buyer intake
          // feature (2026-10-12) is adding a path that lets an anonymous
          // public form feed this endpoint -- without this, a crafted name
          // like "../../../etc/something" would write outside `dir`.
          const filePath = join(dir, basename(file.name));
          writeFileSync(filePath, Buffer.from(file.content_base64, "base64"));
          await uploadDocument(page, order.qualia_id, filePath);
          uploaded.push(file.name);
        }
      }, { contextId: process.env.QUALIA_CONTEXT_ID });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    res.json({ uploaded });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[error] ${message}`);
    res.status(500).json({ status: "error", detail: message });
  }
});

/**
 * POST /accounting/match-emd-wire
 * Body: { orderNumber: string, fedwireNumber: string, composeOnly?: boolean }
 * Destructive: navigates Banking > Incoming Wires (Pending) for the Axos
 * Trust Account, finds the pending wire by FedWire #, opens its "Match and
 * Resolve Wire" > "Send To Order" dialog, resolves orderNumber to a real
 * order and cross-checks the resulting address against Qualia's own
 * fetchOrderByNumber(orderNumber) address before ever submitting, then
 * clicks the real "Send To Order" submit -- creates a real transaction
 * matching real escrow money to a real order, irreversible via this action.
 * Pass composeOnly: true to stop right before that click and just return
 * what would have been matched (see match-emd-wire.ts's doc comment --
 * always dry-run at least once against any new pending wire before a real
 * call).
 * Returns: { status: "matched"|"error", matchedText?, detail? }.
 */
app.post("/accounting/match-emd-wire", requireAuth, async (req: Request, res: Response) => {
  const { orderNumber, fedwireNumber, composeOnly } = req.body as {
    orderNumber?: string;
    fedwireNumber?: string;
    composeOnly?: boolean;
  };
  if (!orderNumber || !fedwireNumber) {
    res.status(400).json({ error: "orderNumber and fedwireNumber are required" });
    return;
  }

  console.log(`[${new Date().toISOString()}] accounting match-emd-wire  order=${orderNumber}  fedwire=${fedwireNumber}${composeOnly ? "  composeOnly" : ""}`);

  try {
    const order = await fetchOrderByNumber(orderNumber);
    if (!order) {
      res.status(404).json({ status: "error", detail: `Order ${orderNumber} not found` });
      return;
    }

    const result = await withSession(
      (page) => matchEmdWire(page, orderNumber, fedwireNumber, order.address1, { composeOnly }),
      { timeout: 300, contextId: process.env.QUALIA_CONTEXT_ID }
    );

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[error] ${message}`);
    res.status(500).json({ status: "error", detail: message });
  }
});

// ─── Closeout workflow (Pipeline-dashboard post_closing/closeout/) ───────────
//
// One endpoint per browser step, each in its own session: issuing, sending
// two emails and closing in one call would run past Vercel's 300s
// maxDuration. The Python side gathers everything from Qualia's API first,
// confirms each step's outcome from the API afterwards, and holds a
// try_claim() before every irreversible call -- these routes have no
// idempotency guard of their own.
//
// The steps run through withDriver(): Browserbase normally, or the user's
// own tab via the Workflow Runner extension when run locally with
// DRIVER=bridge. A user Stop (StoppedError, before the irreversible click)
// comes back as {status: "stopped"}; Python then releases the claim.

async function resolveQualiaId(body: { orderNumber?: string; qualiaId?: string }, res: Response): Promise<string | null> {
  // Pipeline-dashboard sends qualiaId directly; orderNumber lookup kept for other callers.
  if (body.qualiaId) return body.qualiaId;
  const order = await fetchOrderByNumber(body.orderNumber!);
  if (!order) {
    res.status(404).json({ status: "error", detail: `Order ${body.orderNumber} not found` });
    return null;
  }
  return order.qualia_id;
}

async function runStep(res: Response, label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const out = await fn();
    if (!res.headersSent) res.json(out); // resolveQualiaId may have answered 404 already
  } catch (err) {
    if (err instanceof StoppedError) {
      res.json({ status: "stopped", detail: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const sessionId = (err as { sessionId?: string } | null)?.sessionId;
    console.error(`[error] ${label}: ${message}${sessionId ? `  session=${sessionId}` : ""}`);
    res.status(500).json({ status: "error", detail: message, sessionId });
  }
}

const STEP_SESSION = { timeout: 300, contextId: process.env.QUALIA_CONTEXT_ID };

/**
 * POST /closeout/read-recording
 * Body: { orderNumber: string, qualiaId?: string }
 * Read-only: the order's Recording page table (document + recorded date/time).
 * Returns: { status: "read"|"error"|"stopped", instruments?: [{document, recorded}], detail? }
 */
app.post("/closeout/read-recording", requireAuth, async (req: Request, res: Response) => {
  const { orderNumber, qualiaId } = req.body as { orderNumber?: string; qualiaId?: string };
  if (!orderNumber) {
    res.status(400).json({ error: "orderNumber is required" });
    return;
  }
  console.log(`[${new Date().toISOString()}] closeout read-recording  order=${orderNumber}`);
  await runStep(res, "read-recording", async () => {
    const id = await resolveQualiaId({ orderNumber, qualiaId }, res);
    if (!id) return;
    return withDriver((d) => readRecordingStep(d, id), { ...STEP_SESSION, step: "Read recording dates", orderNumber });
  });
});

/**
 * POST /closeout/issue-policies
 * Body: { orderNumber, qualiaId?, policyCount, rehearse?,
 *         policies?: { index, kind, effectiveDate, effectiveTime }[] }
 * Destructive: per policy sets Effective Date/Time and ticks "Use Recording
 * Date" + "Include Endorsements on Policy", then clicks "Issue All Policies"
 * (policyCount > 1) or "Issue" -- unless rehearse (dry run), which only
 * outlines each field, checkbox and the button.
 * Returns: { status: "clicked"|"rehearsed"|"error"|"stopped", button?, detail? }
 */
app.post("/closeout/issue-policies", requireAuth, async (req: Request, res: Response) => {
  const { orderNumber, qualiaId, policyCount, policies, rehearse } = req.body as {
    orderNumber?: string;
    qualiaId?: string;
    policyCount?: number;
    policies?: PolicyPrep[];
    rehearse?: boolean;
  };
  if (!orderNumber || typeof policyCount !== "number" || policyCount < 1) {
    res.status(400).json({ error: "orderNumber and a positive policyCount are required" });
    return;
  }
  console.log(`[${new Date().toISOString()}] closeout issue-policies  order=${orderNumber}  policyCount=${policyCount}`);
  await runStep(res, "issue-policies", async () => {
    const id = await resolveQualiaId({ orderNumber, qualiaId }, res);
    if (!id) return;
    return withDriver((d) => issuePoliciesStep(d, id, policyCount, { rehearse, policies }), {
      ...STEP_SESSION,
      step: rehearse ? "Issue policies (dry run)" : "Issue policies",
      orderNumber,
    });
  });
});

/**
 * POST /closeout/send-message
 * Body: { orderNumber, qualiaId?, subject, body, recipients: string[],
 *         attachments: { name, folderPath }[], composeOnly?: boolean }
 * Destructive unless composeOnly: sends a Qualia "email with attachments".
 * composeOnly fills everything in, returns a screenshot, and sends nothing.
 * Returns: { status: "sent"|"composed"|"error"|"stopped", recipientChips?,
 *            attachments?, bodyPreview?, screenshot?, detail? }
 */
app.post("/closeout/send-message", requireAuth, async (req: Request, res: Response) => {
  const { orderNumber, qualiaId, subject, body, recipients, attachments, pendingAttachments, clearBodyLines, composeOnly } = req.body as {
    orderNumber?: string;
    qualiaId?: string;
    pendingAttachments?: string[];
    clearBodyLines?: string[];
    subject?: string;
    body?: string;
    recipients?: string[];
    attachments?: AttachmentRef[];
    composeOnly?: boolean;
  };
  if (!orderNumber || !subject || !body || !Array.isArray(recipients) || !Array.isArray(attachments)) {
    res.status(400).json({ error: "orderNumber, subject, body, recipients[] and attachments[] are required" });
    return;
  }
  console.log(`[${new Date().toISOString()}] closeout send-message  order=${orderNumber}  recipients=${recipients.length}  attachments=${attachments.length}${composeOnly ? "  composeOnly" : ""}`);
  await runStep(res, "send-message", async () => {
    const id = await resolveQualiaId({ orderNumber, qualiaId }, res);
    if (!id) return;
    return withDriver(
      (d) => sendMessageStep(d, id, { subject, body, recipients, attachments, pendingAttachments, clearBodyLines, composeOnly }),
      { ...STEP_SESSION, step: composeOnly ? "Compose email (dry run)" : "Send email", orderNumber }
    );
  });
});

/**
 * POST /closeout/close
 * Body: { orderNumber: string, qualiaId?: string, rehearse?: boolean }
 * Destructive: sets the order's status to Closed -- unless rehearse (dry
 * run): opens the status menu, chooses Closed, outlines "Close Order" in the
 * confirmation, then clicks "Keep Order".
 * Returns: { status: "closed"|"rehearsed"|"error"|"stopped", detail? }
 */
app.post("/closeout/close", requireAuth, async (req: Request, res: Response) => {
  const { orderNumber, qualiaId, rehearse } = req.body as { orderNumber?: string; qualiaId?: string; rehearse?: boolean };
  if (!orderNumber) {
    res.status(400).json({ error: "orderNumber is required" });
    return;
  }
  console.log(`[${new Date().toISOString()}] closeout close  order=${orderNumber}${rehearse ? "  (dry run)" : ""}`);
  await runStep(res, "close", async () => {
    const id = await resolveQualiaId({ orderNumber, qualiaId }, res);
    if (!id) return;
    return withDriver((d) => closeOrderStep(d, id, { rehearse }), {
      ...STEP_SESSION,
      step: rehearse ? "Close order (dry run)" : "Close order",
      orderNumber,
    });
  });
});

// Fill an individual buyer's blank contact fields (Contacts -> Buyers -> index).
// Called by Pipeline-dashboard's Order Assistant after a human approves; the
// caller sends only fields that are blank in Qualia (checked via the GraphQL
// API) and re-reads them afterwards to verify. Field VALUES (including SSN)
// are never logged -- only their names.
app.post("/contacts/fill-borrower", requireAuth, async (req: Request, res: Response) => {
  const { orderNumber, qualiaId, index, fields } = req.body as { orderNumber?: string; qualiaId?: string; index?: number; fields?: BorrowerFields };
  if (!orderNumber || !fields || typeof fields !== "object") {
    res.status(400).json({ error: "orderNumber and fields are required" });
    return;
  }
  const idx = Number.isInteger(index) ? (index as number) : 0;
  console.log(`[${new Date().toISOString()}] contacts fill-borrower  order=${orderNumber}  index=${idx}  fields=${Object.keys(fields).join(",")}`);
  try {
    // The caller knows Qualia's internal id; only look it up when it's missing.
    const orderId = qualiaId || (await fetchOrderByNumber(orderNumber))?.qualia_id;
    if (!orderId) {
      res.status(404).json({ status: "error", detail: `Order ${orderNumber} not found` });
      return;
    }
    const result = await withSession(
      (page) => fillBorrower(page, orderId, idx, fields),
      { timeout: 300, contextId: process.env.QUALIA_CONTEXT_ID }
    );
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[error] fill-borrower: ${message.split("\n")[0]}`);
    res.status(500).json({ status: "error", detail: message.split("\n")[0] });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

// Export for Vercel serverless handler
export default app;

// Only bind a port when running locally (not on Vercel). DRIVER=bridge
// (local workflow testing) also hosts the extension's WebSocket on /bridge.
if (!process.env.VERCEL) {
  const server = createServer(app);
  if (process.env.DRIVER === "bridge") bridge.attach(server);
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Qualia Access API listening on http://localhost:${PORT}${process.env.DRIVER === "bridge" ? "  (DRIVER=bridge)" : ""}`);
  });
}
