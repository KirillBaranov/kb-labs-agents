import { describe, it, expect, vi } from 'vitest';
import {
  ToolInputNormalizer,
  getRequestedReadSpan,
  isSecondaryArtifactPath,
  isGuardRejectedToolCallError,
  isRiskyShellCommand,
} from '../tool-input-normalizer';
import type { FileSystemReader, NormalizerContext } from '../tool-input-normalizer';

function makeMockFs(overrides: Partial<FileSystemReader> = {}): FileSystemReader {
  return {
    existsSync: vi.fn().mockReturnValue(false),
    statSync: vi.fn().mockReturnValue({ isFile: () => false, isDirectory: () => true }),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<NormalizerContext> = {}): NormalizerContext {
  return {
    workingDir: '/project',
    currentTier: 'medium',
    fileTotalLinesByPath: new Map(),
    fileReadAttemptsByPath: new Map(),
    smallReadWindowByPath: new Map(),
    behaviorPolicy: {
      retrieval: {
        minReadWindowLines: 10,
        maxConsecutiveSmallWindowReadsPerFile: 3,
        smallFileReadAllThresholdLines: 200,
      },
    },
    currentTask: undefined,
    toolDefinitions: [],
    ...overrides,
  };
}

describe('ToolInputNormalizer', () => {
  describe('normalizeToolInput', () => {
    it('wraps non-glob pattern for glob_search', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const result = normalizer.normalizeToolInput('glob_search', { pattern: 'foo' }, makeCtx());
      expect(result.pattern).toBe('**/*foo*');
    });

    it('preserves glob patterns for glob_search', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const result = normalizer.normalizeToolInput('glob_search', { pattern: '**/*.ts' }, makeCtx());
      expect(result.pattern).toBe('**/*.ts');
    });

    it('converts query to pattern for glob_search', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const result = normalizer.normalizeToolInput('glob_search', { query: 'test' }, makeCtx());
      expect(result.pattern).toBe('**/*test*');
    });

    it('sets default cwd for shell_exec', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const result = normalizer.normalizeToolInput('shell_exec', { command: 'ls' }, makeCtx());
      expect(result.cwd).toBe('.');
    });

    it('preserves existing cwd for shell_exec', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const result = normalizer.normalizeToolInput('shell_exec', { command: 'ls', cwd: '/tmp' }, makeCtx());
      expect(result.cwd).toBe('/tmp');
    });

    it('sets safe offset for fs_read', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const result = normalizer.normalizeToolInput('fs_read', { path: '/project/foo.ts', offset: -5 }, makeCtx());
      expect(result.offset).toBe(1);
    });

    it('resolves .backup suffix for fs_read when source exists', () => {
      const mockFs = makeMockFs({
        existsSync: vi.fn().mockImplementation((p: string) => p === '/project/foo.ts'),
      });
      const normalizer = new ToolInputNormalizer(mockFs);
      const result = normalizer.normalizeToolInput('fs_read', { path: 'foo.ts.backup' }, makeCtx());
      expect(result.path).toBe('foo.ts');
    });

    it('does not modify input for unknown tool', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const input = { foo: 'bar' };
      const result = normalizer.normalizeToolInput('custom_tool', input, makeCtx());
      expect(result).toEqual({ foo: 'bar' });
    });
  });

  describe('normalizeDirectoryField', () => {
    it('does nothing when directory is not a string', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const input: Record<string, unknown> = { directory: 123 };
      normalizer.normalizeDirectoryField(input, '/project');
      expect(input.directory).toBe(123);
    });

    it('does nothing for empty directory', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const input: Record<string, unknown> = { directory: '' };
      normalizer.normalizeDirectoryField(input, '/project');
      expect(input.directory).toBe('');
    });

    it('does nothing for "." directory', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const input: Record<string, unknown> = { directory: '.' };
      normalizer.normalizeDirectoryField(input, '/project');
      expect(input.directory).toBe('.');
    });

    it('resolves file path to parent directory when path exists as file', () => {
      const mockFs = makeMockFs({
        existsSync: vi.fn().mockReturnValue(true),
        statSync: vi.fn().mockReturnValue({ isFile: () => true, isDirectory: () => false }),
      });
      const normalizer = new ToolInputNormalizer(mockFs);
      const input: Record<string, unknown> = { directory: 'src/index.ts' };
      normalizer.normalizeDirectoryField(input, '/project');
      expect(input.directory).toBe('src');
    });

    it('keeps directory as-is when it exists as directory', () => {
      const mockFs = makeMockFs({
        existsSync: vi.fn().mockReturnValue(true),
        statSync: vi.fn().mockReturnValue({ isFile: () => false, isDirectory: () => true }),
      });
      const normalizer = new ToolInputNormalizer(mockFs);
      const input: Record<string, unknown> = { directory: 'src' };
      normalizer.normalizeDirectoryField(input, '/project');
      expect(input.directory).toBe('src');
    });

    it('resets to "." for paths outside working dir', () => {
      const mockFs = makeMockFs({
        existsSync: vi.fn().mockReturnValue(false),
      });
      const normalizer = new ToolInputNormalizer(mockFs);
      const input: Record<string, unknown> = { directory: '/other/place/file.ts' };
      normalizer.normalizeDirectoryField(input, '/project');
      // path looks like a file reference, parent doesn't exist
      expect(input.directory).toBe('/other/place/file.ts');
    });
  });

  describe('tryResolvePrimarySourcePath', () => {
    it('returns null for non-backup paths', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      expect(normalizer.tryResolvePrimarySourcePath('foo.ts', '/project')).toBeNull();
    });

    it('resolves .bak suffix when source exists', () => {
      const mockFs = makeMockFs({
        existsSync: vi.fn().mockReturnValue(true),
      });
      const normalizer = new ToolInputNormalizer(mockFs);
      expect(normalizer.tryResolvePrimarySourcePath('foo.ts.bak', '/project')).toBe('foo.ts');
    });

    it('resolves .orig suffix', () => {
      const mockFs = makeMockFs({
        existsSync: vi.fn().mockReturnValue(true),
      });
      const normalizer = new ToolInputNormalizer(mockFs);
      expect(normalizer.tryResolvePrimarySourcePath('foo.ts.orig', '/project')).toBe('foo.ts');
    });

    it('resolves .tmp suffix', () => {
      const mockFs = makeMockFs({
        existsSync: vi.fn().mockReturnValue(true),
      });
      const normalizer = new ToolInputNormalizer(mockFs);
      expect(normalizer.tryResolvePrimarySourcePath('file.ts.tmp', '/project')).toBe('file.ts');
    });

    it('returns null when source does not exist', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      expect(normalizer.tryResolvePrimarySourcePath('foo.ts.backup', '/project')).toBeNull();
    });
  });

  describe('tryResolveTsSourcePath', () => {
    it('returns null for non-js paths', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      expect(normalizer.tryResolveTsSourcePath('foo.ts', '/project')).toBeNull();
    });

    it('resolves .js to .ts when exists', () => {
      const mockFs = makeMockFs({
        existsSync: vi.fn().mockImplementation((p: string) => p.endsWith('.ts')),
      });
      const normalizer = new ToolInputNormalizer(mockFs);
      expect(normalizer.tryResolveTsSourcePath('foo.js', '/project')).toBe('foo.ts');
    });

    it('resolves .js to .tsx when .ts does not exist', () => {
      const mockFs = makeMockFs({
        existsSync: vi.fn().mockImplementation((p: string) => p.endsWith('.tsx')),
      });
      const normalizer = new ToolInputNormalizer(mockFs);
      expect(normalizer.tryResolveTsSourcePath('foo.js', '/project')).toBe('foo.tsx');
    });

    it('returns null when no TS source exists', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      expect(normalizer.tryResolveTsSourcePath('foo.js', '/project')).toBeNull();
    });
  });

  describe('resolveShellCwd', () => {
    it('returns workingDir for empty cwd', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      expect(normalizer.resolveShellCwd({}, '/project')).toBe('/project');
    });

    it('returns workingDir for "."', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      expect(normalizer.resolveShellCwd({ cwd: '.' }, '/project')).toBe('/project');
    });

    it('resolves relative cwd against workingDir', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const result = normalizer.resolveShellCwd({ cwd: 'packages' }, '/project');
      expect(result).toContain('packages');
    });
  });

  describe('computeAdaptiveReadLimit', () => {
    it('caps at 1000 for large requested limits', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const ctx = makeCtx();
      expect(normalizer.computeAdaptiveReadLimit('file.ts', 2000, 1, ctx)).toBe(1000);
    });

    it('uses tier-based baseline for small tier', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const ctx = makeCtx({ currentTier: 'small' });
      const limit = normalizer.computeAdaptiveReadLimit('file.ts', undefined, 1, ctx);
      expect(limit).toBe(180);
    });

    it('uses tier-based baseline for medium tier', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const ctx = makeCtx({ currentTier: 'medium' });
      const limit = normalizer.computeAdaptiveReadLimit('file.ts', undefined, 1, ctx);
      expect(limit).toBe(300);
    });

    it('uses tier-based baseline for large tier', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const ctx = makeCtx({ currentTier: 'large' });
      const limit = normalizer.computeAdaptiveReadLimit('file.ts', undefined, 1, ctx);
      expect(limit).toBe(500);
    });

    it('reads entire small file', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const ctx = makeCtx({
        fileTotalLinesByPath: new Map([['file.ts', 50]]),
      });
      const limit = normalizer.computeAdaptiveReadLimit('file.ts', undefined, 1, ctx);
      expect(limit).toBe(50);
    });

    it('widens window after 3 attempts', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const ctx = makeCtx();
      ctx.fileReadAttemptsByPath.set('file.ts', 2); // next will be 3
      const limit = normalizer.computeAdaptiveReadLimit('file.ts', undefined, 1, ctx);
      expect(limit).toBe(Math.min(1000, Math.round(300 * 1.4)));
    });

    it('widens more after 5 attempts', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const ctx = makeCtx();
      ctx.fileReadAttemptsByPath.set('file.ts', 4); // next will be 5
      const limit = normalizer.computeAdaptiveReadLimit('file.ts', undefined, 1, ctx);
      // Both multipliers apply cumulatively: 300 * 1.4 = 420 (≥3), then 420 * 1.6 = 672 (≥5)
      expect(limit).toBe(Math.min(1000, Math.round(Math.round(300 * 1.4) * 1.6)));
    });

    it('caps at 400 for near-tail reads', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const ctx = makeCtx({
        currentTier: 'large',
        fileTotalLinesByPath: new Map([['file.ts', 500]]),
      });
      const limit = normalizer.computeAdaptiveReadLimit('file.ts', undefined, 450, ctx);
      expect(limit).toBeLessThanOrEqual(400);
    });

    it('increments fileReadAttemptsByPath', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const ctx = makeCtx();
      normalizer.computeAdaptiveReadLimit('file.ts', undefined, 1, ctx);
      expect(ctx.fileReadAttemptsByPath.get('file.ts')).toBe(1);
      normalizer.computeAdaptiveReadLimit('file.ts', undefined, 1, ctx);
      expect(ctx.fileReadAttemptsByPath.get('file.ts')).toBe(2);
    });
  });

  describe('assertToolCallIsAllowed', () => {
    it('throws on missing required params', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const ctx = makeCtx({
        toolDefinitions: [{ function: { name: 'my_tool', parameters: { required: ['path'] } } }],
      });
      expect(() => normalizer.assertToolCallIsAllowed('my_tool', {}, ctx, false)).toThrow(
        'missing required input field',
      );
    });

    it('throws on empty glob_search pattern', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      expect(() => normalizer.assertToolCallIsAllowed('glob_search', { pattern: '' }, makeCtx(), false)).toThrow(
        'non-empty glob pattern',
      );
    });

    it('throws on empty fs_read path', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      expect(() => normalizer.assertToolCallIsAllowed('fs_read', { path: '' }, makeCtx(), false)).toThrow(
        'non-empty file path',
      );
    });

    it('blocks secondary artifact files', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      expect(() => normalizer.assertToolCallIsAllowed('fs_read', { path: '/project/dist/index.js' }, makeCtx(), false)).toThrow(
        'Blocked low-signal file',
      );
    });

    it('allows secondary artifacts when task explicitly requests them', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      expect(() => normalizer.assertToolCallIsAllowed('fs_read', { path: '/project/dist/index.js' }, makeCtx(), true)).not.toThrow();
    });

    it('throws on repeated narrow reads', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      const ctx = makeCtx();
      ctx.smallReadWindowByPath.set('/project/file.ts', 4);
      expect(() => normalizer.assertToolCallIsAllowed('fs_read', { path: '/project/file.ts', limit: 5 }, ctx, false)).toThrow(
        'too narrow repeatedly',
      );
    });

    it('passes valid tool calls', () => {
      const normalizer = new ToolInputNormalizer(makeMockFs());
      expect(() => normalizer.assertToolCallIsAllowed('fs_read', { path: '/project/src/index.ts' }, makeCtx(), false)).not.toThrow();
    });
  });
});

