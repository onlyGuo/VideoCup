# ttsapi attribution

`server/edge-tts.ts` adapts the endpoint-signature, temporary-token and SSML speech
request logic from [ssrsss/ttsapi](https://github.com/ssrsss/ttsapi), a fork of
[wangwangit/tts](https://github.com/wangwangit/tts). Its MIT license and copyright
notice are preserved in [LICENSE](./LICENSE).

Source reviewed: `https://raw.githubusercontent.com/ssrsss/ttsapi/master/index.js`,
retrieved on 2026-10-20. The original webpage, advertising, analytics, file upload
and public Cloudflare deployment are not included. The port adds SSML escaping,
validated parameters, size limits, shared token refresh, cancellation and timeouts.

The MIT license covers this source code. It does not grant a Microsoft service
agreement, guarantee quota, availability, every advertised voice/style, or an
unlimited upstream API. Synthesis requires an Internet connection and sends the
requested text to Microsoft's speech service. Upstream service errors and rate
limits are reported to the editor.

Register `edgeTtsPlugin()` from `server/vite-edge.ts` in the Vite `plugins` array.
It serves both development and `vite preview`; a bare static `dist` deployment
does not include a Node API and cannot use the built-in provider.

- `GET /api/edge/voices`: `{ voices, styles, maxTextLength }`, using the original
  project's 21 Chinese voices as a built-in catalog.
- `POST /api/edge/speech`: JSON `{ input, voice, speed, pitch, volume, style }`.
  Returns MP3 (`audio/mpeg`) or `{ error: { message, code, type } }`.
- `input`: 1–5,000 Unicode code points; JSON request limit 64 KiB.
- `speed`: 0.5–2; `pitch`: -50–50 Hz; `volume`: -1–1 relative change,
  where 0 means unchanged and 0.25 means +25%; `style`: the original project's
  allowlisted styles. Upstream voices may not support every expressive style.

The plugin accepts loopback hostnames only and rejects cross-origin browser
requests. It exposes no arbitrary URL proxy and returns no upstream tokens.

Validation on 2026-10-20: one live synthesis of the generic sentence
“你好，这是语音测试。” returned a 15,120-byte MP3 with MPEG audio frame bytes
`FF F3 64 C4`. Automated tests use mocked upstream responses to check escaping,
parameter limits, routing, concurrent refresh, cancellation, timeout and errors;
they do not consume upstream quota. This smoke check verifies connectivity at
the time of testing, not future availability or every voice/style combination.
