import { GoogleGenAI, type GenerateContentResponse, type Part } from "@google/genai";
import { config as loadDotenv } from "dotenv";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { z } from "zod";
import type { AssetManifest, AssetRecord } from "../shared/types.ts";

const DEFAULT_MODEL = "gemini-3.1-flash-lite-image";
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 2;
const MAX_WORKERS = 2;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const SPRITE_WIDTH = 96;
const SPRITE_HEIGHT = 144;
const SPRITE_FOOT_Y = 140;

const STYLE = `Original hand-authored-looking 1990s 2D pixel-art adventure, set in a contemporary Hyderabad office tower.
Visible chunky square pixel clusters, precise dark blue-green outlines, carefully limited palette, no smooth gradients.
Warm amber lamplight and teak desks, midnight blue-green concrete and glass, terracotta tiles, muted jade furnishings,
parchment details. Attractive cinematic composition and human warmth with a quiet corporate-heist undertone.
Architectural views use a true 2:1 isometric game camera, parallel lines, not a perspective camera.
Never photorealistic, never a glossy 3D render, never a dashboard, never a game screenshot with UI.
No captions, letters, readable signs, logos, speech bubbles, borders, or watermarks drawn into the illustration.
All people are fictional adult Indian office workers, with individual everyday personalities, not stereotypes.`;

const CAST = [
  ["ghost", "Ghost, an observant Indian man in his late twenties, warm brown skin, short slightly tousled black hair, clean-shaven, charcoal overshirt over a muted amber T-shirt, dark trousers, worn tan shoes; unobtrusive messenger bag"],
  ["priya", "Priya, a poised Indian receptionist in her early thirties, medium brown skin, black hair in a neat low bun, small gold earrings and a tiny bindi, muted jade sari with a narrow warm ochre border, parchment blouse; alert friendly expression"],
  ["ramesh", "Ramesh, an Indian credential-desk security guard in his fifties, stocky build, medium brown skin, thick black moustache with a little grey, short greying hair, ochre short-sleeved security shirt with a small plain metal badge and dark epaulettes, navy trousers and black shoes; patient but watchful"],
  ["dev", "Dev, an Indian IT specialist in his late twenties, lean build, medium brown skin, curly black hair, round dark glasses, blue-grey casual shirt with rolled sleeves and a plain ochre lanyard, dark jeans and trainers; curious, slightly sleep-deprived expression"],
  ["anita", "Anita, the Indian CFO's executive assistant and gatekeeper in her forties, deep brown skin, black hair in a practical braid, rust-red salwar kameez with a muted ochre dupatta, simple sandals, holding a small jade clipboard without writing; observant, composed expression"],
  ["kulkarni", "Mr. Kulkarni, an Indian facilities manager in his late fifties, medium brown skin, receding neatly combed dark hair with grey temples, rectangular reading glasses, ivory long-sleeve shirt, muted jade tie, charcoal trousers and polished brown shoes; pragmatic, quietly authoritative expression"],
  ["meera", "Meera, an Indian security investigator in her late thirties, athletic build, medium brown skin, short straight black bob tucked behind the ears, midnight-blue collared security uniform with a small plain brass badge, dark belt, dark trousers and practical boots; focused, calm expression"],
  ["handler", "The Handler, an anonymous human bust entirely in shadow, charcoal high-collared coat, face completely obscured with no visible eyes or facial identity, one warm amber rim light on the shoulder, ominous yet restrained silhouette"],
] as const;

