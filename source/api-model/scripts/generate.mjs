#!/usr/bin/env node
// Runs Smithy codegen and publishes the generated client and server workspace
// packages. Skips the Gradle invocation when nothing that affects the output has
// changed, because the JVM start-up cost would otherwise be paid on every build.
//
// Topology: the model defines one aggregate service (`IsbApi`) that drives the
// client + OpenAPI, and one service per domain (e.g. `LeaseTemplatesApi`) that
// drives that domain's server bindings. smithy-build.json therefore has one
// `aggregate` projection (client + OpenAPI) and one `server-<domain>` projection
// per domain (SSDK). Every domain's generated *sources* land in the single
// committed `@amzn/innovation-sandbox-api-server` package as `domains/<domain>/`,
// exported as the subpath `@amzn/innovation-sandbox-api-server/<domain>` — so each
// Lambda imports only its own domain's bindings while there is one server
// workspace. The package shell (manifest, tsconfigs) is committed, not generated;
// `validateServerManifest` holds it to what codegen requires.
//
// Adding a domain: add a `server-<name>` projection to smithy-build.json (SSDK
// targeting its service), add its operations to both its service and the aggregate
// `IsbApi`, and add its `exports["./<name>"]` entry to the committed
// source/api-server/package.json (validation fails the build until it exists).
// The domain list is derived from smithy-build.json — no separate registry.
//
// This is a thin CLI entry: the reusable pieces live in ./lib/*.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { clientSrc, serverDomains, serverSrc } from "./lib/domains.mjs";
import {
  clearProjection,
  inputHash,
  isModelUpToDate,
  isOpenapiUpToDate,
  isUpToDate,
  modelFingerprint,
  outputFingerprint,
} from "./lib/fingerprint.mjs";
import {
  assertGradleVersionsAgree,
  assertGradleWrapperIntegrity,
  gradleCommand,
  saveBrazilMutatedFiles,
  usesBrazilGradle,
} from "./lib/gradle.mjs";
import { acquireLock, onExit } from "./lib/lifecycle.mjs";
import {
  clientDir,
  modelDir,
  publishedOpenapi,
  serverDir,
} from "./lib/paths.mjs";
import {
  assertManifestMatchesBootstrap,
  publish,
  publishServer,
  rewriteManifest,
} from "./lib/publish.mjs";