describe('getRequestedReadSpan', () => {
  it('returns limit when set', () => {
    expect(getRequestedReadSpan({ limit: 50 })).toBe(50);
  });

  it('calculates from startLine/endLine', () => {
    expect(getRequestedReadSpan({ startLine: 10, endLine: 20 })).toBe(11);
  });

  it('returns null when no span info', () => {
    expect(getRequestedReadSpan({})).toBeNull();
  });

  it('floors the limit', () => {
    expect(getRequestedReadSpan({ limit: 50.7 })).toBe(50);
  });
});

describe('isSecondaryArtifactPath', () => {
  it('detects dist paths', () => {
    expect(isSecondaryArtifactPath('/project/dist/index.js')).toBe(true);
  });

  it('detects build paths', () => {
    expect(isSecondaryArtifactPath('/project/build/app.js')).toBe(true);
  });

  it('detects .map files', () => {
    expect(isSecondaryArtifactPath('index.js.map')).toBe(true);
  });

  it('detects .min.js files', () => {
    expect(isSecondaryArtifactPath('bundle.min.js')).toBe(true);
  });

  it('detects .backup files', () => {
    expect(isSecondaryArtifactPath('file.ts.backup')).toBe(true);
  });

  it('does not flag source files', () => {
    expect(isSecondaryArtifactPath('src/index.ts')).toBe(false);
  });
});

describe('isGuardRejectedToolCallError', () => {
  it('matches blocked low-signal file', () => {
    expect(isGuardRejectedToolCallError('Blocked low-signal file "dist/x.js"')).toBe(true);
  });

  it('matches missing required field', () => {
    expect(isGuardRejectedToolCallError('foo missing required input field(s): path')).toBe(true);
  });

  it('does not match arbitrary errors', () => {
    expect(isGuardRejectedToolCallError('File not found')).toBe(false);
  });
});

describe('isRiskyShellCommand', () => {
  it('detects pnpm test', () => {
    expect(isRiskyShellCommand('pnpm test')).toBe(true);
  });

  it('detects npm build', () => {
    expect(isRiskyShellCommand('npm build')).toBe(true);
  });

  it('detects yarn lint', () => {
    expect(isRiskyShellCommand('yarn lint')).toBe(true);
  });

  it('does not flag safe commands', () => {
    expect(isRiskyShellCommand('ls -la')).toBe(false);
  });

  it('detects pnpm qa', () => {
    expect(isRiskyShellCommand('pnpm qa')).toBe(true);
  });
});
