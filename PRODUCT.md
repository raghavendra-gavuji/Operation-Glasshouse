# Operation Glasshouse

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Players exploring a fictional, voice-driven social-stealth game in a browser on a computer with a keyboard and microphone.

## Product Purpose

Play as Ghost, enter the fictional Meridian Tower in Hyderabad under a cover identity, learn the building's secrets, obtain a visitor keycard, and escape or expose the Handler.

## Positioning

NPCs approach and question the player automatically. The player's spoken choices establish a persistent identity and story ledger. NPCs share rumors, pursue their own objectives, and react to inconsistencies across encounters.

## Operating Context

A crowded, twelve-floor office building with reception on floor 1, collection on floor 2, facilities on floor 3, IT on floor 4, the server room on floor 7, and executives on floor 11. Time is an in-game clock, not the user's real-world deadline.

## Capabilities and Constraints

- Keyboard character movement; automatic proximity-triggered conversations; speaker output and microphone replies.
- Distinct named NPC personalities and voices.
- Gemini-directed high-level NPC decisions; deterministic local movement, collision, navigation, and mission gates.
- Gemini-generated pixel art, cached and prefetched ahead of exploration.
- Persistent visitor identity, authorization, gossip, evidence, suspicion, and mission report.
- Clean, Flagged, Burned, Clock-out, and Double-cross endings.
- One initial browser gesture is required to enable microphone and audio. Camera use is optional and requires separate consent.
- Secrets remain on the server. Personal audio/video is streamed only while enabled and is not recorded to disk by default.
- No deployment deadline or implementation-time limit; the user requested a complete, working game.

## Brand Commitments

The user specified pixel-styled 2D isometric graphics, an office setting in Hyderabad, an atmospheric heist story, and the title Operation Glasshouse. Character names: Ghost, Priya, Ramesh, Dev, Anita, Mr. Kulkarni, the Handler, and Meera.

## Evidence on Hand

The user supplied the story and authorized use of their Gemini API key for text, image, and voice generation. Model availability, latency, and credentials must be verified rather than assumed.

## Product Principles

- Spoken choices change an actual game state rather than presenting a detached chatbot.
- AI latency must never block the render loop.
- Access and endings follow deterministic fictional rules that model output cannot bypass.
- Art does not define collision or traversability.
- Show provider errors and an explicitly labeled practice mode rather than pretending mock behavior is Gemini.

## Accessibility & Inclusion

Captions, volume/mute controls, a text alternative, reduced motion, and a no-camera path. Do not infer honesty, personality, identity, disability, or actual mental state from voice or facial movements. Any optional acting cues are theatrical gameplay, not lie detection; missing camera or slow speech must not lock a player out.
