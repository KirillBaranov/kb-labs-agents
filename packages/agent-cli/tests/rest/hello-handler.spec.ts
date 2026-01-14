import { describe, expect, it, vi } from 'vitest';
import { handleHello } from '../../src/rest/handlers/hello-handler';

describe('handleHello', () => {
  it('returns a greeting payload', async () => {
    const log = vi.fn();

    const response = await handleHello({ name: 'API' }, { runtime: { log } });

    expect(response).toEqual({ message: 'Hello, API!', target: 'API' });
    expect(log).toHaveBeenCalledWith('info', 'Hello REST endpoint executed', {
      requestId: undefined,
      target: 'API',
      produces: ['template.hello.greeting']
    });
  });

  it('falls back to default target when none is provided', async () => {
    const response = await handleHello({}, {});

    expect(response).toEqual({ message: 'Hello, World!', target: 'World' });
  });
});


