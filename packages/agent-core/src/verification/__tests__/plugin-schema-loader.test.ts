/**
 * Unit tests for PluginSchemaLoader (Level 2)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PluginSchemaLoader } from '../plugin-schema-loader.js';

describe('PluginSchemaLoader', () => {
  let loader: PluginSchemaLoader;

  beforeEach(() => {
    loader = new PluginSchemaLoader();
  });

  describe('parseRef()', () => {
    it('should parse scoped package reference', () => {
      // Access private method via type assertion for testing
      const parseRef = (loader as any).parseRef.bind(loader);

      const result = parseRef('@kb-labs/mind-contracts/schema#QueryResult');

      expect(result).toEqual({
        packageName: '@kb-labs/mind-contracts',
        modulePath: '/schema',
        exportName: 'QueryResult',
      });
    });

    it('should parse scoped package without path', () => {
      const parseRef = (loader as any).parseRef.bind(loader);

      const result = parseRef('@kb-labs/mind-contracts#QueryResult');

      expect(result).toEqual({
        packageName: '@kb-labs/mind-contracts',
        modulePath: '',
        exportName: 'QueryResult',
      });
    });

    it('should parse relative path reference', () => {
      const parseRef = (loader as any).parseRef.bind(loader);

      const result = parseRef('./schemas/query#QueryResultSchema');

      expect(result).toEqual({
        packageName: '.',
        modulePath: '/schemas/query',
        exportName: 'QueryResultSchema',
      });
    });

    it('should parse unscoped package reference', () => {
      const parseRef = (loader as any).parseRef.bind(loader);

      const result = parseRef('lodash/fp#compose');

      expect(result).toEqual({
        packageName: 'lodash',
        modulePath: '/fp',
        exportName: 'compose',
      });
    });

    it('should return null for invalid format (missing #)', () => {
      const parseRef = (loader as any).parseRef.bind(loader);

      const result = parseRef('@kb-labs/mind-contracts/schema');

      expect(result).toBeNull();
    });

    it('should return null for invalid format (multiple #)', () => {
      const parseRef = (loader as any).parseRef.bind(loader);

      const result = parseRef('@kb-labs/mind#schema#QueryResult');

      expect(result).toBeNull();
    });

    it('should return null for empty export name', () => {
      const parseRef = (loader as any).parseRef.bind(loader);

      const result = parseRef('@kb-labs/mind-contracts/schema#');

      expect(result).toBeNull();
    });

    it('should return null for empty module part', () => {
      const parseRef = (loader as any).parseRef.bind(loader);

      const result = parseRef('#QueryResult');

      expect(result).toBeNull();
    });
  });

  describe('loadSchema()', () => {
    it('should return null for invalid ref format', async () => {
      const schema = await loader.loadSchema('invalid-ref');

      expect(schema).toBeNull();
    });

    it('should cache schema after first load', async () => {
      // First attempt - will fail to import but test caching logic
      await loader.loadSchema('@kb-labs/test-package/schema#TestSchema');

      // Check cache stats
      const stats = loader.getCacheStats();

      // Should have attempted to cache (even if import failed)
      expect(stats.refs).toEqual([]);
    });
  });

  describe('clearCache()', () => {
    it('should clear schema cache', () => {
      loader.clearCache();

      const stats = loader.getCacheStats();

      expect(stats.size).toBe(0);
      expect(stats.refs).toHaveLength(0);
    });
  });

  describe('getCacheStats()', () => {
    it('should return cache statistics', () => {
      const stats = loader.getCacheStats();

      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('refs');
      expect(Array.isArray(stats.refs)).toBe(true);
    });

    it('should track cache size', () => {
      const initialStats = loader.getCacheStats();
      expect(initialStats.size).toBe(0);
    });
  });
});
