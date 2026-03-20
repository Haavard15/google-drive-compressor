import { config } from '../config.js';

/** Serialize Drive uploads (one at a time) — matches MAX_CONCURRENT_UPLOADS, default 1 */
const permits = Math.max(1, config.MAX_CONCURRENT_UPLOADS);
const waiters: Array<() => void> = [];
let available = permits;

async function acquire(): Promise<void> {
  if (available > 0) {
    available--;
    return;
  }
  await new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
}

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else available++;
}

export async function withUploadSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
