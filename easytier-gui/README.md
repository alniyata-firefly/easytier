# GUI for EasyTier

this is a GUI implementation for EasyTier, based on Tauri2.

## Downstream client provenance

This directory builds the Windows and Android clients of the downstream adaptation described in the [repository README](../README_EN.md#project-provenance-and-downstream-changes). The original client foundation and VPN Core come from [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier); Tauri 2 and the existing native VPN integration remain in use. This adaptation replaces the active interface with React, adds management-server/token enrollment, and exposes the supported Core configuration and uplink selection capabilities. The downstream version number does not identify an official EasyTier release.

The console and clients share an independently drawn [blue three-node SVG mark](../assets/brand/easytier.svg). The flat interface is inspired by UniFi's public demonstrations, but this is not a Ubiquiti project and the mark is not a Ubiquiti-provided or authorized icon. The upstream [LGPL-3.0 license](../LICENSE) and contributor notices remain in place. Bundled [HarmonyOS Sans SC and Inter notices](public/fonts/font-notices.html), license files, and [font provenance](public/fonts/provenance.json) are retained separately; the supplied official font subsets are not modified.

The upstream compilation instructions below remain available. Downstream release packages must additionally use the matching source revision, platform configuration, and the release signing configuration; regenerating the Android project or signing key changes package identity and can prevent an in-place upgrade.

## Compile

### Install prerequisites

```
apt install npm
npm install -g pnpm
```

### For Desktop (Win/Mac/Linux)

```
cd ../tauri-plugin-vpnservice
pnpm install
pnpm build

cd ../easytier-web/frontend-lib
pnpm install
pnpm build

cd ../../easytier-gui
pnpm install
pnpm tauri build
```

### For Android

Need to install android SDK / emulator / NDK / Java (easy with android studio)

```
# For ArchLinux
sudo pacman -Sy sdkmanager
sudo sdkmanager --install platform-tools platforms\;android-34 ndk\;r26 build-tools
export PATH=/opt/android-sdk/platform-tools:$PATH
export ANDROID_HOME=/opt/android-sdk/
export NDK_HOME=/opt/android-sdk/ndk/26.0.10792818/
rustup target add aarch64-linux-android

install java 20
```

Java version depend on gradle version specified in (easytier-gui\src-tauri\gen\android\build.gradle.kts)

See [Gradle compatibility matrix](https://docs.gradle.org/current/userguide/compatibility.html) for detail .

```
pnpm install
pnpm tauri android init
pnpm tauri android build
```
