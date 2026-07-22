/**
 * MCP server for Qualia access tools.
 *
 * Tools exposed:
 *   upload_document       — fetch a Gmail PDF attachment and upload it to a Qualia order
 *   update_closing_date   — set the estimated closing date on a Qualia order
 *   update_purchase_price — set the purchase price on a Qualia order
 *   get_charges           — read CDF charge rows from a Qualia order
 *
 * Each tool accepts either an order number (2026-MO-XXX) or a street address
 * for the order_search parameter.
 *
 * Transport: StreamableHTTP, stateless (new server+transport per request).
 * Mount in server.ts:
 *   app.post("/mcp", requireAuth, mcpHandler);
 *   app.get("/mcp",  requireAuth, mcpHandler);
 *
 * Import pattern note:
 *   The MCP SDK is ESM-first with a "./*" catch-all export. With node10/commonjs
 *   module resolution, TypeScript ignores package exports and resolves type paths
 *   classically — so we import types directly from dist/cjs/*.  At runtime we
 *   use require("…/server/mcp.js") which goes through the catch-all export and
 *   lands on the correct CJS file.
 */
// tsconfig paths maps these to dist/cjs/*.d.ts for TypeScript types;
// at runtime Node.js resolves them via the package's catch-all export to dist/cjs/*.js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { google } from "googleapis";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Request, Response } from "express";
import { withSession } from "./browserbase";
import { uploadDocument } from "./actions/upload-document";
import { updateClosingDate } from "./actions/update-closing-date";
import { updatePurchasePrice } from "./actions/update-purchase-price";
import { getCharges } from "./scripts/read/get-charges";
import type { CdfSection } from "./scripts/read/get-charges";
import { fetchOrderByNumber, fetchOrdersByAddress } from "./utils/order-api";
import type { OrderRecord } from "./utils/order-api";

// ─── Address helpers ──────────────────────────────────────────────────────────

function expandStreetAbbreviations(street: string): string {
  return street
    .replace(/\bN\b/g, "North").replace(/\bS\b/g, "South")
    .replace(/\bE\b/g, "East").replace(/\bW\b/g, "West")
    .replace(/\bSt\.?\b/g, "Street").replace(/\bAve\.?\b/g, "Avenue")
    .replace(/\bBlvd\.?\b/g, "Boulevard").replace(/\bDr\.?\b/g, "Drive")
    .replace(/\bRd\.?\b/g, "Road").replace(/\bLn\.?\b/g, "Lane")
    .replace(/\bCt\.?\b/g, "Court").replace(/\bPl\.?\b/g, "Place")
    .replace(/\bPkwy\.?\b/g, "Parkway").replace(/\bCir\.?\b/g, "Circle");
}

async function resolveOrder(
  search: string
): Promise<{ order: OrderRecord | null; ambiguous?: boolean }> {
  const trimmed = search.trim();

  // Order number pattern: YYYY-MO-NNN
  if (/^\d{4}-MO-\d+$/i.test(trimmed)) {
    return { order: await fetchOrderByNumber(trimmed.toUpperCase()) };
  }

  // Address search — strip city/state if provided, try with abbreviation expansion
  const street = trimmed.split(",")[0].trim();
  let orders = await fetchOrdersByAddress(street);
  if (orders.length === 0) {
    const expanded = expandStreetAbbreviations(street);
    if (expanded !== street) orders = await fetchOrdersByAddress(expanded);
  }

  if (orders.length === 0) return { order: null };
  if (orders.length > 1) return { order: orders[0], ambiguous: true };
  return { order: orders[0] };
}

// ─── Gmail attachment download ────────────────────────────────────────────────

function makeGmail() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64;
  const authOptions: ConstructorParameters<typeof google.auth.GoogleAuth>[0] = b64
    ? { credentials: JSON.parse(Buffer.from(b64, "base64").toString("utf8")) }
    : { keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE! };

  const auth = new google.auth.GoogleAuth({
    ...authOptions,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    clientOptions: { subject: process.env.GMAIL_USER ?? "amit@aureotitle.com" },
  });
  return google.gmail({ version: "v1", auth });
}

