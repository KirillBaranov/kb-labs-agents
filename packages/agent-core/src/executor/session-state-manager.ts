/**
 * Session State Manager (V2 Architecture)
 *
 * Manages specialist session state with hybrid lazy-loading:
 * - Fixed ~1.2K token inline state (summary, findings)
 * - Large artifacts lazy-loaded from cache via useCache()
 * - Prevents token explosion while maintaining context
 */

import type { PluginContextV3 } from '@kb-labs/sdk';
import { useCache } from '@kb-labs/sdk';

/**
 * Artifact reference (stored inline, content in cache)
 */
export interface ArtifactReference {
  id: string; // Unique artifact ID
  type: 'code' | 'search-result' | 'file-content' | 'analysis';
  name: string; // Human-readable name
  size: number; // Size in bytes
  summary?: string; // Optional brief summary (1 line)
}

/**
 * Session state finding (compact, always inline)
 */
export interface SessionFinding {
  step: number; // Which step produced this
  tool: string; // Tool that was used
  fact: string; // The finding (max ~100 chars)
  timestamp: number; // When it was found
}

/**
 * Session state (inline, sent with every LLM call)
 */
export interface SessionState {
  sessionId: string;
  summary: string; // Current understanding (~200 chars)
  findings: SessionFinding[]; // Key facts (max 10 recent)
  artifacts: ArtifactReference[]; // References to cached data
  tokensEstimate: number; // Estimated token count
}

/**
 * Artifact with full content (loaded from cache on-demand)
 */
export interface Artifact {
  id: string;
  type: ArtifactReference['type'];
  name: string;
  content: unknown; // The actual data
  metadata?: Record<string, unknown>;
}

/**
 * Session State Manager
 *
 * Manages specialist memory with token-efficient design:
 * - Keeps inline state under ~1.2K tokens
 * - Stores large data in cache (via useCache)
 * - Provides lazy loading for artifacts
 */
export class SessionStateManager {
  private state: SessionState;
  private cacheNamespace: string;
  private readonly MAX_FINDINGS = 10;
  private readonly MAX_SUMMARY_LENGTH = 200;
  private readonly MAX_FACT_LENGTH = 100;

  constructor(
    private ctx: PluginContextV3,
    sessionId: string
  ) {
    this.cacheNamespace = `session:${sessionId}`;
    this.state = {
      sessionId,
      summary: '',
      findings: [],
      artifacts: [],
      tokensEstimate: 0,
    };
  }

  /**
   * Get current session state (for LLM context)
   */
  getState(): SessionState {
    this.updateTokenEstimate();
    return { ...this.state };
  }

  /**
   * Update session summary
   */
  updateSummary(summary: string): void {
    this.state.summary = summary.slice(0, this.MAX_SUMMARY_LENGTH);
    this.ctx.platform.logger.debug('Session summary updated', {
      sessionId: this.state.sessionId,
      summaryLength: this.state.summary.length,
    });
  }

  /**
   * Add a finding to session state
   */
  addFinding(finding: Omit<SessionFinding, 'timestamp'>): void {
    const newFinding: SessionFinding = {
      ...finding,
      fact: finding.fact.slice(0, this.MAX_FACT_LENGTH),
      timestamp: Date.now(),
    };

    this.state.findings.push(newFinding);

    // Keep only most recent findings
    if (this.state.findings.length > this.MAX_FINDINGS) {
      this.state.findings = this.state.findings.slice(-this.MAX_FINDINGS);
    }

    this.ctx.platform.logger.debug('Finding added to session', {
      sessionId: this.state.sessionId,
      step: finding.step,
      tool: finding.tool,
      totalFindings: this.state.findings.length,
    });
  }

  /**
   * Store artifact in cache and add reference to state
   */
  async storeArtifact(artifact: Omit<Artifact, 'id'>): Promise<string> {
    const artifactId = `artifact:${this.state.sessionId}:${Date.now()}:${artifact.name}`;

    // Store full artifact in cache
    const cache = useCache();
    if (!cache) {
      this.ctx.platform.logger.warn('Cache not available, skipping artifact storage');
      return artifactId;
    }

    const cacheKey = `${this.cacheNamespace}:${artifactId}`;

    const fullArtifact: Artifact = {
      id: artifactId,
      ...artifact,
    };

    await cache.set(cacheKey, fullArtifact, 3600); // 1 hour TTL

    // Add reference to state (lightweight)
    const reference: ArtifactReference = {
      id: artifactId,
      type: artifact.type,
      name: artifact.name,
      size: JSON.stringify(artifact.content).length,
      summary: typeof artifact.content === 'string'
        ? artifact.content.slice(0, 50) + '...'
        : undefined,
    };

    this.state.artifacts.push(reference);

    this.ctx.platform.logger.debug('Artifact stored', {
      sessionId: this.state.sessionId,
      artifactId,
      type: artifact.type,
      size: reference.size,
      totalArtifacts: this.state.artifacts.length,
    });

    return artifactId;
  }

