// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";

export const LeaseDeniedEventSchema = z.object({
  leaseId: z.string(),
  deniedBy: z.email(),
  userEmail: z.email(),
});

export class LeaseDeniedEvent implements IsbEvent {
  readonly DetailType = EventDetailTypes.LeaseDenied;
  readonly Detail: z.infer<typeof LeaseDeniedEventSchema>;

  constructor(eventData: z.infer<typeof LeaseDeniedEventSchema>) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new LeaseDeniedEvent(LeaseDeniedEventSchema.parse(eventDetail));
  }
}
