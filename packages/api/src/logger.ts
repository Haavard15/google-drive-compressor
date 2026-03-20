import { config } from './config.js';

const rank: Record<string, number> = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/** Numeric ceiling: messages with rank <= this are shown (error=0 is most severe). */
function maxSeverityRank(): number {
  return rank[config.LOG_LEVEL] ?? rank.warn;
}

function allow(msgLevel: 'warn' | 'info' | 'debug'): boolean {
  if (config.LOG_LEVEL === 'silent') return false;
  return rank[msgLevel] <= maxSeverityRank();
}

/** stderr — always (except silent). */
export const log = {
  error: (...args: unknown[]) => {
    if (config.LOG_LEVEL === 'silent') return;
    console.error(...args);
  },
  warn: (...args: unknown[]) => {
    if (allow('warn')) console.warn(...args);
  },
  info: (...args: unknown[]) => {
    if (allow('info')) console.log(...args);
  },
  debug: (...args: unknown[]) => {
    if (allow('debug')) console.log(...args);
  },
};
