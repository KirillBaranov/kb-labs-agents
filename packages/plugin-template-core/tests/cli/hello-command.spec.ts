import { describe, expect, it, vi } from 'vitest';
import { runHelloCommand } from '../../src/cli/commands/hello/run';

describe('runHelloCommand', () => {
  it('prints a greeting to stdout by default', async () => {
    const write = vi.fn();

    const result = await runHelloCommand({ name: 'Developer' }, { stdout: { write } as any });

    expect(result).toEqual({ message: 'Hello, Developer!', target: 'Developer' });
    expect(write).toHaveBeenCalledWith('Hello, Developer!\n');
  });

  it('supports JSON output', async () => {
    const write = vi.fn();

    const result = await runHelloCommand({ json: true }, { stdout: { write } as any });

    expect(result).toEqual({ message: 'Hello, World!', target: 'World' });
    expect(write).toHaveBeenCalledWith('{"message":"Hello, World!","target":"World"}\n');
  });
});


