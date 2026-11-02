// The pitbox Android runner: an instrumentation APK that serves UI automation over a local socket.
// No AndroidX — the APK stays small and installs in a second.

plugins {
  id("com.android.application") version "9.2.1"
}

android {
  namespace = "dev.pitbox.runner"
  compileSdk = 36

  defaultConfig {
    applicationId = "dev.pitbox.runner"
    minSdk = 24
    targetSdk = 36
    // Bumped with every protocol change; the host reinstalls the runner when it differs.
    versionCode = 8
    versionName = "0.1.0"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig = signingConfigs.getByName("debug")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

kotlin {
  jvmToolchain(21)
}
