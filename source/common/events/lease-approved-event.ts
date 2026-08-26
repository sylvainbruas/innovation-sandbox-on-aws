// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { ApprovedBySchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";

export const LeaseApprovedEventSchema = z.object({
  leaseId: z.string(),
  approvedBy: ApprovedBySchema,
  userEmail: z.email(),
});

export class LeaseApprovedEvent implements IsbEvent {
  readonly DetailType = EventDetailTypes.LeaseApproved;
  readonly Detail: z.infer<typeof LeaseApprovedEventSchema>;

  constructor(eventData: z.infer<typeof LeaseApprovedEventSchema>) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new LeaseApprovedEvent(LeaseApprovedEventSchema.parse(eventDetail));
  }
}
