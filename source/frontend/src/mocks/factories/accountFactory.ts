// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  SandboxAccountView,
  SandboxAccountViewSchema,
  UnregisteredAccountView,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/model";
import { generateSchemaData } from "@amzn/innovation-sandbox-shared/test/generate-schema-data";

export function createSandboxAccount(
  overrides?: Partial<SandboxAccountView>,
): SandboxAccountView {
  return generateSchemaData(SandboxAccountViewSchema, overrides);
}

// The shared fixtures pin resourceLock to undefined: zocker would otherwise
// randomly generate one (it is optional in the schema), and a randomly-live
// lock disables the retry-cleanup actions, making tests flaky.
export const mockAvailableAccount = createSandboxAccount({
  status: "Available",
  resourceLock: undefined,
});
export const mockActiveAccount = createSandboxAccount({
  status: "Active",
  resourceLock: undefined,
});
export const mockQuarantineAccount = createSandboxAccount({
  status: "Quarantine",
  resourceLock: undefined,
});
export const mockCleanUpAccount = createSandboxAccount({
  status: "CleanUp",
  resourceLock: undefined,
});

export const mockUnregisteredAccounts: UnregisteredAccountView[] = [
  {
    Id: "123456789012",
    Email: "test1@example.com",
    Name: "Test Account 1",
  },
  {
    Id: "210987654321",
    Email: "test2@example.com",
    Name: "Test Account 2",
  },
];
