// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { LeaseLockIntentSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";

export const AssignmentRequestedEventSchema = z.object({
  intent: LeaseLockIntentSchema,
  leaseId: z.string(),
  requestedBy: z.email(),
  lockOwnerId: z.string(),
  leaseOwnerEmail: z.email(),
});

export type AssignmentRequestedEventDetail = z.infer<
  typeof AssignmentRequestedEventSchema
>;

export class AssignmentRequestedEvent implements IsbEvent {
  readonly DetailType = EventDetailTypes.AssignmentRequested;
  readonly Detail: AssignmentRequestedEventDetail;

  constructor(eventData: AssignmentRequestedEventDetail) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new AssignmentRequestedEvent(
      AssignmentRequestedEventSchema.parse(eventDetail),
    );
  }
}
