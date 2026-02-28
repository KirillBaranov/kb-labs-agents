/**
 * FileTracker — consolidates 7+ Maps/Sets from agent.ts into one coherent class.
 *
 * Tracks files read, created, modified, their content hashes, line counts,
 * read attempts, and smallest read windows.
 */

export interface FileTrackingSnapshot {
  filesRead: ReadonlySet<string>;
  filesCreated: ReadonlySet<string>;
  filesModified: ReadonlySet<string>;
  /** Total unique files touched (union of read + created + modified) */
  totalFilesTouched: number;
}

export interface FileReadMeta {
  hash: string;
  totalLines: number;
  smallestReadWindow: number;
  readAttempts: number;
}

export class FileTracker {
  private readonly _filesRead = new Set<string>();
  private readonly _filesCreated = new Set<string>();
  private readonly _filesModified = new Set<string>();
  private readonly _readHash = new Map<string, string>();
  private readonly _totalLines = new Map<string, number>();
  private readonly _smallestReadWindow = new Map<string, number>();
  private readonly _readAttempts = new Map<string, number>();

  // ── Read tracking ──────────────────────────────────────────────

  markRead(path: string, hash: string, totalLines: number, readWindow: number): void {
    this._filesRead.add(path);
    this._readHash.set(path, hash);
    this._totalLines.set(path, totalLines);
    this._readAttempts.set(path, (this._readAttempts.get(path) ?? 0) + 1);

    const prev = this._smallestReadWindow.get(path);
    if (prev === undefined || readWindow < prev) {
      this._smallestReadWindow.set(path, readWindow);
    }
  }

  getReadHash(path: string): string | undefined {
    return this._readHash.get(path);
  }

  getReadMeta(path: string): FileReadMeta | undefined {
    const hash = this._readHash.get(path);
    if (hash === undefined) {return undefined;}
    return {
      hash,
      totalLines: this._totalLines.get(path) ?? 0,
      smallestReadWindow: this._smallestReadWindow.get(path) ?? 0,
      readAttempts: this._readAttempts.get(path) ?? 0,
    };
  }

  // ── Write tracking ─────────────────────────────────────────────

  markCreated(path: string): void {
    this._filesCreated.add(path);
  }

  markModified(path: string): void {
    this._filesModified.add(path);
  }

  // ── Queries ────────────────────────────────────────────────────

  get filesRead(): ReadonlySet<string> {
    return this._filesRead;
  }

  get filesCreated(): ReadonlySet<string> {
    return this._filesCreated;
  }

  get filesModified(): ReadonlySet<string> {
    return this._filesModified;
  }

  /** Read-only access to internal maps — for passing to external utilities */
  get totalLinesByPath(): ReadonlyMap<string, number> {
    return this._totalLines;
  }

  get readAttemptsByPath(): ReadonlyMap<string, number> {
    return this._readAttempts;
  }

  get smallestReadWindowByPath(): ReadonlyMap<string, number> {
    return this._smallestReadWindow;
  }

  /**
   * Bulk-import pre-existing file tracking state (e.g. from shared tool context).
   * Used when agent shares file state with the tool registry context.
   */
  importSharedContext(filesRead?: Set<string>, readHash?: Map<string, string>): void {
    if (filesRead) {
      for (const p of filesRead) {this._filesRead.add(p);}
    }
    if (readHash) {
      for (const [k, v] of readHash) {this._readHash.set(k, v);}
    }
  }

  /**
   * Record total line count for a file (called after fs_read with metadata).
   */
  setTotalLines(path: string, lines: number): void {
    this._totalLines.set(path, lines);
  }

  /**
   * Increment read attempt counter for a file. Returns new count.
   * Called by ToolInputNormalizer before each fs_read.
   */
  incrementReadAttempts(path: string): number {
    const next = (this._readAttempts.get(path) ?? 0) + 1;
    this._readAttempts.set(path, next);
    return next;
  }

  /**
   * Increment small-read-window counter for a file. Returns new count.
   * Called by ToolInputNormalizer when a narrow read window is detected.
   */
  incrementSmallReadWindow(path: string): number {
    const next = (this._smallestReadWindow.get(path) ?? 0) + 1;
    this._smallestReadWindow.set(path, next);
    return next;
  }

  /**
   * Reset small-read-window counter for a file (when full read is used).
   */
  resetSmallReadWindow(path: string): void {
    this._smallestReadWindow.set(path, 0);
  }

  /**
   * Expose mutable maps for ToolInputNormalizer (which mutates them directly).
   * Returns the actual Map instances — ToolInputNormalizer owns the mutation contract.
   */
  getMutableReadAttempts(): Map<string, number> {
    return this._readAttempts;
  }

  getMutableSmallReadWindow(): Map<string, number> {
    return this._smallestReadWindow;
  }

  /**
   * Expose mutable sets for ProgressTracker (which calls .add()/.delete() on them directly).
   */
  getMutableFilesRead(): Set<string> {
    return this._filesRead;
  }

  getMutableFilesCreated(): Set<string> {
    return this._filesCreated;
  }

  getMutableFilesModified(): Set<string> {
    return this._filesModified;
  }

  get totalFilesTouched(): number {
    const union = new Set([...this._filesRead, ...this._filesCreated, ...this._filesModified]);
    return union.size;
  }

  snapshot(): FileTrackingSnapshot {
    return {
      filesRead: new Set(this._filesRead),
      filesCreated: new Set(this._filesCreated),
      filesModified: new Set(this._filesModified),
      totalFilesTouched: this.totalFilesTouched,
    };
  }

  // ── Reset ──────────────────────────────────────────────────────

  clear(): void {
    this._filesRead.clear();
    this._filesCreated.clear();
    this._filesModified.clear();
    this._readHash.clear();
    this._totalLines.clear();
    this._smallestReadWindow.clear();
    this._readAttempts.clear();
  }
}
