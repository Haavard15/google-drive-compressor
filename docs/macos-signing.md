# macOS Signing Setup

This desktop app is configured to support:

- local macOS code signing
- GitHub Actions signing with a temporary keychain
- optional notarization for smoother Gatekeeper experience

## What you need

1. A `Developer ID Application` certificate exported as a `.p12`
2. The `.p12` password
3. Your Apple ID email
4. An Apple app-specific password
5. Your Apple Developer Team ID

Note: a normal `Apple Development` identity is not enough for a proper downloadable release. For public distribution you want `Developer ID Application`.

## Local signing on your Mac

Import the `.p12` into your login keychain:

```bash
security import /path/to/DeveloperIDApplication.p12 \
  -k ~/Library/Keychains/login.keychain-db \
  -P "YOUR_P12_PASSWORD" \
  -T /usr/bin/codesign \
  -T /usr/bin/productsign
```

Check that the identity is available:

```bash
security find-identity -v -p codesigning
```

You should see a `Developer ID Application: ...` identity.

Build a signed DMG locally:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Company (TEAMID)"
pnpm dist:desktop
```

Build a signed and notarized DMG locally:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Company (TEAMID)"
export APPLE_ID="your-apple-id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="YOURTEAMID"
pnpm dist:desktop
```

Skip notarization explicitly:

```bash
export SKIP_NOTARIZE=1
pnpm dist:desktop
```

## GitHub Actions secrets

Set these repository secrets:

- `APPLE_DEVELOPER_ID_CERTIFICATE`: base64 of the `.p12`
- `APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD`: password for the `.p12`
- `KEYCHAIN_PASSWORD`: temporary keychain password used in CI
- `APPLE_SIGNING_IDENTITY`: full signing identity string
- `APPLE_ID`: Apple ID email used for notarization
- `APPLE_APP_SPECIFIC_PASSWORD`: Apple app-specific password
- `APPLE_TEAM_ID`: Apple Developer Team ID

To generate the base64 string for the certificate:

```bash
base64 -i /path/to/DeveloperIDApplication.p12 | pbcopy
```

## Current status on this Mac

At the time this was added, the machine only had an `Apple Development` identity available in Keychain, not a `Developer ID Application` certificate. The workflow and build config are ready, but a proper Developer ID certificate still needs to be imported before Gatekeeper-friendly release builds can be produced.
