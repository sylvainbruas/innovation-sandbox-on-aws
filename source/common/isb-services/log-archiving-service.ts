// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ServiceEnv } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  CloudWatchLogsClient,
  CreateExportTaskCommand,
  DescribeExportTasksCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { DateTime, Duration } from "luxon";

export interface LogArchivingServiceProps {
  logger: Logger;
  logGroupName: string;
  destinationPrefix: string;
  destinationBucketName: string;
}

export class LogArchivingService {
  private readonly logger: Logger;
  private readonly logGroupName: string;
  private readonly destinationPrefix: string;
  private readonly destinationBucketName: string;
  private readonly s3Client: S3Client;
  private readonly logsClient: CloudWatchLogsClient;

  constructor(
    env: ServiceEnv.logArchivingService,
    props: LogArchivingServiceProps,
  ) {
    this.logger = props.logger;
    this.logGroupName = props.logGroupName;
    this.destinationPrefix = props.destinationPrefix;
    this.destinationBucketName = props.destinationBucketName;
    this.s3Client = IsbClients.s3({
      USER_AGENT_EXTRA: env.USER_AGENT_EXTRA,
    });
    this.logsClient = IsbClients.cloudWatchLogs({
      USER_AGENT_EXTRA: env.USER_AGENT_EXTRA,
    });
  }

  async getLastExportedDateTime(): Promise<string | undefined> {
    try {
      const lastExportedKey = `${this.destinationPrefix}/${this.logGroupName}/LAST_EXPORT_TS`;
      const command = new GetObjectCommand({
        Bucket: this.destinationBucketName,
        Key: lastExportedKey,
      });

      const response = await this.s3Client.send(command);
      if (response.Body) {
        return await response.Body.transformToString();
      }
      return undefined;
    } catch (error) {
      if (error instanceof NoSuchKey) {
        return undefined;
      } else {
        this.logger.error(
          `Unexpected Exception getting last exported date time for ${this.logGroupName}`,
          { error },
        );
        throw error;
      }
    }
  }

  async createExportTask(props: {
    fromTime: DateTime;
    toTime: DateTime;
    currentExportTS: string;
  }): Promise<string> {
    const { fromTime, toTime, currentExportTS } = props;

    const safeTimestamp = currentExportTS.replace(/[:.]/g, "-");
    this.logger.info({
      message: `Creating export task for ${this.logGroupName}...`,
      fromTime,
      toTime,
    });

    const toTimeMs = Math.floor(toTime.toMillis());
    let fromTimeMs = Math.floor(fromTime.toMillis());

    const s3KeyPrefix = `${this.destinationPrefix}/${this.logGroupName}/${safeTimestamp}`;

    try {
      const command = new CreateExportTaskCommand({
        logGroupName: this.logGroupName,
        from: fromTimeMs,
        to: toTimeMs,
        destination: this.destinationBucketName,
        destinationPrefix: s3KeyPrefix,
      });

      const response = await this.logsClient.send(command);
      this.logger.debug({
        message: "Export task response",
        ...response,
      });
      if (response.taskId) {
        this.logger.info({
          message: `Created export task for log group`,
          taskId: response.taskId,
        });
        return response.taskId;
      }
      this.logger.error({
        message: "Failed to get taskId for log export",
        response,
      });
      throw new Error(`Failed to get taskId for ${this.logGroupName} export.`);
    } catch (error) {
      this.logger.error({
        message: "Error creating export task",
        error,
      });
      throw new Error(
        `Exception creating export task for ${this.logGroupName}.`,
        error as Error,
      );
    }
  }

  /**
   * Polls DescribeExportTasks until the task reaches a terminal state
   * (COMPLETED, FAILED, or CANCELLED). Bounded so the Lambda cannot exceed its
   * timeout. Returns the final status code; throws if the bound is hit.
   */
  async waitForExportTask(
    taskId: string,
    opts: { pollInterval?: Duration; maxWait?: Duration } = {},
  ): Promise<string> {
    const pollInterval =
      opts.pollInterval ?? Duration.fromObject({ seconds: 10 });
    const maxWait = opts.maxWait ?? Duration.fromObject({ minutes: 12 }); // under 15-min Lambda cap
    const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
    const deadline = DateTime.utc().plus(maxWait);

    while (true) {
      const response = await this.logsClient.send(
        new DescribeExportTasksCommand({ taskId }),
      );
      const status = response.exportTasks?.[0]?.status?.code;
      if (status && terminal.has(status)) {
        this.logger.info({
          message: "Export task reached terminal state",
          taskId,
          status,
        });
        return status;
      }
      if (DateTime.utc() >= deadline) {
        throw new Error(
          `Export task ${taskId} for ${this.logGroupName} did not finish within ${maxWait.toHuman()} (last status: ${status ?? "unknown"})`,
        );
      }
      await new Promise((r) => setTimeout(r, pollInterval.toMillis()));
    }
  }

  async saveLastExportedDateTime(toTime: DateTime<true>): Promise<void> {
    const lastExportedKey = `${this.destinationPrefix}/${this.logGroupName}/LAST_EXPORT_TS`;
    const command = new PutObjectCommand({
      Bucket: this.destinationBucketName,
      Key: lastExportedKey,
      Body: toTime.toISO(),
    });
    await this.s3Client.send(command);
    this.logger.info({
      message: "Saved last exported datetime",
      lastExportedDateTime: toTime,
    });
  }
}