const FLOOR_SCENES = [
  "Ground-floor reception lobby: an expansive double-height glass entrance, jade reception counter, terracotta inlay floor, amber pendant lamps, potted palms, a discreet security turnstile, two elevator doors, a few waiting visitors and a jade-sari receptionist.",
  "Visitor credentials and security desk: an ochre-shirted guard at a teak badge-collection counter, small trays of blank visitor cards, paper visitor ledger without readable writing, waiting chairs, a frosted-glass partition and an elevator corridor.",
  "Facilities and staff pantry: a well-used stainless-steel South Indian filter-coffee station with tumbler and dabarah cups, wall fans, maintenance cupboards, an older ivory-shirted facilities manager with a jade tie, plants and warm shafts of morning light.",
  "IT open office: crowded rows of amber wooden desks, dark monitors, a blue-grey-shirted engineer with round glasses, coiled cables, jade dividers, coffee tumblers, server diagnostic equipment and terracotta walkways.",
  "Finance and accounts office: compact desk islands, paper ledger stacks and blank folders, teal filing cabinets, calculators, potted plants and several busy workers under warm task lamps; no readable documents.",
  "Training and recruitment floor: glass-partitioned meeting rooms, a semicircle of simple chairs, blank whiteboards, a welcoming common table, several workers discussing quietly, jade upholstery and amber ceiling lights.",
  "Restricted server-floor corridor: a striking solid cobalt-blue secure door with a brass card reader, racks visible behind blue-green glass, amber service lights, tidy cable trays and a quiet security desk; tense but beautiful, not science fiction.",
  "Operations and project teams: densely populated desk clusters, cork pinboards covered in small blank parchment notes, terracotta aisles, jade seating, low office partitions, morning sunlight crossing the floor and colleagues speaking in pairs.",
  "Legal and records department: tall midnight-green file cabinets, frosted glass doors, heavy wooden worktables, sealed blank archive boxes and a quiet alcove with a single warm lamp; a few suited workers.",
  "Strategy and client-services floor: busy office bays beside a small glass meeting room, warm teak desks, jade chairs, a model building on a shelf and broad windows overlooking Hyderabad's layered office skyline.",
  "Executive boardroom: long polished but matte teak conference table, twelve muted jade chairs, amber lamps, midnight-blue glass walls, a rust-red-clad executive assistant with clipboard guarding an anteroom, a blank closed folder and broad Hyderabad skyline windows; morning light and quiet tension.",
  "Upper-floor terrace and building services: office roof garden behind glass, Hyderabad skyline and hazy warm sky, potted palms, terracotta paving, maintenance cabinets, a small staff lounge and the top of an elevator enclosure.",
] as const;

export interface AssetSpec {
  id: string;
  kind: AssetRecord["kind"];
  prompt: string;
  aspectRatio: "1:1" | "2:3" | "16:9";
  width: number;
  height: number;
  referenceId?: string;
}

export const ASSET_CATALOG: readonly AssetSpec[] = [
  {
    id: "meridian-exterior", kind: "background", aspectRatio: "16:9", width: 1280, height: 720,
    prompt: `${STYLE}
A richly illustrated full-scene title backdrop for Operation Glasshouse, without any text.
A twelve-storey glass-and-blue-green-concrete office tower in Hyderabad at warm morning light, shown as an elegant
isometric architectural illustration embedded in a lively city block. Tower occupies the RIGHT two thirds,
with its entire height and entrance visible; LEFT third is quieter shaded street and softly patterned low rooftops,
leaving visual breathing space for separately rendered title typography. Terracotta entrance steps, jade glass,
golden sunlight along the edges, leafy trees, a parked yellow-and-black auto-rickshaw, tiny office commuters,
and distant warm Deccan city silhouettes. An amber-lit reception is visible through the entrance.
Compelling layered foreground, midground and skyline; make this a beautiful complete illustration, not a floating building on white.
Render as carefully authored 640 by 360 pixel art enlarged with nearest-neighbor pixels.`,
  },
  ...CAST.map(([id, description]): AssetSpec => ({
    id: `portrait-${id}`, kind: "portrait", aspectRatio: "1:1", width: 256, height: 256,
    referenceId: id === "ghost" ? "meridian-exterior" : "portrait-ghost",
    prompt: `${STYLE}
Create one square character dossier portrait. ${description}.
Consistent close head-and-shoulders framing: entire head and shoulders visible, head near upper center,
eyes around 40 percent down the frame, bust ending at the bottom. Facing slightly to the viewer's right.
Simple dark blue-green office-wall background with subtle amber side light, no scenery or objects competing with the face.
Expressive readable features built from confident large pixel clusters, like a carefully hand-drawn 128 by 128 pixel portrait.
Use the reference only to match pixel style, palette and light; draw the specified DIFFERENT person, not the reference person.
No nameplate, decorative frame, text, montage or additional heads.`,
  })),
  ...CAST.filter(([id]) => id !== "handler").map(([id, description]): AssetSpec => ({
    id: `sprite-${id}`, kind: "sprite", aspectRatio: "2:3", width: SPRITE_WIDTH, height: SPRITE_HEIGHT,
    referenceId: `portrait-${id}`,
    prompt: `${STYLE}
Draw ONE single isolated FULL-BODY standing game character sprite of this exact person: ${description}.
The reference portrait defines this person's face, hair, clothes and colors; preserve the identity.
Use a 2:1 isometric overhead game camera; we see the top of the head, front and left side, facing diagonally
down-right / southeast. Relaxed clear neutral stance, both arms distinguishable, both complete shoes visible.
Compact 1990s adventure-game proportions, not a tiny chibi: head about one fifth of total height.
The entire body from hair to soles fits inside the CENTRAL 70 percent of the canvas, with large empty margins
on ALL four sides, especially below both feet. Crisp chunky pixels at an intended body height of about 64 logical pixels.
SOLID EXACT MAGENTA #ff00ff fills every background pixel. No floor, cast shadow, pedestal, glow, outline halo,
background objects or scenery. Do not use magenta or pink anywhere on the character.
Exactly one pose, not a sprite sheet, not a portrait, no inset reference portrait, no duplicate body or labels.`,
  })),
  ...FLOOR_SCENES.map((scene, index): AssetSpec => ({
    id: `floor-${index + 1}`, kind: "floor", aspectRatio: "16:9", width: 768, height: 432,
    referenceId: "meridian-exterior",
    prompt: `${STYLE}
One atmospheric wide 2:1 isometric cutaway illustration of an office interior at Meridian Tower, floor ${index + 1}.
${scene}
This is a richly composed room-ambience vignette, NOT an authoritative game map, not a dungeon layout.
Show one connected believable office scene with a few small adult characters for scale, strong readable furniture
silhouettes, cozy practical details, warm lamps contrasting blue-green structure.
Frame the room generously to the image edges, no white outside margin, no title, no numbers or diagrams.
Use the reference exterior's pixel language and palette, but show the specified interior.
Render as beautifully hand-authored 384 by 216 pixel art enlarged without smoothing.`,
  })),
  ...([
    ["floor", "muted terracotta office tiles, subtle amber clay variation and thin dark brown grout; small evenly spaced square tiles"],
    ["carpet", "muted jade low-pile woven office carpet, tiny blue-green and ochre flecks, restrained geometric woven texture"],
    ["wall", "midnight blue-green painted concrete, subtle square pixel mottling and small weathered jade flecks, no cracks large enough to look like doors"],
  ] as const).map(([id, material]): AssetSpec => ({
    id: `texture-${id}`, kind: "texture", aspectRatio: "1:1", width: 128, height: 128,
    prompt: `${STYLE}
A seamless, evenly lit, flat TOP-DOWN square material texture of ${material}.
This is a repeatable material swatch, NOT a room, wall elevation or isometric tile.
All four edges must tile seamlessly. No perspective, no raised borders, no shadows, no objects, no central motif.
Fine subtle contrast, low visual noise, a tightly limited palette; genuine chunky pixel texture at 64 by 64 logical pixels.
Fill the entire frame with the material.`,
  })),
];

