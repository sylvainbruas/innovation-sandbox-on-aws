// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { zocker } from "zocker";
import { z } from "zod";

export const generateSchemaData = <T extends z.ZodTypeAny>(
  schema: T,
  overrides?: Partial<z.infer<T>>,
): z.infer<T> =>
  Object.assign({}, zocker(schema).generate(), overrides) as z.infer<T>;
