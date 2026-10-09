plugins {
    id("com.android.library")
    kotlin("android")
}

android {
    namespace = "com.byotalk.android"
    compileSdk = 35
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}
kotlin { compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_1_8) }

dependencies {
    api(project(":byotalk"))
}
