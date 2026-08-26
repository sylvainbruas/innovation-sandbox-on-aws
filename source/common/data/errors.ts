// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export class ConcurrentDataModificationException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentDataModificationException";
  }
}

export class UnknownItem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownItem";
  }
}

export class ItemAlreadyExists extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItemAlreadyExists";
  }
}

export class BatchUnprocessedItemsError extends Error {
  public readonly unprocessedCount: number;

  constructor(unprocessedCount: number) {
    super(`${unprocessedCount} unprocessed item(s) remaining`);
    this.name = "BatchUnprocessedItemsError";
    this.unprocessedCount = unprocessedCount;
  }
}

export class BatchGetUnprocessedKeysError extends Error {
  public readonly unprocessedCount: number;

  constructor(unprocessedCount: number) {
    super(`${unprocessedCount} unprocessed key(s) remaining`);
    this.name = "BatchGetUnprocessedKeysError";
    this.unprocessedCount = unprocessedCount;
  }
}

export class ResourceLockConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceLockConflictError";
  }
}
