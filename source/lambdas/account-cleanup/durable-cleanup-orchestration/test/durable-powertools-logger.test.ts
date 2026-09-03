// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  configureDurableLogger,
  DurablePowertoolsLogger,
} from "@amzn/innovation-sandbox-durable-cleanup-orchestration/logging/durable-powertools-logger.js";
import type { LogItemMessage } from "@aws-lambda-powertools/logger/types";
import type {
  DurableContext,
  DurableLogData,
  DurableLoggingContext,
} from "@aws/durable-execution-sdk-js";

// Spy on the base Powertools method to assert what the adapter forwards up.
function spyOnSuper(level: "info" | "warn" | "error" | "debug" | "critical") {
  return vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
}

// Durable handler used by the replay test: logs, waits (forcing a replay), then
// logs again — exercising the adapter through the real durable execution flow.
const integrationHandler = withDurableExecution(
  async (_event: unknown, context: DurableContext): Promise<void> => {
    configureDurableLogger(context);
    context.logger.info("Before wait", {
      logDetailType: "DurableLoggerIntegrationTest",
    });

    await context.wait("logger-replay-wait", { seconds: 1 });

    context.logger.info("After wait", {
      logDetailType: "DurableLoggerIntegrationTest",
    });
  },
);

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});

afterAll(async () => {
  await LocalDurableTestRunner.teardownTestEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Unit tests drive the adapter directly with a stubbed durable context, so they
// verify the metadata-merging logic in isolation without a live execution.
describe("DurablePowertoolsLogger — metadata injection (stubbed context)", () => {
  // Stand-in for the data the durable context supplies to each log entry.
  const durableLogData = {
    executionArn:
      "arn:aws:lambda:us-east-1:123456789012:function:test:1/durable-execution/test",
    requestId: "request-id",
    operationId: "operation-id",
    attempt: 2,
  } as DurableLogData;

  // Stub context returning the supplied data. The "no data" branch is stubbed
  // inline in its test to sidestep default-parameter substitution.
  function durableLoggingContext(
    data: DurableLogData = durableLogData,
  ): DurableLoggingContext {
    return {
      getDurableLogData: () => data,
    } as DurableLoggingContext;
  }

  it("configures a mode-aware durable logger", () => {
    // Installs the adapter as a mode-aware custom logger (mode-awareness drives
    // replay suppression).
    const configureLogger = vi.fn();

    configureDurableLogger({ configureLogger } as unknown as DurableContext);

    expect(configureLogger).toHaveBeenCalledOnce();
    expect(configureLogger).toHaveBeenCalledWith({
      customLogger: expect.any(DurablePowertoolsLogger),
      modeAware: true,
    });
  });

  it("emits durable metadata at the log root of the serialized output", () => {
    // Verifies real Powertools serialization (not just super() args), catching
    // field-placement regressions. Powertools writes via a Console bound to
    // process.stdout, so we capture stdout, not the global console.
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        writes.push(chunk.toString());
        return true;
      },
    );
    const logger = new DurablePowertoolsLogger({ logLevel: "INFO" });
    logger.configureDurableLoggingContext(durableLoggingContext());

    logger.info("Emitted message", {
      logDetailType: "AccountCleanupCompleted",
    });

    const record = writes
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .find((parsed) => parsed?.message === "Emitted message");

    // Metadata + extra input reach the root; undefined keys are dropped.
    expect(record).toMatchObject({
      message: "Emitted message",
      executionArn: durableLogData.executionArn,
      requestId: durableLogData.requestId,
      logDetailType: "AccountCleanupCompleted",
    });
  });

  it.each(["info", "warn", "error", "debug", "critical"] as const)(
    "delegates %s exactly once with structured details and durable metadata",
    (level) => {
      // Each level forwards once, merging metadata and passing extra input through.
      const logSpy = spyOnSuper(level);
      const logger = new DurablePowertoolsLogger();
      const details = { logDetailType: "AccountCleanupCompleted" };
      logger.configureDurableLoggingContext(durableLoggingContext());

      logger[level]("AccountCleanupCompleted", details);

      expect(logSpy).toHaveBeenCalledOnce();
      expect(logSpy).toHaveBeenCalledWith(
        {
          message: "AccountCleanupCompleted",
          executionArn: durableLogData.executionArn,
          requestId: durableLogData.requestId,
          operationId: durableLogData.operationId,
          attempt: durableLogData.attempt,
        },
        details,
      );
    },
  );

  it("replaces durable context and prevents callers from overriding metadata", () => {
    // Last configure wins; durable metadata overrides caller-supplied
    // operationId/attempt so records can't be spoofed with a wrong identity.
    const infoSpy = spyOnSuper("info");
    const logger = new DurablePowertoolsLogger();
    const replacementData = {
      ...durableLogData,
      operationId: "replacement-operation-id",
      attempt: 3,
    } as DurableLogData;
    logger.configureDurableLoggingContext(
      durableLoggingContext(durableLogData),
    );
    logger.configureDurableLoggingContext(
      durableLoggingContext(replacementData),
    );

    logger.info({
      message: "Structured message",
      operationId: "caller-operation-id",
      attempt: 99,
    } as LogItemMessage);

    expect(infoSpy).toHaveBeenCalledWith({
      message: "Structured message",
      executionArn: replacementData.executionArn,
      requestId: replacementData.requestId,
      operationId: replacementData.operationId,
      attempt: replacementData.attempt,
    });
  });

  it("adds no metadata when the context has no durable log data", () => {
    // Context present but no data (logging outside an execution): pass through
    // with no metadata, no throw.
    const infoSpy = spyOnSuper("info");
    const logger = new DurablePowertoolsLogger();
    // Inline stub: durableLoggingContext(undefined) would fall back to the
    // fixture via default-parameter substitution.
    logger.configureDurableLoggingContext({
      getDurableLogData: () => undefined,
    } as unknown as DurableLoggingContext);

    logger.info("No durable data");

    expect(infoSpy).toHaveBeenCalledWith({ message: "No durable data" });
  });

  it("passes a structured message through unchanged when no context is configured", () => {
    // No context: object input is forwarded verbatim (transparent adapter).
    const infoSpy = spyOnSuper("info");
    const logger = new DurablePowertoolsLogger();

    logger.info({ message: "Plain structured", foo: "bar" } as LogItemMessage);

    expect(infoSpy).toHaveBeenCalledWith({
      message: "Plain structured",
      foo: "bar",
    });
  });

  it("createChild returns a DurablePowertoolsLogger that inherits durable metadata", () => {
    // createChild yields a DurablePowertoolsLogger carrying the parent context,
    // so children keep injecting metadata instead of degrading to a base Logger.
    const infoSpy = spyOnSuper("info");
    const parent = new DurablePowertoolsLogger();
    parent.configureDurableLoggingContext(durableLoggingContext());

    const child = parent.createChild();

    expect(child).toBeInstanceOf(DurablePowertoolsLogger);

    child.info("Child message");

    expect(infoSpy).toHaveBeenCalledWith({
      message: "Child message",
      executionArn: durableLogData.executionArn,
      requestId: durableLogData.requestId,
      operationId: durableLogData.operationId,
      attempt: durableLogData.attempt,
    });
  });

  it("does not leak durable metadata between logger instances", () => {
    // Metadata is per-instance: an unconfigured logger emits a clean record.
    const infoSpy = spyOnSuper("info");
    const configuredLogger = new DurablePowertoolsLogger();
    configuredLogger.configureDurableLoggingContext(durableLoggingContext());
    configuredLogger.info("Configured logger");

    const freshLogger = new DurablePowertoolsLogger();
    freshLogger.info("Fresh logger");

    expect(infoSpy).toHaveBeenNthCalledWith(2, {
      message: "Fresh logger",
    });
  });
});

