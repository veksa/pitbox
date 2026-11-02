// A Watch Face Format face: resources only, no code (watch faces with code no longer run on current Wear OS).
// One complication slot whose default data source is the example's own, so a flow can set this face and read
// the complication's value without the system's editor.

plugins {
  id("com.android.application")
}

android {
  namespace = "dev.pitbox.example.wearface"
  compileSdk = 36

  defaultConfig {
    applicationId = "dev.pitbox.example.wearface"
    minSdk = 33
    targetSdk = 36
    versionCode = 1
    versionName = "1.0"
  }
}
