import java.util.Properties
import java.io.File
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Keep private adaptation signing material outside the Git checkout. The
// repository's public development keystore must never sign adapted releases.
val privateKeystorePropertiesFile = System.getenv("ET_ANDROID_KEYSTORE_PROPERTIES")
    ?.takeIf { it.isNotBlank() }
    ?.let { File(it) }
val privateKeystoreProperties = Properties().apply {
    if (privateKeystorePropertiesFile != null) {
        check(privateKeystorePropertiesFile.isFile) {
            "ET_ANDROID_KEYSTORE_PROPERTIES must point to a private signing properties file"
        }
        privateKeystorePropertiesFile.inputStream().use { load(it) }
        for (property in listOf("keyAlias", "keyPassword", "storeFile", "storePassword")) {
            check(!getProperty(property).isNullOrBlank()) {
                "Private signing properties are missing $property"
            }
        }
    }
}

val versionPattern = Regex("""^(\d+)\.(\d+)\.(\d+)$""")

val tauriConfFile = file("../../../tauri.conf.json")
check(tauriConfFile.exists()) { "Missing tauri.conf.json at ${tauriConfFile.path}" }
val tauriConf = tauriConfFile.reader(Charsets.UTF_8).use { JsonSlurper().parse(it) as? Map<*, *> }
    ?: error("Failed to parse ${tauriConfFile.path} as a JSON object")
val tauriVersionName = tauriConf["version"] as? String
    ?: error("Missing string field \"version\" in ${tauriConfFile.path}")
val versionNameProp = tauriProperties.getProperty("tauri.android.versionName")?.ifBlank { null }
check(versionNameProp == null || versionNameProp == tauriVersionName) {
    "Property \"tauri.android.versionName\" conflicts with tauri.conf.json version"
}

val tauriVersionMatch = versionPattern.matchEntire(tauriVersionName)
    ?: error("Android version must use x.y.z format, but got \"$tauriVersionName\"")

val configuredVersionCode = ((tauriConf["bundle"] as? Map<*, *>)?.get("android") as? Map<*, *>)?.get("versionCode")
val tauriVersionCode = if (configuredVersionCode != null) {
    check(configuredVersionCode is Number) { "bundle.android.versionCode must be an integer" }
    configuredVersionCode.toString().toIntOrNull()
        ?: error("bundle.android.versionCode must be an integer within Android's supported range")
} else {
    val (major, minor, patch) = tauriVersionMatch.destructured
    (major.toLong() * 1_000_000 + minor.toLong() * 1_000 + patch.toLong()).also {
        check(it in 1..2_100_000_000L) { "Derived Android versionCode is outside the supported range" }
    }.toInt()
}
check(tauriVersionCode in 1..2_100_000_000) { "Android versionCode is outside the supported range" }
val versionCodeProp = tauriProperties.getProperty("tauri.android.versionCode")?.ifBlank { null }
if (versionCodeProp != null) {
    val propertyVersionCode = versionCodeProp.toIntOrNull()
        ?: error("Property \"tauri.android.versionCode\" must be an integer")
    check(propertyVersionCode == tauriVersionCode) {
        "Property \"tauri.android.versionCode\" conflicts with tauri.conf.json Android versionCode"
    }
}

android {
    compileSdk = 34
    namespace = "com.kkrainbow.easytier"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.kkrainbow.easytier"
        minSdk = 24
        targetSdk = 34
        versionCode = tauriVersionCode
        versionName = tauriVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        if (privateKeystorePropertiesFile != null) {
            create("adaptedRelease") {
                keyAlias = privateKeystoreProperties.getProperty("keyAlias")
                keyPassword = privateKeystoreProperties.getProperty("keyPassword")
                storeFile = File(privateKeystoreProperties.getProperty("storeFile"))
                check(storeFile?.isFile == true) { "Private signing keystore does not exist" }
                storePassword = privateKeystoreProperties.getProperty("storePassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".adapted.debug"
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            applicationIdSuffix = ".adapted"
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
            signingConfig = signingConfigs.findByName("adaptedRelease")
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

gradle.taskGraph.whenReady {
    val buildsRelease = allTasks.any { it.project == project && it.name.contains("Release", ignoreCase = true) }
    check(!buildsRelease || privateKeystorePropertiesFile != null) {
        "Adapted release APKs require ET_ANDROID_KEYSTORE_PROPERTIES; the public repository key is not used"
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.6.1")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.8.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test:runner:1.5.2")
    androidTestImplementation("androidx.test:core:1.5.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
