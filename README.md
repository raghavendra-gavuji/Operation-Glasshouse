# Operation Glasshouse

A full-screen, pixel-isometric social-stealth game in the fictional Meridian Tower, Financial District, Hyderabad. You are Ghost: establish a cover identity, meet the people who work here, collect a visitor keycard, and decide whether the Handler deserves your loyalty.

## Play locally

Use **Node.js 22 or newer**. On Windows, double-click **`start-game.cmd`**, keep its console open, then open **http://127.0.0.1:4317**. The launcher installs missing project dependencies and starts the local server. Close the console or press Ctrl+C when finished.

Alternatively, from PowerShell:

```powershell
npm.cmd install
$env:PORT = "4317"
npm.cmd run dev
```

`npm.cmd` avoids the PowerShell execution-policy restriction that can affect `npm.ps1`. No system policy change is necessary.

For live Gemini conversations, put your key in the **untracked server-side `.env`** file. If you do not have one yet, copy `.env.example` to `.env` and fill in `GEMINI_API_KEY` locally. Never use a `VITE_`-prefixed key: those variables are intended for client bundles. Do not put credentials in source files, screenshots, saved missions, or browser storage.

The included configuration names these models:

| Purpose | Model |
| --- | --- |
| NPC direction and typed dialogue | `gemini-3.8-flash` |
| Live microphone conversations | `gemini-3.8-live` |
| Generated pixel artwork | `gemini-3.1-flash-lite-image` |
| Spoken briefing and text-mode replies | `gemini-3.8-flash-tts` |

Each model can be changed with its corresponding `GEMINI_*_MODEL` variable in `.env`. Availability, rate limits, cost, and provider behavior depend on your Google project. A configured key is not a promise that every request will succeed.

**No key? Choose “Practice without AI.”** It is a deliberate, labeled, scripted mode using the same physical world, action gates, story ledger, and endings. The shipped Gemini-generated artwork is already cached; playing does not require regenerating it.

## How to play

| Control | Action |
| --- | --- |
| WASD or arrow keys | Walk in screen-relative directions |
| Shift | Run; people may notice the behavior |
| Walk near a person | They approach and begin a conversation automatically |
| Speak, or use the reply field | Answer the person currently talking to you |
| Leave conversation | Walk away when the conversation permits |
| Enter beside the lift | Open floor selection; use ↑/↓ and Enter, or click a floor |
| L | Read your story ledger |
| Escape / pause button | Pause the operation |
| F1 | Toggle the decision log and navigation debug overlay |

Touch movement buttons are available on narrow screens. The lift works only when Ghost is physically nearby, not as a teleport menu.

**Start mission is an audio permission gesture.** The browser may ask for your microphone; denying it keeps typed Gemini dialogue available. There is no press-E conversation step. The opening briefing can be skipped, and you can move while it plays. Camera permission is separate and is never required for any mission gate.

The mission has three real prerequisites:

1. Give **Priya on floor 1** an invented name, company, and host or work role, then register in the visitor log.
2. Get **Dev on floor 4** to authorize that same name with a fictional `MT-...` ticket or `MT-ID-...` staff prop. **Anita on floor 11** is an alternative after you learn the CFO's itinerary.
3. Collect the card from **Ramesh on floor 2**. Your claimed name, visitor log, and authorization must match.

Return to the entrance on floor 1 with the card. Mr. Kulkarni on floor 3 knows the access rules, the CFO's whereabouts, the blue door on seven, and—once you have earned a proper conversation—something about the Handler. Learning the secret creates a separate option to call Meera at the exit.

The office day runs from 09:00 to 18:00 over approximately 24 minutes of active simulation. Pause stops it; hiding the tab opens pause rather than silently advancing the game. Meera's security call has a separate fair response allowance that does not count connection, model, or speech-playback waits.

The five outcomes are **Clean**, **Flagged**, **Burned**, **Clock-out**, and **Double-cross**. Leaving early without a card, after confirmation, abandons the job as a Clock-out; the report distinguishes that choice from reaching closing time. The report preserves exact recorded claims, transcripts, witnesses, and delivered rumors. Its Amateur-to-Phantom assessment describes the fictional operation, not the player.

### Practice mode

Use the contextual conversation choices for a complete non-AI route. You can also enter explicit claims such as `My name is Tara Shah`, `My company is Aster Systems`, `My host is Dev`, or `My ticket is MT-4827`. Other free-form text is not secretly sent to an AI or presented as an intelligent response. A rejected action displays the engine's reason; practice choices cannot bypass the game's paperwork rules.

