import com.vanniktech.maven.publish.JavadocJar
import com.vanniktech.maven.publish.KotlinJvm
import com.vanniktech.maven.publish.SourcesJar

plugins {
    id("com.vanniktech.maven.publish")
    kotlin("jvm")
    kotlin("plugin.serialization")
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api("com.squareup.okhttp3:okhttp:5.4.0")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")

    testImplementation(kotlin("test"))
    testImplementation("com.squareup.okhttp3:mockwebserver:5.5.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}

tasks.test {
    useJUnitPlatform()
}

mavenPublishing {
    configure(KotlinJvm(javadocJar = JavadocJar.Empty(), sourcesJar = SourcesJar.Sources()))
    coordinates(project.group.toString(), "modelhitch-core", project.version.toString())
    publishToMavenCentral(automaticRelease = true)
    if (providers.gradleProperty("signingInMemoryKey").isPresent) signAllPublications()
    pom {
        name.set("ModelHitch Kotlin Core")
        description.set("Provider-neutral Kotlin chat, streaming, tools, and model discovery.")
        url.set("https://github.com/bobbybacklogs/ModelHitch")
        licenses {
            license {
                name.set("MIT License")
                url.set("https://opensource.org/license/mit")
                distribution.set("repo")
            }
        }
        developers {
            developer {
                id.set("bobbybacklogs")
                name.set("Geno Ventures Labs")
                organization.set("Geno Ventures Labs")
                organizationUrl.set("https://github.com/bobbybacklogs")
            }
        }
        scm {
            connection.set("scm:git:https://github.com/bobbybacklogs/ModelHitch.git")
            developerConnection.set("scm:git:ssh://git@github.com/bobbybacklogs/ModelHitch.git")
            url.set("https://github.com/bobbybacklogs/ModelHitch")
        }
    }
}