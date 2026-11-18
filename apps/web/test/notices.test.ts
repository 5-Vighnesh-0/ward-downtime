// Spec 2026-11-18 §1.2: one notice line shows the most urgent notice first.
import { describe, expect, it } from 'vitest';
import { sortNotices, type NoticeKey } from '../src/ui/notices.ts';

describe('sortNotices', () => {
  it('puts the idle warning and data problems first and the update last, keeping order within a rank', () => {
    const keys: NoticeKey[] = ['update', 'offline', 'alert', 'persist', 'chainFork', 'idle', 'clockSkew', 'alert', 'unsynced', 'serverBehind', 'storageLost'];
    const list = keys.map((key, i) => ({ key, i }));
    expect(sortNotices(list).map((n) => `${n.key}${n.key === 'alert' ? n.i : ''}`)).toEqual([
      'idle', 'chainFork', 'storageLost', 'alert2', 'alert7', 'serverBehind', 'offline', 'unsynced', 'clockSkew', 'persist', 'update',
    ]);
  });
});
