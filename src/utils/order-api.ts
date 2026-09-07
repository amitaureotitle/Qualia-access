import dotenv from "dotenv";
dotenv.config();

export interface OrderRecord {
  order_number: string;
  qualia_id: string;
  address1: string;
  city: string;
  state: string;
  zipcode: string;
  status: string;
  estimated_closing: string | null;
  purchase_price: string | null;
  buyers: string | null;
  sellers: string | null;
  seller_email: string | null;
  /** Wholesaler/referral company name (e.g. "ZMO Homes"), or null for a direct/organic deal. */
  source_of_business: string | null;
}

export interface WholesalerContact {
  wholesaler_name: string | null;
  wholesaler_email: string | null;
}

/**
 * Look up an order by its human-readable order number (e.g. "2026-MO-181").
 * Returns the record including qualia_id, or null if not found.
 */
export async function fetchOrderByNumber(orderNumber: string): Promise<OrderRecord | null> {
  const base = (process.env.BASE_URL ?? "").replace(/\/$/, "");
  const key = process.env.INTERNAL_API_KEY ?? "";
  const res = await fetch(`${base}/api/internal/order/${encodeURIComponent(orderNumber)}`, {
    headers: { "X-Internal-Key": key },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Order API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<OrderRecord>;
}

/**
 * Look up orders by street address (partial match on address1).
 * Returns all orders whose address1 contains the given street string (case-insensitive).
 */
export async function fetchOrdersByAddress(street: string): Promise<OrderRecord[]> {
  const base = (process.env.BASE_URL ?? "").replace(/\/$/, "");
  const key = process.env.INTERNAL_API_KEY ?? "";
  const res = await fetch(
    `${base}/api/internal/orders/by-address?q=${encodeURIComponent(street)}`,
    { headers: { "X-Internal-Key": key } }
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Order API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<OrderRecord[]>;
}

/**
 * Best-effort wholesaler name/email for a wholesaler-sourced order. There's no
 * stored contact for this anywhere in Qualia, so the server resolves it by
 * searching Gmail for the earliest message about the order's address and
 * returning whoever sent it -- both fields come back null for a direct/organic
 * deal (no source_of_business on file) or if no matching email was found.
 * This hits Gmail live on the server, so only call it when actually needed.
 */
export async function fetchWholesalerContact(orderNumber: string): Promise<WholesalerContact> {
  const base = (process.env.BASE_URL ?? "").replace(/\/$/, "");
  const key = process.env.INTERNAL_API_KEY ?? "";
  const res = await fetch(
    `${base}/api/internal/order/${encodeURIComponent(orderNumber)}/wholesaler-contact`,
    { headers: { "X-Internal-Key": key } }
  );
  if (!res.ok) throw new Error(`Order API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<WholesalerContact>;
}
