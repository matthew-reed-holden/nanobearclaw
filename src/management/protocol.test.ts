import { describe, it, expect } from 'vitest';
import { METHODS, EVENTS } from './protocol.js';
import type {
  AuthFrame,
  RequestFrame,
  ResponseFrame,
  EventFrame,
} from './protocol.js';

describe('Protocol', () => {
  it('should define exactly 11 methods', () => {
    expect(METHODS).toEqual([
      'health',
      'chat.send',
      'chat.abort',
      'sessions.list',
      'chat.history',
      'channels.status',
      'whatsapp.pair',
      'groups.sync',
      'groups.list',
      'files.sync',
      'files.list',
    ]);
  });

  it('should define exactly 9 events', () => {
    expect(EVENTS).toEqual([
      'chat.delta',
      'chat.final',
      'chat.error',
      'agent.tool',
      'health',
      'channels.status',
      'whatsapp.qr',
      'groups.discovered',
      'memory.updated',
    ]);
  });

  it('should have correct frame type shapes', () => {
    const auth: AuthFrame = { type: 'auth', token: 'test' };
    const req: RequestFrame = {
      type: 'req',
      id: '1',
      method: 'health',
      params: {},
    };
    const res: ResponseFrame = {
      type: 'res',
      id: '1',
      ok: true,
      result: { status: 'ok' },
    };
    const ev: EventFrame = {
      type: 'event',
      event: 'chat.delta',
      payload: { content: 'hi' },
    };
    expect(auth.type).toBe('auth');
    expect(req.type).toBe('req');
    expect(res.type).toBe('res');
    expect(ev.type).toBe('event');
  });
});
