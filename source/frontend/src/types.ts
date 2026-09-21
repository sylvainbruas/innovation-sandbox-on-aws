// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export interface ApiSuccessResponse<T> {
  status: "success";
  data: T;
}

export interface ApiFailResponse {
  status: "fail";
  data: object;
}

export interface ApiErrorResponse {
  status: "error";
  code: number;
  message: string;
  data: object;
}

export type ApiResponse<T> =
  ApiSuccessResponse<T> | ApiFailResponse | ApiErrorResponse;

export interface ApiPaginatedResult<T> {
  result: T[];
  nextPageIdentifier: string | null;
}
