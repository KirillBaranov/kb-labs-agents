/**
 * Tests for ProgressReporter
 */

import { describe, it, expect, vi } from "vitest";
import { ProgressReporter } from "../reporter.js";
import type { ILogger } from "@kb-labs/sdk";
import type { ProgressEvent } from "../types.js";

// Mock logger
const createMockLogger = (): ILogger => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
});

describe("ProgressReporter", () => {
  describe("Event emission", () => {
    it("should emit task_started event", () => {
      const events: ProgressEvent[] = [];
      const logger = createMockLogger();
      const reporter = new ProgressReporter(logger, (e) => events.push(e));

      reporter.start("Test task");

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("task_started");
      expect(events[0].data.taskDescription).toBe("Test task");
      expect(logger.info).toHaveBeenCalledWith("🎯 Task started: Test task");
    });

    it("should emit task_classified event", () => {
      const events: ProgressEvent[] = [];
      const logger = createMockLogger();
      const reporter = new ProgressReporter(logger, (e) => events.push(e));

      reporter.classified("medium", "high", "heuristic");

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("task_classified");
      expect(events[0].data.tier).toBe("medium");
      expect(events[0].data.confidence).toBe("high");
      expect(events[0].data.method).toBe("heuristic");
    });

    it("should emit planning events", () => {
      const events: ProgressEvent[] = [];
      const logger = createMockLogger();
      const reporter = new ProgressReporter(logger, (e) => events.push(e));

      reporter.planning("started");
      reporter.planning("completed", { subtaskCount: 3 });

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("planning_started");
      expect(events[1].type).toBe("planning_completed");
      expect(events[1].data.subtaskCount).toBe(3);
    });

    it("should emit subtask events", () => {
      const events: ProgressEvent[] = [];
      const logger = createMockLogger();
      const reporter = new ProgressReporter(logger, (e) => events.push(e));

      reporter.subtask(1, "Test subtask", "medium", "started");
      reporter.subtask(1, "Test subtask", "medium", "progress", {
        progress: 50,
      });
      reporter.subtask(1, "Test subtask", "medium", "completed");

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe("subtask_started");
      expect(events[1].type).toBe("subtask_progress");
      expect(events[1].data.progress).toBe(50);
      expect(events[2].type).toBe("subtask_completed");
    });

    it("should emit tier_escalated event", () => {
      const events: ProgressEvent[] = [];
      const logger = createMockLogger();
      const reporter = new ProgressReporter(logger, (e) => events.push(e));

      reporter.escalated(1, "small", "medium", "Task too complex");

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("tier_escalated");
      expect(events[0].data.fromTier).toBe("small");
      expect(events[0].data.toTier).toBe("medium");
      expect(events[0].data.reason).toBe("Task too complex");
    });

    it("should emit task_completed event", () => {
      const events: ProgressEvent[] = [];
      const logger = createMockLogger();
      const reporter = new ProgressReporter(logger, (e) => events.push(e));

      reporter.start("Test");
      reporter.complete("success", {
        total: "$0.05",
        small: "$0.01",
        medium: "$0.04",
        large: "$0.00",
      });

      const completeEvent = events.find((e) => e.type === "task_completed");
      expect(completeEvent).toBeDefined();
      expect(completeEvent!.data.status).toBe("success");
      expect(completeEvent!.data.costBreakdown.total).toBe("$0.05");
    });
  });

  describe("Tier emoji mapping", () => {
    it("should use correct emoji for each tier", () => {
      const logger = createMockLogger();
      const reporter = new ProgressReporter(logger);

      reporter.classified("small", "high", "heuristic");
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("🟢"));

      reporter.classified("medium", "high", "heuristic");
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("🟡"));

      reporter.classified("large", "high", "heuristic");
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("🔴"));
    });
  });

  describe("Event history", () => {
    it("should store all emitted events", () => {
      const logger = createMockLogger();
      const reporter = new ProgressReporter(logger);

      reporter.start("Test");
      reporter.classified("medium", "high", "heuristic");
      reporter.planning("started");

      const events = reporter.getEvents();
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe("task_started");
      expect(events[1].type).toBe("task_classified");
      expect(events[2].type).toBe("planning_started");
    });

    it("should clear events", () => {
      const logger = createMockLogger();
      const reporter = new ProgressReporter(logger);

      reporter.start("Test");
      reporter.classified("medium", "high", "heuristic");

      expect(reporter.getEvents()).toHaveLength(2);

      reporter.clear();
      expect(reporter.getEvents()).toHaveLength(0);
    });
  });

  describe("No callback mode", () => {
    it("should work without callback (CLI mode)", () => {
      const logger = createMockLogger();
      const reporter = new ProgressReporter(logger);

      expect(() => {
        reporter.start("Test");
        reporter.classified("medium", "high", "heuristic");
        reporter.complete("success", {
          total: "$0.05",
          small: "$0.01",
          medium: "$0.04",
          large: "$0.00",
        });
      }).not.toThrow();

      expect(logger.info).toHaveBeenCalled();
    });
  });
});
