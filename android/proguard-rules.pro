# Consumer rules: pitbox's push receiver (debug variant only) reaches these Firebase classes by reflection, so a
# minified debug build must keep their names. Classes that are absent (no Firebase in the app) make these rules
# no-ops; in a release build they keep only the few Firebase members named here, which the app's own Firebase uses.
-keep class com.google.firebase.messaging.FcmBroadcastProcessor { <init>(android.content.Context); *** process(android.content.Intent); }
-keep class com.google.firebase.messaging.ServiceStarter { *** getInstance(); *** startMessagingService(android.content.Context, android.content.Intent); }
-keep class com.google.android.gms.tasks.Tasks { *** await(com.google.android.gms.tasks.Task, long, java.util.concurrent.TimeUnit); }
-keep class com.google.android.gms.tasks.Task
-keep class com.google.firebase.FirebaseApp { *** getApps(android.content.Context); }
-dontwarn com.google.firebase.**
-dontwarn com.google.android.gms.tasks.**
