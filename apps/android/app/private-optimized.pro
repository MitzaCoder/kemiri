# AndroidX Compose, Coil (including its service discovery) and Firebase supply consumer rules.
# kotlinx.serialization supplies its generated serializer and companion lookup rules. These
# project models are reached through generated serializers; their wire names are string constants,
# so neither the whole protocol package nor Kotlin classes need to be kept by name.

# Optional compatibility scanner: also named by the library manifest, and checked by reflection.
-keepnames class com.journeyapps.barcodescanner.CaptureActivity