const specs = new Map(ASSET_CATALOG.map((spec) => [spec.id, spec]));
const recordSchema = z.object({
  id: z.string(),
  url: z.string(),
  kind: z.enum(["portrait", "sprite", "floor", "background", "texture"]),
  model: z.string().min(1).max(160).regex(/^[a-zA-Z0-9._/-]+$/),
  generatedAt: z.string().datetime(),
}).superRefine((record, context) => {
  const spec = specs.get(record.id);
  if (!spec || record.kind !== spec.kind || !new RegExp(`^/generated/${record.id}-[a-f0-9]{16}\\.png$`).test(record.url)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Unknown asset or unsafe asset path." });
  }
});
const manifestSchema = z.object({
  version: z.literal(1),
  assets: z.array(recordSchema).max(ASSET_CATALOG.length),
  status: z.enum(["ready", "partial", "empty"]),
}).refine((manifest) => new Set(manifest.assets.map(({ id }) => id)).size === manifest.assets.length);

export class ArtError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
    this.name = "ArtError";
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function safeError(error: unknown): ArtError {
  if (error instanceof ArtError) return error;
  if (hasCode(error, "ENOSPC")) return new ArtError("STORAGE", "The artwork cache is out of disk space.");
  if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) return new ArtError("STORAGE", "The server cannot access the artwork cache; check its filesystem permissions.");
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
    const status = error.status;
    return new ArtError("PROVIDER", `Gemini image request failed (HTTP ${status}).`, status === 429 || status >= 500);
  }
  return new ArtError("GENERATION", "Image generation failed; check the server's image configuration and connectivity.");
}

function manifestFor(assets: AssetRecord[]): AssetManifest {
  const order = new Map(ASSET_CATALOG.map((spec, index) => [spec.id, index]));
  const sorted = [...assets].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { version: 1, assets: sorted, status: sorted.length === ASSET_CATALOG.length ? "ready" : sorted.length ? "partial" : "empty" };
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  model: string;
}

