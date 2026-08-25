plugins {
    id("com.android.library") version "9.3.1"
}

android {
    namespace = "external.modelhitch.consumer"
    compileSdk = 36

    defaultConfig {
        minSdk = 23
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("io.github.bobbybacklogs.modelhitch:modelhitch-android:0.1.0")
}