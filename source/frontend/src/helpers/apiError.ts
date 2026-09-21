// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const NO_ACTIVE_SESSION_MESSAGE = "No active session";

/**
 * Error thrown for non-OK HTTP responses. Carries the HTTP status code and the
 * JSend `data` payload so callers can branch on specific statuses (e.g. 429)
 * and read structured fields (e.g. data.retryAt) that the message alone omits.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly data?: Record<string, any>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
