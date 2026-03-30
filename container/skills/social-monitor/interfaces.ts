// container/skills/social-monitor/interfaces.ts

export interface MonitorContext {
  groupFolder: string;
  personaPath: string;
  approvalPolicyPath: string;
  dryRun: boolean;
}

export interface TimelineItem {
  id: string;
  author: { handle: string; name: string; followers?: number };
  content: string;
  createdAt: string;
  metrics?: { likes: number; replies: number; reposts: number };
  url: string;
}

export interface EngagementAction {
  type: 'like' | 'reply' | 'repost' | 'quote' | 'ignore';
  targetId: string;
  targetUrl: string;
  targetAuthor: string;
  targetContent: string;
  content?: string;
  approvalCategory: string;
}

export interface ActionResult {
  success: boolean;
  platformId?: string;
  url?: string;
  error?: string;
  dryRun?: boolean;
}

export interface PersonaDraft {
  content: string;
  sourceStats: {
    postsAnalyzed: number;
    likesAnalyzed: number;
    dateRange: { from: string; to: string };
  };
}

export interface SocialMonitor {
  platform: string;
  fetchTimeline(ctx: MonitorContext): Promise<TimelineItem[]>;
  formatForDecision(items: TimelineItem[]): string;
  executeAction(action: EngagementAction): Promise<ActionResult>;
  bootstrapPersona?(ctx: MonitorContext): Promise<PersonaDraft>;
}

export interface EngagementLogEntry {
  id: string;
  platform: string;
  actionType: string;
  targetId: string;
  targetUrl: string;
  targetAuthor: string;
  targetContent: string;
  content: string | null;
  approvalId: string | null;
  status: 'executed' | 'rejected' | 'expired' | 'failed';
  triggeredBy: 'monitor' | 'command';
  createdAt: string;
  executedAt: string | null;
}
