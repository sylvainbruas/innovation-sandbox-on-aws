// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { LogArchivingEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/log-archiving-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import {
  now,
  nowAsIsoDatetimeString,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  CloudWatchLogsClient,
  CreateExportTaskCommand,
  DescribeExportTasksCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { DateTime, Duration } from "luxon";

const testExportPeriodDays = 7;
const testEnv = generateSchemaData(LogArchivingEnvironmentSchema, {
  EXPORT_PERIOD_DAYS: String(testExportPeriodDays),
});

const testLogGroupName = "TestLogGroup";
const testDestinationPrefix = "TestPrefix";
const testDestinationBucketName = "TestBucket";
const logArchivingService = IsbServices.logArchivingService(
  {
    ...testEnv,
  },
  {
    logger: new Logger(),
    logGroupName: testLogGroupName,
    destinationPrefix: testDestinationPrefix,
    destinationBucketName: testDestinationBucketName,
  },
);

const cwLogsMock = mockClient(CloudWatchLogsClient);
const s3Mock = mockClient(S3Client);

const lastExportedTS = now().minus({ days: testExportPeriodDays }).toISO();
s3Mock.on(GetObjectCommand).resolves({
  Body: {
    transformToString: async () => lastExportedTS,
  },
} as any);

beforeAll(async () => {
  bulkStubEnv(testEnv);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.resetAllMocks();
  cwLogsMock.reset();
  s3Mock.reset();
});

describe("Log Archiving Service", () => {
  it("should get the last exported timestamp", async () => {
    const response = await logArchivingService.getLastExportedDateTime();
    expect(response).toEqual(lastExportedTS);
  });

  it("should create an export task and return its taskId", async () => {
    const toTime = now().minus({ days: 1 });
    const fromTime = now().minus({ days: testExportPeriodDays + 1 });
    const currentExportTS = nowAsIsoDatetimeString();
    cwLogsMock.on(CreateExportTaskCommand).resolves({
      taskId: "TestTaskId",
    } as any);
    const taskId = await logArchivingService.createExportTask({
      fromTime,
      toTime,
      currentExportTS,
    });
    expect(taskId).toEqual("TestTaskId");
    assertCreateExportTaskCall(currentExportTS, fromTime, toTime);
  });

  it("should throw exception when taskId isn't returned", async () => {
    const toTime = now().minus({ days: 1 });
    const fromTime = now().minus({ days: testExportPeriodDays + 1 });
    const currentExportTS = nowAsIsoDatetimeString();
    cwLogsMock.on(CreateExportTaskCommand).resolves({} as any);
    await expect(
      logArchivingService.createExportTask({
        fromTime,
        toTime,
        currentExportTS,
      }),
    ).rejects.toThrow(`Exception creating export task for ${testLogGroupName}`);
    assertCreateExportTaskCall(currentExportTS, fromTime, toTime);
  });

  it("should throw exception when create export task fails", async () => {
    const toTime = now().minus({ days: 1 });
    const fromTime = now().minus({ days: testExportPeriodDays + 1 });
    const currentExportTS = nowAsIsoDatetimeString();
    cwLogsMock.on(CreateExportTaskCommand).rejects(new Error("Test Error"));
    await expect(
      logArchivingService.createExportTask({
        fromTime,
        toTime,
        currentExportTS,
      }),
    ).rejects.toThrow(`Exception creating export task for ${testLogGroupName}`);
    assertCreateExportTaskCall(currentExportTS, fromTime, toTime);
  });

  it("should return COMPLETED when export task finishes", async () => {
    cwLogsMock.on(DescribeExportTasksCommand).resolves({
      exportTasks: [{ status: { code: "COMPLETED" } }],
    } as any);
    const status = await logArchivingService.waitForExportTask("TestTaskId", {
      pollInterval: Duration.fromMillis(0),
      maxWait: Duration.fromObject({ seconds: 1 }),
    });
    expect(status).toEqual("COMPLETED");
  });

  it("should poll past PENDING/RUNNING states until terminal", async () => {
    cwLogsMock
      .on(DescribeExportTasksCommand)
      .resolvesOnce({
        exportTasks: [{ status: { code: "PENDING" } }],
      } as any)
      .resolvesOnce({
        exportTasks: [{ status: { code: "RUNNING" } }],
      } as any)
      .resolves({
        exportTasks: [{ status: { code: "COMPLETED" } }],
      } as any);
    const status = await logArchivingService.waitForExportTask("TestTaskId", {
      pollInterval: Duration.fromMillis(0),
      maxWait: Duration.fromObject({ seconds: 5 }),
    });
    expect(status).toEqual("COMPLETED");
  });

  it("should throw when waitForExportTask exceeds the bound", async () => {
    cwLogsMock.on(DescribeExportTasksCommand).resolves({
      exportTasks: [{ status: { code: "RUNNING" } }],
    } as any);
    await expect(
      logArchivingService.waitForExportTask("TestTaskId", {
        pollInterval: Duration.fromMillis(0),
        maxWait: Duration.fromMillis(50),
      }),
    ).rejects.toThrow(/did not finish/);
  });

  function assertCreateExportTaskCall(
    currentExportTS: string,
    fromTime: DateTime,
    toTime: DateTime,
  ) {
    expect(cwLogsMock.calls().length).toEqual(1);

    const createExportTaskCommand = cwLogsMock.commandCalls(
      CreateExportTaskCommand,
    )[0]!.args[0]!.input!;
    expect(createExportTaskCommand).toBeDefined();
    expect(createExportTaskCommand.logGroupName).toEqual(testLogGroupName);
    expect(createExportTaskCommand.destination).toEqual(
      testDestinationBucketName,
    );
    const safeTimestamp = currentExportTS.replace(/[:.]/g, "-");
    expect(createExportTaskCommand.destinationPrefix).toEqual(
      `${testDestinationPrefix}/${testLogGroupName}/${safeTimestamp}`,
    );
    expect(createExportTaskCommand.from).toEqual(fromTime.toMillis());
    expect(createExportTaskCommand.to).toEqual(toTime.toMillis());
  }
});
