/**
 * Tool Name Sanitizer Tests
 */

import { describe, it, expect } from 'vitest';
import { sanitizeToolName, createToolNameMapping, restoreToolName } from '../tool-name-sanitizer.js';

describe('sanitizeToolName', () => {
  it('should replace colons with underscores', () => {
    expect(sanitizeToolName('fs:read')).toBe('fs_read');
    expect(sanitizeToolName('fs:write')).toBe('fs_write');
    expect(sanitizeToolName('mind:rag-query')).toBe('mind_rag_query');
  });

  it('should handle multiple colons', () => {
    expect(sanitizeToolName('a:b:c')).toBe('a_b_c');
    expect(sanitizeToolName('foo:bar:baz:qux')).toBe('foo_bar_baz_qux');
  });

  it('should handle names without colons', () => {
    expect(sanitizeToolName('simple')).toBe('simple');
    expect(sanitizeToolName('already_sanitized')).toBe('already_sanitized');
  });

  it('should handle empty string', () => {
    expect(sanitizeToolName('')).toBe('');
  });

  it('should replace hyphens and preserve numbers', () => {
    expect(sanitizeToolName('tool:test-123')).toBe('tool_test_123');
  });
});

describe('createToolNameMapping', () => {
  it('should create mapping for single tool', () => {
    const mapping = createToolNameMapping(['fs:read']);
    expect(mapping.get('fs_read')).toBe('fs:read');
  });

  it('should create mapping for multiple tools', () => {
    const mapping = createToolNameMapping(['fs:read', 'fs:write', 'mind:rag-query']);
    expect(mapping.get('fs_read')).toBe('fs:read');
    expect(mapping.get('fs_write')).toBe('fs:write');
    expect(mapping.get('mind_rag_query')).toBe('mind:rag-query');
  });

  it('should handle empty array', () => {
    const mapping = createToolNameMapping([]);
    expect(mapping.size).toBe(0);
  });

  it('should handle tools without colons', () => {
    const mapping = createToolNameMapping(['simple', 'already_ok']);
    expect(mapping.get('simple')).toBe('simple');
    expect(mapping.get('already_ok')).toBe('already_ok');
  });

  it('should handle duplicate sanitized names (last wins)', () => {
    // Edge case: two different original names sanitize to same value
    const mapping = createToolNameMapping(['a:b', 'a_b']);
    // Both sanitize to "a_b", so map should have size 1
    expect(mapping.size).toBe(1);
    expect(mapping.get('a_b')).toBe('a_b'); // Last one wins
  });
});

describe('restoreToolName', () => {
  it('should restore original name from mapping', () => {
    const mapping = createToolNameMapping(['fs:read', 'mind:rag-query']);
    expect(restoreToolName('fs_read', mapping)).toBe('fs:read');
    expect(restoreToolName('mind_rag_query', mapping)).toBe('mind:rag-query');
  });

  it('should return sanitized name if not in mapping (fallback)', () => {
    const mapping = createToolNameMapping(['fs:read']);
    expect(restoreToolName('unknown_tool', mapping)).toBe('unknown_tool');
  });

  it('should handle empty mapping', () => {
    const mapping = new Map<string, string>();
    expect(restoreToolName('fs_read', mapping)).toBe('fs_read');
  });
});

describe('roundtrip (sanitize -> restore)', () => {
  it('should successfully roundtrip tool names', () => {
    const original = ['fs:read', 'fs:write', 'fs:edit', 'mind:rag-query', 'mind:rag-status'];
    const mapping = createToolNameMapping(original);

    // Sanitize all names
    const sanitized = original.map(sanitizeToolName);
    expect(sanitized).toEqual(['fs_read', 'fs_write', 'fs_edit', 'mind_rag_query', 'mind_rag_status']);

    // Restore all names
    const restored = sanitized.map((name) => restoreToolName(name, mapping));
    expect(restored).toEqual(original);
  });

  it('should roundtrip complex names', () => {
    const original = ['a:b:c', 'foo:bar-baz', 'test:123'];
    const mapping = createToolNameMapping(original);

    const sanitized = original.map(sanitizeToolName);
    const restored = sanitized.map((name) => restoreToolName(name, mapping));

    expect(restored).toEqual(original);
  });
});
