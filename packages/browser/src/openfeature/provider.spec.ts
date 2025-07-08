import {
  type EvaluationContext,
  type Logger,
  StandardResolutionReasons,
} from "@openfeature/core";
import { DatadogProvider } from "./provider";

describe("DatadogProvider", () => {
  let provider: DatadogProvider;
  let mockLogger: Logger;
  let mockContext: EvaluationContext;

  beforeEach(() => {
    provider = new DatadogProvider({
      clientToken: "xxx",
      applicationId: "xxx",
      env: "test",
      site: "http://localhost:8000",
    });
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockContext = {};
  });

  describe("metadata", () => {
    it("should have correct metadata", () => {
      expect(provider.metadata).toEqual({
        name: "datadog",
      });
    });

    it("should run on client", () => {
      expect(provider.runsOn).toBe("client");
    });
  });

  describe("resolveBooleanEvaluation", () => {
    it("should return default value with DEFAULT reason", () => {
      const result = provider.resolveBooleanEvaluation(
        "test-flag",
        true,
        mockContext,
        mockLogger,
      );
      expect(result).toEqual({
        value: true,
        reason: StandardResolutionReasons.DEFAULT,
      });
    });
  });

  describe("resolveStringEvaluation", () => {
    it("should return default value with DEFAULT reason", () => {
      const result = provider.resolveStringEvaluation(
        "test-flag",
        "default",
        mockContext,
        mockLogger,
      );
      expect(result).toEqual({
        value: "default",
        reason: StandardResolutionReasons.DEFAULT,
      });
    });
  });

  describe("resolveNumberEvaluation", () => {
    it("should return default value with DEFAULT reason", () => {
      const result = provider.resolveNumberEvaluation(
        "test-flag",
        42,
        mockContext,
        mockLogger,
      );
      expect(result).toEqual({
        value: 42,
        reason: StandardResolutionReasons.DEFAULT,
      });
    });
  });

  describe("resolveObjectEvaluation", () => {
    it("should return default value with DEFAULT reason", () => {
      const defaultValue = { key: "value" };
      const result = provider.resolveObjectEvaluation(
        "test-flag",
        defaultValue,
        mockContext,
        mockLogger,
      );
      expect(result).toEqual({
        value: defaultValue,
        reason: StandardResolutionReasons.DEFAULT,
      });
    });
  });
});
