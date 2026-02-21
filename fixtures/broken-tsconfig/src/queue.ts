export interface QueueOptions {
  maxConcurrent: number;
  timeoutMs: number;
}

export interface QueuedTask {
  id: string;
  priority: number;
  fn: () => Promise<void>;
}

export class TaskQueue {
  private queue: QueuedTask[] = [];
  private running = 0;

  constructor(private options: QueueOptions) {}

  enqueue(task: QueuedTask): void {
    this.queue.push(task);
    this.queue.sort((a, b) => b.priority - a.priority);
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && this.running < this.options.maxConcurrent) {
      const task = this.queue.shift()!;
      this.running++;
      try {
        await Promise.race([
          task.fn(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Task ${task.id} timed out`)), this.options.timeoutMs)
          ),
        ]);
      } finally {
        this.running--;
      }
    }
  }
}
