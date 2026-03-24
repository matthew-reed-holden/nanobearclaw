import type { ChildProcessRunner } from '../child-process-runner.js';
import type { ManagementServer } from './server.js';

let runner: ChildProcessRunner;
let mgmtServer: ManagementServer | null = null;
const startTime = Date.now();

// Maps sessionKey → the runId of its most recent chat.send.
// Exported so paas-entrypoint can tag streamed output events with the correct runId.
export const sessionRunIds = new Map<string, string>();

export function setRunner(r: ChildProcessRunner): void {
  runner = r;
}

export function setManagementServer(s: ManagementServer): void {
  mgmtServer = s;
}

export async function handleHealth() {
  return {
    status: 'ok' as const,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeAgents: runner?.activeCount ?? 0,
  };
}

export async function handleChatSend(params: {
  sessionKey: string;
  message: string;
}) {
  const runId = crypto.randomUUID();
  sessionRunIds.set(params.sessionKey, runId);

  // With `-p`, claude processes one prompt and exits. Each chat.send spawns
  // a fresh process. Kill any existing session for this key first.
  if (runner.getSession(params.sessionKey)) {
    await runner.kill(params.sessionKey);
  }

  try {
    await runner.spawn({
      sessionKey: params.sessionKey,
      model: process.env.MODEL_PRIMARY || 'claude-sonnet-4-20250514',
      systemPrompt: process.env.SYSTEM_PROMPT || '',
      initialPrompt: params.message,
      onError: (data: string) => {
        // Log stderr from claude CLI so errors aren't silently discarded
        console.error(`[claude:${params.sessionKey}] ${data.trimEnd()}`);
      },
    });
  } catch (err: unknown) {
    // Pre-flight failures (missing API key, max concurrency) surface as
    // chat.error events so the frontend gets actionable feedback.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[chat.send:${params.sessionKey}] Spawn failed: ${message}`);
    mgmtServer?.pushEvent('chat.error', {
      sessionKey: params.sessionKey,
      runId,
      error: message,
    });
  }

  return { runId, sessionKey: params.sessionKey };
}

export async function handleChatAbort(params: { sessionKey: string }) {
  sessionRunIds.delete(params.sessionKey);
  await runner.kill(params.sessionKey);
  return { aborted: true };
}

export async function handleSessionsList(_params: { limit?: number }) {
  return []; // PaaS PostgreSQL is source of truth for sessions
}

export async function handleChatHistory(_params: {
  sessionKey: string;
  limit?: number;
}) {
  return []; // PaaS PostgreSQL is source of truth for history
}

export const handlers: Record<string, (params: any) => Promise<any>> = {
  health: handleHealth,
  'chat.send': handleChatSend,
  'chat.abort': handleChatAbort,
  'sessions.list': handleSessionsList,
  'chat.history': handleChatHistory,
};
