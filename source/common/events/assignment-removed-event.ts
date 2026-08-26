// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { PrincipalTypeSchema } from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";

export const AssignmentRemovedEventSchema = z.object({
  leaseId: z.string(),
  principalId: z.string(),
  principalType: PrincipalTypeSchema,
  assigneeEmail: z.email().optional(),
  accountId: z.string(),
  removedBy: z.email(),
  leaseOwner: z.email(),
});

export type AssignmentRemovedEventDetail = z.infer<
  typeof AssignmentRemovedEventSchema
>;

export class AssignmentRemovedEvent implements IsbEvent {
  readonly DetailType = EventDetailTypes.AssignmentRemoved;
  readonly Detail: AssignmentRemovedEventDetail;

  constructor(eventData: AssignmentRemovedEventDetail) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new AssignmentRemovedEvent(
      AssignmentRemovedEventSchema.parse(eventDetail),
    );
  }
}
