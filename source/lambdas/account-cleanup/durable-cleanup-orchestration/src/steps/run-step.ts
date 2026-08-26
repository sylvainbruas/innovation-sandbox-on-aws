// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CleanupContext } from "./types.js";

const NO_RETRY = { retryStrategy: () => ({ shouldRetry: false }) };

/**
 * Error wrapper that carries the step name where the failure occurred.
 * Used by handleCleanupFailure to report which step failed.
 */
export class CleanupStepError extends Error {
  public readonly stepName: string;
  public override readonly cause: unknown;

  constructor(stepName: string, cause: unknown) {
    const message =
      cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = "CleanupStepError";
    this.stepName = stepName;
    this.cause = cause;
  }
}

/**
 * Result wrapper returned by runStep.
 */
export interface StepResult<T> {
  output: T;
  stepName: string;
  durationMs: number;
}

/**
 * Options for runStep.
 */
export interface RunStepOptions {
  /** If true, skip writing this step to the cleanup report */
  skipReport?: boolean;
  /** Additional fields to include in the report step entry (e.g., codeBuildExecutionArn, cooldownDurationHours) */
  stepMetadata?: Record<string, unknown>;
}

/**
 * Executes a named step within the durable cleanup flow:
 *
 * 1. Logs step start
 * 2. Wraps the step function in context.step() for durable checkpointing
 * 3. Appends the step to the progressive cleanup report (inside the checkpoint)
 * 4. Logs step completion with duration
 *
 * On failure, wraps the error in a CleanupStepError so the top-level catch
 * can identify which step failed.
 */
export async function runStep<T>(
  ctx: CleanupContext,
  stepName: string,
  fn: () => Promise<T>,
  options?: RunStepOptions,
): Promise<StepResult<T>> {
  const { durableContext, reportWriter, reportKey } = ctx;
  const startTime = Date.now();

  durableContext.logger.info(`Step started: ${stepName}`, { stepName });

  let output: T;
  try {
    output = await durableContext.step<T>(
      stepName,
      async () => {
        // Append step to cleanup report (inside durable step for replay safety)
        if (!options?.skipReport) {
          await reportWriter.appendStep(
            reportKey,
            stepName,
            options?.stepMetadata,
          );
        }
        return fn();
      },
      NO_RETRY,
    );
  } catch (error) {
    throw new CleanupStepError(stepName, error);
  }

  const durationMs = Date.now() - startTime;

  durableContext.logger.info(`Step completed: ${stepName}`, {
    stepName,
    durationMs,
  });

  return { output, stepName, durationMs };
}
