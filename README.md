# KB Labs Plugin Template

> **Gold standard reference template** for building production-ready KB Labs plugins with CLI, REST, and Studio surfaces.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9+-orange.svg)](https://pnpm.io/)
[![Documentation](https://img.shields.io/badge/docs-7.7k_lines-blue.svg)](./docs)

**What makes this template special:**
- ✅ **7,700+ lines** of comprehensive documentation
- ✅ **100% canonical patterns** (no legacy code)
- ✅ **Production-ready examples** (validation, testing, contracts, multi-tenancy)
- ✅ **Complete error handling** with 8 custom error classes
- ✅ **KB Labs standard structure** (cli, rest, studio, lifecycle, core, utils)

## 🚀 Quick start

```bash
# Clone and install
git clone https://github.com/kb-labs/kb-labs-plugin-template.git
cd kb-labs-plugin-template
pnpm install

# Build the plugin
pnpm --filter @kb-labs/plugin-template-core run build

# Run hello command
kb template:hello --name Developer
# Output: Hello, Developer!
```

## 🛠️ Using Shared Command Kit Helpers

This template demonstrates **86% boilerplate reduction** using helpers from `@kb-labs/shared-command-kit`. Instead of writing 400+ lines of repetitive code, use declarative helpers.

### Error Handling (`defineError`)

**Before** (400 lines of 8 custom error classes):
```typescript
export class ValidationError extends Error {
  constructor(message: string, public field?: string, public details?: unknown) {
    super(message);
    this.name = 'ValidationError';
  }
}
// ... 7 more classes × 50 lines each = 400 lines
```

**After** (50 lines with `defineError`):
```typescript
import { defineError, commonErrors } from '@kb-labs/shared-command-kit';

// Template-specific errors
export const TemplateError = defineError('TEMPLATE', {
  BusinessRuleViolation: {
    code: 400,
    message: (rule: string) => `Business rule violated: ${rule}`,
  },
  QuotaExceeded: {
    code: 429,
    message: (resource: string) => `Quota exceeded for ${resource}`,
  },
});

// Common errors (validation, not found, etc.)
export const CommonError = defineError('COMMON', commonErrors);

// Usage:
throw new TemplateError.BusinessRuleViolation('Insufficient funds');
throw new CommonError.ValidationFailed('Email must be valid');
```

**Savings**: 400 lines → 50 lines (87% reduction)

### Permission Presets (`permissions.combine`)

**Before** (25 lines of manual permission blocks):
```typescript
permissions: {
  fs: {
    mode: 'readWrite',
    allow: ['.kb/template/**', 'package.json'],
    deny: ['**/*.key', '**/*.secret', '**/node_modules/**'],
  },
  net: { allowHosts: ['localhost:*'] },
  env: { allow: ['NODE_ENV', 'KB_LABS_*', 'TEMPLATE_*'] },
  quotas: { timeoutMs: 60000, memoryMb: 512 },
}
```

**After** (10 lines with presets):
```typescript
import { permissions } from '@kb-labs/shared-command-kit';

permissions: permissions.combine(
  permissions.presets.pluginWorkspace('template'),
  permissions.presets.localhost(),
  {
    env: { allow: ['TEMPLATE_*'] }, // Template-specific env vars
  }
)
```

**Savings**: 25 lines → 10 lines (60% reduction)

### Schema Builders (`schema.*`)

**Before** (manual Zod schemas):
```typescript
import { z } from 'zod';

export const HelloRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  cwd: z.string().optional(),
});
```

**After** (schema builders for clarity):
```typescript
import { z } from 'zod';
import { schema } from '@kb-labs/shared-command-kit';

export const HelloRequestSchema = z.object({
  name: schema.text({ min: 1, max: 100 }).optional(),
  cwd: schema.cwd(),
});
```

**Benefits**: Clearer intent, reusable validation patterns

### Analytics Tracking (`withAnalytics`)

**Before** (manual event tracking):
```typescript
async handler(ctx, argv, flags) {
  ctx.logger?.info('Command started', { name: flags.name });

  const greeting = createGreeting(flags.name);

  ctx.logger?.info('Command completed', { message: greeting.message });
  return { ok: true, result: greeting };
}
```

**After** (automatic started/completed/failed events):
```typescript
import { withAnalytics } from '@kb-labs/shared-command-kit';

async handler(ctx, argv, flags) {
  return await withAnalytics(
    ctx,
    'template.hello',
    {
      started: { name: flags.name },
      completed: (result) => ({ message: result.result?.message }),
      failed: (error) => ({ error: error.message }),
    },
    async () => {
      const greeting = createGreeting(flags.name);
      return { ok: true, result: greeting };
    }
  );
}
```

**Benefits**: Automatic event emission with duration tracking, consistent analytics

### Available Helpers

| Helper | Purpose | Savings |
|--------|---------|---------|
| `defineError()` | Error factory | 87% (400→50 lines) |
| `permissions.combine()` | Permission presets | 60% (25→10 lines) |
| `schema.*` | Validation builders | Clarity + reuse |
| `defineSetupHandler()` | Declarative lifecycle | 84% (126→20 lines) |
| `withAnalytics()` | Auto analytics | +10 lines (feature) |

**See also:**
- [Migration Guide](./docs/MIGRATION-helpers.md) - Migrate existing plugins
- [shared-command-kit README](../kb-labs-shared/packages/shared-command-kit/README.md) - Full API reference
- [utils/errors.ts](./packages/plugin-template-core/src/utils/errors.ts) - defineError example

## 📖 Documentation (7,700+ lines!)

### Getting started
- 📘 [Getting Started](./docs/getting-started.md) - Setup, build, and first steps
- 🏗️ [Architecture](./docs/architecture.md) - KB Labs folder structure and patterns
- 📦 [Naming Convention](./docs/naming-convention.md) - The Pyramid Rule (mandatory!)
- 🔄 [Refactoring Guide](./docs/REFACTORING.md) - Migration from old DDD structure

### Surface guides
- 🖥️ [CLI Guide](./docs/cli-guide.md) - Adding CLI commands with `defineCommand`
- 🌐 [REST Guide](./docs/rest-guide.md) - Adding REST handlers with Zod validation
- 🎨 [Studio Guide](./docs/studio-guide.md) - Creating React widgets for KB Labs UI

### Comprehensive examples (2,500+ lines)
- ✅ [Validation Examples](./docs/examples/validation-examples.md) - Zod schemas, custom validation, type inference
- 🧪 [Test Examples](./docs/examples/test-examples.md) - CLI, REST, widget, and integration testing
- 🔐 [Contracts Examples](./docs/examples/contracts-examples.md) - Type-safe IDs and hierarchical contracts
- 🏢 [Multi-Tenancy Examples](./docs/examples/multi-tenancy-examples.md) - SaaS patterns, rate limiting, quotas

### Folder-specific READMEs (2,000+ lines)
- [cli/README.md](./packages/plugin-template-core/src/cli/README.md) - CLI patterns and best practices (324 lines)
- [rest/README.md](./packages/plugin-template-core/src/rest/README.md) - REST handlers with Zod (358 lines)
- [studio/README.md](./packages/plugin-template-core/src/studio/README.md) - React widgets and layouts (443 lines)
- [lifecycle/README.md](./packages/plugin-template-core/src/lifecycle/README.md) - Setup, destroy, upgrade hooks (333 lines)
- [core/README.md](./packages/plugin-template-core/src/core/README.md) - Pure business logic (240 lines)
- [utils/README.md](./packages/plugin-template-core/src/utils/README.md) - Utilities and error handling (348 lines)

## 🎯 What you get

### KB Labs standard structure

```
packages/plugin-template-core/src/
├── cli/              # CLI commands (defineCommand pattern)
│   ├── commands/     # Command implementations
│   ├── utils.ts      # getCommandId helper
│   └── README.md     # 324 lines of CLI patterns
├── rest/             # REST API handlers
│   ├── handlers/     # definePluginHandler implementations
│   ├── schemas/      # Zod request/response schemas
│   └── README.md     # 358 lines of REST patterns
├── studio/           # Studio React components
│   ├── widgets/      # Widget implementations
│   └── README.md     # 443 lines of widget patterns
├── lifecycle/        # Plugin lifecycle hooks
│   ├── setup.ts      # Installation handler
│   └── README.md     # 333 lines of lifecycle patterns
├── core/             # Pure business logic
│   ├── greeting.ts   # Domain entities
│   └── README.md     # 240 lines of core patterns
└── utils/            # Shared utilities
    ├── errors.ts     # defineError pattern (219 lines)
    ├── constants.ts  # Shared constants
    └── README.md     # 348 lines of utility patterns
```

### Streamlined error handling with `defineError`

```typescript
import {
  TemplateError,         // Template-specific errors
  CommonError,           // Common errors (validation, not found, etc.)
  formatErrorForLogging, // For ctx.logger
  formatErrorForUser     // For user-facing messages
} from './utils/errors.js';

// Template-specific errors
throw new TemplateError.BusinessRuleViolation('Insufficient funds');
throw new TemplateError.QuotaExceeded('api_requests');

// Common errors
throw new CommonError.ValidationFailed('Email must be valid');
throw new CommonError.NotFound('User not found');
```

### Production-ready examples

**Validation with Zod:**
```typescript
const UserSchema = z.object({
  email: z.string().email('Invalid email'),
  age: z.number().int().min(18, 'Must be 18+')
});

export const handleCreateUser = definePluginHandler({
  schema: { input: UserSchema, output: UserResponseSchema },
  async handle(input, ctx) {
    // Input is already validated!
    const user = await createUser(input);
    return { userId: user.id };
  }
});
```

**Type-safe contracts:**
```typescript
export const CommandIds = {
  HELLO: 'template:hello',
  CREATE: 'template:create'
} as const;

// Use everywhere - autocomplete + type safety
export const run = defineCommand({
  name: CommandIds.HELLO,  // ✅ No typos!
  //...
});
```

**Multi-tenancy:**
```typescript
import { TenantRateLimiter } from '@kb-labs/tenant';

const limiter = new TenantRateLimiter(broker);

const result = await limiter.checkLimit(tenantId, 'api');
if (!result.allowed) {
  throw new QuotaExceededError('api', result.limit!, result.current!);
}
```

## 🧱 Architecture highlights

### Canonical patterns (100% compliant)

**CLI commands:**
```typescript
export const run = defineCommand({
  name: getCommandId('template:hello'),
  flags: {
    name: { type: 'string', default: 'World' }
  },
  async handler(ctx, argv, flags) {
    ctx.logger?.info('Command started', { name: flags.name });
    ctx.ui?.write(`Hello, ${flags.name}!\n`);
    return { ok: true, message: `Hello, ${flags.name}!`, target: flags.name };
  }
});
```

**REST handlers:**
```typescript
export const handleHello = definePluginHandler({
  schema: {
    input: HelloRequestSchema,
    output: HelloResponseSchema
  },
  async handle(input, ctx) {
    ctx.logger?.info('REST handler started', { name: input.name });
    const greeting = createGreeting(input.name);
    return { message: greeting.message, target: greeting.target };
  }
});
```

**Studio widgets:**
```typescript
export function HelloWidget({ data, loading, error }: HelloWidgetProps) {
  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!data) return <div>No data</div>;

  return (
    <div className="widget-container">
      <h2>Hello from Plugin Template</h2>
      <p>{data.message}</p>
    </div>
  );
}
```

### No legacy code!

- ❌ No `createConsoleLogger` (deprecated)
- ❌ No DDD layers (domain/application/infrastructure)
- ❌ No path aliases (@app/*, @domain/*)
- ✅ 100% `ctx.logger` everywhere
- ✅ Pure functions in `core/`
- ✅ KB Labs standard folders

## 📦 Repository layout

```
kb-labs-plugin-template/
├── packages/
│   ├── plugin-template-core/    # Main plugin package
│   │   ├── src/
│   │   │   ├── cli/            # CLI commands (324 line README)
│   │   │   ├── rest/           # REST handlers (358 line README)
│   │   │   ├── studio/         # React widgets (443 line README)
│   │   │   ├── lifecycle/      # Plugin lifecycle (333 line README)
│   │   │   ├── core/           # Business logic (240 line README)
│   │   │   └── utils/          # Utilities + errors (348 line README)
│   │   ├── tests/              # Vitest tests
│   │   └── package.json        # @kb-labs/plugin-template-core
│   └── contracts/              # Type-safe contracts
├── docs/
│   ├── getting-started.md      # Setup guide
│   ├── architecture.md         # KB Labs structure
│   ├── cli-guide.md            # CLI patterns (1,395 lines of guides)
│   ├── rest-guide.md
│   ├── studio-guide.md
│   ├── examples/               # 2,500+ lines of examples
│   │   ├── validation-examples.md
│   │   ├── test-examples.md
│   │   ├── contracts-examples.md
│   │   └── multi-tenancy-examples.md
│   └── adr/
│       └── 0009-flatten-plugin-structure.md
└── scripts/                    # Sandbox scripts
```

## 🧪 Testing

```bash
# Run all tests
pnpm --filter @kb-labs/plugin-template-core run test

# Run with coverage
pnpm test -- --coverage

# Watch mode
pnpm run test:watch
```

**Test examples included:**
- ✅ CLI command tests (mocking context, validation)
- ✅ REST handler tests (Zod validation, dependencies)
- ✅ Widget tests (React Testing Library, states)
- ✅ Core logic tests (pure functions, edge cases)
- ✅ Integration tests (full flows)

See [Test Examples](./docs/examples/test-examples.md) for comprehensive testing patterns.

## 🔧 Scripts

| Script | Description |
|--------|-------------|
| `pnpm build` | Build all packages |
| `pnpm test` | Run test suites |
| `pnpm lint` | Lint codebase |
| `pnpm type-check` | TypeScript validation |
| `pnpm --filter @kb-labs/plugin-template-core build` | Build core package |

## 🎓 Learning path

### New to KB Labs plugins?

1. **Start here:** [Getting Started](./docs/getting-started.md)
2. **Understand structure:** [Architecture](./docs/architecture.md)
3. **Add your first command:** [CLI Guide](./docs/cli-guide.md)
4. **Add validation:** [Validation Examples](./docs/examples/validation-examples.md)
5. **Write tests:** [Test Examples](./docs/examples/test-examples.md)

### Building a SaaS plugin?

1. **Multi-tenancy:** [Multi-Tenancy Examples](./docs/examples/multi-tenancy-examples.md)
2. **Type-safe IDs:** [Contracts Examples](./docs/examples/contracts-examples.md)
3. **REST API:** [REST Guide](./docs/rest-guide.md)
4. **Rate limiting:** See multi-tenancy examples

### Need specific patterns?

- **Validation?** → [Validation Examples](./docs/examples/validation-examples.md)
- **Testing?** → [Test Examples](./docs/examples/test-examples.md)
- **Error handling?** → [utils/errors.ts](./packages/plugin-template-core/src/utils/errors.ts)
- **CLI commands?** → [CLI Guide](./docs/cli-guide.md) + [cli/README.md](./packages/plugin-template-core/src/cli/README.md)
- **REST handlers?** → [REST Guide](./docs/rest-guide.md) + [rest/README.md](./packages/plugin-template-core/src/rest/README.md)
- **React widgets?** → [Studio Guide](./docs/studio-guide.md) + [studio/README.md](./packages/plugin-template-core/src/studio/README.md)

## 🌟 Highlights

### 7,700+ lines of documentation
- 6 comprehensive folder READMEs (2,061 lines)
- 4 production-ready example guides (2,500 lines)
- 4 updated surface guides (1,395 lines)
- Architecture docs (ADR, REFACTORING, architecture.md)

### Streamlined error handling
- `defineError()` pattern (87% reduction vs custom classes)
- Template-specific errors (BusinessRuleViolation, QuotaExceeded, MissingConfig)
- Common errors (ValidationFailed, NotFound, PermissionDenied, etc.)
- Formatting utilities (formatErrorForLogging, formatErrorForUser)
- Assertions (assertNotNull, assertBusinessRule)
- Error wrapping (wrapWithErrorHandling)

### Production patterns
- Zod validation (advanced schemas, custom validation, type inference)
- Testing (CLI, REST, widgets, core, integration)
- Contracts (type-safe IDs, validation helpers)
- Multi-tenancy (rate limiting, quotas, data isolation)

### No legacy code
- 100% ctx.logger (createConsoleLogger deprecated)
- 0 path aliases (simple imports)
- 0 DDD layers (KB Labs standard folders)
- Pure functions in core/ (no side effects)

## 🤝 Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for:
- Coding standards
- KB Labs folder structure rules
- PR checklist
- Testing requirements

## 📄 License

MIT © KB Labs

---

**Last updated:** 2025-11-30
**Template version:** 2.0.0 (Flattened structure)
**Documentation:** 7,735 lines
**Status:** ✅ Production-ready gold standard


## License

MIT License - see [LICENSE](LICENSE) for details.
