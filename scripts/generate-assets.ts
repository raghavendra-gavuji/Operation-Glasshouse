import { ASSET_CATALOG, ArtError, generateAssets } from "../server/art.ts";

const HELP = `Operation Glasshouse - real Gemini artwork

npm run assets                         Generate only missing assets; safe to resume.
npm run assets -- --only ID,ID          Generate only these known missing assets.
npm run assets -- --force ID,ID         Regenerate exactly these assets.
npm run assets -- --list                List all supported IDs.

Server-only environment:
  GEMINI_API_KEY                       Required only for missing images.
  GEMINI_IMAGE_MODEL                   Default: gemini-3.1-flash-lite-image.
  GLASSHOUSE_ENV_FILE                  Optional private dotenv path.
  GLASSHOUSE_GENERATED_DIR             Optional output directory.

Two workers maximum, two attempts maximum, ninety-second request timeout.
Images are processed into game-ready PNGs; model and timestamp live in manifest.json.
Sprites are neutral single poses, 96x144, foot anchor (48,140); they are not animation atlases.
Floor pictures are ambience, never navigation or collision data.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(HELP);
    return;
  }
  if (args.length === 1 && args[0] === "--list") {
    for (const { id, kind, width, height } of ASSET_CATALOG) console.log(`${id}\t${kind}\t${width}x${height}`);
    return;
  }
  let ids: string[] | undefined;
  let force = false;
  if (args.length) {
    if (args.length !== 2 || !["--only", "--force"].includes(args[0])) {
      throw new ArtError("ARGUMENTS", "Use --only ID,ID or --force ID,ID. Bare --force is not allowed; see --help.");
    }
    ids = args[1].split(",").map((id) => id.trim());
    force = args[0] === "--force";
  }
  const manifest = await generateAssets(ids, force);
  console.log(`[art] ${manifest.status}: ${manifest.assets.length}/${ASSET_CATALOG.length} usable generated assets.`);
}

main().catch((error: unknown) => {
  console.error(`[art] ${error instanceof ArtError ? error.message : "Artwork generation failed. No credentials or raw provider errors are printed."}`);
  process.exitCode = 1;
});
