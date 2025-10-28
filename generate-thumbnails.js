const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const inputDir = 'src/images/artwork/';
const outputDir = 'src/images/artwork/thumbnails/';
const thumbnailWidth = 200; // Set the width of the thumbnail
const thumbnailHeight = 200; // Set the height of the thumbnail

// Supported input extensions for Sharp
const supportedExt = /\.(jpe?g|png|webp|tiff|avif)$/i;

// Ensure the output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Process each entry in the input directory but skip subdirectories and unsupported files
fs.readdirSync(inputDir, { withFileTypes: true }).forEach(dirent => {
  if (!dirent.isFile()) return; // skip directories like "thumbnails"
  const file = dirent.name;
  if (!supportedExt.test(file)) {
    console.warn(`Skipping unsupported file (by extension): ${file}`);
    return;
  }

  const inputPath = path.join(inputDir, file);
  const outputPath = path.join(outputDir, file);

  sharp(inputPath)
    .resize(thumbnailWidth, thumbnailHeight, {
      fit: sharp.fit.cover,
      position: 'northwest' // Crop from the top-left-ish area
    })
    .toFile(outputPath)
    .then(() => {
      console.log(`Thumbnail generated: ${outputPath}`);
    })
    .catch(err => {
      console.error(`Error processing ${inputPath}:`, err);
    });

});
