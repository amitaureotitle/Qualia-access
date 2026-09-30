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
import { join } from "path";
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

dotenv.config();

const PORT = parseInt(process.env.API_PORT ?? "3001", 10);
const API_KEY = process.env.QUALIA_API_KEY;

if (!API_KEY) throw new Error("QUALIA_API_KEY env var is required");

const ISSUER = new URL(process.env.MCP_ISSUER_URL ?? "https://qualia-access.vercel.app");

const oauthProvider = createOAuthProvider();

const app = express();
// Default 100kb is too small for a base64-encoded PDF attachment (see
// /upload-document below); Vercel's own Function request-body cap is 4.5mb
// regardless of this setting, so this just gets Express out of the way
// under that ceiling rather than raising it further.
app.use(express.json({ limit: "4mb" }));

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
          const filePath = join(dir, file.name);
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

// ─── Start ────────────────────────────────────────────────────────────────────

// Export for Vercel serverless handler
export default app;

// Only bind a port when running locally (not on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Qualia Access API listening on http://localhost:${PORT}`);
  });
}
