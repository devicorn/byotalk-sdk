plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
    `maven-publish`
}

kotlin { jvmToolchain(17) }
// Android minSdk 24 runs Java 8 bytecode without desugaring surprises.
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_1_8)
}
java {
    sourceCompatibility = JavaVersion.VERSION_1_8
    targetCompatibility = JavaVersion.VERSION_1_8
}

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    api("com.squareup.okhttp3:okhttp:5.1.0") // 5.x: happy-eyeballs connects (IPv4 + IPv6 raced)
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
    environment("BYOTALK_API_URL", System.getenv("BYOTALK_API_URL") ?: "http://localhost:3100")
    environment("BYOTALK_RT_URL", System.getenv("BYOTALK_RT_URL") ?: "ws://localhost:3001")
    testLogging { events("passed", "skipped", "failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}

publishing {
    publications.create<MavenPublication>("release") {
        artifactId = "byotalk"
        from(components["java"])
    }
}
