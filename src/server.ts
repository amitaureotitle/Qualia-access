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
import { getCharges, CdfSection } from "./scripts/read/get-charges";
import { mcpHandler } from "./mcp-server";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createOAuthProvider, loginHandler } from "./mcp-auth";

dotenv.config();

const PORT = parseInt(process.env.API_PORT ?? "3001", 10);
const API_KEY = process.env.QUALIA_API_KEY;

if (!API_KEY) throw new Error("QUALIA_API_KEY env var is required");

const ISSUER = new URL(process.env.MCP_ISSUER_URL ?? "https://qualia-access.vercel.app");

const oauthProvider = createOAuthProvider();

const app = express();
app.use(express.json());

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

// ─── Start ────────────────────────────────────────────────────────────────────

// Export for Vercel serverless handler
export default app;

// Only bind a port when running locally (not on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Qualia Access API listening on http://localhost:${PORT}`);
  });
}
