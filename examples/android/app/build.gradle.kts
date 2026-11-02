// A small native app that pitbox's own end-to-end tests drive: no framework, no AndroidX.

plugins {
  id("com.android.application")
}

android {
  namespace = "dev.pitbox.example"
  compileSdk = 36

  defaultConfig {
    applicationId = "dev.pitbox.example"
    minSdk = 24
    targetSdk = 36
    versionCode = 1
    versionName = "1.0"
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

kotlin {
  jvmToolchain(21)
}
