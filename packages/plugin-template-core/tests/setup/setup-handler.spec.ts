import { describe, it, expect, vi } from 'vitest';
import { run as setupHandler } from '../../src/setup/handler';

describe('template setup handler', () => {
  it('builds declarative operations and writes README imperatively', async () => {
    const mkdir = vi.fn(async () => undefined);
    const writeFile = vi.fn(async () => undefined);
    const ensureSection = vi.fn(async () => undefined);

    const result = await setupHandler(
      {},
      {
        runtime: {
          fs: {
            mkdir,
            writeFile,
          },
          config: {
            ensureSection,
          },
        },
      },
    );

    expect(result.operations).toBeDefined();
    const fileOperation = result.operations?.find(
      (op: any) => op.operation.kind === 'file' && op.operation.path === '.kb/template/hello-config.json',
    );
    expect(fileOperation).toBeTruthy();

    expect(writeFile).toHaveBeenCalledWith(
      '.kb/template/README.md',
      expect.stringContaining('Template plugin workspace files'),
    );
    expect(ensureSection).toHaveBeenCalled();

    expect(result.configDefaults).toMatchObject({
      enabled: true,
      greeting: {
        configPath: '.kb/template/hello-config.json',
      },
    });
    expect(result.suggestions?.gitignore).toContain('.kb/template/output/');
  });
});
