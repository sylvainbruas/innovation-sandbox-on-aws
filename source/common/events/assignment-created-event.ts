// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { PrincipalTypeSchema } from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";

export const AssignmentCreatedEventSchema = z.object({
  leaseId: z.string(),
  principalId: z.string(),
  principalType: PrincipalTypeSchema,
  assigneeEmail: z.email().optional(),
  accountId: z.string(),
  addedBy: z.email(),
  leaseOwner: z.email(),
});

export type AssignmentCreatedEventDetail = z.infer<
  typeof AssignmentCreatedEventSchema
>;

export class AssignmentCreatedEvent implements IsbEvent {
  readonly DetailType = EventDetailTypes.AssignmentCreated;
  readonly Detail: AssignmentCreatedEventDetail;

  constructor(eventData: AssignmentCreatedEventDetail) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new AssignmentCreatedEvent(
      AssignmentCreatedEventSchema.parse(eventDetail),
    );
  }
}
