// src/management/agent-runner-parser.ts

import type { StreamEvent } from './stream-parser.js';

const STREAM_EVENT_MARKER = '---NANOCLAW_STREAM_EVENT---';
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface ParseResult {
  events: StreamEvent[];
  output?: ContainerOutput;
}

type ParserState = 'idle' | 'awaiting_stream_json' | 'awaiting_output_json' | 'awaiting_output_end';

export class AgentRunnerParser {
  private state: ParserState = 'idle';
  private sessionKey: string;
  private runId: string;

  constructor(sessionKey: string, runId: string) {
    this.sessionKey = sessionKey;
    this.runId = runId;
  }

  parseLine(line: string): ParseResult {
    const events: StreamEvent[] = [];

    // Check for markers first
    if (line === STREAM_EVENT_MARKER) {
      this.state = 'awaiting_stream_json';
      return { events };
    }

    if (line === OUTPUT_START_MARKER) {
      this.state = 'awaiting_output_json';
      return { events };
    }

    if (line === OUTPUT_END_MARKER) {
      this.state = 'idle';
      return { events };
    }

    // Handle state-dependent parsing
    if (this.state === 'awaiting_stream_json') {
      this.state = 'idle';
      try {
        const parsed = JSON.parse(line) as { event: string; payload: Record<string, unknown> };
        const payload = { sessionKey: this.sessionKey, runId: this.runId, ...parsed.payload };
        events.push({ event: parsed.event, payload });
      } catch {
        // Malformed JSON — skip silently
      }
      return { events };
    }

    if (this.state === 'awaiting_output_json') {
      this.state = 'awaiting_output_end';
      try {
        const output = JSON.parse(line) as ContainerOutput;

        if (output.status === 'error' && output.error) {
          events.push({
            event: 'chat.error',
            payload: { sessionKey: this.sessionKey, runId: this.runId, error: output.error },
          });
        } else if (output.status === 'success' && output.result) {
          events.push({
            event: 'chat.final',
            payload: {
              sessionKey: this.sessionKey,
              runId: this.runId,
              content: output.result,
              ...(output.newSessionId ? { sessionId: output.newSessionId } : {}),
              usage: { inputTokens: 0, outputTokens: 0 },
            },
          });
        }

        return { events, output };
      } catch {
        this.state = 'idle';
        return { events };
      }
    }

    // Unknown line in idle state — ignore
    return { events };
  }

  reset(): void {
    this.state = 'idle';
  }
}