// Integration tests run the adapter through a real durable execution so replay
// suppression and metadata sourcing are exercised end-to-end, not stubbed.
describe("DurablePowertoolsLogger — real durable execution", () => {
  it("uses the real durable context and suppresses replay logs", async () => {
    // Real durable SDK: handler replays (invocations > 1), yet the pre-wait log
    // emits once (replay suppression) with real metadata + caller extra input.
    const infoSpy = spyOnSuper("info");
    const runner = new LocalDurableTestRunner({
      handlerFunction: integrationHandler,
    });

    const result = await runner.run({ payload: {} });

    expect(result.getStatus()).toBe("SUCCEEDED");
    expect(result.getInvocations().length).toBeGreaterThan(1);

    const beforeWaitCalls = infoSpy.mock.calls.filter(
      ([input]) =>
        typeof input === "object" &&
        input !== null &&
        "message" in input &&
        input.message === "Before wait",
    );
    expect(beforeWaitCalls).toHaveLength(1);
    expect(beforeWaitCalls[0]?.[0]).toEqual(
      expect.objectContaining({
        message: "Before wait",
        executionArn: expect.any(String),
        requestId: expect.any(String),
        operationId: undefined,
        attempt: undefined,
      }),
    );
    expect(beforeWaitCalls[0]?.[1]).toEqual({
      logDetailType: "DurableLoggerIntegrationTest",
    });

    // Non-replayed post-wait log still emits.
    const afterWaitCalls = infoSpy.mock.calls.filter(
      ([input]) =>
        typeof input === "object" &&
        input !== null &&
        "message" in input &&
        input.message === "After wait",
    );
    expect(afterWaitCalls).toHaveLength(1);
  });
});
