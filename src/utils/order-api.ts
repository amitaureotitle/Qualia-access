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
