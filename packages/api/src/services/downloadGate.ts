import { config } from '../config.js';

/**
 * Limits parallel Drive downloads (stream + disk write). Default 1 so only one
 * download runs at a time; the next job can prefetch while the current job encodes/uploads.
 */
const permits = Math.max(1, config.MAX_CONCURRENT_DOWNLOADS);
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

export async function withDownloadSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
