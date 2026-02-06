/**
 * Verification-Memory Integration
 *
 * Bridges verification results with the memory system.
 * Stores verified mentions as findings, unverified as blockers.
 */

import type { VerificationResult } from '@kb-labs/agent-contracts';
import type { FileMemory } from './file-memory.js';

/**
 * Options for storing verification results in memory
 */
export interface StoreVerificationOptions {
  /** Subtask ID for context */
  subtaskId?: string;
  /** Subtask description for context */
  subtaskDescription?: string;
  /** Whether this is a synthesis verification (final answer) */
  isSynthesis?: boolean;
}

/**
 * Store verification results in memory.
 *
 * - Verified mentions → findings (trusted facts for future subtasks)
 * - Unverified mentions → blockers (hallucination warnings)
 * - Gaps → blockers (known missing information)
 *
 * @param memory - FileMemory instance
 * @param verification - Verification result to store
 * @param options - Storage options
 */
export async function storeVerificationInMemory(
  memory: FileMemory,
  verification: VerificationResult,
  options: StoreVerificationOptions = {}
): Promise<void> {
  const { subtaskId, subtaskDescription, isSynthesis } = options;
  const prefix = subtaskId ? `[${subtaskId}] ` : '';
  const context = subtaskDescription ? ` (${subtaskDescription})` : '';
  const source = isSynthesis ? 'synthesis-verification' : 'subtask-verification';

  // Store verified mentions as findings
  for (const mention of verification.verifiedMentions) {
    // eslint-disable-next-line no-await-in-loop -- Sequential memory storage required
    await memory.addFinding(
      `${prefix}Verified: ${mention}`,
      verification.confidence,
      [source, subtaskId ?? 'unknown']
    );
  }

  // Store unverified mentions as blockers (potential hallucinations)
  for (const mention of verification.unverifiedMentions) {
    // eslint-disable-next-line no-await-in-loop -- Sequential memory storage required
    await memory.addBlocker(
      `${prefix}UNVERIFIED CLAIM${context}: ${mention} - DO NOT repeat this claim without verification`,
      subtaskId
    );
  }

  // Store gaps as blockers
  for (const gap of verification.gaps) {
    // eslint-disable-next-line no-await-in-loop -- Sequential memory storage required
    await memory.addBlocker(
      `${prefix}MISSING INFO${context}: ${gap}`,
      subtaskId
    );
  }

  // Store critical warnings as blockers
  for (const warning of verification.warnings) {
    if (warning.code === 'LOW_CONFIDENCE' || warning.code === 'CONTRADICTION') {
      // eslint-disable-next-line no-await-in-loop -- Sequential memory storage required
      await memory.addBlocker(
        `${prefix}WARNING: ${warning.message}`,
        subtaskId
      );
    }
  }
}

/**
 * Build verification context for the next subtask.
 *
 * Provides the subtask with:
 * - Verified facts from previous subtasks
 * - Known hallucinations to avoid
 * - Information gaps that need to be filled
 *
 * @param memory - FileMemory instance
 * @returns Context string for next subtask
 */
export async function buildVerificationContext(memory: FileMemory): Promise<string> {
  // Get recent memories which include findings and blockers
  const recentMemories = await memory.getRecent(50);
  const parts: string[] = [];

  // Extract verified facts (findings with "Verified:" prefix)
  const verifiedFacts = recentMemories.filter(
    (m) => m.type === 'finding' && m.content.includes('Verified:')
  );
  if (verifiedFacts.length > 0) {
    parts.push('## Verified Facts (from previous verification)');
    parts.push('These facts have been verified and can be trusted:');
    for (const fact of verifiedFacts.slice(-10)) {
      parts.push(`- ${fact.content}`);
    }
    parts.push('');
  }

  // Extract unverified claims (blockers with "UNVERIFIED CLAIM" prefix)
  const unverifiedClaims = recentMemories.filter(
    (m) => m.type === 'blocker' && m.content.includes('UNVERIFIED CLAIM')
  );
  if (unverifiedClaims.length > 0) {
    parts.push('## Known Unverified Claims (AVOID)');
    parts.push('These claims could not be verified - do NOT repeat them:');
    for (const claim of unverifiedClaims.slice(-5)) {
      parts.push(`- ${claim.content}`);
    }
    parts.push('');
  }

  // Extract information gaps
  const gaps = recentMemories.filter(
    (m) => m.type === 'blocker' && m.content.includes('MISSING INFO')
  );
  if (gaps.length > 0) {
    parts.push('## Information Gaps');
    parts.push('The following information is still needed:');
    for (const gap of gaps.slice(-5)) {
      parts.push(`- ${gap.content}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Get verification summary from memory.
 *
 * Returns a summary of verification state for the current session.
 */
export async function getVerificationSummary(memory: FileMemory): Promise<VerificationMemorySummary> {
  const recentMemories = await memory.getRecent(100);

  const verifiedFacts = recentMemories.filter(
    (m) => m.type === 'finding' && m.content.includes('Verified:')
  );
  const unverifiedClaims = recentMemories.filter(
    (m) => m.type === 'blocker' && m.content.includes('UNVERIFIED CLAIM')
  );
  const informationGaps = recentMemories.filter(
    (m) => m.type === 'blocker' && m.content.includes('MISSING INFO')
  );
  const warnings = recentMemories.filter(
    (m) => m.type === 'blocker' && m.content.includes('WARNING:')
  );

  return {
    verifiedFactsCount: verifiedFacts.length,
    unverifiedClaimsCount: unverifiedClaims.length,
    informationGapsCount: informationGaps.length,
    warningsCount: warnings.length,
    verifiedFacts: verifiedFacts.map((f) => f.content),
    unverifiedClaims: unverifiedClaims.map((b) => b.content),
    informationGaps: informationGaps.map((b) => b.content),
  };
}

/**
 * Summary of verification state in memory
 */
export interface VerificationMemorySummary {
  verifiedFactsCount: number;
  unverifiedClaimsCount: number;
  informationGapsCount: number;
  warningsCount: number;
  verifiedFacts: string[];
  unverifiedClaims: string[];
  informationGaps: string[];
}

/**
 * Clear verification-related entries from memory.
 *
 * Note: FileMemory doesn't have a direct remove method,
 * so we add a marker that can be used to filter old verification data.
 */
export async function clearVerificationMemory(memory: FileMemory): Promise<void> {
  const summary = await getVerificationSummary(memory);

  // Add a marker indicating verification was cleared
  await memory.addFinding(
    `Verification cleared: ${summary.verifiedFactsCount} facts, ${summary.unverifiedClaimsCount} claims, ${summary.informationGapsCount} gaps`,
    1.0,
    ['verification-memory', 'system']
  );
}
