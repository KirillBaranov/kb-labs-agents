export interface RunStats {
  taskId: string;
  iterations: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
}

export class AnalyticsCollector {
  private runs: RunStats[] = [];

  record(stats: RunStats): void {
    this.runs.push(stats);
  }

  summary(): { totalRuns: number; avgTokens: number; totalCost: number } {
    const totalRuns = this.runs.length;
    const avgTokens = totalRuns > 0
      ? this.runs.reduce((s, r) => s + r.totalTokens, 0) / totalRuns
      : 0;
    const totalCost = this.runs.reduce((s, r) => s + r.cost, 0);
    return { totalRuns, avgTokens, totalCost };
  }
}
