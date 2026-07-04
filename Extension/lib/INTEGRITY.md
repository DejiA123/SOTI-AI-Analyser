# Vendored library integrity manifest

These files are third-party, pre-built binaries (Tesseract.js OCR engine + WASM cores +
English language data) vendored locally so the extension makes **no external requests** at
runtime. They are loaded only from this `lib/` folder (see `sidepanel.js` OCR worker options)
and are constrained by the extension CSP (`script-src`/`worker-src 'self'`, `wasm-unsafe-eval`).

Because these are opaque blobs that run with the extension's privileges, their integrity is
pinned here. Re-generate this file whenever a library is intentionally updated, and verify the
hashes at package/build time so a swapped or tampered blob is caught before it ships.

**Upstream:** Tesseract.js v5.x (Apache-2.0). Confirm the exact release and re-pin on upgrade.

## SHA-256

| SHA-256 | Bytes | File |
|---|---:|---|
| `ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468` | 10923060 | `eng.traineddata.gz` |
| `66b601224a0c4a8977bc9d92dd39841189f9ca22cc4122fcd7208cdb0961eeef` | 2859709 | `tesseract-core-simd-lstm.wasm` |
| `18797eef96bab787636c40b53efaa445cf5ca1c97abd735c4fd8dc3d03652959` | 3938656 | `tesseract-core-simd-lstm.wasm.js` |
| `2de765b01966e99ed7cd194900d61d9119cef2854034d46883e6eb2d02273d90` | 3457272 | `tesseract-core-simd.wasm` |
| `bb44be9fe52b5ebe2806462e96fcb1a1980fb2e038eb639ac315b585c3ce2415` | 4734610 | `tesseract-core-simd.wasm.js` |
| `249b39a010a357cc0d9d61789a355105bc029091b7d446e651b96a4b4da15713` | 4734234 | `tesseract-core.v5.wasm.js` |
| `5324ce2174f378b33830053d4db20e28086bafaa692edb8e4064fa462d220ecd` | 3456990 | `tesseract-core.v5.wasm.wasm` |
| `5324ce2174f378b33830053d4db20e28086bafaa692edb8e4064fa462d220ecd` | 3456990 | `tesseract-core.wasm` |
| `249b39a010a357cc0d9d61789a355105bc029091b7d446e651b96a4b4da15713` | 4734234 | `tesseract-core.wasm.js` |
| `be119976d929c12f5f1d6cdc8f74118e7d05afc9edef9dd099df699af69299ce` | 66686 | `tesseract.v5.min.js` |
| `d4e856a0ab7584d2d3e2942e5aa007e192e535ccd0b837ce8e4bb86a20d36816` | 123674 | `worker.min.js` |
| `d4e856a0ab7584d2d3e2942e5aa007e192e535ccd0b837ce8e4bb86a20d36816` | 123674 | `worker.v5.min.js` |

## Verify (PowerShell)

```powershell
Get-ChildItem -File .\lib |
  ForEach-Object { '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower(), $_.Name }
```

## Verify (bash)

```bash
cd lib && sha256sum *
```
