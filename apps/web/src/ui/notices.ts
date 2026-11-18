// Which notice the one notice line shows first (spec 2026-11-18 §1.2). Lower rank = more urgent.
export type NoticeKey = 'idle' | 'chainFork' | 'storageLost' | 'alert' | 'serverBehind' | 'offline' | 'unsynced' | 'clockSkew' | 'persist' | 'update';

const RANK: Record<NoticeKey, number> = {
  idle: 0, // WCAG 2.2.1: the sign-out warning must be seen at once
  chainFork: 1,
  storageLost: 1,
  alert: 2,
  serverBehind: 3,
  offline: 4,
  unsynced: 5,
  clockSkew: 6,
  persist: 7,
  update: 8,
};

/** Most urgent first; notices of the same rank keep their order (Array.prototype.sort is stable). */
export const sortNotices = <T extends { key: NoticeKey }>(list: T[]): T[] => [...list].sort((a, b) => RANK[a.key] - RANK[b.key]);
