// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import type {
  ConstructorOptions,
  LogItemExtraInput,
  LogItemMessage,
} from "@aws-lambda-powertools/logger/types";
import type {
  DurableContext,
  DurableLogData,
  DurableLogger,
  DurableLoggingContext,
} from "@aws/durable-execution-sdk-js";

/**
 * Adapts Powertools Logger to the Durable Execution SDK and adds the current
 * execution metadata to each structured log entry. Calling Powertools directly
 * would bypass replay suppression, while configuring it without this adapter
 * would omit durable execution metadata.
 */
export class DurablePowertoolsLogger extends Logger implements DurableLogger {
  private durableLoggingContext?: DurableLoggingContext;

  configureDurableLoggingContext(
    durableLoggingContext: DurableLoggingContext,
  ): void {
    this.durableLoggingContext = durableLoggingContext;
  }

  // Factory used by createChild so child loggers stay DurablePowertoolsLogger
  // instances and keep injecting durable metadata rather than silently
  // degrading to a base Logger.
  protected override createLogger(
    options?: ConstructorOptions,
  ): DurablePowertoolsLogger {
    const childLogger = new DurablePowertoolsLogger(options);
    if (this.durableLoggingContext) {
      childLogger.configureDurableLoggingContext(this.durableLoggingContext);
    }
    return childLogger;
  }

  override info(input: LogItemMessage, ...extraInput: LogItemExtraInput): void {
    super.info(this.withDurableContext(input), ...extraInput);
  }

  override warn(input: LogItemMessage, ...extraInput: LogItemExtraInput): void {
    super.warn(this.withDurableContext(input), ...extraInput);
  }

  override error(
    input: LogItemMessage,
    ...extraInput: LogItemExtraInput
  ): void {
    super.error(this.withDurableContext(input), ...extraInput);
  }

  override debug(
    input: LogItemMessage,
    ...extraInput: LogItemExtraInput
  ): void {
    super.debug(this.withDurableContext(input), ...extraInput);
  }

  override critical(
    input: LogItemMessage,
    ...extraInput: LogItemExtraInput
  ): void {
    super.critical(this.withDurableContext(input), ...extraInput);
  }

  private withDurableContext(input: LogItemMessage): LogItemMessage {
    const durableLogData = this.durableLoggingContext?.getDurableLogData();
    const metadata = durableLogData
      ? this.toDurableMetadata(durableLogData)
      : {};

    if (typeof input === "string") {
      return {
        message: input,
        ...metadata,
      };
    }

    return {
      ...input,
      ...metadata,
    };
  }

  private toDurableMetadata(durableLogData: DurableLogData) {
    return {
      executionArn: durableLogData.executionArn,
      requestId: durableLogData.requestId,
      operationId: durableLogData.operationId,
      attempt: durableLogData.attempt,
    };
  }
}

/** Installs a fresh replay-aware Powertools logger on a durable context. */
export function configureDurableLogger(context: DurableContext): void {
  context.configureLogger({
    customLogger: new DurablePowertoolsLogger(),
    modeAware: true,
  });
}
