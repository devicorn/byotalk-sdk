plugins {
    kotlin("jvm") version "2.2.10" apply false
    kotlin("plugin.serialization") version "2.2.10" apply false
    kotlin("android") version "2.2.10" apply false
    id("com.android.library") version "8.13.1" apply false
}

allprojects {
    group = "com.byotalk"
    version = "0.1.0"
}
