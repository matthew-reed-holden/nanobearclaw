// container/skills/x-integration/approval-policy.ts
import fs from 'fs';

export type ApprovalMode = 'auto' | 'confirm' | 'block';

export interface ApprovalPolicy {
  [actionType: string]: ApprovalMode;
}

const DEFAULT_POLICY: ApprovalPolicy = {
  x_post: 'confirm',
  x_reply: 'auto',
  x_quote: 'confirm',
  x_like: 'auto',
  x_retweet: 'auto',
};

let cached: ApprovalPolicy | null = null;

export function loadApprovalPolicy(policyPath: string): ApprovalPolicy {
  if (cached) return cached;

  try {
    const raw = fs.readFileSync(policyPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const policy: ApprovalPolicy = { ...DEFAULT_POLICY };
    for (const [key, value] of Object.entries(parsed)) {
      if (value === 'auto' || value === 'confirm' || value === 'block') {
        policy[key] = value;
      }
    }
    cached = policy;
    return policy;
  } catch {
    cached = DEFAULT_POLICY;
    return DEFAULT_POLICY;
  }
}

export function getApprovalMode(policyPath: string, actionType: string): ApprovalMode {
  const policy = loadApprovalPolicy(policyPath);
  return policy[actionType] ?? 'confirm';
}

export function resetPolicyCache(): void {
  cached = null;
}
