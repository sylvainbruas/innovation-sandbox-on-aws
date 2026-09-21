// Filesystem anchors shared by the api-model build scripts. Everything resolves
// from the package root, which is two levels up from this module
// (scripts/lib/ -> scripts/ -> api-model/), so the scripts keep working wherever
// they are invoked from.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The api-model package root. */
export const modelDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
/** The repository (workspace) root, used by compatibility verification's git calls. */
export const repoRoot = resolve(modelDir, "../..");
export const buildDir = join(modelDir, "build");
export const clientDir = join(modelDir, "..", "api-client");
export const serverDir = join(modelDir, "..", "api-server");
export const projections = join(buildDir, "smithyprojections/isb-api-model");
/** The aggregate projection's model dump the parity suite reads. */
export const modelJson = join(projections, "aggregate", "model", "model.json");
/** The aggregate projection's OpenAPI document the doc/tag parity suite reads. */
export const openapiJson = join(
  projections,
  "aggregate",
  "openapi",
  "IsbApi.openapi.json",
);
/** The published, tracked OpenAPI contract (the human-facing document, A9). */
export const publishedOpenapi = join(
  repoRoot,
  "docs",
  "openapi",
  "innovation-sandbox-api.json",
);
/** The published, tracked AWS CLI (C2J) model dir (`aws isb`). */
export const awsCliModelDir = join(repoRoot, "docs", "aws-cli-model");
export const stampFile = join(buildDir, ".generate-inputs.json");
export const lockFile = join(buildDir, ".generate.lock");
