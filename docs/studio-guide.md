# Studio Guide

Studio widgets present plugin data inside the KB Labs UI. This document explains how to add widgets, menus, and layouts.

## Directory layout

```
packages/plugin-template-core/src/studio/
├── widgets/
│   ├── hello-widget.tsx    # Widget component
│   └── index.ts            # Barrel export
└── index.ts                # Studio surface export
```

- **widgets/** – React components that render data from REST endpoints
- **index.ts** – Re-exports for consumers

## Adding a widget

### 1. Create widget component

Create `src/studio/widgets/your-widget.tsx`:

```tsx
import React from 'react';

export interface YourWidgetProps {
  data?: {
    title: string;
    items: Array<{ id: string; name: string }>;
  };
  loading?: boolean;
  error?: Error;
}

export function YourWidget({ data, loading, error }: YourWidgetProps) {
  // Handle loading state
  if (loading) {
    return (
      <div className="widget-loading">
        <span>Loading...</span>
      </div>
    );
  }

  // Handle error state
  if (error) {
    return (
      <div className="widget-error">
        <h3>Error</h3>
        <p>{error.message}</p>
      </div>
    );
  }

  // Handle empty state
  if (!data || data.items.length === 0) {
    return (
      <div className="widget-empty">
        <p>No data available</p>
      </div>
    );
  }

  // Render data
  return (
    <div className="widget-container">
      <h2>{data.title}</h2>
      <ul>
        {data.items.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </div>
  );
}
```

### 2. Export widget

Add to `src/studio/widgets/index.ts`:

```typescript
export * from './your-widget.js';
```

### 3. Register in manifest

Update `src/manifest.v2.ts`:

```typescript
studio: {
  widgets: [
    // ... existing widgets
    {
      id: 'template.your-widget',
      kind: 'card',
      title: 'Your Widget',
      description: 'Displays your data',
      data: {
        source: {
          type: 'rest',
          routeId: '/your-endpoint',
          method: 'POST',
          body: { filter: 'active' } // Optional request body
        },
        schema: {
          zod: './rest/schemas/your-schema.js#YourResponseSchema'
        }
      },
      layoutHint: {
        w: 3,  // Width in grid columns
        h: 2,  // Height in grid rows
        minW: 2,
        minH: 2
      }
    }
  ]
}
```

### 4. Add to build config

Ensure `tsup.config.ts` includes widget files (usually auto-included).

### 5. Write tests

Create `tests/studio/your-widget.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { YourWidget } from '../../src/studio/widgets/your-widget.js';

describe('YourWidget', () => {
  it('should render data', () => {
    const data = {
      title: 'Test Widget',
      items: [
        { id: '1', name: 'Item 1' },
        { id: '2', name: 'Item 2' }
      ]
    };

    render(<YourWidget data={data} />);

    expect(screen.getByText('Test Widget')).toBeInTheDocument();
    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Item 2')).toBeInTheDocument();
  });

  it('should show loading state', () => {
    render(<YourWidget loading />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('should show error state', () => {
    const error = new Error('Failed to load');
    render(<YourWidget error={error} />);

    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Failed to load')).toBeInTheDocument();
  });

  it('should show empty state', () => {
    render(<YourWidget data={{ title: 'Empty', items: [] }} />);
    expect(screen.getByText('No data available')).toBeInTheDocument();
  });
});
```

## Data sources

Widgets can get data from multiple sources:

### REST API source

```typescript
{
  id: 'template.rest-widget',
  data: {
    source: {
      type: 'rest',
      routeId: '/metrics',
      method: 'GET',
      params: {
        period: '7d'
      }
    },
    schema: {
      zod: './rest/schemas/metrics-schema.js#MetricsResponseSchema'
    }
  }
}
```

### Static data source

```typescript
{
  id: 'template.static-widget',
  data: {
    source: {
      type: 'static',
      value: {
        message: 'Hello from static data',
        timestamp: new Date().toISOString()
      }
    }
  }
}
```

### CLI command source

```typescript
{
  id: 'template.cli-widget',
  data: {
    source: {
      type: 'cli',
      commandId: 'template:hello',
      args: ['--json']
    }
  }
}
```

## Widget patterns

### Metric card

```tsx
export interface MetricCardProps {
  data?: {
    label: string;
    value: number;
    trend?: number;
  };
  loading?: boolean;
  error?: Error;
}

export function MetricCard({ data, loading, error }: MetricCardProps) {
  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!data) return <div>No data</div>;

  return (
    <div className="metric-card">
      <div className="metric-label">{data.label}</div>
      <div className="metric-value">{data.value}</div>
      {data.trend && (
        <div className={`metric-trend ${data.trend > 0 ? 'up' : 'down'}`}>
          {data.trend > 0 ? '↑' : '↓'} {Math.abs(data.trend)}%
        </div>
      )}
    </div>
  );
}
```

### Data table

```tsx
export interface DataTableProps {
  data?: {
    columns: Array<{ key: string; label: string }>;
    rows: Array<Record<string, unknown>>;
  };
  loading?: boolean;
  error?: Error;
}

export function DataTable({ data, loading, error }: DataTableProps) {
  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!data || data.rows.length === 0) return <div>No data</div>;

  return (
    <table className="data-table">
      <thead>
        <tr>
          {data.columns.map((col) => (
            <th key={col.key}>{col.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((row, i) => (
          <tr key={i}>
            {data.columns.map((col) => (
              <td key={col.key}>{String(row[col.key])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

### Interactive widget with state

```tsx
import { useState } from 'react';

export function FilterWidget({ data }: FilterWidgetProps) {
  const [filter, setFilter] = useState('all');

  if (!data) return <div>No data</div>;

  const filteredItems = data.items.filter((item) => {
    if (filter === 'all') return true;
    return item.status === filter;
  });

  return (
    <div>
      <select value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="all">All</option>
        <option value="active">Active</option>
        <option value="done">Done</option>
      </select>

      <ul>
        {filteredItems.map((item) => (
          <li key={item.id}>
            {item.name} <span>({item.status})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### Widget with actions

```tsx
export function ActionsWidget({ data }: ActionsWidgetProps) {
  const handleAction = async (actionId: string) => {
    try {
      const response = await fetch(`/api/actions/${actionId}`, {
        method: 'POST'
      });
      const result = await response.json();
      console.log('Action completed:', result);
    } catch (error) {
      console.error('Action failed:', error);
    }
  };

  return (
    <div className="actions">
      <h3>Quick Actions</h3>
      <button onClick={() => handleAction('sync')}>
        Sync Data
      </button>
      <button onClick={() => handleAction('refresh')}>
        Refresh
      </button>
    </div>
  );
}
```

## Layout hints

Control widget size and position in the grid:

```typescript
{
  layoutHint: {
    w: 4,       // Width: 4 columns (out of 6 on large screens)
    h: 3,       // Height: 3 rows
    minW: 2,    // Minimum width
    minH: 2,    // Minimum height
    maxW: 6,    // Maximum width
    maxH: 4     // Maximum height
  }
}
```

Grid configuration (in manifest):

```typescript
studio: {
  layouts: [
    {
      id: 'template.dashboard',
      kind: 'grid',
      title: 'Dashboard',
      config: {
        cols: {
          sm: 2,   // 2 columns on small screens
          md: 4,   // 4 columns on medium screens
          lg: 6    // 6 columns on large screens
        },
        rowHeight: 60  // Pixels per row unit
      },
      widgets: [
        'template.hello-widget',
        'template.metrics-widget'
      ]
    }
  ]
}
```

## Styling

Use semantic classnames that align with KB Labs design system:

```tsx
<div className="widget-container">
  <div className="widget-header">
    <h2 className="widget-title">Title</h2>
  </div>
  <div className="widget-content">
    {content}
  </div>
  <div className="widget-footer">
    <button className="btn-primary">Action</button>
  </div>
</div>
```

## Best practices

### ✅ DO

- **Keep widgets presentational** - no business logic
- **Handle all states** - loading, error, empty, success
- **Use TypeScript** - type your props
- **Follow React best practices** - hooks, composition
- **Write tests** - test rendering and interactions
- **Use semantic classnames** - align with KB Labs design
- **Fetch via data sources** - don't make direct API calls

### ❌ DON'T

- Don't put business logic in widgets (use `core/`)
- Don't make direct API calls (use data sources in manifest)
- Don't access filesystem or process
- Don't use global state without proper context
- Don't ignore loading/error/empty states
- Don't use inline styles excessively

## Related documentation

- [studio/README.md](../packages/plugin-template-core/src/studio/README.md) - Detailed Studio patterns
- [React Documentation](https://react.dev) - React best practices
- [React Testing Library](https://testing-library.com/react) - Testing guide

## Examples

See the hello widget implementation:

- [studio/widgets/hello-widget.tsx](../packages/plugin-template-core/src/studio/widgets/hello-widget.tsx) - Full widget example
