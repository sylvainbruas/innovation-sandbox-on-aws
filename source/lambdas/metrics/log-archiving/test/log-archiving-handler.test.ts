// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LogArchivingService } from "@amzn/innovation-sandbox-commons/isb-services/log-archiving-service.js";
import { LogArchivingEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/log-archiving-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { handler } from "@amzn/innovation-sandbox-log-archiving/log-archiving-handler.js";
import { DateTime } from "luxon";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const testExportPeriodDays = 7;
const testEnv = generateSchemaData(LogArchivingEnvironmentSchema, {
  EXPORT_PERIOD_DAYS: String(testExportPeriodDays),
  LOG_GROUP_NAMES: "TestLogGroup",
});
const mockedContext = mockContext(testEnv);
const scheduleEvent = {};
const createExportTaskSpy = vi
  .spyOn(LogArchivingService.prototype, "createExportTask")
  .mockResolvedValue("task-id");
const waitForExportTaskSpy = vi
  .spyOn(LogArchivingService.prototype, "waitForExportTask")
  .mockResolvedValue("COMPLETED");
const saveLastExportedDateTimeSpy = vi
  .spyOn(LogArchivingService.prototype, "saveLastExportedDateTime")
  .mockResolvedValue(undefined);

beforeAll(async () => {
  bulkStubEnv(testEnv);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("log-archiving-handler", () => {
  it("should create a successful export task when called the first time", async () => {
    const getLastExportedDateTimeSpy = vi
      .spyOn(LogArchivingService.prototype, "getLastExportedDateTime")
      .mockResolvedValue(undefined);
    await handler(scheduleEvent, mockedContext);
    expect(getLastExportedDateTimeSpy).toHaveBeenCalledWith();
    expect(createExportTaskSpy).toHaveBeenCalledWith({
      fromTime: expect.any(DateTime),
      toTime: expect.any(DateTime),
      currentExportTS: expect.any(String),
    });
    expect(waitForExportTaskSpy).toHaveBeenCalledWith("task-id");
    expect(saveLastExportedDateTimeSpy).toHaveBeenCalledTimes(1);
  });

  it("should create a successful export task when called at the right time", async () => {
    const getLastExportedDateTimeSpy = vi
      .spyOn(LogArchivingService.prototype, "getLastExportedDateTime")
      .mockResolvedValue(now().minus({ days: testExportPeriodDays }).toISO());
    await handler(scheduleEvent, mockedContext);
    expect(getLastExportedDateTimeSpy).toHaveBeenCalledWith();
    expect(createExportTaskSpy).toHaveBeenCalledWith({
      fromTime: expect.any(DateTime),
      toTime: expect.any(DateTime),
      currentExportTS: expect.any(String),
    });
    expect(saveLastExportedDateTimeSpy).toHaveBeenCalledTimes(1);
  });

  it("should not create an export task when called too frequently", async () => {
    const getLastExportedDateTimeSpy = vi
      .spyOn(LogArchivingService.prototype, "getLastExportedDateTime")
      .mockResolvedValue(now().minus({ days: 1 }).toISO());
    await handler(scheduleEvent, mockedContext);
    expect(getLastExportedDateTimeSpy).toHaveBeenCalledWith();
    expect(createExportTaskSpy).not.toHaveBeenCalled();
    expect(waitForExportTaskSpy).not.toHaveBeenCalled();
    expect(saveLastExportedDateTimeSpy).not.toHaveBeenCalled();
  });

  it("should create a successful export task with the default period when the last exported date is invalid", async () => {
    const getLastExportedDateTimeSpy = vi
      .spyOn(LogArchivingService.prototype, "getLastExportedDateTime")
      .mockResolvedValue("Invalid Date");
    await handler(scheduleEvent, mockedContext);
    expect(getLastExportedDateTimeSpy).toHaveBeenCalledWith();
    expect(createExportTaskSpy).toHaveBeenCalledWith({
      fromTime: expect.any(DateTime),
      toTime: expect.any(DateTime),
      currentExportTS: expect.any(String),
    });
    expect(saveLastExportedDateTimeSpy).toHaveBeenCalledTimes(1);
  });

  it("should serially export every log group from LOG_GROUP_NAMES", async () => {
    vi.spyOn(
      LogArchivingService.prototype,
      "getLastExportedDateTime",
    ).mockResolvedValue(undefined);
    const multiEnv = {
      ...testEnv,
      LOG_GROUP_NAMES:
        "ISBLogGroup, ISBLogGroup-Cleanup, ISBLogGroup-Auth, ISBLogGroup-CustomResources",
    };
    bulkStubEnv(multiEnv);
    try {
      await handler(scheduleEvent, mockContext(multiEnv));
      expect(createExportTaskSpy).toHaveBeenCalledTimes(4);
      expect(waitForExportTaskSpy).toHaveBeenCalledTimes(4);
      expect(saveLastExportedDateTimeSpy).toHaveBeenCalledTimes(4);
    } finally {
      bulkStubEnv(testEnv);
    }
  });

  it("should continue past a failed log group and surface the failure", async () => {
    vi.spyOn(
      LogArchivingService.prototype,
      "getLastExportedDateTime",
    ).mockResolvedValue(undefined);
    // Second group's wait reports a non-COMPLETED terminal status.
    waitForExportTaskSpy.mockResolvedValueOnce("COMPLETED");
    waitForExportTaskSpy.mockResolvedValueOnce("FAILED");
    waitForExportTaskSpy.mockResolvedValueOnce("COMPLETED");

    const multiEnv = {
      ...testEnv,
      LOG_GROUP_NAMES: "a,b,c",
    };
    bulkStubEnv(multiEnv);
    try {
      await expect(
        handler(scheduleEvent, mockContext(multiEnv)),
      ).rejects.toThrow(/Log archiving failed for 1\/3/);

      expect(createExportTaskSpy).toHaveBeenCalledTimes(3);
      expect(waitForExportTaskSpy).toHaveBeenCalledTimes(3);
      // Marker is only saved for successful groups.
      expect(saveLastExportedDateTimeSpy).toHaveBeenCalledTimes(2);
    } finally {
      bulkStubEnv(testEnv);
    }
  });
});
