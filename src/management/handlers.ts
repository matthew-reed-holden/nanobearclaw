import type { AgentRunner } from './agent-runner.js';

// Maps sessionKey → the runId of its most recent chat.send.
// Exported so paas-entrypoint can tag streamed output events with the correct runId.
export const sessionRunIds = new Map<string, string>();
const startTime = Date.now();

export function createHandlers(
  runner: AgentRunner,
  pushEvent?: (event: string, payload: Record<string, unknown>) => void,
): Record<string, (params: any) => Promise<any>> {
  return {
    health: async () => ({
      status: 'ok' as const,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      activeAgents: runner.activeCount,
    }),

    'chat.send': async (params: {
      sessionKey: string;
      message: string;
      resumeSessionId?: string;
    }) => {
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
          resumeSessionId: params.resumeSessionId,
        });
      } catch (err: unknown) {
        // Pre-flight failures (missing API key, max concurrency) surface as
        // chat.error events so the frontend gets actionable feedback.
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[chat.send:${params.sessionKey}] Spawn failed: ${message}`,
        );
        pushEvent?.('chat.error', {
          sessionKey: params.sessionKey,
          runId,
          error: message,
        });
      }

      return { runId, sessionKey: params.sessionKey };
    },

    'chat.abort': async (params: { sessionKey: string }) => {
      sessionRunIds.delete(params.sessionKey);
      await runner.kill(params.sessionKey);
      return { aborted: true };
    },

    'sessions.list': async () => [],

    'chat.history': async () => [],
  };
}
