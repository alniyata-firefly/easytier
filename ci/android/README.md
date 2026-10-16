# Android arm64 release build

`.github/workflows/build-android.yml` is both manually runnable and reusable:

```yaml
jobs:
  android:
    uses: ./.github/workflows/build-android.yml
    secrets: inherit
```

It uploads `android-arm64`, containing the signed APK, its SHA-256 file,
`verification.json`, and `build-manifest.json`. The manifest binds every other
file to the full checked-out commit. The workflow needs only `contents: read`;
it does not publish a release or access a running VPN/controller.

Configure these repository or organization **Secrets**, using the existing
adapted-release keystore:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64 encoding of the complete existing keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Existing store password |
| `ANDROID_KEY_ALIAS` | Existing signing entry alias |
| `ANDROID_KEY_PASSWORD` | Existing private-key password |

No replacement key is generated. Missing secrets fail before toolchain setup;
the certificate and private-key password are checked before compilation. The
public expected certificate fingerprint is pinned in `signing.py`. Signing files
are private temporary files outside the checkout, never uploaded or cached, and
removed on exit. The checked-in historical development key is never used.

## Preserved identity and toolchain

| Item | Value |
| --- | --- |
| Application ID | `com.kkrainbow.easytier.adapted` |
| Java/JNI namespace | `com.kkrainbow.easytier` |
| Version / versionCode | `2.7.2` / `2007003` |
| ABI | `arm64-v8a` |
| Rust / Java / Node | `1.95` / `21` / `22` |
| pnpm / protoc | `10` / `35.1` |
| NDK | `26.0.10792818` |
| Compile / target / minimum SDK | `36` / `34` / `24` |
| AGP / Kotlin / Gradle | `8.10.1` / `2.1.21` / checked-in `8.14.3` wrapper |

The scoped Gradle init overlay adjusts the existing generated Android project
without editing tracked Android sources. Both native compile phases of Tauri's
normal build use the same Android link flags plus
`max-page-size=16384` and `common-page-size=16384`. Explicit
`tauri/custom-protocol` keeps the built React UI embedded alongside Core. Only
crate downloads are cached; native output is rebuilt for the checked-out commit.

`verify_apk.py` checks the actual signer, package identity, SDK/AGP metadata,
arm64 ELF architecture, Core version, native-output hash, the frozen contents of
every React asset (including the React bundle audit and full font notices),
reflected VPN/JNI bridge after R8, every native library's LOAD/RELRO
alignment, and APK ZIP alignment. A 4 KiB or incorrectly signed APK is rejected.
The R8 gate includes `setClientEnabled`, its reflected boolean argument, saved
pause preferences, explicit service-stop APIs and both services' pause guards;
it follows renamed application helpers and closures through the actual mapping.
These checks do not replace installation and VPN tests on an Android device.

## Local use

Install the toolchain listed above, make `pnpm`, `rustc`, `cargo`, and `protoc`
available, export `ANDROID_HOME`, `JAVA_HOME`, and the four signing secrets, then
install the workspace with the frozen pnpm lockfile. The private output directory
must be outside the source checkout:

```bash
python3 ci/android/build.py --source . --output "$RUNNER_TEMP/easytier-android-build" --jobs 2
```

Use a fresh output directory for each run. Full build logs remain private and
are not uploaded. On failure, the first compiler/Gradle error and final 80 lines
are printed after removing signing-secret values and temporary signing paths.
Do not enable shell tracing while supplying secrets. For validation without compiling:

```bash
python3 -m unittest discover -s ci/android -p 'test_*.py'
```

References: [Tauri Android signing](https://v2.tauri.app/distribute/sign/android/),
[Android 16 KiB compatibility](https://developer.android.com/guide/practices/page-sizes),
[GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).
