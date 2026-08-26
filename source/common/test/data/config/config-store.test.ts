// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ConflictError } from "@amzn/innovation-sandbox-commons/data/config/index.js";
import { describe, expect, it } from "vitest";

describe("ConflictError", () => {
  it("is an Error subclass with the ConflictError name and preserved message", () => {
    const error = new ConflictError("section was modified");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.name).toBe("ConflictError");
    expect(error.message).toBe("section was modified");
  });
});
