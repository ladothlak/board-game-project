/**
 * Single-flight queue for LLM calls.
 * The local Unsloth server handles one request at a time, so queuing
 * prevents pileup and makes abuse slower and more visible.
 *
 * Usage:
 *   const result = await withQueue(() => fetchLlm(...));
 */

type Task<T> = () => Promise<T>;

interface QueueState {
  running: boolean;
  resolvers: Array<(value: unknown) => void>;
}

const state: QueueState = {
  running: false,
  resolvers: [],
};

/**
 * Execute `task` with mutual exclusion. If another LLM call is in flight,
 * this waits its turn. Returns the task's resolved value.
 */
export async function withQueue<T>(task: Task<T>): Promise<T> {
  if (!state.running) {
    state.running = true;
    try {
      return await task();
    } finally {
      state.running = false;
      // Release any waiting tasks.
      const waiting = state.resolvers.splice(0);
      for (const resolve of waiting) {
        Promise.resolve().then(resolve);
      }
    }
  }

  // Wait our turn.
  return new Promise<T>((resolve) => {
    state.resolvers.push(() => {
      withQueue(task).then(resolve);
    });
  });
}
