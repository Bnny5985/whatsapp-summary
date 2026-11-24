# p2p-bridge

Lets the owner's paired phones open the local dashboard from anywhere, over [Iroh](https://iroh.computer)
(QUIC + TLS 1.3, end-to-end encrypted, direct through NATs when possible, encrypted relay otherwise).
Started and supervised by the engine (`p2p.js`); nothing for the user to install.

```
p2p-bridge --data-dir <per-user folder> --port <dashboard port>
env P2P_PROXY_SECRET=<per-session secret, 32+ letters/digits>
```

## Files (in `--data-dir`, never in the repo)
- `p2p_secret.key` – this computer's Iroh identity.
- `paired_devices.json` – the allowlist of phone NodeIds.

## Protocols
- `wa-summary/pair/1` – only while a pairing window is open. The phone sends one JSON message
  `{"token": "...", "name": "..."}`; a matching one-time token adds its NodeId to the allowlist.
- `wa-summary/http/1` – paired phones only. One bidirectional stream = one HTTP request (or one WebSocket).
  The bridge strips any `X-P2P-*`, `X-Remote-Peer-Id`, `Tailscale-*`, `X-Forwarded-*`, `Forwarded` and hop-by-hop
  headers, sets `Host: 127.0.0.1:<port>`, and adds `X-Remote-Peer-Id` + `X-P2P-Proxy-Secret`.

QR payload: `{"v":1,"nodeId":"…","relayUrl":"…","token":"…"}`. Pairing windows last 2 minutes by default.

## Control (JSON lines on stdin, replies/events on stdout)
| command | reply |
|---|---|
| `{"id":1,"cmd":"status"}` | `nodeId`, `relayUrl`, `pairing`, `devices` |
| `{"id":2,"cmd":"pair_start","ttl":120}` | `qr`, `expiresIn` |
| `{"id":3,"cmd":"pair_stop"}` | |
| `{"id":4,"cmd":"list"}` | `devices` |
| `{"id":5,"cmd":"revoke","nodeId":"…"}` | `removed` (open connections are closed) |
| `{"cmd":"shutdown"}` | |

Events: `ready`, `online`, `offline`, `paired`, `connected`, `disconnected`. Closing stdin stops the bridge.

## Build and test
```
cargo test
cargo build --release          # on Windows: target/release/p2p-bridge.exe
cargo run --example phone -- <key-file> <desktop-node-id> pair <token> [name]   # stand-in phone
cargo run --example phone -- <key-file> <desktop-node-id> get /                  # (set RELAY=<relayUrl>)
```
The Windows binary is built by `.github/workflows/p2p-bridge.yml`; `scripts/build-engine.js` copies it into the installer.