  /**
   * Load artifact from cache (lazy loading)
   */
  async loadArtifact(artifactId: string): Promise<Artifact | null> {
    const cache = useCache();
    if (!cache) {
      this.ctx.platform.logger.warn('Cache not available, cannot load artifact');
      return null;
    }

    const cacheKey = `${this.cacheNamespace}:${artifactId}`;

    const artifact = await cache.get<Artifact>(cacheKey);

    if (!artifact) {
      this.ctx.platform.logger.warn('Artifact not found in cache', {
        sessionId: this.state.sessionId,
        artifactId,
      });
      return null;
    }

    this.ctx.platform.logger.debug('Artifact loaded from cache', {
      sessionId: this.state.sessionId,
      artifactId,
      type: artifact.type,
    });

    return artifact;
  }

  /**
   * Get all artifacts (loads from cache)
   */
  async getAllArtifacts(): Promise<Artifact[]> {
    const artifacts: Artifact[] = [];

    for (const ref of this.state.artifacts) {
      const artifact = await this.loadArtifact(ref.id);
      if (artifact) {
        artifacts.push(artifact);
      }
    }

    return artifacts;
  }

  /**
   * Clear old artifacts to prevent cache bloat
   */
  async pruneArtifacts(keepCount: number = 5): Promise<void> {
    if (this.state.artifacts.length <= keepCount) {
      return;
    }

    // Remove oldest artifacts
    const toRemove = this.state.artifacts.slice(0, this.state.artifacts.length - keepCount);

    const cache = useCache();
    if (!cache) {
      this.ctx.platform.logger.warn('Cache not available, cannot prune artifacts');
      return;
    }

    for (const ref of toRemove) {
      const cacheKey = `${this.cacheNamespace}:${ref.id}`;
      await cache.delete(cacheKey);
    }

    this.state.artifacts = this.state.artifacts.slice(-keepCount);

    this.ctx.platform.logger.info('Session artifacts pruned', {
      sessionId: this.state.sessionId,
      removed: toRemove.length,
      remaining: this.state.artifacts.length,
    });
  }

  /**
   * Serialize state for LLM context (compact representation)
   */
  serializeForLLM(): string {
    let output = '';

    // Summary
    if (this.state.summary) {
      output += `# Session Summary\n${this.state.summary}\n\n`;
    }

    // Findings
    if (this.state.findings.length > 0) {
      output += `# Key Findings (${this.state.findings.length}):\n`;
      for (const finding of this.state.findings) {
        output += `- [Step ${finding.step}, ${finding.tool}] ${finding.fact}\n`;
      }
      output += '\n';
    }

    // Artifact references (not full content)
    if (this.state.artifacts.length > 0) {
      output += `# Available Artifacts (${this.state.artifacts.length}):\n`;
      for (const artifact of this.state.artifacts) {
        output += `- ${artifact.name} (${artifact.type}, ${artifact.size} bytes)`;
        if (artifact.summary) {
          output += ` - ${artifact.summary}`;
        }
        output += '\n';
      }
      output += '\n';
    }

    return output;
  }

  /**
   * Estimate token count for current state
   */
  private updateTokenEstimate(): void {
    const serialized = this.serializeForLLM();
    // Rough estimate: 1 token ≈ 4 characters
    this.state.tokensEstimate = Math.ceil(serialized.length / 4);
  }

  /**
   * Get current token estimate
   */
  getTokenEstimate(): number {
    this.updateTokenEstimate();
    return this.state.tokensEstimate;
  }

  /**
   * Clear all session data (cleanup)
   */
  async clear(): Promise<void> {
    const cache = useCache();
    if (!cache) {
      this.ctx.platform.logger.warn('Cache not available, cannot clear artifacts');
      // Still reset state even if cache is unavailable
      this.state = {
        sessionId: this.state.sessionId,
        summary: '',
        findings: [],
        artifacts: [],
        tokensEstimate: 0,
      };
      return;
    }

    // Remove all artifacts from cache
    for (const ref of this.state.artifacts) {
      const cacheKey = `${this.cacheNamespace}:${ref.id}`;
      await cache.delete(cacheKey);
    }

    // Reset state
    this.state = {
      sessionId: this.state.sessionId,
      summary: '',
      findings: [],
      artifacts: [],
      tokensEstimate: 0,
    };

    this.ctx.platform.logger.info('Session state cleared', {
      sessionId: this.state.sessionId,
    });
  }
}
