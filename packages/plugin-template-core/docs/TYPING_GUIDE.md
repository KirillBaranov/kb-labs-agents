# Command Typing Guide

This guide explains different levels of typing for CLI commands using `@kb-labs/cli-command-kit`.

## Overview

There are three levels of typing you can use when defining commands:

1. **Level 1: No Typing** - Minimal approach, fastest to write
2. **Level 2: Partial Typing** - Flags only, good balance
3. **Level 3: Full Typing** - Flags + Result, maximum type safety (recommended)

## Level 1: No Typing

**Best for:** Quick prototyping, simple commands

```typescript
import { defineCommand } from '@kb-labs/cli-command-kit';

export const run = defineCommand({
  name: 'my-plugin:hello',
  flags: {
    name: {
      type: 'string',
      description: 'Name to greet.',
      alias: 'n',
    },
    json: {
      type: 'boolean',
      description: 'Emit JSON payload.',
      default: false,
    },
  },
  async handler(ctx, argv, flags) {
    // flags is Record<string, unknown>
    // No autocomplete, need type assertions
    const name = flags.name as string | undefined;
    const json = flags.json as boolean | undefined;
    
    // ... your logic
    
    return { ok: true };
  },
});
```

**Pros:**
- Fastest to write
- No type definitions needed

**Cons:**
- No type safety
- No autocomplete for flags
- Need manual type assertions

## Level 2: Partial Typing (Flags Only)

**Best for:** Small to medium commands, good balance

```typescript
import { defineCommand } from '@kb-labs/cli-command-kit';

type MyPluginHelloFlags = {
  name: { type: 'string'; description?: string; alias?: string };
  json: { type: 'boolean'; description?: string; default?: boolean };
};

export const run = defineCommand<MyPluginHelloFlags>({
  name: 'my-plugin:hello',
  flags: {
    name: {
      type: 'string',
      description: 'Name to greet.',
      alias: 'n',
    },
    json: {
      type: 'boolean',
      description: 'Emit JSON payload.',
      default: false,
    },
  },
  async handler(ctx, argv, flags) {
    // flags.name and flags.json are properly typed!
    // TypeScript autocomplete works
    ctx.logger?.info('Hello', { name: flags.name });
    
    // ... your logic
    
    return { ok: true };
  },
});
```

**Pros:**
- Flags are typed
- Autocomplete works for flags
- Less boilerplate than full typing

**Cons:**
- Result type not enforced
- Can return anything from handler

## Level 3: Full Typing (Flags + Result)

**Best for:** Production commands, complex logic, team projects

```typescript
import { defineCommand, type CommandResult } from '@kb-labs/cli-command-kit';

type MyPluginHelloFlags = {
  name: { type: 'string'; description?: string; alias?: string };
  json: { type: 'boolean'; description?: string; default?: boolean };
};

type MyPluginHelloResult = CommandResult & {
  result?: {
    message: string;
    target: string;
  };
};

export const run = defineCommand<MyPluginHelloFlags, MyPluginHelloResult>({
  name: 'my-plugin:hello',
  flags: {
    name: {
      type: 'string',
      description: 'Name to greet.',
      alias: 'n',
    },
    json: {
      type: 'boolean',
      description: 'Emit JSON payload.',
      default: false,
    },
  },
  async handler(ctx, argv, flags) {
    // Full type safety:
    // - flags.name is string | undefined (autocomplete!)
    // - flags.json is boolean (autocomplete!)
    // - Return type must match MyPluginHelloResult
    
    ctx.logger?.info('Hello', { name: flags.name });
    
    const result = {
      message: \`Hello, \${flags.name ?? 'World'}!\`,
      target: flags.name ?? 'World',
    };
    
    // TypeScript ensures this matches MyPluginHelloResult
    return { ok: true, result };
  },
});
```

**Pros:**
- Maximum type safety
- Flags AND result types enforced
- Full autocomplete support
- Catches errors at compile time

**Cons:**
- More boilerplate
- Need to define result types

## Flag Type Definition

When defining flag types, use this structure:

```typescript
type MyFlags = {
  // String flag
  name: { 
    type: 'string'; 
    description?: string; 
    alias?: string; 
    required?: true;
    default?: string;
    choices?: readonly string[];
  };
  
  // Boolean flag
  json: { 
    type: 'boolean'; 
    description?: string; 
    default?: boolean;
  };
  
  // Number flag
  limit: { 
    type: 'number'; 
    description?: string; 
    default?: number;
  };
};
```

## Result Type Definition

Always extend `CommandResult`:

```typescript
import type { CommandResult } from '@kb-labs/cli-command-kit';

type MyResult = CommandResult & {
  // Add your custom result fields
  data?: SomeDataType;
  count?: number;
  message?: string;
};
```

## Migration Path

1. Start with **Level 1** for prototyping
2. Move to **Level 2** when flags become complex
3. Use **Level 3** for production code

## Examples

See `src/cli/commands/hello/run.ts` for all three levels implemented side-by-side.

