// container/skills/x-integration/tools.ts
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import {
  postTweet,
  replyToTweet,
  quoteTweet,
  likeTweet,
  retweet,
  searchRecent,
  getHomeTimeline,
} from './actions.js';
import { getApprovalMode } from './approval-policy.js';
import { XMonitor } from './monitor.js';
import { buildBootstrapInterviewPrompt } from './interview.js';
import { runMonitorCycle } from '../social-monitor/framework.js';
import type { MonitorContext, EngagementLogEntry } from '../social-monitor/interfaces.js';

const WORKSPACE_BASE = process.env.NANOCLAW_WORKSPACE_BASE || '/workspace';
const TASKS_DIR = path.join(WORKSPACE_BASE, 'ipc', 'tasks');
const IPC_DIR = path.join(WORKSPACE_BASE, 'ipc');
const GROUP_DIR = path.join(WORKSPACE_BASE, 'group');
const GROUP_FOLDER = process.env.NANOCLAW_GROUP_FOLDER || '';
const APPROVAL_POLICY_PATH = path.join(GROUP_DIR, 'approval-policy.json');
const IS_MAIN = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

function mainOnly(): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
  if (!IS_MAIN) {
    return {
      content: [{ type: 'text', text: 'Only the main group can use X integration.' }],
      isError: true,
    };
  }
  return null;
}

