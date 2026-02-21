import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WorkspaceRepoNode {
  name: string;
  path: string;
  reasons: string[];
}

export interface WorkspaceDiscoveryResult {
  rootDir: string;
  repos: WorkspaceRepoNode[];
}

function parsePackageJsonWorkspaces(packageJsonPath: string): string[] {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { workspaces?: string[] | { packages?: string[] } };
    if (Array.isArray(parsed.workspaces)) {
      return parsed.workspaces;
    }
    if (Array.isArray(parsed.workspaces?.packages)) {
      return parsed.workspaces.packages;
    }
  } catch {
    // Ignore malformed package.json; discovery is best-effort.
  }
  return [];
}

function normalizeGlobLike(input: string): string {
  return input.replace(/\/\*\*\/\*$/g, '').replace(/\/\*$/g, '').replace(/^\.\//, '');
}

function addRepo(
  map: Map<string, WorkspaceRepoNode>,
  rootDir: string,
  repoPath: string,
  reason: string
): void {
  const abs = path.isAbsolute(repoPath) ? repoPath : path.resolve(rootDir, repoPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }

  const key = path.normalize(abs);
  const name = path.basename(abs);
  const existing = map.get(key);
  if (existing) {
    if (!existing.reasons.includes(reason)) {
      existing.reasons.push(reason);
    }
    return;
  }

  map.set(key, {
    name,
    path: abs,
    reasons: [reason],
  });
}

export async function discoverWorkspace(rootDir: string): Promise<WorkspaceDiscoveryResult> {
  const repoMap = new Map<string, WorkspaceRepoNode>();

  addRepo(repoMap, rootDir, rootDir, 'workspace_root');

  const packageJsonPath = path.join(rootDir, 'package.json');
  const workspaceGlobs = parsePackageJsonWorkspaces(packageJsonPath);
  for (const raw of workspaceGlobs) {
    const candidate = normalizeGlobLike(raw);
    if (!candidate) {
      continue;
    }
    const base = path.resolve(rootDir, candidate);
    try {
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue;
        }
        addRepo(repoMap, rootDir, path.join(base, entry.name), 'workspace_glob');
      }
    } catch {
      addRepo(repoMap, rootDir, base, 'workspace_path');
    }
  }

  const gitModulesPath = path.join(rootDir, '.gitmodules');
  if (fs.existsSync(gitModulesPath)) {
    try {
      const content = fs.readFileSync(gitModulesPath, 'utf-8');
      const matches = content.matchAll(/^\s*path\s*=\s*(.+)\s*$/gm);
      for (const match of matches) {
        const submodulePath = match[1]?.trim();
        if (submodulePath) {
          addRepo(repoMap, rootDir, submodulePath, 'git_submodule');
        }
      }
    } catch {
      // Ignore malformed .gitmodules.
    }
  }

  // Detect nested repositories one level deep.
  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      const child = path.join(rootDir, entry.name);
      if (fs.existsSync(path.join(child, '.git'))) {
        addRepo(repoMap, rootDir, child, 'nested_git');
      }
    }
  } catch {
    // Best effort.
  }

  return {
    rootDir,
    repos: Array.from(repoMap.values())
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}
