import com.vanniktech.maven.publish.AndroidSingleVariantLibrary
import com.vanniktech.maven.publish.JavadocJar
import com.vanniktech.maven.publish.SourcesJar

plugins {
    id("com.android.library")
    id("com.vanniktech.maven.publish")
}

android {
    namespace = "com.genoventureslabs.modelhitch.android"
    compileSdk = 37

    defaultConfig {
        minSdk = 23
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        warningsAsErrors = true
    }

}

dependencies {
    api(project(":modelhitch-core"))
}

mavenPublishing {
    configure(
        AndroidSingleVariantLibrary(
            variant = "release",
            sourcesJar = SourcesJar.Sources(),
            javadocJar = JavadocJar.Empty(),
        ),
    )
    coordinates(project.group.toString(), "modelhitch-android", project.version.toString())
    publishToMavenCentral(automaticRelease = true)
    if (providers.gradleProperty("signingInMemoryKey").isPresent) signAllPublications()
    pom {
        name.set("ModelHitch Android")
        description.set("Native Android ModelHitch SDK with Android Keystore BYOK storage.")
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