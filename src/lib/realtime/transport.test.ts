import { describe, expect, it } from 'vitest';
import { unwrapAppSyncEvent } from './transport';

describe('unwrapAppSyncEvent', () => {
  const durable = { eventId: 'e1', revision: 3, items: [{ type: 'CHAT_MESSAGE_CREATED' }] };

  it('unwraps the { id, type, event } envelope Amplify delivers', () => {
    expect(unwrapAppSyncEvent({ id: 'sub-1', type: 'data', event: durable })).toEqual(durable);
  });

  it('parses string payloads and passes raw events through', () => {
    expect(unwrapAppSyncEvent({ id: 'sub-1', type: 'data', event: JSON.stringify(durable) })).toEqual(durable);
    expect(unwrapAppSyncEvent(JSON.stringify(durable))).toEqual(durable);
    expect(unwrapAppSyncEvent(durable)).toEqual(durable);
    expect(unwrapAppSyncEvent('not json')).toBeNull();
  });
});
