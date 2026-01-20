/**
 * Unit tests for SpecialistOutput schema validation (Level 1)
 */

import { describe, it, expect } from 'vitest';
import { validateSpecialistOutput, SpecialistOutputSchema } from '../agent-output-schema.js';

describe('SpecialistOutput Schema Validation', () => {
  describe('validateSpecialistOutput()', () => {
    it('should validate valid minimal output', () => {
      const output = {
        summary: 'Task completed successfully',
        traceRef: 'trace:abc123',
      };

      const result = validateSpecialistOutput(output);

      expect(result.valid).toBe(true);
      expect(result.output).toEqual(output);
      expect(result.errors).toBeUndefined();
    });

    it('should validate output with claims', () => {
      const output = {
        summary: 'Created file',
        traceRef: 'trace:abc123',
        claims: [
          {
            kind: 'file-write',
            filePath: '/tmp/test.txt',
            contentHash: 'abc123',
          },
        ],
      };

      const result = validateSpecialistOutput(output);

      expect(result.valid).toBe(true);
      expect(result.output?.claims).toHaveLength(1);
    });

    it('should validate output with artifacts', () => {
      const output = {
        summary: 'Search completed',
        traceRef: 'trace:abc123',
        artifacts: [
          {
            kind: 'summary',
            label: 'Search results',
            content: 'Found 10 results',
            contentHash: 'abc123def456',
          },
        ],
      };

      const result = validateSpecialistOutput(output);

      expect(result.valid).toBe(true);
      expect(result.output?.artifacts).toHaveLength(1);
    });

    it('should fail when summary is missing', () => {
      const output = {
        traceRef: 'trace:abc123',
      };

      const result = validateSpecialistOutput(output);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors![0].path).toBe('summary');
      expect(result.errors![0].message).toContain('Required');
    });

    it('should fail when traceRef is missing', () => {
      const output = {
        summary: 'Task completed',
      };

      const result = validateSpecialistOutput(output);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors![0].path).toBe('traceRef');
    });

    it('should fail when summary is empty string', () => {
      const output = {
        summary: '',
        traceRef: 'trace:abc123',
      };

      const result = validateSpecialistOutput(output);

      expect(result.valid).toBe(false);
      expect(result.errors![0].path).toBe('summary');
      expect(result.errors![0].message).toContain('Summary is required');
    });

    it('should fail when traceRef does not start with "trace:"', () => {
      const output = {
        summary: 'Task completed',
        traceRef: 'invalid-ref',
      };

      const result = validateSpecialistOutput(output);

      expect(result.valid).toBe(false);
      expect(result.errors![0].path).toBe('traceRef');
      expect(result.errors![0].message).toContain('must start with "trace:"');
    });

    it('should fail when summary is wrong type', () => {
      const output = {
        summary: 123,
        traceRef: 'trace:abc123',
      };

      const result = validateSpecialistOutput(output);

      expect(result.valid).toBe(false);
      expect(result.errors![0].path).toBe('summary');
      expect(result.errors![0].message).toContain('Expected string');
    });

    it('should handle null output gracefully', () => {
      const result = validateSpecialistOutput(null);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('should handle undefined output gracefully', () => {
      const result = validateSpecialistOutput(undefined);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });
  });

  describe('FileWriteClaim validation', () => {
    it('should validate valid file-write claim', () => {
      const output = {
        summary: 'File written',
        traceRef: 'trace:abc123',
        claims: [
          {
            kind: 'file-write',
            filePath: '/tmp/test.txt',
            contentHash: 'abc123',
          },
        ],
      };

      const result = validateSpecialistOutput(output);

      expect(result.valid).toBe(true);
    });

    it('should fail when contentHash is missing in file-write claim', () => {
      const output = {
        summary: 'File written',
        traceRef: 'trace:abc123',
        claims: [
          {
            kind: 'file-write',
            filePath: '/tmp/test.txt',
          },
        ],
      };

      const result = validateSpecialistOutput(output);

      expect(result.valid).toBe(false);
      expect(result.errors![0].path).toContain('contentHash');
    });
  });

  describe('FileEditClaim validation', () => {
    it('should validate valid file-edit claim', () => {
      const output = {
        summary: 'File edited',
        traceRef: 'trace:abc123',
        claims: [
          {
            kind: 'file-edit',
            filePath: '/tmp/test.txt',
            anchor: {
              beforeSnippet: 'line before edit',
              afterSnippet: 'line after edit',
              contentHash: 'abc123def456',
            },
          },
        ],
      };

      const result = validateSpecialistOutput(output);

      expect(result.valid).toBe(true);
    });

    it('should fail when anchor is missing in file-edit claim', () => {
      const output = {
        summary: 'File edited',
        traceRef: 'trace:abc123',
        claims: [
          {
            kind: 'file-edit',
            filePath: '/tmp/test.txt',
          },
        ],
      };

      const result = validateSpecialistOutput(output);

      expect(result.valid).toBe(false);
      expect(result.errors![0].path).toContain('anchor');
    });
  });

  describe('CompactArtifact validation', () => {
    it('should validate artifact with content under 1KB', () => {
      const output = {
        summary: 'Task done',
        traceRef: 'trace:abc123',
        artifacts: [
          {
            kind: 'summary',
            label: 'Search results',
            content: 'a'.repeat(1000), // 1000 bytes
            contentHash: 'abc123def456',
          },
        ],
      };

      const result = validateSpecialistOutput(output);

      expect(result.valid).toBe(true);
    });

    it('should fail when artifact content exceeds 1KB', () => {
      const output = {
        summary: 'Task done',
        traceRef: 'trace:abc123',
        artifacts: [
          {
            kind: 'summary',
            label: 'Search results',
            content: 'a'.repeat(1025), // Over 1KB
            contentHash: 'abc123def456',
          },
        ],
      };

      const result = validateSpecialistOutput(output);

      expect(result.valid).toBe(false);
      expect(result.errors![0].message).toContain('1KB');
    });
  });
});
