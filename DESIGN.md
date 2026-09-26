---
name: Operation Glasshouse
description: A pixel office you can disappear into, with the mission kept on paper.
colors:
  ink: "#182c29"
  ink-deep: "#10211f"
  jade: "#325d50"
  paper: "#ecdfc6"
  paper-dark: "#d3c09e"
  amber: "#f2c16d"
  burgundy: "#743d46"
  white: "#fff6e5"
typography:
  display:
    fontFamily: "Tower Display, Arial Narrow, Impact, sans-serif"
    fontSize: "clamp(76px, 9.8vw, 162px)"
    fontWeight: 850
    lineHeight: 0.84
    letterSpacing: "-0.028em"
  headline:
    fontFamily: "Tower Display, Arial Narrow, Impact, sans-serif"
    fontSize: "42px"
    fontWeight: 750
    lineHeight: 1.05
  body:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
  dialogue:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(14px, 1.3vw, 18px)"
    fontWeight: 500
    lineHeight: 1.5
  clock:
    fontFamily: "Consolas, Courier New, monospace"
    fontSize: "16px"
    letterSpacing: "0.04em"
rounded:
  control: "1px"
spacing:
  tight: "8px"
  group: "16px"
  panel: "24px"
  dialog: "32px"
components:
  button-amber:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.ink-deep}"
    rounded: "{rounded.control}"
    padding: "12px 20px"
  button-paper:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px 20px"
  button-jade:
    backgroundColor: "{colors.jade}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
    padding: "12px 20px"
  button-burgundy:
    backgroundColor: "{colors.burgundy}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
    padding: "12px 20px"
---

# Design System: Operation Glasshouse

## Overview

**Creative North Star: "An office you can disappear into."**

The world leads; the interface is the paperwork carried into it. A generated pixel tower fills the opening, with oversized condensed lettering at the left and Ghost at the right. During play, the camera follows a real character through an isometric office rather than presenting a dashboard of game statistics.

The visual direction is user-pinned: an atmospheric two-dimensional pixel office, sandstone and carpet, jade partitions, burgundy files, amber light, and tactile paper dossiers. The committed form is not a random concept-roll outcome. The production HTML preserves the THESIS, OWN-WORLD, STORY, FIRST VIEWPORT, and FORM contract.

**Key Characteristics:**
- Real pixel artwork, grounded in a playable architectural diorama.
- Condensed poster lettering paired with an unobtrusive system UI face.
- Warm paper for conversations, mission documents, and deliberate decisions.
- Hard-edged, offset depth rather than glass panels or luminous borders.

## Colors

The full palette has four material roles: deep jade architecture, warm paper, amber attention, and burgundy consequences.

### Primary

**Jade** carries ordinary affirmative controls and the architectural identity. **Amber** marks the initial mission action, the in-game clock accent, and Ghost's persistent locator. It is not a generic score color.

### Secondary

**Burgundy** identifies consequential choices, the unverified visitor stamp, and the security call. It does not encode judgments about a player's face, voice, or real honesty.

### Neutral

**Ink** and **ink-deep** support the title, top bar, surrounding city, and text on paper. **Paper** and **paper-dark** carry the mission dossier, conversation, field borders, and document separators. **White** is warm rather than blue-white.

**The Evidence Rule.** Status colors reflect actual game state: a completed record, a collected keycard, a delivered concern, or a current connection error.

## Typography

**Display Font:** locally served Barlow Condensed, registered as `Tower Display`, with Arial Narrow and Impact fallbacks.

**Body Font:** Segoe UI, Helvetica Neue, Arial, sans-serif.

**Operational Font:** Consolas/Courier New for the mission clock and call allowance. Monospace is not the general visual costume.

The title's large, compact lettering belongs to a game poster. Document headings retain that compression at a smaller scale; dialogue remains a readable, sentence-case sans.

### Hierarchy

- **Display:** the title uses the frontmatter ramp; its first line is smaller than “Glasshouse.” The unusually large maximum follows the explicitly requested poster treatment.
- **Headline:** paper dialogs use 42px display type on desktop, 33px on narrow layouts.
- **Body:** the base UI is 14px. Contextual document metadata is smaller and quieter than actionable story content.
- **Dialogue:** 14–18px on desktop, with a 13px narrow-layout treatment and 1.5–1.55 line height.
- **Clock:** 16px desktop and 13px mobile; the Live/Practice truth label stays visible alongside it.

**The Voice Rule.** A speaker's name, portrait, and actual caption establish a conversation. Decoration never replaces those identifiers.

## Layout

