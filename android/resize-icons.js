// Генерирует иконки Sonic VPN для всех mipmap-плотностей (размеры 1:1 как у v2rayNG)
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'icon-source.png');
const OUT = path.join(process.cwd(), 'branding', 'app', 'src', 'main', 'res');

// [mipmap-dir, файл, width, height] — точно как в v2rayNG 2.2.6
const targets = [
  ['mipmap-mdpi', 'ic_launcher.png', 48, 48],
  ['mipmap-hdpi', 'ic_launcher.png', 72, 72],
  ['mipmap-xhdpi', 'ic_launcher.png', 96, 96],
  ['mipmap-xxhdpi', 'ic_launcher.png', 144, 144],
  ['mipmap-xxxhdpi', 'ic_launcher.png', 192, 192],
  ['mipmap-mdpi', 'ic_launcher_round.png', 48, 48],
  ['mipmap-xhdpi', 'ic_launcher_round.png', 96, 96],
  ['mipmap-xxhdpi', 'ic_launcher_round.png', 144, 144],
  ['mipmap-xxxhdpi', 'ic_launcher_round.png', 192, 192],
  ['mipmap-mdpi', 'ic_launcher_foreground.png', 108, 108],
  ['mipmap-hdpi', 'ic_launcher_foreground.png', 162, 162],
  ['mipmap-xhdpi', 'ic_launcher_foreground.png', 216, 216],
  ['mipmap-xxhdpi', 'ic_launcher_foreground.png', 324, 324],
  ['mipmap-xxxhdpi', 'ic_launcher_foreground.png', 432, 432],
  ['mipmap-xhdpi', 'ic_banner.png', 320, 180],
  ['mipmap-xhdpi', 'ic_banner_foreground.png', 320, 180],
];

for (const [dir, file, w, h] of targets) {
  const outDir = path.join(OUT, dir);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, file);
  const cover = w === h; // квадратные — cover; баннер — cover с центром
  await sharp(SRC).resize(w, h, { fit: 'cover', position: 'center' }).png().toFile(outPath);
  console.log(`ok ${dir}/${file} ${w}x${h}`);
}
console.log('done');
