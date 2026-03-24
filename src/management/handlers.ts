import type { ChildProcessRunner } from '../child-process-runner.js';

let runner: ChildProcessRunner;
const startTime = Date.now();

export function setRunner(r: ChildProcessRunner): void {
  runner = r;
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
  // Spawn-or-reuse: if session doesn't exist, spawn a new agent process.
  if (!runner.getSession(params.sessionKey)) {
    await runner.spawn({
      sessionKey: params.sessionKey,
      model: process.env.MODEL_PRIMARY || 'claude-sonnet-4-20250514',
      systemPrompt: process.env.SYSTEM_PROMPT || '',
    });
  }
  await runner.sendMessage(params.sessionKey, params.message);
  return { runId, sessionKey: params.sessionKey };
}

export async function handleChatAbort(params: { sessionKey: string }) {
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
