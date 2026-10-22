import type { Page } from "playwright-core";
import { playwrightDriver } from "../steps/playwright-driver";
import { sendMessageStep, SendMessageInput, SendMessageResult } from "../steps/send-message";

// The step itself lives in steps/send-message.ts (driver-based, shared with
// the Closeout Tester extension); this is the Playwright entry point.
export type { AttachmentRef, SendMessageInput, SendMessageResult } from "../steps/send-message";

export function sendMessage(page: Page, orderId: string, input: SendMessageInput): Promise<SendMessageResult> {
  return sendMessageStep(playwrightDriver(page), orderId, input);
}