export function extractGeneratedImage(response: GenerateContentResponse, requestedModel: string): GeneratedImage {
  if (response.promptFeedback?.blockReason) {
    throw new ArtError("REFUSED", "Gemini declined the image request. No image was saved.");
  }
  for (const candidate of response.candidates ?? []) {
    if (["SAFETY", "IMAGE_SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"].includes(candidate.finishReason ?? "")) {
      throw new ArtError("REFUSED", "Gemini declined the image request. No image was saved.");
    }
    for (const part of candidate.content?.parts ?? []) {
      if (part.thought || !part.inlineData?.data) continue;
      const { data, mimeType } = part.inlineData;
      if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") {
        throw new ArtError("IMAGE_FORMAT", "Gemini returned an unsupported image format.");
      }
      if (data.length > MAX_IMAGE_BYTES * 4 / 3 + 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(data)) {
        throw new ArtError("IMAGE_DATA", "Gemini returned invalid or oversized image data.");
      }
      const bytes = Buffer.from(data, "base64");
      if (!bytes.length) throw new ArtError("EMPTY_IMAGE", "Gemini returned empty image data.", true);
      const model = response.modelVersion || requestedModel;
      if (!/^[a-zA-Z0-9._/-]{1,160}$/.test(model)) {
        throw new ArtError("MODEL_METADATA", "Gemini returned invalid model provenance.");
      }
      return { bytes, mimeType, model };
    }
  }
  throw new ArtError("EMPTY_IMAGE", "Gemini returned no image. Text-only responses are not treated as artwork.", true);
}

