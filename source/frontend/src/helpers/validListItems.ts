// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ZodType } from "zod";

export function toValidListItems<Input, Output>({
  clientName,
  getItemId,
  items,
  itemType,
  mapItem,
  schema,
}: {
  clientName: string;
  getItemId: (item: Input) => string | undefined;
  items: readonly Input[];
  itemType: string;
  mapItem: (item: Input) => unknown;
  schema: ZodType<Output>;
}): Output[] {
  return items.flatMap((item) => {
    const parsed = schema.safeParse(mapItem(item));
    if (parsed.success) {
      return [parsed.data];
    }

    console.warn(
      `[${clientName}] Ignoring invalid ${itemType} returned by API`,
      {
        itemId: getItemId(item) ?? "<missing>",
        issues: parsed.error.issues,
      },
    );
    return [];
  });
}
