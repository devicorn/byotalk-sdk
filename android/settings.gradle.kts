pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "byotalk-android-sdk"
include(":byotalk")
// The Android helper needs an Android SDK; JVM-only machines (CI) build and test the core module alone.
if (file("local.properties").exists() || System.getenv("ANDROID_HOME") != null) include(":byotalk-android")
