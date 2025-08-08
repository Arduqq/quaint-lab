const fs = require("fs");
const path = require("path");

module.exports = function(eleventyConfig) {

    // Passthrough copy for CSS
    eleventyConfig.addPassthroughCopy("./src/css");
    // Passthrough copy for JS
    eleventyConfig.addPassthroughCopy("./src/js");
    // Passthrough copy for fonts
    eleventyConfig.addPassthroughCopy("./src/*.ico");
    // Passthrough copy for global images directory
    eleventyConfig.addPassthroughCopy("./src/images");
    eleventyConfig.addPassthroughCopy("./src/fonts");
    // Collection for blinkies
    eleventyConfig.addCollection("blinkies", function(collection) {
        const blinkieDir = path.join(__dirname, "src", "images", "blinkies");
        return fs.readdirSync(blinkieDir).map(file => {
            return {
                fileSlug: file,
                url: `images/blinkies/${file}`
            };
        });
    });

    eleventyConfig.addCollection("exhibition-winter", function(collectionApi) {
        return collectionApi.getFilteredByTags("artwork", "exhibition-winter");
      });
    
    eleventyConfig.addCollection("exhibitions", function(collectionApi) {
        return collectionApi.getFilteredByGlob("./src/posts/exhibitions/*.md");
      });

    // Directory configuration
    return {
        markdownTemplateEngine: 'njk',
        htmlTemplateEngine: 'njk',
        templateFormats: ['md', 'njk', 'html', '11ty.js'],
        dir: {
            input: 'src',
            output: 'dist'
        }
    };
};
