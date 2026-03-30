import { describe, it, expect } from 'vitest';
import { AgentRunnerParser } from './agent-runner-parser.js';

describe('AgentRunnerParser', () => {
  it('parses a stream event (chat.delta)', () => {
    const parser = new AgentRunnerParser('session-1', 'run-1');
    const r1 = parser.parseLine('---NANOCLAW_STREAM_EVENT---');
    expect(r1.events).toEqual([]);
    expect(r1.output).toBeUndefined();

    const r2 = parser.parseLine('{"event":"chat.delta","payload":{"content":"Hi"}}');
    expect(r2.events).toEqual([
      { event: 'chat.delta', payload: { sessionKey: 'session-1', runId: 'run-1', content: 'Hi' } },
    ]);
    expect(r2.output).toBeUndefined();
  });

  it('parses a stream event (agent.tool)', () => {
    const parser = new AgentRunnerParser('s1', 'r1');
    parser.parseLine('---NANOCLAW_STREAM_EVENT---');
    const r = parser.parseLine('{"event":"agent.tool","payload":{"tool":"Bash","input":{"cmd":"ls"},"output":null}}');
    expect(r.events).toEqual([
      { event: 'agent.tool', payload: { sessionKey: 's1', runId: 'r1', tool: 'Bash', input: { cmd: 'ls' }, output: null } },
    ]);
  });

  it('parses a ContainerOutput sandwich', () => {
    const parser = new AgentRunnerParser('s1', 'r1');
    const r1 = parser.parseLine('---NANOCLAW_OUTPUT_START---');
    expect(r1.events).toEqual([]);

    const r2 = parser.parseLine('{"status":"success","result":"Done.","newSessionId":"abc"}');
    expect(r2.output).toEqual({ status: 'success', result: 'Done.', newSessionId: 'abc' });
    expect(r2.events).toEqual([
      {
        event: 'chat.final',
        payload: {
          sessionKey: 's1',
          runId: 'r1',
          content: 'Done.',
          sessionId: 'abc',
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      },
    ]);

    const r3 = parser.parseLine('---NANOCLAW_OUTPUT_END---');
    expect(r3.events).toEqual([]);
  });

  it('emits chat.error for error ContainerOutput', () => {
    const parser = new AgentRunnerParser('s1', 'r1');
    parser.parseLine('---NANOCLAW_OUTPUT_START---');
    const r = parser.parseLine('{"status":"error","result":null,"error":"boom"}');
    expect(r.events).toEqual([
      {
        event: 'chat.error',
        payload: { sessionKey: 's1', runId: 'r1', error: 'boom' },
      },
    ]);
  });

  it('emits no events for null-result session-update outputs', () => {
    const parser = new AgentRunnerParser('s1', 'r1');
    parser.parseLine('---NANOCLAW_OUTPUT_START---');
    const r = parser.parseLine('{"status":"success","result":null,"newSessionId":"xyz"}');
    expect(r.events).toEqual([]);
    expect(r.output).toEqual({ status: 'success', result: null, newSessionId: 'xyz' });
  });

  it('ignores unknown lines', () => {
    const parser = new AgentRunnerParser('s1', 'r1');
    const r = parser.parseLine('[agent-runner] some log message');
    expect(r.events).toEqual([]);
    expect(r.output).toBeUndefined();
  });

  it('handles malformed JSON gracefully', () => {
    const parser = new AgentRunnerParser('s1', 'r1');
    parser.parseLine('---NANOCLAW_STREAM_EVENT---');
    const r = parser.parseLine('not json');
    expect(r.events).toEqual([]);
  });

  it('resets state properly between outputs', () => {
    const parser = new AgentRunnerParser('s1', 'r1');
    parser.parseLine('---NANOCLAW_OUTPUT_START---');
    parser.parseLine('{"status":"success","result":"one","newSessionId":"a"}');
    parser.parseLine('---NANOCLAW_OUTPUT_END---');
    parser.parseLine('---NANOCLAW_OUTPUT_START---');
    const r = parser.parseLine('{"status":"success","result":"two","newSessionId":"b"}');
    expect(r.output?.result).toBe('two');
  });
});