function keySprite(data: Buffer, width: number, height: number): { left: number; top: number; width: number; height: number } {
  const keyed = new Uint8Array(width * height);
  const isMagenta = (r: number, g: number, b: number, margin: number) =>
    r > 130 && b > 120 && r - g > margin && b - g > margin;
  for (let pixel = 0; pixel < keyed.length; pixel++) {
    const i = pixel * 4;
    if (data[i + 3] < 128 || isMagenta(data[i], data[i + 1], data[i + 2], 65)) keyed[pixel] = 1;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      const i = pixel * 4;
      const touchesKey = (x > 0 && keyed[pixel - 1]) || (x + 1 < width && keyed[pixel + 1])
        || (y > 0 && keyed[pixel - width]) || (y + 1 < height && keyed[pixel + width]);
      const clear = keyed[pixel] || (touchesKey && isMagenta(data[i], data[i + 1], data[i + 2], 28));
      data[i + 3] = clear ? 0 : 255;
      if (clear) data.fill(0, i, i + 4);
    }
  }

  // Keep real detached accessories, but discard tiny isolated chroma-compression flecks.
  const visited = new Uint8Array(keyed.length);
  const queue = new Int32Array(keyed.length);
  const components: number[][] = [];
  for (let start = 0; start < keyed.length; start++) {
    if (visited[start] || !data[start * 4 + 3]) continue;
    const component: number[] = [];
    let head = 0;
    let tail = 1;
    queue[0] = start;
    visited[start] = 1;
    while (head < tail) {
      const pixel = queue[head++];
      component.push(pixel);
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const neighbors = [x > 0 ? pixel - 1 : -1, x + 1 < width ? pixel + 1 : -1, y > 0 ? pixel - width : -1, y + 1 < height ? pixel + width : -1];
      for (const next of neighbors) {
        if (next >= 0 && !visited[next] && data[next * 4 + 3]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    components.push(component);
  }
  const largest = components.reduce((maximum, component) => Math.max(maximum, component.length), 0);
  for (const component of components) {
    if (component.length < Math.max(3, largest * 0.002)) {
      for (const pixel of component) data.fill(0, pixel * 4, pixel * 4 + 4);
    }
  }
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let opaque = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!data[(y * width + x) * 4 + 3]) continue;
      opaque++;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (opaque < width * height * 0.015 || opaque > width * height * 0.72) {
    throw new ArtError("SPRITE_BACKGROUND", "Sprite has no usable isolated body on its chroma background.");
  }
  if (left < 2 || top < 2 || right >= width - 2 || bottom >= height - 2) {
    throw new ArtError("SPRITE_CROPPED", "Sprite reaches the image edge; regeneration is required to preserve the whole body.");
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function despillSprite(data: Buffer, width: number, height: number): void {
  const contaminated = new Uint8Array(width * height);
  for (let pixel = 0; pixel < contaminated.length; pixel++) {
    const i = pixel * 4;
    const [r, g, b] = data.subarray(i, i + 3);
    if (data[i + 3] && r > g + 12 && b > g + 10 && Math.min(r, b) > Math.max(r, b) * 0.38) contaminated[pixel] = 1;
  }
  const original = Buffer.from(data);
  for (let pixel = 0; pixel < contaminated.length; pixel++) {
    if (!contaminated[pixel]) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    let nearest = -1;
    let distance = 33;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const candidate = (y + dy) * width + x + dx;
        const squared = dx * dx + dy * dy;
        if (!contaminated[candidate] && original[candidate * 4 + 3] && squared < distance) {
          nearest = candidate;
          distance = squared;
        }
      }
    }
    if (nearest < 0) data.fill(0, pixel * 4, pixel * 4 + 4);
    else original.copy(data, pixel * 4, nearest * 4, nearest * 4 + 4);
  }
}

function sealTextureEdges(data: Buffer, width: number, height: number, channels: number): void {
  const blend = (first: number, last: number, weight: number) => {
    for (let channel = 0; channel < channels; channel++) {
      const a = data[first + channel];
      const b = data[last + channel];
      data[first + channel] = Math.round(a * (1 - weight) + b * weight);
      data[last + channel] = Math.round(b * (1 - weight) + a * weight);
    }
  };
  for (let y = 0; y < height; y++) {
    for (let edge = 0; edge < 4; edge++) blend((y * width + edge) * channels, (y * width + width - edge - 1) * channels, (4 - edge) / 8);
  }
  for (let x = 0; x < width; x++) {
    for (let edge = 0; edge < 4; edge++) blend((edge * width + x) * channels, ((height - edge - 1) * width + x) * channels, (4 - edge) / 8);
  }
}

export async function prepareAssetImage(spec: AssetSpec, image: GeneratedImage): Promise<Buffer> {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(image.bytes, { limitInputPixels: 16_777_216 }).metadata();
  } catch {
    throw new ArtError("IMAGE_DATA", "Gemini's image could not be decoded. No asset was published.");
  }
  const expectedFormat = image.mimeType === "image/jpeg" ? "jpeg" : image.mimeType.slice(6);
  if (metadata.format !== expectedFormat || !metadata.width || !metadata.height || metadata.width < 32 || metadata.height < 32) {
    throw new ArtError("IMAGE_FORMAT", "Generated image bytes do not match the declared format or usable dimensions.");
  }
  if (spec.kind === "sprite") {
    const { data, info } = await sharp(image.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const bounds = keySprite(data, info.width, info.height);
    const scale = Math.min(40 / bounds.width, 66 / bounds.height);
    const width = Math.max(2, Math.round(bounds.width * scale)) * 2;
    const height = Math.max(2, Math.round(bounds.height * scale)) * 2;
    const body = await sharp(data, { raw: info }).extract(bounds)
      .resize(width / 2, height / 2, { kernel: "nearest", fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
    // Dark magenta survives a brightness-only chroma key; borrow nearby real body colors, not invented outlines.
    despillSprite(body.data, body.info.width, body.info.height);
    const pixels = await sharp(body.data, { raw: body.info }).resize(width, height, { kernel: "nearest" }).png().toBuffer();
    return sharp({ create: { width: spec.width, height: spec.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: pixels, left: Math.floor((spec.width - width) / 2), top: SPRITE_FOOT_Y - height }])
      .png({ palette: true, colours: 96, dither: 0, compressionLevel: 9 }).toBuffer();
  }
  const { data, info } = await sharp(image.bytes).flatten({ background: "#152b30" }).removeAlpha()
    .resize(spec.width / 2, spec.height / 2, { fit: "cover", kernel: "nearest" }).raw().toBuffer({ resolveWithObject: true });
  if (spec.kind === "texture") sealTextureEdges(data, info.width, info.height, info.channels);
  return sharp(data, { raw: info }).resize(spec.width, spec.height, { kernel: "nearest" })
    .png({ palette: true, colours: spec.kind === "portrait" ? 96 : 128, dither: 0, compressionLevel: 9 }).toBuffer();
}

const sleep = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));

async function atomicWrite(path: string, data: Buffer | string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => { if (!hasCode(error, "ENOENT")) throw error; });
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

async function recoverDeadLock(path: string): Promise<void> {
  let recovery;
  try {
    recovery = await open(join(path, "recover"), "wx");
  } catch (error) {
    if (hasCode(error, "EEXIST") || hasCode(error, "ENOENT")) return;
    throw error;
  }
  let moved = false;
  try {
    let owner: unknown;
    try {
      owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
    } catch (error) {
      if (!hasCode(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
      if (Date.now() - (await lstat(path)).mtimeMs < 10_000) return;
      if (error instanceof SyntaxError) throw new ArtError("LOCK_INVALID", "An artwork lock has invalid ownership metadata; stop asset processes before clearing it.");
    }
    if (typeof owner === "object" && owner !== null && "pid" in owner && typeof owner.pid === "number" && processAlive(owner.pid)) return;
    const abandoned = `${path}.${randomUUID()}.abandoned`;
    await recovery.close();
    await rename(path, abandoned);
    moved = true;
    for (const name of ["owner.json", "recover"]) {
      await unlink(join(abandoned, name)).catch((error: unknown) => { if (!hasCode(error, "ENOENT")) throw error; });
    }
    await rmdir(abandoned);
  } finally {
    if (!moved) {
      await recovery.close();
      await unlink(join(path, "recover")).catch((error: unknown) => { if (!hasCode(error, "ENOENT")) throw error; });
    }
  }
}

async function withLock<T>(directory: string, name: string, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  const lockRoot = join(directory, ".locks");
  await mkdir(lockRoot, { recursive: true });
  const path = join(lockRoot, name);
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(path);
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      await recoverDeadLock(path);
      if (Date.now() - started > timeoutMs) throw new ArtError("LOCK_TIMEOUT", "Another artwork job still owns this asset; retry after it finishes.");
      await sleep(40);
    }
  }
  try {
    await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid }));
    return await operation();
  } finally {
    await unlink(join(path, "owner.json")).catch((error: unknown) => { if (!hasCode(error, "ENOENT")) throw error; });
    const releasing = Date.now();
    for (;;) {
      try {
        await rmdir(path);
        break;
      } catch (error) {
        if (!hasCode(error, "ENOTEMPTY") && !hasCode(error, "EEXIST")) throw error;
        if (Date.now() - releasing > 15_000) throw new ArtError("LOCK_RELEASE", "Artwork was written but its lock could not be released; stop other asset processes before retrying.");
        await sleep(20);
      }
    }
  }
}

