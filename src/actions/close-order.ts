import type { Page } from "playwright-core";
import { playwrightDriver } from "../steps/playwright-driver";
import { closeOrderStep, CloseOrderResult } from "../steps/close-order";

// The step itself (and its live-verified selector notes) moved to
// steps/close-order.ts on 2026-10-19 -- driver-based, shared with the
// Closeout Tester extension. This is the Playwright entry point used by
// /post-closing/send-and-close and /closeout/close.
export type { CloseOrderResult } from "../steps/close-order";

export function closeOrder(page: Page, orderId: string): Promise<CloseOrderResult> {
  return closeOrderStep(playwrightDriver(page), orderId);
}
