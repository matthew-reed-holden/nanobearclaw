import { ChildProcessRunner } from './child-process-runner.js';
import {
  ManagementServer,
  createHandlers,
  sessionRunIds,
  parseStreamJsonLine,
  resetStreamState,
} from './management/index.js';
import { ChannelStatusReporter } from './management/channel-status.js';
import { WhatsAppPairingRelay } from './management/whatsapp-relay.js';

// Trigger channel self-registration (each module calls registerChannel())
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import type { Channel, NewMessage } from './types.js';

const MANAGEMENT_PORT = parseInt(process.env.MANAGEMENT_PORT || '18789');
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_AGENTS || '3');

async function main() {
  const runner = new ChildProcessRunner({ maxConcurrent: MAX_CONCURRENT });

  // --- Channel initialization ---
  // Channels deliver inbound messages via onMessage. In k8s mode we route
  // them through the child-process runner as chat.send requests, using the
  // channel-qualified JID as the session key.
  const connectedChannels = new Map<string, Channel>();

  // Create handlers with a late-bound pushEvent that captures server by reference.
  // eslint-disable-next-line prefer-const -- server must be declared before the closure but assigned after
  let server: ManagementServer;

  const pushEvent = (event: string, payload: any) =>
    server.pushEvent(event, payload);

  // Set up channel status reporter and WhatsApp relay (wired after channels connect)
  const statusReporter = new ChannelStatusReporter(connectedChannels, {
    emit: pushEvent,
  });

  // WhatsApp channel reference — set after channel creation
  let whatsAppChannel: Channel | null = null;
  const whatsAppRelay = new WhatsAppPairingRelay(null as any, {
    emit: pushEvent,
  });

  const handlers = createHandlers(runner, pushEvent, {
    channelStatusReporter: statusReporter,
    whatsAppRelay,
  });
  server = new ManagementServer({ port: MANAGEMENT_PORT, handlers });
  await server.start();
  console.log(
    `NanoClaw K8s management API listening on port ${MANAGEMENT_PORT}`,
  );

  // Per-session line buffer: stdout `data` events deliver arbitrary byte
  // chunks, not complete lines. We accumulate partial lines here so that
  // JSON objects split across chunks are reassembled before parsing.
  const lineBuffers = new Map<string, string>();

  runner.on('output', (sessionKey: string, data: string) => {
    const runId = sessionRunIds.get(sessionKey) || '';
    const prev = lineBuffers.get(sessionKey) || '';
    const combined = prev + data;
    const lines = combined.split('\n');
    // Last element is either empty (if data ended with \n) or a partial line
    lineBuffers.set(sessionKey, lines.pop()!);
    for (const line of lines.filter(Boolean)) {
      for (const ev of parseStreamJsonLine(line, sessionKey, runId)) {
        server.pushEvent(ev.event, ev.payload);
      }
    }
  });

  // When a chat completes, send the final response back to the channel
  runner.on('exit', (sessionKey: string, code: number | null) => {
    // Flush any remaining buffered output before emitting exit events.
    const remaining = lineBuffers.get(sessionKey) || '';
    lineBuffers.delete(sessionKey);
    resetStreamState(sessionKey);
    if (remaining.trim()) {
      const runId = sessionRunIds.get(sessionKey) || '';
      for (const ev of parseStreamJsonLine(remaining, sessionKey, runId)) {
        server.pushEvent(ev.event, ev.payload);
      }
    }

    const runId = sessionRunIds.get(sessionKey) || '';
    sessionRunIds.delete(sessionKey);
    if (code !== 0 && code !== null) {
      server.pushEvent('chat.error', {
        sessionKey,
        runId,
        error: `Agent process exited with code ${code}`,
      });
    }
  });

  runner.on('stderr', (sessionKey: string, data: string) => {
    console.error(`[claude:${sessionKey}] ${data.trimEnd()}`);
  });

  // --- Connect channels ---
  // Channel callbacks route inbound messages through the child-process runner.
  // The sessionKey is the chat JID — each conversation gets its own Claude process.
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      const sessionKey = chatJid;
      const runId = sessionRunIds.get(sessionKey) || crypto.randomUUID();
      sessionRunIds.set(sessionKey, runId);

      // Find the channel that owns this JID to send responses back
      const channel = [...connectedChannels.values()].find((ch) =>
        ch.ownsJid(chatJid),
      );

      // Spawn a Claude process for this message
      runner
        .spawn({
          sessionKey,
          model: process.env.MODEL_PRIMARY || 'claude-sonnet-4-20250514',
          systemPrompt: process.env.SYSTEM_PROMPT || '',
          initialPrompt: msg.content,
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[channel:${sessionKey}] Spawn failed: ${message}`);
          // Try to send error back to channel
          channel?.sendMessage(chatJid, `Error: ${message}`).catch(() => {});
        });

      // Collect streamed output and send back to channel when complete
      // This is handled by the runner 'exit' event — we need to track
      // which channel to respond to
      if (channel) {
        channelResponseTargets.set(sessionKey, { channel, chatJid });
      }
    },
    onChatMetadata: (chatJid: string) => {
      // Auto-register chats in k8s mode so channels deliver all messages.
      // Standalone NanoClaw requires explicit /chatid registration, but in
      // PaaS mode every chat is implicitly registered.
      if (!autoRegisteredGroups[chatJid]) {
        autoRegisteredGroups[chatJid] = {
          name: chatJid,
          folder: chatJid,
          trigger: '',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        };
      }
    },
    registeredGroups: () => autoRegisteredGroups,
  };

  // In PaaS mode, all chats are auto-registered so channels deliver every message.
  const autoRegisteredGroups: Record<string, any> = {};

  // Track which channel to send responses back to
  const channelResponseTargets = new Map<
    string,
    { channel: Channel; chatJid: string }
  >();

  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      console.warn(`Channel ${channelName}: credentials missing — skipping`);
      continue;
    }
    try {
      await channel.connect();
      connectedChannels.set(channelName, channel);
      console.log(`Channel ${channelName}: connected`);
      if (channelName === 'whatsapp') {
        whatsAppChannel = channel;
        // Re-create relay with actual channel reference
        (whatsAppRelay as any).whatsApp = whatsAppChannel;
        whatsAppRelay.start();
      }
    } catch (err) {
      console.error(
        `Channel ${channelName}: connection failed —`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (connectedChannels.size === 0) {
    console.warn('No channels connected — management API only mode');
  } else {
    console.log(
      `${connectedChannels.size} channel(s) connected: ${[...connectedChannels.keys()].join(', ')}`,
    );
    statusReporter.start();
  }

  const shutdown = async () => {
    console.log('Shutting down...');
    statusReporter.stop();
    for (const [name, ch] of connectedChannels) {
      try {
        await ch.disconnect();
      } catch {
        console.error(`Failed to disconnect channel ${name}`);
      }
    }
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
