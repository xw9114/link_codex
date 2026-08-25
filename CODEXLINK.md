# CodexLink

CodexLink is a personal, one-phone/one-Windows-PC remote controller for Codex.
The data path is deliberately private:

```text
Android 10+ -> Tailscale Tailnet WSS -> CodexLink Companion
            -> codex app-server (stdio JSONL) -> allowlisted local project
```

There is no public relay in the personal deployment. The Companion binds only
to a Tailscale CGNAT/ULA address and uses a persistent self-signed certificate
that the Android client pins during pairing. The WebSocket payload is then
protected by the Remodex v2 E2EE session (Ed25519 identity, X25519 ephemeral
keys, HKDF-SHA256, AES-256-GCM and replay sequencing).

## Included deliverables

- `companion/`: Electron tray Companion, provider management, project
  allowlist, Windows Credential Manager integration and private TLS relay.
  The packaged installer includes the Relay/Bridge `ws` runtime dependency;
  no separate Node.js or npm installation is required on the target PC.
- `android/`: Kotlin/Compose client (`minSdk 29`) with QR pairing, foreground
  reconnect service, encrypted Room cache and a conversation-style task UI.
  Intermediate command, MCP and protocol events are hidden from the main
  timeline; the phone shows user messages, Codex replies, necessary errors and
  approval cards instead.
- `protocol/`: shared secure-transport test vectors.
- `phodex-bridge/` and `relay/`: Remodex bridge/relay integration used by the
  Companion.
- `companion/scripts/install-tailnet-firewall.ps1` and
  `companion/scripts/remove-tailnet-firewall.ps1`: administrator-only Windows
  firewall rules for the private listener.

## Requirements

Windows 10/11, Tailscale in the `Running` state, Codex CLI `0.148.0` or newer,
and an Android 10+ phone on the same Tailnet. The Companion keeps the existing
`CODEX_HOME`, so desktop Codex threads remain visible. The computer must stay
awake, online and logged in while a task is running.

## Build

### Android debug APK

```powershell
$env:ANDROID_HOME = 'E:\android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
cd E:\codex\codexlink\android
E:\android-sdk\gradle-8.11.1\bin\gradle.bat `
  testDebugUnitTest assembleDebug assembleDebugAndroidTest
```

The debug APK is emitted at
`android/app/build/outputs/apk/debug/app-debug.apk`. It is signed with the
local Android debug key, not a release/store key; install it only on a device
where you trust the APK.

### Windows NSIS package

```powershell
cd E:\codex\codexlink\companion
$env:ELECTRON_BUILDER_BINARIES_MIRROR =
  'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm ci
