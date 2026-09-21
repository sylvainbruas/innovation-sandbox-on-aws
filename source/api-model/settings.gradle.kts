import org.gradle.api.initialization.resolve.RepositoriesMode

rootProject.name = "isb-api-model"

// PeruGradle injects the version set's WIRE repository into settings. Keep
// Maven Central only for public builds; a project-level repository would take
// precedence over WIRE and make the jailed build fleet attempt public DNS.
val wireReadRepositoryAvailable = extra.has("wireReadRepositoryUrl")

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        if (!wireReadRepositoryAvailable) {
            mavenCentral()
        }
    }
}
