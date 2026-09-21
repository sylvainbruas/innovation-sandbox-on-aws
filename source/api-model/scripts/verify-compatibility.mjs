#!/usr/bin/env node
// Verifies backward compatibility of the Smithy model against an explicit
// reference tip: `node scripts/verify-compatibility.mjs --reference <branch-or-tag>`.
// The reusable logic lives in ./lib/compatibility.mjs.
import { fileURLToPath } from "node:url";

import { verifyCompatibility } from "./lib/compatibility.mjs";

/** Parses the only accepted flag, `--reference <branch-or-tag>`. */
export function parseArguments(args) {
  let reference;
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === "--reference" && args[i + 1]) {
      reference = args[++i];
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  if (!reference) {
    throw new Error(
      "compatibility verification requires --reference <branch-or-tag>",
    );
  }
  return { reference };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { reference } = parseArguments(process.argv.slice(2));
    verifyCompatibility({ reference });
  } catch (error) {
    console.error(`api-model: ${error.message}`);
    process.exit(1);
  }
}
