import { setTimeout as delay } from 'node:timers/promises';
import type { ClockPort } from '@application/port/ClockPort.js';

export class SystemClock implements ClockPort {
  public now(): Date {
    return new Date();
  }

  public async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await delay(ms, undefined, signal ? { signal } : undefined);
  }
}
