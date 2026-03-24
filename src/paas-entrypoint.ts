import { ChildProcessRunner } from './child-process-runner.js';
import { ManagementServer } from './management/server.js';
import { setRunner } from './management/handlers.js';

const MANAGEMENT_PORT = parseInt(process.env.MANAGEMENT_PORT || '18789');
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_AGENTS || '3');

async function main() {
  const runner = new ChildProcessRunner({ maxConcurrent: MAX_CONCURRENT });
  setRunner(runner);

  const server = new ManagementServer({ port: MANAGEMENT_PORT });
  await server.start();
  console.log(
    `NanoClaw PaaS management API listening on port ${MANAGEMENT_PORT}`,
  );

  // Wire runner output events to management server event push.
  // Claude Code --output-format stream-json emits JSON lines on stdout.
  // Parse these into chat.delta / chat.final / agent.tool events.
  runner.on('output', (sessionKey: string, data: string) => {
    for (const line of data.split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'content_block_delta') {
          server.pushEvent('chat.delta', {
            sessionKey,
            runId: parsed.runId || '',
            content: parsed.delta?.text || '',
          });
        } else if (parsed.type === 'message_stop') {
          server.pushEvent('chat.final', {
            sessionKey,
            runId: parsed.runId || '',
            content: '',
            usage: parsed.usage || { inputTokens: 0, outputTokens: 0 },
          });
        } else if (parsed.type === 'tool_use') {
          server.pushEvent('agent.tool', {
            sessionKey,
            runId: parsed.runId || '',
            tool: parsed.name || '',
            input: parsed.input,
            output: null,
          });
        }
      } catch {
        // Non-JSON line — ignore (startup text, etc.)
      }
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    await runner.killAll();
    await server.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
