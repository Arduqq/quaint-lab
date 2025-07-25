const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const inputDir = 'src/images/artwork/';
const outputDir = 'src/images/artwork/thumbnails/';
const thumbnailWidth = 200; // Set the width of the thumbnail
const thumbnailHeight = 200; // Set the height of the thumbnail

// Ensure the output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Process each image in the input directory
fs.readdirSync(inputDir).forEach(file => {
  const inputPath = path.join(inputDir, file);
  const outputPath = path.join(outputDir, file);

  sharp(inputPath)
    .resize(thumbnailWidth, thumbnailHeight, {
      fit: sharp.fit.cover,
      position: sharp.strategy.entropy
    })
    .toFile(outputPath)
    .then(() => {
      console.log(`Thumbnail generated: ${outputPath}`);
    })
    .catch(err => {
      console.error(`Error processing ${inputPath}:`, err);
    });
});
