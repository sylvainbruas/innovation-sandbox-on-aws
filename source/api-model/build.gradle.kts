// Smithy model for the Innovation Sandbox HTTP API.
//
// smithy-jar (not smithy-base) is required: smithy-base registers only the
// `smithyCli` configuration and cannot resolve `smithyBuild(...)`. java-library
// is required for `implementation(...)`; the Smithy plugins do not apply it.
plugins {
    `java-library`
    id("software.amazon.smithy.gradle.smithy-jar") version "1.2.0"
}

val smithyVersion: String by project
val smithyTypeScriptVersion: String by project

dependencies {
    // Traits the model itself references.
    implementation("software.amazon.smithy:smithy-model:$smithyVersion")
    implementation("software.amazon.smithy:smithy-aws-traits:$smithyVersion")

    // Pinned CLI used by the compatibility check. The smithy-jar plugin
    // creates this configuration but does not add the CLI dependency.
    smithyCli("software.amazon.smithy:smithy-cli:$smithyVersion")

    // Generators, resolved onto the Smithy build classpath.
    smithyBuild("software.amazon.smithy:smithy-openapi:$smithyVersion")
    smithyBuild("software.amazon.smithy:smithy-aws-apigateway-openapi:$smithyVersion")
    smithyBuild(
        "software.amazon.smithy.typescript:smithy-aws-typescript-codegen:$smithyTypeScriptVersion",
    )
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

tasks.register<JavaExec>("smithyDiff") {
    group = "verification"
    description = "Compares two Smithy model directories with the pinned CLI"
    classpath = configurations["smithyCli"]
    mainClass.set("software.amazon.smithy.cli.SmithyCli")
    val diffConfig = layout.buildDirectory.file("smithy-diff-config.json")

    // The Node verification layer applies exact, expiring exceptions to the
    // structured CSV events, so return events even when they are incompatible.
    isIgnoreExitValue = true
    doFirst {
        val configFile = diffConfig.get().asFile
        configFile.parentFile.mkdirs()
        configFile.writeText(
            """
            {
              "version": "1.0",
              "maven": {
                "dependencies": [
                  "software.amazon.smithy:smithy-aws-traits:$smithyVersion"
                ]
              }
            }
            """.trimIndent(),
        )
        args = listOf(
            "diff",
            "--config",
            configFile.absolutePath,
            "--mode",
            "arbitrary",
            "--old",
            providers.gradleProperty("oldModel").get(),
            "--new",
            providers.gradleProperty("newModel").get(),
            "--severity",
            "DANGER",
            "--format",
            "csv",
            "--no-color",
        )
    }
}
