/**
 * Verification module
 *
 * Cross-tier verification system for detecting hallucinations
 * and assessing agent response quality.
 */

export {
  requestVerification,
  verifyResponse,
  toVerificationResult,
  VERIFICATION_TOOL,
} from './cross-tier-verifier.js';

export {
  summarizeToolResults,
  extractFilesFromToolResults,
} from './tool-results-summarizer.js';
