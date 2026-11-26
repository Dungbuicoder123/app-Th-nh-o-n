plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services")
}

// Keep generated files outside Desktop folders that may be cloud-synchronized.
layout.buildDirectory.set(
    File(System.getProperty("java.io.tmpdir"), "doanvienso-android-build/app")
)

android {
    namespace = "vn.dongnai.doanvienso"
    compileSdk = 34

    defaultConfig {
        applicationId = "vn.dongnai.doanvienso"
        minSdk = 24
        targetSdk = 34
        versionCode = 10
        versionName = "1.2.5"
    }

    val releasePassword = providers.environmentVariable("DOANVIENSO_SIGNING_PASSWORD")
        .orElse(providers.fileContents(rootProject.layout.projectDirectory.file(".signing/release-password"))
            .asText.map { it.trim() })
        .orNull
    signingConfigs {
        if (releasePassword != null) {
            create("distribution") {
                storeFile = rootProject.file(".signing/doanvienso-release.p12")
                storePassword = releasePassword
                keyAlias = "doanvienso"
                keyPassword = releasePassword
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("distribution")
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:33.9.0"))
    implementation("com.google.firebase:firebase-firestore")
    implementation("com.google.firebase:firebase-auth")
    implementation("com.google.firebase:firebase-storage")
    implementation("com.google.android.gms:play-services-auth:21.2.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("androidx.webkit:webkit:1.11.0")
}
