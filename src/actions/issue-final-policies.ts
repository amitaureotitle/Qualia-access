import type { Page } from "playwright-core";
import { playwrightDriver } from "../steps/playwright-driver";
import { issuePoliciesStep, IssueResult } from "../steps/issue-policies";

// The step itself lives in steps/issue-policies.ts (driver-based, shared
// with the Closeout Tester extension); this is the Playwright entry point.
export type { IssueResult } from "../steps/issue-policies";

export function issueFinalPolicies(page: Page, orderId: string, policyCount: number): Promise<IssueResult> {
  return issuePoliciesStep(playwrightDriver(page), orderId, policyCount);
}
