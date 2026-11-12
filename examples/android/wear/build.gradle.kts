// The watch half of the example: what only a watch has — a tile, a complication data source and an ambient
// mode — for pitbox's end-to-end run. The phone app (../app) runs on watches too; this one adds the rest.

plugins {
  id("com.android.application")
}

android {
  namespace = "dev.pitbox.example.wear"
  compileSdk = 36

  defaultConfig {
    applicationId = "dev.pitbox.example.wear"
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

dependencies {
  implementation("androidx.activity:activity:1.13.0")
  implementation("androidx.wear:wear:1.4.0")
  implementation("androidx.wear.tiles:tiles:1.6.2")
  implementation("androidx.wear.protolayout:protolayout:1.4.2")
  implementation("androidx.wear.watchface:watchface-complications-data-source-ktx:1.3.0")
  implementation("androidx.concurrent:concurrent-futures:1.3.0")
}