async function requestApproval(category: string, action: string, summary: string, details: Record<string, unknown> = {}): Promise<{ approved: boolean; respondedBy: string }> {
  const requestId = `apr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();

  writeIpcFile(path.join(IPC_DIR, GROUP_FOLDER, 'tasks'), {
    type: 'request_approval',
    requestId,
    category,
    action,
    summary,
    details,
    expiresAt,
    groupFolder: GROUP_FOLDER,
    timestamp: new Date().toISOString(),
  });

  const resultDir = path.join(IPC_DIR, GROUP_FOLDER, 'approval_results');
  const resultFile = path.join(resultDir, `${requestId}.json`);
  const maxWait = 3600_000;
  const pollInterval = 2_000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
      fs.unlinkSync(resultFile);
      return { approved: result.approved, respondedBy: result.respondedBy };
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }
  return { approved: false, respondedBy: 'system:timeout' };
}

export function createXTools(server: any) {
  server.tool(
    'x_post',
    'Post a tweet to X. Requires approval per policy.',
    { content: z.string().max(280).describe('Tweet text (max 280 chars)') },
    async (args: { content: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      try {
        const mode = getApprovalMode(APPROVAL_POLICY_PATH, 'x_post');
        if (mode === 'block') {
          return { content: [{ type: 'text' as const, text: 'x_post is blocked by approval policy.' }], isError: true };
        }
        if (mode === 'confirm') {
          const approval = await requestApproval('x_post', 'post', `Post tweet: "${args.content}"`, { content: args.content });
          if (!approval.approved) {
            return { content: [{ type: 'text' as const, text: `Approval denied by ${approval.respondedBy}` }], isError: true };
          }
        }
        const result = await postTweet(args.content);
        return { content: [{ type: 'text' as const, text: result.url || 'Tweet posted' }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_like',
    'Like a tweet on X.',
    { tweet_url: z.string().describe('Tweet URL or ID') },
    async (args: { tweet_url: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      const tweetId = extractTweetId(args.tweet_url);
      const mode = getApprovalMode(APPROVAL_POLICY_PATH, 'x_like');
      if (mode === 'block') {
        return { content: [{ type: 'text' as const, text: 'x_like is blocked by approval policy.' }], isError: true };
      }
      try {
        if (mode === 'confirm') {
          const approval = await requestApproval('x_like', 'like', `Like tweet ${tweetId}`, { tweetId });
          if (!approval.approved) {
            return { content: [{ type: 'text' as const, text: `Approval denied by ${approval.respondedBy}` }], isError: true };
          }
        }
        await likeTweet(tweetId);
        return { content: [{ type: 'text' as const, text: `Liked tweet ${tweetId}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_reply',
    'Reply to a tweet on X. Requires approval per policy.',
    {
      tweet_url: z.string().describe('Tweet URL or ID'),
      content: z.string().max(280).describe('Reply text (max 280 chars)'),
    },
    async (args: { tweet_url: string; content: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      const tweetId = extractTweetId(args.tweet_url);
      try {
        const mode = getApprovalMode(APPROVAL_POLICY_PATH, 'x_reply');
        if (mode === 'block') {
          return { content: [{ type: 'text' as const, text: 'x_reply is blocked by approval policy.' }], isError: true };
        }
        if (mode === 'confirm') {
          const approval = await requestApproval('x_reply', 'reply', `Reply to ${tweetId}: "${args.content}"`, { tweetId, content: args.content });
          if (!approval.approved) {
            return { content: [{ type: 'text' as const, text: `Approval denied by ${approval.respondedBy}` }], isError: true };
          }
        }
        const result = await replyToTweet(tweetId, args.content);
        return { content: [{ type: 'text' as const, text: result.url || 'Reply posted' }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_retweet',
    'Retweet a tweet on X.',
    { tweet_url: z.string().describe('Tweet URL or ID') },
    async (args: { tweet_url: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      const tweetId = extractTweetId(args.tweet_url);
      const mode = getApprovalMode(APPROVAL_POLICY_PATH, 'x_retweet');
      if (mode === 'block') {
        return { content: [{ type: 'text' as const, text: 'x_retweet is blocked by approval policy.' }], isError: true };
      }
      try {
        if (mode === 'confirm') {
          const approval = await requestApproval('x_retweet', 'retweet', `Retweet ${tweetId}`, { tweetId });
          if (!approval.approved) {
            return { content: [{ type: 'text' as const, text: `Approval denied by ${approval.respondedBy}` }], isError: true };
          }
        }
        await retweet(tweetId);
        return { content: [{ type: 'text' as const, text: `Retweeted ${tweetId}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_quote',
    'Quote tweet on X with your own commentary. Requires approval per policy.',
    {
      tweet_url: z.string().describe('Tweet URL or ID'),
      comment: z.string().max(280).describe('Your commentary (max 280 chars)'),
    },
    async (args: { tweet_url: string; comment: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      const tweetId = extractTweetId(args.tweet_url);
      try {
        const mode = getApprovalMode(APPROVAL_POLICY_PATH, 'x_quote');
        if (mode === 'block') {
          return { content: [{ type: 'text' as const, text: 'x_quote is blocked by approval policy.' }], isError: true };
        }
        if (mode === 'confirm') {
          const approval = await requestApproval('x_quote', 'quote', `Quote ${tweetId}: "${args.comment}"`, { tweetId, comment: args.comment });
          if (!approval.approved) {
            return { content: [{ type: 'text' as const, text: `Approval denied by ${approval.respondedBy}` }], isError: true };
          }
        }
        const result = await quoteTweet(tweetId, args.comment);
        return { content: [{ type: 'text' as const, text: result.url || 'Quote posted' }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_search',
    'Search recent tweets on X (last 7 days).',
    {
      query: z.string().describe('Search query'),
      max_results: z.number().min(10).max(100).default(10).optional(),
    },
    async (args: { query: string; max_results?: number }) => {
      try {
        const results = await searchRecent(args.query, args.max_results ?? 10);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_timeline',
    'Fetch your home timeline from X.',
    { max_results: z.number().min(10).max(100).default(50).optional() },
    async (args: { max_results?: number }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      try {
        const results = await getHomeTimeline(args.max_results ?? 50);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_setup',
    'Bootstrap your X persona from account history. Analyzes recent tweets and likes to generate persona data, then starts an interview to refine it.',
    {},
    async () => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      try {
        const monitor = new XMonitor();
        const ctx: MonitorContext = {
          groupFolder: GROUP_FOLDER,
          personaPath: path.join(GROUP_DIR, 'x-persona.md'),
          approvalPolicyPath: APPROVAL_POLICY_PATH,
          dryRun: false,
        };
        const draft = await monitor.bootstrapPersona!(ctx);
        const interviewPrompt = buildBootstrapInterviewPrompt(draft.content);
        return {
          content: [{
            type: 'text' as const,
            text: `Persona bootstrap complete. ${draft.sourceStats.postsAnalyzed} tweets and ${draft.sourceStats.likesAnalyzed} likes analyzed (${draft.sourceStats.dateRange.from} to ${draft.sourceStats.dateRange.to}).\n\n${interviewPrompt}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );
}

function extractTweetId(urlOrId: string): string {
  const match = urlOrId.match(/status\/(\d+)/);
  return match ? match[1] : urlOrId;
}
