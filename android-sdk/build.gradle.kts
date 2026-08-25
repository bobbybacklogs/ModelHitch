plugins {
    id("com.android.application") version "9.3.1" apply false
    id("com.android.library") version "9.3.1" apply false
    id("com.vanniktech.maven.publish") version "0.37.0" apply false
    kotlin("jvm") version "2.2.0" apply false
    kotlin("plugin.compose") version "2.2.0" apply false
    kotlin("plugin.serialization") version "2.2.0" apply false
}

val publicationGroup = providers.gradleProperty("modelhitch.group").get()
val publicationVersion = providers.gradleProperty("modelhitch.version").get()

allprojects {
    group = publicationGroup
    version = publicationVersion
}

tasks.register("validateCentralRelease") {
    group = "publishing"
    description = "Validate version, tag, Central credentials, and signing inputs before publishing."
    doLast {
        require(!publicationVersion.endsWith("-SNAPSHOT")) {
            "Central releases require a non-SNAPSHOT modelhitch.version."
        }
        val expectedTag = "android-v$publicationVersion"
        val releaseTag = providers.environmentVariable("GITHUB_REF_NAME").orNull
            ?: providers.gradleProperty("releaseTag").orNull
        require(releaseTag == expectedTag) {
            "Release tag must be $expectedTag (received ${releaseTag ?: "none"})."
        }
        val requiredProperties = listOf(
            "mavenCentralUsername",
            "mavenCentralPassword",
            "signingInMemoryKey",
            "signingInMemoryKeyPassword",
        )
        val missing = requiredProperties.filter { providers.gradleProperty(it).orNull.isNullOrBlank() }
        require(missing.isEmpty()) {
            "Missing Central release Gradle properties: ${missing.joinToString()}."
        }
    }
}
