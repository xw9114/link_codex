# Third-Party Notices

CodexLink combines the upstream Remodex bridge with the following runtime and
build dependencies. Their own license files remain authoritative.

| Component | Use | License / source |
| --- | --- | --- |
| Remodex | Bridge, secure transport, relay protocol and compatibility code | Apache-2.0; upstream commit `8105e25038ad07443da01cda6c21e5f77ec61cd5` |
| Electron | Windows Companion shell and tray process | MIT; https://github.com/electron/electron |
| electron-builder | NSIS packaging | MIT; https://github.com/electron-userland/electron-builder |
| `ws` | Relay and Bridge WebSocket transport | MIT; https://github.com/websockets/ws |
| `qrcode` | Pairing QR generation | MIT; https://github.com/soldair/node-qrcode |
| `selfsigned` | Local TLS identity generation | MIT; https://github.com/digitalbazaar/selfsigned |
| Jetpack Compose | Android UI | Apache-2.0; https://developer.android.com/jetpack/compose |
| AndroidX / Hilt / Room | Android lifecycle, DI and encrypted persistence integration | Apache-2.0; https://developer.android.com/jetpack |
| Kotlin serialization | Android protocol serialization | Apache-2.0; https://github.com/Kotlin/kotlinx.serialization |
| OkHttp | Android WebSocket client | Apache-2.0; https://square.github.io/okhttp/ |
| Bouncy Castle | Android Curve25519/Ed25519 protocol primitives | MIT-like Bouncy Castle license; https://www.bouncycastle.org/licence.html |
| SQLCipher for Android | Encrypted Room database | BSD-style; https://github.com/sqlcipher/android-database-sqlcipher |
| CameraX / ML Kit barcode scanning | Pairing QR scanner | Apache-2.0; https://developer.android.com/training/camerax |

The generated APK and NSIS package include their respective dependency
metadata. This file is a source-level attribution summary, not a replacement
for those notices.