npm run dist
```

The installer is `companion/dist/CodexLink-Companion-0.1.1-x64.exe`.

For the current local build, copies are also in `dist/`:

| Artifact | SHA-256 |
| --- | --- |
| `dist/CodexLink-Companion-0.1.1-x64.exe` | `C6E954DBF0777D94C244F977FC275F4BF3EDFAC6DEFF4D3A9A184E22DCD7AD98` |
| `dist/CodexLink-Android-0.1.1-debug.apk` | `EC046142EA0E9BBA90A72D38F617832AAA3E819DA111510B63C813B8A2B900F9` |
| `dist/CodexLink-Android-0.1.2-debug.apk` | `D3E6634344A452F1D8085658382DE32E5DA33FC200CDDD742D7A1E4886E01D97` |
| `dist/CodexLink-Android-0.1.3-debug.apk` | `3CD82548B79551D355F1A352913335623CDD645354B8D7CB184C7D32A5500CB0` |
| `dist/CodexLink-Android-0.1.4-debug.apk` | `180A0E9D12A570C26A8AA9042BBF01D80E8B9AA654B12170483783A3A1DE2961` |

The Android 0.1.1 build serializes encrypted WebSocket sends and suppresses
duplicate reconnect callbacks. This prevents the initial `initialize` and
`project/list` requests from racing during handshake and leaving the phone in
an online/reconnecting loop.

The Android 0.1.2 build presents tasks as a chat: the original prompt and
follow-up messages appear on the right, Codex responses appear on the left,
and intermediate command/MCP/status protocol events are hidden. Approval
requests remain available because they require an explicit phone decision.

The Android 0.1.3 build also makes streaming list keys unique across event
types. This prevents a fast pair of agent-message delta/completion events from
causing a Compose duplicate-key crash while a task is running.

Android 0.1.4 and Companion 0.1.1 include a connection-lifecycle audit. The
Android client no longer misses Codex initialization when E2EE becomes ready
before the UI subscribes, serializes replay-cursor persistence, reconnects
instead of acknowledging dropped event bursts, hydrates real conversation
history through `thread/read`, clears stale pairing approvals/caches, refreshes
project/provider metadata in parallel and rotates between the pinned TailIP
and MagicDNS endpoint. The Companion serializes Tailnet and Bridge restarts,
cleans Relay resources after bind failures, invalidates approvals when their
project or turn disappears and rechecks the allowlist before every thread-bound
request.

## Install and pair

1. Install Tailscale on both devices and sign in to the same Tailnet.
2. On Windows, install the NSIS package and allow CodexLink to start with
   Windows. Confirm that `tailscale status --json` reports `BackendState:
   Running` and that `codex --version` is at least `0.148.0`.
3. From an elevated PowerShell prompt, run
   `companion/scripts/install-tailnet-firewall.ps1` in the source checkout. If
   using the installed Companion, the same scripts are available under its
   `resources\codexlink-scripts` directory. The script removes stale CodexLink
   rules and creates inbound TCP `9443` rules scoped to the current Tailnet
   address, Tailnet CGNAT/ULA sources and the detected Tailscale interface.
4. Open the Companion tray window, add each permitted project directory and
   review the desktop permission ceiling. The default is `workspace-write` and
   `on-request`; the phone cannot raise it.
5. Scan the five-minute QR code in the Android app. The QR contains only the
   private WSS endpoint, session bootstrap metadata, certificate fingerprints
   and an expiring pairing code. A new scan is required after resetting trust.
6. Start a task from an allowlisted `projectId`. API Provider credentials are
   entered on the phone over E2EE and stored only in Windows Credential
   Manager; they are not written to the Android database or logs.

## Providers

The Companion exposes `chatgpt`, `openai_responses` and `custom_responses`.
Custom providers must implement the Responses API at `Base URL/responses`.
Chat Completions conversion is intentionally unsupported. A provider is fixed
when a thread starts; changing it requires a new or forked thread. Provider
changes restart the idle app-server after the current task completes.

## Security and operational boundaries

- The phone submits a project ID, never a filesystem path. The Companion
  resolves it against its canonical allowlist and rejects traversal, junction
  aliases and sibling-prefix escapes.
- The Companion never binds `0.0.0.0`, a LAN address or a public interface.
- API keys and custom header values are passed to Codex through process
  environment variables and Windows Credential Manager, and are redacted from
  responses/logs.
- `danger-full-access` and `never` approvals are desktop opt-ins. They are not
  available from the phone unless the desktop ceiling explicitly allows them.
- Remove the firewall rules before uninstalling if another service needs port
  `9443`:

```powershell
.\remove-tailnet-firewall.ps1
```

Use the matching path under `resources\codexlink-scripts` when running from an
installed Companion.

## Verification

From the repository root:

```powershell
cd E:\codex\codexlink\relay; npm test
cd E:\codex\codexlink\companion; npm test
cd E:\codex\codexlink\phodex-bridge; npm test
```

The Relay and Companion suites pass on Windows. The Bridge suite includes
upstream macOS launchd and symlink tests; those are skipped or fail when run on
Windows without Developer Mode. Its parallel rollout-mirror tests can also be
timing-sensitive in the full multi-file run; the CodexLink compatibility tests
and an isolated rollout-mirror run pass. The Android unit/instrumentation
compilation command above has passed; a physical-device QR and
foreground-service run is still required for final hardware acceptance.
