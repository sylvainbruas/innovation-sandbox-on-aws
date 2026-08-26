// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

type PaginationSchemaOptions = {
  maxPageSize?: number;
  defaultPageSize?: number;
};

export const createPaginationQueryStringParametersSchema = ({
  maxPageSize = 50,
  defaultPageSize = maxPageSize,
}: PaginationSchemaOptions = {}) =>
  z.object({
    pageIdentifier: z.string().optional(),
    maxResults: z.coerce
      .number()
      .int()
      .gt(0)
      .lte(maxPageSize)
      .default(defaultPageSize),
  });

export type PaginationQueryStringParameters = z.infer<
  ReturnType<typeof createPaginationQueryStringParametersSchema>
>;