async function withGenerationSlot<T>(directory: string, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    for (let slot = 0; slot < MAX_WORKERS; slot++) {
      try {
        return await withLock(directory, `worker-${slot}`, 0, operation);
      } catch (error) {
        if (!(error instanceof ArtError) || error.code !== "LOCK_TIMEOUT") throw error;
      }
    }
    await sleep(40);
  }
  throw new ArtError("QUEUE_TIMEOUT", "The two shared artwork workers are still busy; retry after current generation finishes.");
}

export type ImageGenerator = (spec: AssetSpec, reference: Buffer | undefined, signal: AbortSignal) => Promise<GeneratedImage>;

function loadEnvironment(): void {
  const explicit = process.env.GLASSHOUSE_ENV_FILE;
  const result = loadDotenv({ path: explicit || resolve(".env") });
  if (result.error && (explicit || !hasCode(result.error, "ENOENT"))) {
    throw new ArtError("CONFIGURATION", "The configured artwork environment file could not be loaded.");
  }
}

function geminiGenerator(): ImageGenerator {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new ArtError("CONFIGURATION", "Missing GEMINI_API_KEY. Cached art remains available; configure the server to generate missing images.");
  const model = process.env.GEMINI_IMAGE_MODEL || DEFAULT_MODEL;
  if (!/^[a-zA-Z0-9._/-]{1,160}$/.test(model)) throw new ArtError("CONFIGURATION", "GEMINI_IMAGE_MODEL is not a valid model name.");
  const client = new GoogleGenAI({ apiKey });
  return async (spec, reference, signal) => {
    const parts: Part[] = [{ text: spec.prompt }];
    if (reference) parts.push({ inlineData: { mimeType: "image/png", data: reference.toString("base64") } });
    const response = await client.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: spec.aspectRatio, imageSize: "1K" },
        httpOptions: { timeout: REQUEST_TIMEOUT_MS, retryOptions: { attempts: 1 } },
        abortSignal: signal,
      },
    });
    return extractGeneratedImage(response, model);
  };
}

interface ArtLogger { info(message: string): void; warn(message: string): void; error(message: string): void }
interface ArtServiceOptions {
  directory?: string;
  generate?: ImageGenerator;
  logger?: ArtLogger;
  timeoutMs?: number;
  retryDelayMs?: number;
  cooldownMs?: number;
}
export interface ArtGenerationStatus {
  queued: string[];
  running: string[];
  failed: { id: string; message: string; at: string }[];
}
type JobResult = { ok: true; asset: AssetRecord } | { ok: false; error: ArtError };
interface Job { id: string; force: boolean; done: Promise<JobResult>; finish(result: JobResult): void }

