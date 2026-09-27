const path = require("path");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "store-assets");
const BACKGROUND = "#0E0F12";

async function generateAppIcon() {
  const src = path.join(ROOT, "assets", "icon.png");
  const dest = path.join(OUT_DIR, "app-icon-512.png");
  await sharp(src).resize(512, 512, { fit: "cover" }).png().toFile(dest);
  console.log(`wrote ${dest}`);
}

async function generateFeatureGraphic() {
  const src = path.join(ROOT, "assets", "xayra-logo.png");
  const dest = path.join(OUT_DIR, "feature-graphic.png");
  const width = 1024;
  const height = 500;

  const logoMaxHeight = Math.round(height * 0.6);
  const logoMaxWidth = Math.round(width * 0.6);
  const logoBuffer = await sharp(src)
    .resize(logoMaxWidth, logoMaxHeight, { fit: "inside" })
    .toBuffer();
  const logoMeta = await sharp(logoBuffer).metadata();

  const left = Math.round((width - logoMeta.width) / 2);
  const top = Math.round((height - logoMeta.height) / 2);

  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: BACKGROUND,
    },
  })
    .composite([{ input: logoBuffer, left, top }])
    .png()
    .toFile(dest);
  console.log(`wrote ${dest}`);
}

async function main() {
  await generateAppIcon();
  await generateFeatureGraphic();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
