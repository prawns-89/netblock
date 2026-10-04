/**
 * The single-writer primitive.
 *
 * Every state-changing operation in the system is funnelled through one
 * SerialExecutor instance. Tasks run strictly one at a time, in submission
 * order, and a task's full async body completes before the next begins. This is
 * what makes "two state-changing operations can never execute concurrently" a
 * structural property rather than a convention: network handlers, timers, UI
 * handlers and recovery all submit here and none of them can touch state
 * directly.
 */

export type ExecutorStats = {
  readonly submitted: number;
  readonly completed: number;
  readonly maxObservedConcurrency: number;
  readonly queueDepth: number;
};

export class SerialExecutor {
  #tail: Promise<unknown> = Promise.resolve();
  #submitted = 0;
  #completed = 0;
  #running = 0;
  #maxConcurrency = 0;
  #closed = false;

  /**
   * Queue `task`. Resolves/rejects with the task's outcome. A rejecting task
   * never breaks the chain for subsequent tasks.
   */
  submit<T>(task: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('executor closed'));
    this.#submitted++;

    const run = this.#tail.then(async () => {
      this.#running++;
      this.#maxConcurrency = Math.max(this.#maxConcurrency, this.#running);
      try {
        return await task();
      } finally {
        this.#running--;
        this.#completed++;
      }
    });

    // Keep the chain alive regardless of this task's outcome.
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Resolves once everything queued so far has finished. */
  async drain(): Promise<void> {
    await this.#tail;
  }

  close(): void {
    this.#closed = true;
  }

  get stats(): ExecutorStats {
    return {
      submitted: this.#submitted,
      completed: this.#completed,
      maxObservedConcurrency: this.#maxConcurrency,
      queueDepth: this.#submitted - this.#completed,
    };
  }
}
