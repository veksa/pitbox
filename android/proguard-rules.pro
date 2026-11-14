# Consumer rules of the debug variant only (android/build.gradle): pitbox's push receiver reaches these Firebase
# classes by reflection, so a minified debug build must keep their names. Classes that are absent (no Firebase in
# the app) make these rules no-ops. A release build of an app gets none of them.
-keep class com.google.firebase.messaging.FcmBroadcastProcessor { <init>(android.content.Context); *** process(android.content.Intent); }
-keep class com.google.firebase.messaging.ServiceStarter { *** getInstance(); *** startMessagingService(android.content.Context, android.content.Intent); }
-keep class com.google.android.gms.tasks.Tasks { *** await(com.google.android.gms.tasks.Task, long, java.util.concurrent.TimeUnit); }
-keep class com.google.android.gms.tasks.Task
-keep class com.google.firebase.FirebaseApp { *** getApps(android.content.Context); }
-dontwarn com.google.firebase.**
-dontwarn com.google.android.gms.tasks.**