export function createAssetService(options: ArtServiceOptions = {}) {
  const directory = resolve(options.directory || process.env.GLASSHOUSE_GENERATED_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "public", "generated"));
  const logger = options.logger || console;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? 1_500;
  const cooldownMs = options.cooldownMs ?? 5 * 60_000;
  const pending: Job[] = [];
  const jobs = new Map<string, Job>();
  const running = new Set<string>();
  const failures = new Map<string, { id: string; message: string; at: string }>();
  const reportedInvalid = new Set<string>();
  let generate = options.generate;

  async function readAssets(): Promise<AssetManifest> {
    let raw: string;
    try {
      raw = await readFile(join(directory, "manifest.json"), "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return manifestFor([]);
      throw new ArtError("MANIFEST_READ", "The generated artwork manifest could not be read.");
    }
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { throw new ArtError("MANIFEST_INVALID", "The artwork manifest contains invalid JSON."); }
    const parsed = manifestSchema.safeParse(decoded);
    if (!parsed.success) throw new ArtError("MANIFEST_INVALID", "The artwork manifest has invalid records or unsafe paths.");
    const usable = await Promise.all(parsed.data.assets.map(async (record) => {
      const spec = specs.get(record.id)!;
      try {
        const path = join(directory, basename(record.url));
        const file = await lstat(path);
        if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_IMAGE_BYTES) throw new ArtError("IMAGE_FILE", "Invalid generated asset file.");
        const image = await sharp(path).metadata();
        if (image.format !== "png" || image.width !== spec.width || image.height !== spec.height || (spec.kind === "sprite" && !image.hasAlpha)) {
          throw new ArtError("IMAGE_FILE", "Invalid generated asset dimensions or transparency.");
        }
        reportedInvalid.delete(record.id);
        return record;
      } catch (error) {
        if (!hasCode(error, "ENOENT") && !(error instanceof ArtError) && !(error instanceof Error)) throw error;
        if (!reportedInvalid.has(record.id)) logger.warn(`[art] ${record.id} is missing or invalid; it will be regenerated when requested.`);
        reportedInvalid.add(record.id);
        return null;
      }
    }));
    return manifestFor(usable.filter((record): record is AssetRecord => record !== null));
  }

  function requireGenerator(): ImageGenerator {
    if (!generate) generate = geminiGenerator();
    return generate;
  }

  async function requestImage(spec: AssetSpec, reference: Buffer | undefined): Promise<GeneratedImage> {
    const provider = requireGenerator();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          provider(spec, reference, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new ArtError("TIMEOUT", "Gemini image generation timed out; it was not retried to avoid duplicate billing."));
              controller.abort();
            }, timeoutMs);
          }),
        ]);
      } catch (error) {
        const failure = safeError(error);
        if (!failure.retryable || attempt === MAX_ATTEMPTS) throw failure;
        logger.warn(`[art] ${spec.id}: ${failure.message} Retrying once.`);
        await sleep(retryDelayMs);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw new ArtError("GENERATION", "Image generation exhausted its bounded attempts.");
  }

  async function generateOne(id: string, force: boolean): Promise<AssetRecord> {
    const spec = specs.get(id)!;
    return withLock(directory, id, timeoutMs * MAX_ATTEMPTS + 30_000, async () => {
      const manifest = await readAssets();
      const cached = manifest.assets.find((asset) => asset.id === id);
      if (cached && !force) return cached;
      const referenceRecord = manifest.assets.find((asset) => asset.id === spec.referenceId);
      const reference = referenceRecord ? await readFile(join(directory, basename(referenceRecord.url))) : undefined;
      logger.info(`[art] Generating ${id}.`);
      // File-backed slots also bound API + CLI concurrency when both processes use the same cache.
      const image = await withGenerationSlot(directory, timeoutMs * MAX_ATTEMPTS + 30_000, () => requestImage(spec, reference));
      const pixels = await prepareAssetImage(spec, image);
      const filename = `${id}-${createHash("sha256").update(pixels).digest("hex").slice(0, 16)}.png`;
      const asset: AssetRecord = { id, kind: spec.kind, url: `/generated/${filename}`, model: image.model, generatedAt: new Date().toISOString() };
      await atomicWrite(join(directory, filename), pixels);
      await withLock(directory, "manifest", 15_000, async () => {
        const latest = await readAssets();
        const updated = manifestFor([...latest.assets.filter((record) => record.id !== id), asset]);
        await atomicWrite(join(directory, "manifest.json"), `${JSON.stringify(updated, null, 2)}\n`);
      });
      logger.info(`[art] Saved ${id} (${spec.width}x${spec.height}, ${image.model}).`);
      return asset;
    });
  }

  async function work(job: Job): Promise<void> {
    running.add(job.id);
    try {
      const asset = await generateOne(job.id, job.force);
      failures.delete(job.id);
      job.finish({ ok: true, asset });
    } catch (error) {
      const failure = safeError(error);
      failures.set(job.id, { id: job.id, message: failure.message, at: new Date().toISOString() });
      logger.error(`[art] ${job.id}: ${failure.message}`);
      job.finish({ ok: false, error: failure });
    } finally {
      running.delete(job.id);
      jobs.delete(job.id);
      pump();
    }
  }

  function pump(): void {
    while (running.size < MAX_WORKERS && pending.length) void work(pending.shift()!);
  }

  function enqueue(id: string, force = false): Promise<JobResult> {
    const existing = jobs.get(id);
    if (existing) return existing.done;
    let finish!: Job["finish"];
    const done = new Promise<JobResult>((resolve) => { finish = resolve; });
    const job: Job = { id, force, done, finish };
    jobs.set(id, job);
    pending.push(job);
    queueMicrotask(pump);
    return done;
  }

  async function scheduleFloorAssets(floors: number[]): Promise<void> {
    if (!Array.isArray(floors) || floors.length > 12 || floors.some((floor) => !Number.isInteger(floor) || floor < 1 || floor > 12)) {
      throw new ArtError("INVALID_FLOORS", "Prefetch accepts at most twelve integer floors, from 1 through 12.");
    }
    const manifest = await readAssets();
    const cached = new Set(manifest.assets.map(({ id }) => id));
    const missing = [...new Set(floors)].map((floor) => `floor-${floor}`).filter((id) => !cached.has(id) && !jobs.has(id));
    if (!missing.length) return;
    requireGenerator();
    for (const id of missing) {
      const failure = failures.get(id);
      if (failure && Date.now() - Date.parse(failure.at) < cooldownMs) {
        throw new ArtError("COOLDOWN", `Generation of ${id} recently failed. Retry after the five-minute cooldown.`);
      }
    }
    for (const id of missing) void enqueue(id);
  }

  async function generateAssets(ids: readonly string[] = ASSET_CATALOG.map(({ id }) => id), force = false): Promise<AssetManifest> {
    if (!ids.length || ids.some((id) => !specs.has(id))) throw new ArtError("INVALID_ASSETS", "Choose one or more known asset IDs; arbitrary names and prompts are not accepted.");
    const selected = [...new Set(ids)];
    const depth = (id: string): number => {
      const parent = specs.get(id)!.referenceId;
      return parent && selected.includes(parent) ? depth(parent) + 1 : 0;
    };
    const errors: string[] = [];
    for (let level = 0; level <= 3; level++) {
      const results = await Promise.all(selected.filter((id) => depth(id) === level).map((id) => enqueue(id, force)));
      for (const result of results) if (!result.ok) errors.push(result.error.message);
    }
    if (errors.length) throw new ArtError("BATCH_FAILED", `${errors.length} asset job(s) failed. Completed images are saved; rerun to resume. ${errors[0]}`);
    return readAssets();
  }

  return {
    readAssets,
    scheduleFloorAssets,
    generateAssets,
    async waitForIdle(): Promise<void> { await Promise.all([...jobs.values()].map((job) => job.done)); },
    getArtGenerationStatus(): ArtGenerationStatus {
      return { queued: pending.map(({ id }) => id), running: [...running], failed: [...failures.values()] };
    },
  };
}

let service: ReturnType<typeof createAssetService> | undefined;
function defaultService() {
  if (!service) {
    loadEnvironment();
    service = createAssetService();
  }
  return service;
}

export function readAssets(): Promise<AssetManifest> { return defaultService().readAssets(); }
/** Enqueues known floor art without waiting for Gemini. It never changes a floor plan. */
export function scheduleFloorAssets(floors: number[]): Promise<void> { return defaultService().scheduleFloorAssets(floors); }
export function getArtGenerationStatus(): ArtGenerationStatus { return defaultService().getArtGenerationStatus(); }
export function generateAssets(ids?: readonly string[], force = false): Promise<AssetManifest> { return defaultService().generateAssets(ids, force); }
