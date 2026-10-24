# Android emulator

How to run the ClubAdmin app on an Android emulator against your local
services, step by step. Written for **Windows with WSL2** (the emulator runs
in Windows, the repository and the services in WSL), the setup with the most
steps; the notes say what differs on Linux and macOS. The short version is in
`development.md`, "Mobile app".

You need the local environment running first (`development.md`, "First
run"): `pnpm dev:services`, demo data (`pnpm db:reset`) and the API
(`pnpm dev`).

There are two ways to get the app onto the emulator:

- **Download the build CI makes on every push** (section 5): no Android
  build tools needed. Logs in with the persona picker (demo data); "Log in
  with email" does not work with it, because it was built against CI's
  Zitadel.
- **Build it yourself** (section 6): needed to test app changes that are
  not pushed yet, and for "Log in with email". The first build compiles every
  native library and takes long.

Sections 1–4 prepare the emulator and are the same for both.

## 1. Install Android Studio and turn on virtualisation (Windows)

1. Install [Android Studio](https://developer.android.com/studio) in
   Windows. It is only needed for the Android SDK and the emulator: **do not
   open the ClubAdmin repository in it.** Opening it from WSL makes Android
   Studio hang on "Detecting project structure" (it reads the whole
   repository, `node_modules` included). If you already did, use *File →
   Close Project*; the welcome screen has *More Actions → Virtual Device
   Manager*.
2. The emulator needs the processor's virtualisation through Windows'
   hypervisor (WSL already uses it):
   - Press the Windows key, type **"Turn Windows features on or off"**
     (Swedish: "Aktivera eller inaktivera Windows-funktioner").
   - Tick **Windows Hypervisor Platform** ("Plattform för Windows-hypervisor").
     "Virtual Machine Platform" is already ticked by WSL; leave it.
   - OK, and **restart Windows**.

   Without this, starting the emulator ends with "Emulator failed to
   connect within 5 minutes".

On Linux the emulator uses KVM (`/dev/kvm`); on macOS it needs nothing extra.

## 2. Create the emulator

In Android Studio's **Device Manager**:

1. **+ → Create Virtual Device → Phone → Pixel 8 → Next.**
2. Choose a system image with **API 34 or 35**, **Google APIs**, **x86_64**
   (arm64 on Apple Silicon). **Not "Google Play"**: Play images do not allow
   `adb root`, which the next steps need. Avoid the newest preview levels.
   Download it with the arrow next to it, then *Next → Finish*.
3. Start it with ▶ once to check that it boots (the first boot takes a few
   minutes). If it does not: ⋮ → *Cold Boot Now*, or set *Graphics* to
   *Software* in the device's settings (pencil → *Show Advanced Settings*).
4. Check in **PowerShell** that Windows sees it:

   ```powershell
   & "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" devices
   ```

   It lists `emulator-5554   device`.

## 3. Use Windows' adb from WSL

`adb` talks to the emulator. Inside WSL there is either no `adb` or one that
cannot see an emulator running in Windows, so `pnpm dev:trust-ca --android`
fails at `adb root`. The repository has a wrapper,
`packages/devtools/wsl/adb`, that runs Windows' `adb.exe` (found through
`%LOCALAPPDATA%`, or `WINDOWS_ADB`) and passes files on the Linux side as
Windows paths. Link it once, in WSL:

```bash
cd ~/ClubAdmin
mkdir -p ~/bin
ln -sf "$PWD/packages/devtools/wsl/adb" ~/bin/adb
grep -q 'HOME/bin' ~/.bashrc || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
adb devices          # lists the same emulator as in PowerShell
```

`~/bin` must come first on `PATH`, before any other `adb`.

On Linux and macOS use the SDK's own `adb` (`platform-tools` on `PATH`).

## 4. Prepare the emulator: names, certificate, port

The app calls `https://api.clubadmin.localhost`. Inside the emulator that
name must point at the emulator itself (127.0.0.1), the emulator must trust
Caddy's local certificate, and its port 443 must be forwarded to your
machine, where Docker Desktop publishes Caddy.

### 4a. The names, once

Android looks names up through the host's DNS servers, which do not know
`*.clubadmin.localhost`. We add them to the emulator's hosts file, which
needs the emulator started with a writable system:

1. Close the emulator (its window, or ■ in Device Manager).
2. In PowerShell, find its name and start it writable. Keep the window open
   while the emulator runs.

   ```powershell
   & "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -list-avds
   & "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -avd Pixel_8_API_35 -writable-system -no-snapshot-load
   ```

3. In WSL, once it has booted:

   ```bash
   adb root
   adb remount
   ```

   The first time, `adb remount` asks you to reboot. Then:

   ```bash
   adb reboot
   adb wait-for-device
   adb root
   adb remount
   ```

4. Add the names and check:

   ```bash
   adb shell "echo '127.0.0.1 clubadmin.localhost api.clubadmin.localhost auth.clubadmin.localhost' >> /system/etc/hosts"
   adb shell cat /system/etc/hosts
   adb shell ping -c 1 api.clubadmin.localhost     # answers from 127.0.0.1
   ```

From now on, **always start the emulator with the PowerShell command in step
2**, not with ▶ in Android Studio: without `-writable-system` the change may
be gone.

On Linux with systemd-resolved the names resolve without this. Otherwise
start the emulator with `-dns-server` pointing at a resolver that answers
them, as CI does (dnsmasq with `--address=/clubadmin.localhost/127.0.0.1`).

### 4b. Certificate and port, after every emulator start

With the services running, in WSL:

```bash
pnpm dev:trust-ca --android
```

It puts Caddy's certificate in the emulator's user certificate store (once;
it stays) and forwards the emulator's port 443 to your machine with
`adb reverse` (lost when the emulator restarts, so run it after each start).

Quick check: open Chrome in the emulator and go to
`https://api.clubadmin.localhost/health/ready` (needs `pnpm dev` running).
It answers without a certificate warning.

## 5. Install the build from CI

Every CI run on `main` keeps the app it tested as the artifact
**clubadmin-android-development** for 14 days: the development variant
(persona picker, trusts the local certificate), with its JavaScript bundled
(no Metro), for x86_64 emulators.

**In the browser:** GitHub → *Actions* → workflow **CI** → the latest green
run on `main` → *Artifacts* → **clubadmin-android-development** (a zip file;
you must be logged in to GitHub). Unzip it to get `app-release.apk`, then in
WSL:

```bash
adb install -r /mnt/c/Users/<you>/Downloads/app-release.apk
```

**With the GitHub CLI** (`gh auth login` once):

```bash
run=$(gh run list --repo SweRavn/ClubAdmin --workflow ci.yml --branch main \
  --status success --limit 1 --json databaseId --jq '.[0].databaseId')
gh run download "$run" --repo SweRavn/ClubAdmin -n clubadmin-android-development -D /tmp/clubadmin-apk
adb install -r /tmp/clubadmin-apk/app-release.apk
```

If `adb install` fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (an
earlier build signed differently), remove the old app first:
`adb uninstall org.clubadmin.app.dev` (this also signs it out).

## 6. Build it yourself (in WSL)

Built as CI builds it: a release build of the development variant, with the
JavaScript bundled, so no Metro server is needed. The emulator and `adb`
stay in Windows; only the build tools are installed in WSL.

### 6a. Java and the Android build tools, once

```bash
sudo apt update && sudo apt install -y openjdk-17-jdk-headless unzip
mkdir -p ~/android-sdk/cmdline-tools && cd ~/android-sdk/cmdline-tools
curl -LO https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
unzip -q commandlinetools-linux-*_latest.zip && mv cmdline-tools latest
cat >> ~/.bashrc <<'EOF'
export ANDROID_HOME="$HOME/android-sdk"
export PATH="$HOME/bin:$PATH:$ANDROID_HOME/cmdline-tools/latest/bin"
EOF
source ~/.bashrc
yes | sdkmanager --licenses
```

If the download answers 404, a newer version exists: copy the link to
"Command line tools only" for Linux from developer.android.com/studio.
Gradle downloads the rest (platform, build tools, NDK) on the first build.
**Do not install `platform-tools` in WSL**, so `adb` stays the wrapper.

### 6b. Give WSL memory and cores

The first build compiles every native library (C++ and Kotlin) and needs
several GB of memory; with too little, WSL swaps and the build can take
hours instead of 15–30 minutes. In Windows, create or edit
`C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
memory=12GB
processors=10
```

(about three quarters of the machine), then `wsl --shutdown` in PowerShell
and open WSL again. Close the emulator while building if memory is tight.
`free -h` in WSL shows the memory: "available" is what counts, not "free".

### 6c. Build and install

```bash
cd ~/ClubAdmin/apps/mobile
for key in AUTH_ISSUER AUTH_MOBILE_CLIENT_ID AUTH_PROJECT_ID; do
  export "$key=$(grep -E "^$key=" ../../.env.local | cut -d= -f2-)"
done
export APP_VARIANT=development
pnpm exec expo prebuild --platform android --no-install
cd android
./gradlew assembleRelease -PreactNativeArchitectures=x86_64 \
  -x lintVitalRelease -x lintVitalAnalyzeRelease -x lintVitalReportRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

**Rebuilding:** run the same commands. Leave out `--clean` on `prebuild`
unless native dependencies or `app.config.ts` changed (after `git pull`,
check `apps/mobile/package.json` and `app.config.ts`): `--clean` deletes
`android/` and with it everything Gradle has compiled, so the next build
starts from scratch. Without it, a rebuild takes minutes.

If the build stops with "OutOfMemory" or "Metaspace", do what CI does and
run `./gradlew` again:

```bash
sed -i 's/^org.gradle.jvmargs=.*/org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g/' gradle.properties
```

## 7. Test

1. Keep `pnpm dev` running in WSL.
2. Open **ClubAdmin** in the emulator's app list and pick a persona (who is
   who: `seed-data.md`). For example Anna (two children in two clubs),
   Erik (leader: take attendance), Liam (English; not called up to IKN
   P2012's match, so it is not in his schedule).
3. After `pnpm db:reset`, sign out in the app (Settings) and in again: the
   app keeps cached data of the old database until then.

**Offline:** airplane mode in the emulator does not cut `adb reverse`, which
does not go over the emulator's network. The app believes it is offline
(the banner shows, and answers and attendance wait in the outbox until
airplane mode is off), but requests such as a persona login still reach the
API. On a real phone neither login works without a network; a login made
earlier stays, so the schedule and attendance work in a hall without
coverage. To test a real loss of the connection, also remove the forwarding
and restore it afterwards:

```bash
adb reverse --remove-all        # the API is now unreachable
pnpm dev:trust-ca --android     # back
```

**Automated flows:** with Maestro installed
(`curl -Ls "https://get.maestro.mobile.dev" | bash`):

```bash
maestro test -e APP_ID=org.clubadmin.app.dev -e APP_SCHEME=clubadmin-dev \
  apps/mobile/maestro/08-answer.yaml
```

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| "Emulator failed to connect within 5 minutes" | Windows Hypervisor Platform is off | Section 1, step 2 |
| Android Studio spins on "Detecting project structure" | The repository is open in Android Studio | *File → Close Project*; it is not needed |
| `pnpm dev:trust-ca --android` fails at `adb root` | WSL's `adb` does not see the emulator, or a "Google Play" image | Section 3; a Google APIs image (section 2) |
| `adb remount` says to reboot | First time with `-writable-system` | `adb reboot`, `adb wait-for-device`, `adb root`, `adb remount` |
| The app cannot reach the server, `ping` does not resolve | Emulator started without `-writable-system`, or the hosts entry is missing | Section 4a |
| The app cannot reach the server, the name resolves | Port forwarding lost after the emulator restarted, or the services/API not running | `pnpm dev:trust-ca --android`; `pnpm dev` |
| Certificate error in the emulator's Chrome | Caddy's certificate not in the emulator (or Caddy's data was deleted) | `pnpm dev:trust-ca --android` |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | A build signed differently is installed | `adb uninstall org.clubadmin.app.dev` |
| The build takes hours | WSL short of memory or cores | Section 6b; no `--clean` on rebuilds |
