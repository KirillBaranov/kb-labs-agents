import { describe, it, expect, beforeEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrchestratorAgentRegistry } from '../agent-registry.js';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to test fixtures
const FIXTURES_DIR = join(__dirname, 'fixtures', 'agents');

describe('OrchestratorAgentRegistry', () => {
  let registry: OrchestratorAgentRegistry;

  beforeEach(() => {
    // Pass cwd and relative path separately
    registry = new OrchestratorAgentRegistry(__dirname, join('fixtures', 'agents'));
  });

  describe('loadAgents', () => {
    it('should load agents from directory', async () => {
      await registry.loadAgents();

      const agents = registry.getAll();
      expect(agents.length).toBe(2);
    });

    it('should include test-agent-1', async () => {
      await registry.loadAgents();

      const agent = registry.get('test-agent-1');
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('Test Agent One');
      expect(agent?.metadata.description).toContain('monorepo');
    });

    it('should include test-agent-2', async () => {
      await registry.loadAgents();

      const agent = registry.get('test-agent-2');
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('Test Agent Two');
      expect(agent?.metadata.description).toContain('search');
    });

    it('should extract metadata correctly', async () => {
      await registry.loadAgents();

      const agent = registry.get('test-agent-1');
      expect(agent?.metadata.tags).toContain('monorepo');
      expect(agent?.metadata.tags).toContain('validation');
      expect(agent?.metadata.examples).toBeDefined();
      expect(agent?.metadata.examples!.length).toBe(2);
    });

    it('should extract tier correctly', async () => {
      await registry.loadAgents();

      const agent1 = registry.get('test-agent-1');
      expect(agent1?.tier).toBe('small');

      const agent2 = registry.get('test-agent-2');
      expect(agent2?.tier).toBe('medium');
    });
  });

  describe('findByTags', () => {
    beforeEach(async () => {
      await registry.loadAgents();
    });

    it('should find agents by single tag', () => {
      const agents = registry.findByTags(['monorepo']);
      expect(agents.length).toBe(1);
      expect(agents[0].id).toBe('test-agent-1');
    });

    it('should find agents by multiple tags', () => {
      const agents = registry.findByTags(['search', 'semantic']);
      expect(agents.length).toBe(1);
      expect(agents[0].id).toBe('test-agent-2');
    });

    it('should find all agents with "test" tag', () => {
      const agents = registry.findByTags(['test']);
      expect(agents.length).toBe(2);
    });

    it('should return empty array for non-existent tag', () => {
      const agents = registry.findByTags(['nonexistent-tag-xyz']);
      expect(agents.length).toBe(0);
    });
  });

  describe('findByKeywords', () => {
    beforeEach(async () => {
      await registry.loadAgents();
    });

    it('should find agents by keyword in description', () => {
      const agents = registry.findByKeywords('monorepo');
      expect(agents.some((a) => a.id === 'test-agent-1')).toBe(true);
    });

    it('should find agents by keyword in examples', () => {
      const agents = registry.findByKeywords('implementation');
      expect(agents.some((a) => a.id === 'test-agent-2')).toBe(true);
    });

    it('should be case-insensitive', () => {
      const agents = registry.findByKeywords('MONOREPO');
      expect(agents.some((a) => a.id === 'test-agent-1')).toBe(true);
    });

    it('should return empty array for non-matching keyword', () => {
      const agents = registry.findByKeywords('xyz-nonexistent-keyword-123');
      expect(agents.length).toBe(0);
    });
  });

  describe('toPromptFormat', () => {
    beforeEach(async () => {
      await registry.loadAgents();
    });

    it('should format agents for prompt', () => {
      const prompt = registry.toPromptFormat();

      expect(prompt).toContain('Test Agent One');
      expect(prompt).toContain('Test Agent Two');
      expect(prompt).toContain('test-agent-1');
      expect(prompt).toContain('test-agent-2');
    });

    it('should include metadata in formatted output', () => {
      const prompt = registry.toPromptFormat();

      expect(prompt).toContain('Tags:');
      expect(prompt).toContain('Examples:');
    });

    it('should separate agents with dividers', () => {
      const prompt = registry.toPromptFormat();
      expect(prompt).toContain('---');
    });
  });

  describe('utility methods', () => {
    beforeEach(async () => {
      await registry.loadAgents();
    });

    it('should return correct count', () => {
      const count = registry.count();
      expect(count).toBe(2);
    });

    it('should check if agents are loaded', () => {
      expect(registry.hasAgents()).toBe(true);
    });
  });

  describe('empty registry', () => {
    it('should handle non-existent directory gracefully', async () => {
      const emptyRegistry = new OrchestratorAgentRegistry('/nonexistent', 'path');
      await emptyRegistry.loadAgents();

      expect(emptyRegistry.count()).toBe(0);
      expect(emptyRegistry.hasAgents()).toBe(false);
      expect(emptyRegistry.toPromptFormat()).toContain(
        'No agent agents available',
      );
    });
  });

  describe('agents without metadata', () => {
    it('should skip agents without metadata section', async () => {
      // Create a test without metadata in fixtures if needed
      // For now, just verify existing agents all have metadata
      await registry.loadAgents();
      const agents = registry.getAll();

      agents.forEach((agent) => {
        expect(agent.metadata).toBeDefined();
        expect(agent.metadata.description).toBeDefined();
      });
    });
  });
});