export function main(options = {}) {
  const root = options.modelDir ?? modelDir;
  const outputDir = options.clientDir ?? clientDir;
  const outputServerDir = options.serverDir ?? serverDir;
  const outputBuildDir = options.buildDir ?? join(root, "build");
  const outputProjections = join(
    outputBuildDir,
    "smithyprojections/isb-api-model",
  );
  const outputClientSrc = clientSrc(outputProjections);
  const outputModelJson = join(
    outputProjections,
    "aggregate",
    "model",
    "model.json",
  );
  const outputOpenapiJson = join(
    outputProjections,
    "aggregate",
    "openapi",
    "IsbApi.openapi.json",
  );
  const domains = options.domains ?? serverDomains(root);
  const outputStampFile = join(outputBuildDir, ".generate-inputs.json");
  const outputLockFile = join(outputBuildDir, ".generate.lock");
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const runner = options.spawnSync ?? spawnSync;
  const registerExit = options.onExit ?? onExit;
  // The generated OpenAPI is the published, human-facing contract (unlike the
  // gitignored client/server sources). Generation is NON-MUTATING by default: it
  // does not touch the tracked `docs/` copy, so a build never dirties the working
  // tree and `openapi-publication.test.ts` can compare the committed contract
  // against a fresh projection. The tracked copy is refreshed only on the explicit
  // `--write-docs` publish (which regenerates first, under the generation lock).
  const writeDocs = options.writeDocs ?? false;
  const publishedOpenapiJson = options.publishedOpenapiJson ?? publishedOpenapi;
  const publishOpenapiDoc = () => {
    mkdirSync(dirname(publishedOpenapiJson), { recursive: true });
    copyFileSync(outputOpenapiJson, publishedOpenapiJson);
  };

  // Ahead of the cache check, so drift is reported even on an unchanged run.
  assertGradleVersionsAgree(root);
  assertGradleWrapperIntegrity(root);

  const hash = inputHash(root, env);

  // `--write-docs` never takes the fast path: it must publish from a freshly
  // regenerated projection under the generation lock (acquired below), not copy a
  // cache-hit projection lock-free — a concurrent generator could clear the
  // projection between the freshness check and the copy (a TOCTOU).
  if (
    !writeDocs &&
    isUpToDate(hash, outputStampFile, outputDir, "client") &&
    isUpToDate(hash, outputStampFile, outputServerDir, "server", false) &&
    isModelUpToDate(hash, outputStampFile, outputModelJson) &&
    isOpenapiUpToDate(hash, outputStampFile, outputOpenapiJson)
  ) {
    console.log("api-model: inputs unchanged, skipping generation");
    return 0;
  }

  // The client manifest is generated and byte-compared to the checked-in copy
  // after rewriting; the server manifest is committed and only validated, but
  // both must exist up front so the failure comes before the Gradle run.
  const bootstrapManifests = new Map();
  for (const [name, dir] of [
    ["client", outputDir],
    ["server", outputServerDir],
  ]) {
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) {
      console.error(`api-model: expected ${name} manifest at ${manifestPath}`);
      return 1;
    }
    bootstrapManifests.set(name, readFileSync(manifestPath, "utf8"));
  }

  const release = acquireLock(outputBuildDir, outputLockFile);
  const restoreMutated = usesBrazilGradle(env)
    ? saveBrazilMutatedFiles(root)
    : null;
  // Registered together so a signal restores tracked files and frees the lock;
  // the returned function makes the normal path idempotent with the handlers.
  // Release runs in a finally so a failed restore still frees the lock.
  const cleanup = registerExit(() => {
    try {
      restoreMutated?.();
    } finally {
      release();
    }
  });
  try {
    clearProjection(outputProjections);

    // run-gradlew forwards args through, so the task must be passed explicitly;
    // omitting it runs Gradle's default task and produces no codegen.
    const gradlew = gradleCommand(env, platform);
    const result = runner(gradlew, ["build"], {
      cwd: root,
      stdio: "inherit",
      shell: platform === "win32",
    });

    if (result.error) {
      console.error(
        `api-model: could not run ${gradlew}: ${result.error.message}`,
      );
      return 1;
    }
    if (result.status !== 0) {
      return result.status ?? 1;
    }
    if (!existsSync(outputClientSrc)) {
      console.error(
        `api-model: expected generated client at ${outputClientSrc}`,
      );
      return 1;
    }
    const missing = domains.filter(
      (domain) => !existsSync(serverSrc(domain, outputProjections)),
    );
    if (missing.length > 0) {
      console.error(
        `api-model: missing generated server output for: ${missing.join(", ")}`,
      );
      return 1;
    }

    publish(outputClientSrc, outputDir);
    rewriteManifest(outputDir);
    assertManifestMatchesBootstrap(bootstrapManifests.get("client"), outputDir);
    // The server manifest is committed, not generated; publishServer validates it
    // against codegen's requirements, so no bootstrap comparison is needed.
    publishServer(domains, outputProjections, outputServerDir);

    // Stamped only after output is in place, so an interrupted run leaves the
    // cache cold rather than falsely warm.
    const outputs = {
      client: outputFingerprint(outputDir),
      server: outputFingerprint(outputServerDir),
      model: modelFingerprint(outputModelJson),
      openapi: modelFingerprint(outputOpenapiJson),
    };
    writeFileSync(
      outputStampFile,
      `${JSON.stringify({ inputs: hash, outputs }, null, 2)}\n`,
    );
    // Publish the tracked contract only on `--write-docs`; still under the lock
    // this `try` holds, and from the projection just regenerated above.
    if (writeDocs) publishOpenapiDoc();
    console.log(
      "api-model: generated packages published " +
        `(client ${outputs.client.count}, server ${outputs.server.count} ` +
        `files across ${domains.length} domain(s))`,
    );
    return 0;
  } finally {
    cleanup();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    // `--write-docs` refreshes the tracked OpenAPI contract; without it, generation
    // is non-mutating (does not touch `docs/`), so a normal build/CI never dirties it.
    process.exit(main({ writeDocs: process.argv.includes("--write-docs") }));
  } catch (error) {
    console.error(`api-model: ${error.message}`);
    process.exit(1);
  }
}