## Sound, accessibility, and privacy

- Captions, typed replies, speaker volume/mute, microphone mute, reduced motion, pause, and the ledger are built into the game.
- Typed and practice dialogue remains readable even if spoken captions are disabled.
- The camera starts off, requires an explicit separate permission, and is optional. Missing camera access never blocks Anita or any other character.
- Enabled microphone audio and optional camera frames go to Gemini during live conversations. This app does not write microphone or video recordings to disk.
- Local saves contain game state and text transcripts, **not audio or video**. Settings includes an explicit confirmation to erase saved progress. Do not enter real personal details.
- Use fictional callback codes such as `SIM-0420`, not real telephone numbers.
- **There is no lie detector.** NPC suspicion is a fictional interpretation of story claims, witnessed behavior, and delivered gossip. It does not measure real honesty, facial expressions, gaze, accent, disability, emotions, or speaking speed.
- Browser permissions belong to the browser. You can revoke microphone/camera permission in its site settings.
- Explicit microphone retries reuse the unlocked audio context. The camera is released on the mission report, return to title, or reset.

## Architecture

`src/game/` owns deterministic mission gates, all twelve collision maps, A* navigation, NPC motion, rumor delivery, security, serialization, and endings. The canvas renderer only draws that state; it does not move NPCs or let generated art define traversability.

`src/main.ts` connects the renderer, keyboard/touch input, mission UI, `VoiceClient`, typed dialogue, and the engine. Live tool requests go through engine validation before the result and updated context are sent back. Farewells wait for the voice turn and queued speaker audio to finish before closing the connection.

The high-level Gemini director receives one batched active-floor context approximately every 3–5 seconds. It has one request in flight, a timeout, floor-staleness checks, and exponential backoff with jitter. The animation loop never waits for it. F1 exposes the actual decision source and measured response latency; an API error produces a visible notice and retry/practice controls, not a pretend Gemini fallback.

`server/` keeps credentials and provider SDK calls out of the browser. `server/art.ts` supplies the validated art manifest and bounded asynchronous generation service. The client caches images and prefetches adjacent/previewed floors, not one request per frame.

## Artwork

The repository includes **31 actual Gemini-generated PNGs**: the tower exterior, eight portraits, seven body sprites, twelve floor ambience scenes, and three textures. `public/generated/manifest.json` records their IDs, content-hashed URLs, models, and timestamps. The UI uses manifest URLs rather than guessing filenames.

Sprites are neutral poses on transparent **96 × 144** canvases, with feet anchored at **(48, 140)**. Gait, shadows, depth sorting, and Ghost's outline are rendered locally without distorting the sprite proportions. Portraits are 256 × 256; the exterior is 1280 × 720; floor previews are 768 × 432; textures are 128 × 128. Ambience previews are not navigation maps.

To generate missing assets intentionally, with a server key configured:

```powershell
npm.cmd run assets
```

The generator resumes from valid cached assets. Generation uses the provider and may incur costs; do not start concurrent generation jobs for the same inventory. If an asset is missing or fails to load, the game identifies that state and draws intentional pixel placeholders until real art is available.

Barlow Condensed fonts are served locally from `public/fonts`; the accompanying `OFL-Barlow.txt` preserves the SIL Open Font License.

## Checks and production build

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

The tests cover the deterministic engine and endings, provider validation, artwork integrity, screen-relative input, exact live transcript assembly, practice options, and single-flight director behavior. `npm run build` produces the browser bundle in `dist`; it does not bundle the server `.env`.

To serve that production build instead of Vite middleware:

```powershell
$env:NODE_ENV = "production"
$env:PORT = "4317"
npm.cmd start
```

The exact HTTP/WebSocket contracts, bounded provider behavior, and opt-in real-API smoke commands are documented in [`server\README.md`](server/README.md). The complete simulation and persistence contract is in [`src\game\README.md`](src/game/README.md).

For browser checks, the development build exposes a **read-only** `window.__glasshouse` inspection object: copied state, floor plans, character definitions, and UI status. It has no gameplay setters and is removed from production builds. Stable `data-testid` attributes identify the actual start, dialogue, lift, pause, mission, and report controls.

This is a local prototype, not a deployed multi-user service. Gemini can mishear speech, misunderstand a story, take time to reply, hit quota, or request an invalid action. The ledger makes the recorded version visible, and deterministic engine validation remains authoritative.
