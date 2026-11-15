// The Wear OS relay example: one APK for both the phone and the watch (the Data Layer joins an app only with its
// own package and key), with a Ping button and a WearableListenerService that answers a ping with a pong — what
// `device action=pair value=watch` between two emulators is checked with (scripts/e2e-wear-pair.mjs).
//
// Its Data Layer calls go through `DataLayer`: pitbox's stand-in in the debug source set, Play services in the
// release one — the seam an app adds to use the relay. The connect library comes as the AAR `yarn check-connect`
// builds (android/build/outputs/aar), debug only.

plugins {
  id("com.android.application")
}

android {
  namespace = "dev.pitbox.example.relay"
  compileSdk = 36

  defaultConfig {
    applicationId = "dev.pitbox.example.relay"
    minSdk = 30
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

val connectAar = file("../../../android/build/outputs/aar/connect-debug.aar")

dependencies {
  implementation("com.google.android.gms:play-services-wearable:19.0.0")
  debugImplementation(files(connectAar))
}

// Only this module needs the AAR: the rest of the example builds without it.
tasks.named("preBuild") {
  doFirst {
    if (!connectAar.exists()) throw GradleException("no connect library AAR at $connectAar: run `yarn check-connect` in the pitbox root first")
  }
}
