// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";

/**
 * Runs one metric collector with a timeout and a typed fallback. On timeout or
 * error it logs a warning and returns the fallback, so a single failing
 * collector never sinks the whole heartbeat. The return type is preserved (T),
 * keeping the final log payload fully type-checked against the log schema.
 */
export async function collectMetric<T>(
  logger: Logger,
  name: string,
  timeoutMs: number,
  fallback: T,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await withTimeout(fn(), timeoutMs, name);
  } catch (error) {
    logger.warn(`Metric "${name}" failed; using fallback`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  name: string,
): Promise<T> {
  // Race the work against a promise that rejects when the timeout signal
  // aborts (after timeoutMs); whichever settles first wins.
  const signal = AbortSignal.timeout(timeoutMs);
  const timeout = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error(`${name} timed out after ${timeoutMs}ms`)),
      { once: true },
    );
  });
  return Promise.race([promise, timeout]);
}