The canvas occupies the entire viewport. At desktop widths, a narrow paper dossier sits at the upper right; the conversation stretches across the bottom of the remaining scene. The top bar contains floor identity, time, mode, and a small set of controls.

At 760px and below, the dossier becomes compact and is hidden while a conversation owns the bottom portion of the screen. It is not removed from the mission. Touch movement controls appear on narrow/coarse-pointer layouts. The clock and Live/Practice status remain visible.

Paper dialogs protect focus for pause, settings, the ledger, floor selection, and confirmed abandonment/reset. The lift menu is a physical interaction, not global navigation. Adjacent and selected floor artwork appears as an explicitly labeled ambience preview, never as a collision map.

Groups favor 8–16px spacing; panels and dialogs use 24–32px. The title and scene have more breathing room than the supporting documents.

## Elevation & Depth

Depth follows pixel and paper materials. Office floors, wall faces, desk tops, foliage, and characters cast directional architectural shadows. UI documents use offset hard-edged shadows rather than glow. The small dossier rotation, visitor stamp, and paper clip give it a physical origin without turning the whole interface into ornament.

### Shadow Vocabulary

- **Dossier:** `5px 7px 0 #07191532`.
- **Conversation:** `5px 6px 0 #071c1c5c`.
- **Focused document:** `8px 10px 0 #061a1c55`.
- **Button lift:** `3px 4px 0 #091a2040`.

The renderer sorts actors by projected foot depth. Ghost has an alpha-derived amber outline, a ground shadow, and an always-visible name marker. Occluding walls and tightly overlapping NPC sprites fade for legibility; the renderer never moves actors to make a prettier composition.

**The Ground Rule.** All actor positions and collision decisions come from the engine. Generated ambience, labels, and camera movement cannot change them.

## Shapes

Controls have nearly square 1px corners. Paper panels are rectangular, with stamps and the occasional clip rather than rounded card stacks. The game world uses a 2:1 isometric projection and deliberately low-resolution canvas rendering.

Generated sprites retain their 96 × 144 proportions and `(48, 140)` foot anchor. There is no squash/stretch substitution for directional artwork. Neutral poses gain restrained local gait, outlines, and shadows. Images use pixelated scaling and canvas image smoothing stays disabled.

The floor-seven server clue uses an actual blue threshold and frame, distinct from the other amber doorways.

## Components

### Buttons

Amber initiates the mission; jade submits an ordinary reply; paper supports navigation and secondary actions; burgundy marks deliberate abandonment or reset. Controls name the action and have hover, disabled, and focus states.

Focus uses a 3px amber outline over dark surfaces and a dark jade outline over paper/light controls. The offset keeps it visually separate from the button fill.

### Inputs

The reply field is warm paper with a visible border, sentence-case copy, and a 16px input font on narrow screens. Text alternatives remain readable when spoken captions are disabled. Long captions and briefing text can be keyboard-focused and scrolled.

### Mission dossier

The visitor pass shows the actual claimed identity. Its three checkboxes represent the actual visitor log, authorization, and card. It is a mission document, not a collection of generic hero metrics.

### Conversations and ledger

Conversations arrive automatically in the world. The pane includes the current portrait, name, role, caption, fictional suspicion, microphone/text controls, and an explicit way to leave.

The ledger separates claims, learned facts, delivered/pending rumors, and final transcripts. Empty states explain how content will arrive. User/model strings are escaped when rendered as document markup.

### Errors and modes

Connection errors use a visible amber notice with a specific recovery. Practice is plainly labeled as scripted/non-AI. A server failure never becomes a success-shaped “Gemini” response.

### Artwork loading

Image elements begin hidden, receive URLs from the validated manifest, and are revealed only after their load event. Static “missing src” detector warnings on those slots are contextually false positives, not shipped broken-image boxes. The browser checks verify no visible broken images. Do not hardcode content-hashed filenames to satisfy a static warning.

## Do's and Don'ts

### Do:
- **Do** keep the office scene dominant and the camera grounded on Ghost.
- **Do** use actual generated artwork with correct proportions and anchors.
- **Do** keep mode, clock, dialogue, and meaningful mission state discoverable.
- **Do** preserve dark focus rings on paper and reduced-motion alternatives.
- **Do** label suspicion as fictional story interpretation.

### Don't:
- **Don't** turn the game into a neon, glass-panel, or metrics dashboard.
- **Don't** make scene art authoritative over collision or navigation.
- **Don't** hide failures behind scripted output labeled as live AI.
- **Don't** encode gaze, accent, facial movements, or emotions as honesty measurements.
- **Don't** replace the committed tower opening or paper documents during a local refinement.
