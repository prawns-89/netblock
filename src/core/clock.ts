/** Injectable time + timer source, so the 50-second policy is testable deterministically. */

export type TimerHandle = { readonly id: number };

export interface Clock {
  now(): number;
  setTimer(delayMs: number, fn: () => void): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

export class SystemClock implements Clock {
  #next = 1;
  readonly #handles = new Map<number, NodeJS.Timeout>();

  now(): number {
    return Date.now();
  }

  setTimer(delayMs: number, fn: () => void): TimerHandle {
    const id = this.#next++;
    const t = setTimeout(() => {
      this.#handles.delete(id);
      fn();
    }, Math.max(0, delayMs));
    // Never hold the process open just to wait for a restore timer; durable
    // recovery covers the case where the process exits before it fires.
    t.unref?.();
    this.#handles.set(id, t);
    return { id };
  }

  clearTimer(handle: TimerHandle): void {
    const t = this.#handles.get(handle.id);
    if (t !== undefined) {
      clearTimeout(t);
      this.#handles.delete(handle.id);
    }
  }
}

type VirtualTimer = { id: number; dueAt: number; fn: () => void; seq: number };

/** Controllable clock. `advance` fires due timers in (dueAt, insertion) order. */
export class VirtualClock implements Clock {
  #now: number;
  #nextId = 1;
  #seq = 0;
  #timers: VirtualTimer[] = [];

  constructor(startAt = 1_700_000_000_000) {
    this.#now = startAt;
  }

  now(): number {
    return this.#now;
  }

  setTimer(delayMs: number, fn: () => void): TimerHandle {
    const id = this.#nextId++;
    this.#timers.push({ id, dueAt: this.#now + Math.max(0, delayMs), fn, seq: this.#seq++ });
    return { id };
  }

  clearTimer(handle: TimerHandle): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle.id);
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }

  /** Move time forward, firing timers as their deadlines pass. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      const due = this.#timers
        .filter((t) => t.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq);
      const next = due[0];
      if (next === undefined) break;
      this.#timers = this.#timers.filter((t) => t.id !== next.id);
      this.#now = Math.max(this.#now, next.dueAt);
      next.fn();
      await drainMicrotasks();
    }
    this.#now = target;
    await drainMicrotasks();
  }

  /** Jump the wall clock without firing timers: models a reboot or a suspended process. */
  jump(ms: number): void {
    this.#now += ms;
  }

  /** Drop all in-memory timers: models process death. Durable state is unaffected. */
  dropAllTimers(): void {
    this.#timers = [];
  }
}

/** Let queued promise callbacks settle. Generous enough for nested await chains. */
export async function drainMicrotasks(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
