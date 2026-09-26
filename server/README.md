# Gemini backend and browser audio

`server\index.ts` is the Express/HTTP/WebSocket entry point used by `npm run dev` and `npm start`. It binds to `127.0.0.1:4317` by default. `HOST` accepts loopback addresses only; `PORT` selects the port. Browser API and WebSocket requests must use the server's exact origin. A separate browser-facing Gemini credential is neither used nor returned.

Use an untracked local `.env`, or set `GLASSHOUSE_ENV_FILE` to a private dotenv file. Existing process variables take precedence. `GEMINI_API_KEY` stays in the server process; never give it a `VITE_` prefix. Model overrides are `GEMINI_TEXT_MODEL`, `GEMINI_LIVE_MODEL`, `GEMINI_IMAGE_MODEL`, and `GEMINI_TTS_MODEL`; defaults are respectively `gemini-3.8-flash`, `gemini-3.8-live`, `gemini-3.1-flash-lite-image`, and `gemini-3.8-flash-tts`.

Development uses Vite middleware. Production (`NODE_ENV=production`) serves `dist` when built, with SPA fallback only for non-API GET requests. Generated artwork is served from `public\generated` independently of a rebuild. If `dist` is absent, the server uses Vite instead.

## HTTP contract

The payload types live in `shared\types.ts`.

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/health` | None | `{configured, credentialsValidated:false, models, transport, limits, assets}`. `configured` means key presence, **not credential validation**. `assets` exposes queued/running/failed art jobs. |
| `POST /api/director` | **Direct** `DirectorContext`, not `{context}` | `DirectorReply` with `source:"gemini"` |
| `POST /api/dialogue` | `{context: ConversationContext, text}` | `DialogueReply`; actions are proposals, never engine-approved results |
| `POST /api/tts` | `{text, voiceName}`; up to 1200 characters | Mono, 24 kHz, signed 16-bit PCM WAV bytes |
| `GET /api/assets` | None | `AssetManifest`; a genuinely empty manifest is valid |
| `POST /api/assets/prefetch` | `{floors:number[]}`; 1-12 integer floors | HTTP 202 after enqueue, with queue status; generation failures appear in health status |

Errors have `{error:{code,message,retryable}}`, an appropriate non-2xx status, and no raw provider exception. JSON bodies are limited to 256 KiB. Four asynchronous HTTP requests may be active; additional global and per-operation token buckets bound paid generation. SDK calls use one HTTP attempt, with 30-second text and 45-second TTS deadlines. There are no automatic model substitutions or fabricated Gemini replies.

Flash uses `LOW` thinking and a compact structural `responseJsonSchema`. The complete bounded Zod schema produces a nested response grammar rejected by the current model with HTTP 400 `INVALID_ARGUMENT`. Types, properties, required fields, enums and unions remain in the provider schema; **all length, count, range and role-capability checks still run server-side after generation**. Both `schemaOutput` and ordinary JSON text responses are parsed. Malformed or truncated results are rejected, not repaired into a success.

TTS input is the verbatim narration text, not a prompt containing stage instructions. WAV output is validated; raw PCM output is wrapped in one WAV header. The cache is memory-only, limited to 24 entries / 16 MiB, with a ten-minute expiry.

## Live protocol and authority

`WS /api/live` uses the `ClientLiveMessage` / `ServerLiveMessage` unions. Send `start` with a conversation context, and wait for `ready` before media or text. The proxy waits for Gemini's actual `setupComplete` before announcing readiness and starting the NPC's greeting.

Input audio is mono, 16 kHz, signed little-endian PCM. Output is 24 kHz PCM. Camera frames are optional JPEGs, at most 192 KiB and one frame per second. A gap in microphone packets sends Gemini `audioStreamEnd`. Setup is limited to 20 seconds; each encounter to three minutes, with an explicit error rather than ending the mission. There are at most two live connections, bounded start rates, a 15-second heartbeat, bounded pending tools, and no automatic reconnect.

`apply_game_action` emits an `action` with an opaque `requestId`. The browser must apply the action through the game engine and return `tool_result`. Only then does the proxy send Gemini the engine's accepted/rejected result using the original provider function-call ID. Missing confirmations are rejected after ten seconds; cancelled or late confirmations never become approvals.

Priya registers; Dev or Anita authorizes; Ramesh issues the card. Kulkarni can only disclose available facts. Meera's proposed resolution is checked by the engine; the double-cross exit call is not a voice-tool shortcut. Positive suspicion requires game evidence. Private knowledge and delivered hearsay never become omniscient player-state access. Voice, camera, accent, pauses and missing devices are not evidence of deception or identity.

## `VoiceClient` integration

`src\audio.ts` exports `VoiceClient` and `VoiceCallbacks`. The constructor and methods follow the shared integration contract: `prepare`, `connect`, `disconnect`, `updateContext`, `respondToTool`, `sendText`, `setMuted`, `setVolume`, `setCameraEnabled`, `playNarration`, and `dispose`.

- Call `prepare()` directly from Begin Mission or an explicit Retry Microphone gesture. It creates/unlocks one AudioContext and requests microphone access. A declined microphone leaves playback unlocked. Explicit retries reuse that context; `connect()` never requests media permissions.
- `micEnabled` means a live microphone track is available and unmuted, not that it is currently transmitting. Capture/worklet output is disabled outside an encounter, when muted, and while the document is hidden. `dispose()` releases tracks and closes the context.
- `setMuted` controls the microphone. `setVolume(0)` silences output. The worklet performs anti-aliased, fractional-phase resampling, including from 44.1 kHz, and never monitors microphone input through the speaker.
- `onTranscript` contains a **cumulative utterance snapshot**, not a delta. Replace the current caption until `final:true`. WS `sendText` gets one finalized player transcript from the server; do not journal it a second time. REST dialogue needs its own transcript entries.
- On `onAction`, apply the engine action, call `respondToTool`, then send updated context if the encounter still exists. For accepted `end_conversation`, **wait for `onTurnComplete` before disconnecting** so the acknowledged farewell can finish.
- `onTurnComplete` runs only after a server turn boundary and drained speaker audio. `onPlaybackDrained` is optional and can also occur between chunks; it alone is not a farewell signal. Barge-in, errors and disconnect immediately cancel both current and scheduled playback.
- `onClose(reason: string)` receives the safe server/transport explanation, or `Encounter ended.` for an intentional disconnect. Existing zero-argument callbacks can ignore this argument.
- `playNarration` uses the same unlocked context and cannot overlap a live encounter. Intentional cancellation rejects with `AbortError`, without an error toast. Audio and video are never written to disk.
- Camera access is requested only by `setCameraEnabled(true)`, from a separate explicit consent click. Optional `onCameraStream` provides the local preview stream; disabling the camera releases it.

## Validation

Offline regression tests:

```powershell
npm.cmd run typecheck
npm.cmd test -- tests\server.test.ts tests\server-web.test.ts tests\audio.test.ts tests\audio-worklet.test.ts
```

The real smoke tests are **opt-in and incur provider usage**. They exercise Flash director/dialogue, two TTS voices and caching, and Live audio/transcription plus an engine-rejected tool call. They keep generated audio in memory and never print credentials.

```powershell
$env:GLASSHOUSE_ENV_FILE = 'C:\private\glasshouse.env'
$env:GLASSHOUSE_REAL_API_SMOKE = '1'
npm.cmd test -- tests\server-smoke.test.ts
```
