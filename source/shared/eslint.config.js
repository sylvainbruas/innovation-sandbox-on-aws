// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { builtinModules } from "node:module";

import tsParser from "@typescript-eslint/parser";

const nodeImportMessage =
  "The shared package is browser-safe and must not import Node built-ins.";
const boundaryImportMessage =
  "The shared package must not depend on backend, frontend, AWS, Lambda, or Middy packages.";

const nodeBuiltinRestrictions = [
  ...new Set(
    builtinModules.map((moduleName) => moduleName.replace(/^node:/, "")),
  ),
].map((name) => ({
  name,
  message: nodeImportMessage,
}));

export default [
  {
    ignores: ["dist", "node_modules"],
  },
  {
    files: ["types/**/*.ts", "utils/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: nodeBuiltinRestrictions,
          patterns: [
            {
              group: ["node:*"],
              message: nodeImportMessage,
            },
            {
              group: [
                "@amzn/innovation-sandbox-commons",
                "@amzn/innovation-sandbox-commons/**",
                "@amzn/innovation-sandbox-frontend",
                "@amzn/innovation-sandbox-frontend/**",
                "@aws-lambda-powertools",
                "@aws-lambda-powertools/**",
                "@aws-sdk",
                "@aws-sdk/**",
                "@middy",
                "@middy/**",
              ],
              message: boundaryImportMessage,
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "Dynamic imports are not allowed in the statically analyzable shared package.",
        },
        {
          selector: "CallExpression[callee.name='require']",
          message:
            "CommonJS require calls are not allowed in the ESM shared package.",
        },
      ],
    },
  },
];
