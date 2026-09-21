// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  generateValidationMessage,
  type ServiceException,
  type ValidationCustomizer,
} from "@aws-smithy/server-common";

/** A JSend `data.errors[]` entry: dotted field path (or absent) and a message. */
export interface JSendFieldError {
  field?: string;
  message: string;
}

/**
 * Formats a Smithy validation-failure path as the JSend `field` the existing
 * pre-Smithy API used. Smithy failure paths are JSON pointers
 * (`/budgetThresholds/0/dollarsSpent`); the existing pre-Smithy errors — produced by
 * `createHttpJSendValidationError` from a Zod issue path — use dotted segments
 * (`budgetThresholds.0.dollarsSpent`). A whole-payload failure (empty path) maps to
 * `input`, matching that convention.
 */
function toJSendField(path: string): string {
  const field = path.split("/").filter(Boolean).join(".");
  return field === "" ? "input" : field;
}

/**
 * Renders the generated pipeline's Smithy-model-constraint failures as the existing
 * pre-Smithy JSend `ValidationError`. Two reasons it exists — and stays required:
 *
 * 1. **It is mandatory.** The generator runs with `disableDefaultValidation: true`,
 *    so the pipeline ships no built-in validation renderer;
 *    `get<Domain>ApiServiceHandler(service, customizer)` requires a
 *    `ValidationCustomizer`. Something has to turn a failed validate step into a
 *    response.
 * 2. **It bridges the format.** Left to the default, Smithy would answer with its
 *    framework `ValidationException` shape; ISB needs the existing pre-Smithy JSend
 *    body instead — `{ status: "fail", data: { errors: [{ field, message }] } }`, with
 *    Zod-style dotted field paths (see `toJSendField`), no top-level `message`, and
 *    `x-amzn-errortype: ValidationError` (emitted by the generated operation
 *    serializer).
 *
 * It runs during the validate step, before the operation body, and renders every
 * failure the Smithy model *can* express — `@required`, `@length`, `@range` (e.g.
 * `maxResults` `1..2000`), enum, type, and `@timestampFormat`. It has nothing to
 * suppress: a constraint the Smithy model cannot express faithfully is simply left
 * out of the model and is enforced by the operation's Zod re-parse instead (notably `.gt(0)` on the
 * `Double` amount/duration fields, which the inclusive-only `@range` cannot express
 * — see `lease-templates.smithy` — alongside strict unknown keys and refined formats).
 *
 * The concrete `ValidationError` is per-domain — each server package generates its
 * own from the shared model shape — so the caller supplies a `createValidationError`
 * factory that builds *its* domain's error from the JSend field list. This shared
 * customizer owns the field formatting and the blank-top-level-message rule; the
 * factory owns construction, keeping the customizer usable by every domain's
 * `get<Domain>ApiServiceHandler` without importing a single domain's package.
 */
export function jsendValidationCustomizer<Operation extends string>(
  createValidationError: (errors: JSendFieldError[]) => ServiceException,
): ValidationCustomizer<Operation> {
  return (_context, failures) => {
    if (failures.length === 0) {
      return undefined;
    }

    const error = createValidationError(
      failures.map((failure) => ({
        field: toJSendField(failure.path),
        message: generateValidationMessage(failure),
      })),
    );
    // The generated `ValidationError` extends `Error`, so it always carries a
    // `message` string (whatever the factory passed, or `Error`'s default). The
    // Smithy model declares `message` optional and the existing pre-Smithy
    // `ValidationError` body omits it entirely, so clear it to `undefined`: the
    // generated serializer drops undefined members, so the body is `{ status, data }`
    // with no `"message": ""`.
    (error as { message?: string }).message = undefined;
    return error;
  };
}
