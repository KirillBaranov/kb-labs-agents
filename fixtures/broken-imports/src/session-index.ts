import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class SessionIndex {
  private indexPath: string;

  constructor(baseDir: string) {
    this.indexPath = join(baseDir, 'session-index.json');
  }

  load(): Record<string, string> {
    try {
      const raw = readFileSync(this.indexPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  save(index: Record<string, string>): void {
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
  }
}
