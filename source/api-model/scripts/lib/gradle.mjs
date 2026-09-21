// Gradle launcher selection, wrapper/version integrity, and the Brazil-build
// accommodations the generation and verification scripts share.
import { createHash } from "node:crypto";
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { modelDir } from "./paths.mjs";

/**
 * True when running under a Brazil build. BRAZIL_PACKAGE_NAME survives the
 * nested npm chain (peru-build -> npm run build -> npm run --workspace -> node).
 *
 * This is the raw environment signal only. It is NOT sufficient to decide the
 * Gradle path: the AWS Solutions publishing pipeline injects BRAZIL_PACKAGE_NAME
 * on its public build farm, which has no Brazil tooling, so run-gradlew is not on
 * PATH there. Use usesBrazilGradle() for every path-dependent decision.
 */
export function underBrazil(env = process.env) {
  return Boolean(env.BRAZIL_PACKAGE_NAME);
}

/**
 * True when `name` resolves to a file on PATH. Kept env/platform-injectable so
 * the launcher decision can be exercised without a real run-gradlew installed.
 */
export function hasExecutable(
  name,
  env = process.env,
  platform = process.platform,
) {
  const pathVar = env.PATH ?? env.Path ?? "";
  const sep = platform === "win32" ? ";" : ":";
  const exts =
    platform === "win32" ? (env.PATHEXT ?? ".EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of pathVar.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      if (!existsSync(candidate)) continue;
      if (platform === "win32") return true;
      try {
        accessSync(candidate, fsConstants.X_OK);
        return true;
      } catch {
        // A non-executable file cannot be launched by spawnSync.
      }
    }
  }
  return false;
}

/**
 * True only when the Brazil Gradle launcher is actually usable — BRAZIL_PACKAGE_NAME
 * is set AND run-gradlew is on PATH. This is a capability predicate, not just an
 * environment flag: the solutions pipeline sets BRAZIL_PACKAGE_NAME on a farm that
 * lacks run-gradlew (spawnSync ENOENT), so keying off underBrazil() alone would
 * pick the Brazil launcher where it does not exist. Every path-dependent behavior
 * (launcher selection, restoring run-gradlew-mutated files, fingerprint inputs)
 * must branch on this single predicate so they cannot disagree.
 */
export function usesBrazilGradle(
  env = process.env,
  platform = process.platform,
) {
  return underBrazil(env) && hasExecutable("run-gradlew", env, platform);
}

/**
 * Launcher to invoke. Brazil has no internet egress, so the committed wrapper
 * cannot fetch its distribution from services.gradle.org; run-gradlew (from
 * PeruGradle) resolves it from a workspace-local repository instead. Falls back
 * to the committed wrapper whenever run-gradlew is not actually available.
 */
export function gradleCommand(env = process.env, platform = process.platform) {
  if (usesBrazilGradle(env, platform)) return "run-gradlew";
  return platform === "win32" ? "gradlew.bat" : "./gradlew";
}

/**
 * run-gradlew rewrites gradle-wrapper.properties with a workspace-local
 * distributionUrl, dropping the pinned checksum the public path depends on, and
 * appends its own entries to .gitignore. Returns a restore function so a Brazil
 * build leaves no tracked file modified.
 */
export function saveBrazilMutatedFiles(root = modelDir) {
  const files = [
    join(root, "gradle/wrapper/gradle-wrapper.properties"),
    join(root, ".gitignore"),
  ].filter((f) => existsSync(f));
  const originals = files.map((f) => [f, readFileSync(f)]);
  return () => {
    for (const [file, original] of originals) {
      // Restore runs from a finally block, so a missing file must not throw and
      // mask the underlying build failure.
      if (existsSync(file) && readFileSync(file).equals(original)) continue;
      writeFileSync(file, original);
    }
  };
}

/** Gradle version the committed wrapper resolves, e.g. "8.10". */
export function publicGradleVersion(root = modelDir) {
  const file = join(root, "gradle/wrapper/gradle-wrapper.properties");
  if (!existsSync(file)) return null;
  const match = /distributionUrl=.*?gradle-([\d.]+?)-(?:bin|all)\.zip/.exec(
    readFileSync(file, "utf8"),
  );
  return match?.[1] ?? null;
}

/** Gradle version the Brazil path resolves, from the `gradle-version` file. */
export function brazilGradleVersion(root = modelDir) {
  const file = join(root, "gradle-version");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").trim() || null;
}

/**
 * The two build paths pin Gradle independently — the wrapper properties for the
 * public path, `gradle-version` for Brazil — so a bump to one silently diverges
 * from the other and the paths stop generating with the same toolchain.
 *
 * Brazil resolves a version *prefix* to a concrete distribution (8.10 ->
 * 8.10.2), so the check is prefix-based rather than an equality test.
 */
export function assertGradleVersionsAgree(root = modelDir) {
  const pub = publicGradleVersion(root);
  const brazil = brazilGradleVersion(root);
  if (!pub || !brazil) return;
  const agree = pub === brazil || pub.startsWith(`${brazil}.`);
  if (!agree) {
    throw new Error(
      `Gradle pin drift: wrapper resolves ${pub} but gradle-version says ` +
        `${brazil}. Update both so the public and Brazil paths agree.`,
    );
  }
}

/**
 * Verifies the committed wrapper bootstrap against Gradle's published digest.
 * The distribution ZIP has a separate checksum in gradle-wrapper.properties;
 * both controls are required because the bootstrap JAR selects and launches it.
 */
export function assertGradleWrapperIntegrity(root = modelDir) {
  const jar = join(root, "gradle/wrapper/gradle-wrapper.jar");
  const checksumFile = `${jar}.sha256`;
  if (!existsSync(jar) || !existsSync(checksumFile)) {
    throw new Error(
      "Gradle wrapper integrity files are missing; regenerate the wrapper and " +
        "record Gradle's published wrapper JAR SHA-256",
    );
  }
  const expected = readFileSync(checksumFile, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error("Gradle wrapper JAR checksum file is malformed");
  }
  const actual = createHash("sha256").update(readFileSync(jar)).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `Gradle wrapper JAR checksum mismatch: expected ${expected}, got ${actual}`,
    );
  }
}
