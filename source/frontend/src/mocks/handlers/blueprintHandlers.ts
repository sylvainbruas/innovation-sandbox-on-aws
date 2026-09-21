// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { BlueprintWithStackSetsView } from "@amzn/innovation-sandbox-frontend/domains/blueprints/model";
import { createBlueprintWithStackSets } from "@amzn/innovation-sandbox-frontend/mocks/factories/blueprintFactory";
import { mockBlueprintApi } from "@amzn/innovation-sandbox-frontend/mocks/mockApi";

export const mockBlueprint: BlueprintWithStackSetsView =
  createBlueprintWithStackSets();
mockBlueprintApi.returns([mockBlueprint]);

export const blueprintHandlers = [
  mockBlueprintApi.getHandler(),
  mockBlueprintApi.getHandler("/:id"),
  mockBlueprintApi.postHandler(),
  mockBlueprintApi.putHandler("/:id"),
  mockBlueprintApi.deleteHandler("/:id"),
];