async function downloadPdfAttachments(
  messageId: string
): Promise<{ name: string; path: string }[]> {
  const gmail = makeGmail();
  const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });

  const dir = join(tmpdir(), `mcp-upload-${messageId}`);
  mkdirSync(dir, { recursive: true });
  const files: { name: string; path: string }[] = [];

  async function walk(part: { filename?: string; body?: { attachmentId?: string }; parts?: typeof part[] }) {
    if (part.filename && part.body?.attachmentId && part.filename.toLowerCase().endsWith(".pdf")) {
      const res = await gmail.users.messages.attachments.get({
        userId: "me", messageId, id: part.body.attachmentId,
      });
      const dest = join(dir, part.filename);
      writeFileSync(dest, Buffer.from(res.data.data ?? "", "base64url"));
      files.push({ name: part.filename, path: dest });
    }
    for (const p of (part.parts ?? [])) await walk(p);
  }

  if (msg.data.payload) await walk(msg.data.payload as Parameters<typeof walk>[0]);
  return files;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const CDF_SECTIONS = [
  "origination_charges", "services_not_shopped_for", "services_shopped_for",
  "taxes_and_fees", "prepaids", "escrows", "other_charges", "lender_credits",
] as const;

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "qualia-access", version: "1.0.0" });

  // ── upload_document ─────────────────────────────────────────────────────────
  server.tool(
    "upload_document",
    "Upload a PDF attachment from a Gmail message to the Documents section of a Qualia order. " +
    "The server fetches the attachment directly via Gmail API — the file never touches the caller's machine.",
    {
      order_search: z.string().describe("Order number (e.g. 2026-MO-267) or street address (e.g. '600 S 5th St')"),
      gmail_message_id: z.string().describe("Gmail message ID (hex string like 19f84d0a9cc8677d) containing the PDF attachment"),
      doc_name: z.string().optional().describe("Optional display name override for the document in Qualia"),
    },
    async ({ order_search, gmail_message_id, doc_name }) => {
      const { order, ambiguous } = await resolveOrder(order_search);
      if (!order) {
        return { content: [{ type: "text" as const, text: `No order found matching: "${order_search}"` }] };
      }

      const files = await downloadPdfAttachments(gmail_message_id);
      if (files.length === 0) {
        return { content: [{ type: "text" as const, text: "No PDF attachments found in that message" }] };
      }

      const uploaded: string[] = [];
      try {
        await withSession(async (page) => {
          for (const file of files) {
            await uploadDocument(page, order.qualia_id, file.path, doc_name ? { name: doc_name } : {});
            uploaded.push(file.name);
          }
        });
      } finally {
        for (const file of files) {
          try { unlinkSync(file.path); } catch { /* ignore */ }
        }
      }

      const note = ambiguous ? `\nNote: multiple orders matched — used ${order.order_number}` : "";
      return {
        content: [{
          type: "text" as const,
          text: `Uploaded to ${order.order_number}:\n${uploaded.map(f => `  ✓ ${f}`).join("\n")}${note}`,
        }],
      };
    }
  );

  // ── update_closing_date ─────────────────────────────────────────────────────
  server.tool(
    "update_closing_date",
    "Update the estimated closing date on a Qualia order",
    {
      order_search: z.string().describe("Order number (e.g. 2026-MO-267) or street address"),
      new_date: z.string().describe("New closing date in MM/DD/YYYY format"),
    },
    async ({ order_search, new_date }) => {
      const { order, ambiguous } = await resolveOrder(order_search);
      if (!order) {
        return { content: [{ type: "text" as const, text: `No order found matching: "${order_search}"` }] };
      }
      await withSession(async (page) => {
        await updateClosingDate(page, order.qualia_id, new_date);
      });
      const note = ambiguous ? ` (matched ${order.order_number} from ambiguous address)` : "";
      return {
        content: [{
          type: "text" as const,
          text: `Updated closing date for ${order.order_number} to ${new_date}${note}`,
        }],
      };
    }
  );

  // ── update_purchase_price ───────────────────────────────────────────────────
  server.tool(
    "update_purchase_price",
    "Update the purchase price on a Qualia order",
    {
      order_search: z.string().describe("Order number (e.g. 2026-MO-267) or street address"),
      amount: z.string().describe("New purchase price as a number string without $ or commas, e.g. '42500'"),
    },
    async ({ order_search, amount }) => {
      const { order, ambiguous } = await resolveOrder(order_search);
      if (!order) {
        return { content: [{ type: "text" as const, text: `No order found matching: "${order_search}"` }] };
      }
      await withSession(async (page) => {
        await updatePurchasePrice(page, order.qualia_id, amount);
      });
      const note = ambiguous ? ` (matched ${order.order_number} from ambiguous address)` : "";
      return {
        content: [{
          type: "text" as const,
          text: `Updated purchase price for ${order.order_number} to $${amount}${note}`,
        }],
      };
    }
  );

  // ── get_charges ─────────────────────────────────────────────────────────────
  server.tool(
    "get_charges",
    "Get CDF charge rows for a Qualia order",
    {
      order_search: z.string().describe("Order number (e.g. 2026-MO-267) or street address"),
      section: z.enum(CDF_SECTIONS).optional()
        .describe("CDF section to read (default: services_not_shopped_for)"),
    },
    async ({ order_search, section }) => {
      const { order, ambiguous } = await resolveOrder(order_search);
      if (!order) {
        return { content: [{ type: "text" as const, text: `No order found matching: "${order_search}"` }] };
      }

      const resolvedSection = (section as CdfSection) ?? "services_not_shopped_for";
      const rows = await getCharges(order.order_number, resolvedSection);

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No charges found in section: ${resolvedSection}` }] };
      }

      const lines = rows.map((r) =>
        [r.line, r.description, r.payee,
          r.borrowerAtClosing && `B: ${r.borrowerAtClosing}`,
          r.sellerAtClosing && `S: ${r.sellerAtClosing}`]
          .filter(Boolean).join(" | ")
      );

      const note = ambiguous ? `\nNote: matched ${order.order_number} from ambiguous address` : "";
      return {
        content: [{
          type: "text" as const,
          text: `${order.order_number} — ${resolvedSection}:\n${lines.join("\n")}${note}`,
        }],
      };
    }
  );

  return server;
}

// ─── Express handler ──────────────────────────────────────────────────────────

export async function mcpHandler(req: Request, res: Response): Promise<void> {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}
