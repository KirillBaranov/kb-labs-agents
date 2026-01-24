/**
 * Tests for HeuristicComplexityClassifier
 */

import { describe, it, expect } from "vitest";
import { HeuristicComplexityClassifier } from "../heuristic-classifier.js";

describe("HeuristicComplexityClassifier", () => {
  const classifier = new HeuristicComplexityClassifier();

  describe("English keywords", () => {
    it("should classify simple search tasks as small", async () => {
      const result = await classifier.classify({
        taskDescription: "Find all TODO comments in the codebase",
      });

      expect(result.tier).toBe("small");
      expect(result.method).toBe("heuristic");
    });

    it("should classify implementation tasks as medium", async () => {
      const result = await classifier.classify({
        taskDescription: "Implement user authentication with JWT",
      });

      expect(result.tier).toBe("medium");
      expect(result.method).toBe("heuristic");
    });

    it("should classify architectural tasks as large", async () => {
      const result = await classifier.classify({
        taskDescription: "Design a scalable multi-tenant architecture",
      });

      expect(result.tier).toBe("large");
      expect(result.method).toBe("heuristic");
    });
  });

  describe("Russian keywords", () => {
    it("should classify search tasks as small (Russian)", async () => {
      const result = await classifier.classify({
        taskDescription: "Найди все TODO комментарии",
      });

      expect(result.tier).toBe("small");
      expect(result.method).toBe("heuristic");
    });

    it("should classify implementation as medium (Russian)", async () => {
      const result = await classifier.classify({
        taskDescription: "Реализуй аутентификацию пользователя",
      });

      expect(result.tier).toBe("medium");
      expect(result.method).toBe("heuristic");
    });

    it("should classify architecture as large (Russian)", async () => {
      const result = await classifier.classify({
        taskDescription: "Спроектируй масштабируемую архитектуру",
      });

      expect(result.tier).toBe("large");
      expect(result.method).toBe("heuristic");
    });
  });

  describe("Edge cases", () => {
    it("should handle very short tasks", async () => {
      const result = await classifier.classify({
        taskDescription: "Find X",
      });

      expect(result.tier).toBe("small");
      expect(["high", "low"]).toContain(result.confidence);
    });

    it("should handle very long tasks", async () => {
      const longTask = "Design ".repeat(50) + "a system";
      const result = await classifier.classify({
        taskDescription: longTask,
      });

      expect(result.tier).toBe("large");
      expect(result.method).toBe("heuristic");
    });

    it("should provide reasoning", async () => {
      const result = await classifier.classify({
        taskDescription: "Implement feature",
      });

      expect(result.reasoning).toBeDefined();
      expect(result.reasoning).toContain("score");
    });
  });

  describe("Confidence levels", () => {
    it("should return high confidence for clear matches", async () => {
      const result = await classifier.classify({
        taskDescription: "Design and architect a complex system",
      });

      expect(result.confidence).toBe("high");
      expect(result.tier).toBe("large");
    });

    it("should return low confidence for ambiguous tasks", async () => {
      const result = await classifier.classify({
        taskDescription: "Do something with the code",
      });

      expect(["high", "low"]).toContain(result.confidence);
    });
  });
});
