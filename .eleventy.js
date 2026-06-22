const fs = require("fs");
const path = require("path");

module.exports = function(eleventyConfig) {
  // Passthrough copy
  eleventyConfig.addPassthroughCopy("./src/css");
  eleventyConfig.addPassthroughCopy("./src/js");
  eleventyConfig.addPassthroughCopy("./src/*.ico");
  eleventyConfig.addPassthroughCopy("./src/images");
  eleventyConfig.addPassthroughCopy("./src/sounds");
  eleventyConfig.addPassthroughCopy("./src/fonts");
  eleventyConfig.addPassthroughCopy("./src/projects");
  eleventyConfig.addPassthroughCopy("./src/xml-style.xsl");
  // Copy server pages' static assets (images/css) so they are available at /server/...
  eleventyConfig.addPassthroughCopy({"./src/pages/server/fear-and-hunger": "server/fear-and-hunger"});
  eleventyConfig.addPassthroughCopy({"./src/pages/server/skylanders/archive": "server/skylanders/archive"});
  eleventyConfig.addPassthroughCopy({"./src/pages/server/skylanders/models": "server/skylanders/models"});
  // Extracted Lost Islands 3D models (.obj + animations) for the model viewer
  eleventyConfig.addPassthroughCopy({"./src/models": "models"});

  // simple slug helper
  const slugify = (s = "") =>
    String(s)
      .toLowerCase()
      .replace(/[^\w]+/g, "-")
      .replace(/^-+|-+$/g, "");

  // Filters
  eleventyConfig.addFilter("slug", slugify);
  eleventyConfig.addFilter("getImages", function(dirPath) {
    const fullPath = path.join(__dirname, "src", dirPath);
    try {
      if (fs.existsSync(fullPath) && fs.lstatSync(fullPath).isDirectory()) {
        const files = fs.readdirSync(fullPath);
        return files
          .filter(file => /\.(png|jpe?g|gif|svg|webp)$/i.test(file))
          .map(file => path.join("/", dirPath, file));
      }
    } catch (e) {
      console.error(`Error in getImages filter for ${dirPath}:`, e);
    }
    return [];
  });
  eleventyConfig.addFilter("join", (arr, sep = ",") =>
    Array.isArray(arr) ? arr.join(sep) : arr || ""
  );
  eleventyConfig.addFilter("json", (obj) => JSON.stringify(obj).replace(/</g, "\\u003c"));
  eleventyConfig.addFilter("flattenRoster", (games) =>
    games.flatMap((g) => g.characters)
         .filter((c) => c.render)
         .map((c) => ({ name: c.name, render: c.render }))
  );
  eleventyConfig.addFilter("toSlugs", (input, sep = " ") => {
    const arr = Array.isArray(input) ? input : input ? [input] : [];
    return arr.map(slugify).join(sep);
  });
  eleventyConfig.addFilter("dateToRfc822", (date) => {
    const d = (date && date.date) ? date.date : date;
    if (!d || isNaN(new Date(d).getTime())) return "";
    return new Date(d).toUTCString();
  });
  eleventyConfig.addFilter("readableDate", (dateObj) => {
    return new Date(dateObj).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  });

  eleventyConfig.addFilter("slice", (arr, start, end) => {
    return (arr || []).slice(start, end);
  });

  eleventyConfig.addFilter("limit", (arr, count) => {
    return (arr || []).slice(0, count);
  });

  // Returns URLs of the 5 newest artworks — used for the "new" badge in the atelier
  eleventyConfig.addCollection("newestArtworkUrls", function(collectionApi) {
    return collectionApi
      .getFilteredByGlob("./src/posts/artwork/**/*.md")
      .filter(item => !item.data.draft)
      .sort((a, b) => (b.date || 0) - (a.date || 0))
      .slice(0, 5)
      .map(item => item.url);
  });

  // Build a deduplicated categories collection with metadata (hasArtwork, thumb, posts)
  eleventyConfig.addCollection("categoriesData", function(collectionApi) {
    const items = collectionApi.getAll();
    const map = new Map();

    // consider only items coming from src/posts/**
    items.forEach(item => {
      if (!item.inputPath) return;
      // only posts under /posts/
      if (!item.inputPath.includes("/posts/")) return;
      // exclude games from categories
      if (item.inputPath.includes("/posts/games/")) return;
      const cats = item.data && item.data.categories ? item.data.categories : [];
      (Array.isArray(cats) ? cats : [cats]).forEach(cat => {
        if (!cat) return;
        const name = String(cat);
        if (!map.has(name)) {
          map.set(name, { name: name, posts: [], hasArtwork: false, nonArtworkCount: 0, thumb: null });
        }
        const entry = map.get(name);
        entry.posts.push(item);
        // mark artwork categories and pick representative thumbnail if available
        if (item.inputPath.includes('/posts/artwork/')) {
          entry.hasArtwork = true;
          if (item.data && item.data.image && !entry.thumb) {
            entry.thumb = '/images/artwork/thumbnails/' + item.data.image;
          }
        } else {
          entry.nonArtworkCount = (entry.nonArtworkCount || 0) + 1;
        }
      });
    });

    // Convert to array and sort alphabetically
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  });

  // Collection: categories -> array of { name, posts[] }
  eleventyConfig.addCollection("categories", function (collectionApi) {
    const map = new Map();
    collectionApi.getAll().forEach((item) => {
      if (item.inputPath && item.inputPath.includes("/posts/games/")) return;
      const cats = item.data && item.data.categories;
      if (!cats) return;
      const arr = Array.isArray(cats) ? cats : [cats];
      arr.forEach((cat) => {
        if (!map.has(cat)) map.set(cat, []);
        map.get(cat).push(item);
      });
    });

    return [...map.entries()].map(([name, posts]) => ({
      name,
      // sort posts newest-first if they have dates
      posts: posts.sort((a, b) => (b.date || 0) - (a.date || 0)),
    }));
  });

  // Collection: allCategories -> simple alphabetized array of category names
  eleventyConfig.addCollection("allCategories", function (collectionApi) {
    const set = new Set();
    collectionApi.getAll().forEach((item) => {
      if (item.inputPath && item.inputPath.includes("/posts/games/")) return;
      const cats = item.data && item.data.categories;
      if (!cats) return;
      (Array.isArray(cats) ? cats : [cats]).forEach((c) => set.add(c));
    });
    return [...set].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
  });

  eleventyConfig.addCollection("blinkies", function(collection) {
    const blinkieDir = path.join(__dirname, "src", "images", "blinkies");
    let files = [];
    try {
      files = fs.readdirSync(blinkieDir);
    } catch (e) {
      files = [];
    }
    return files.map(file => ({ fileSlug: file, url: `images/blinkies/${file}` }));
  });

  eleventyConfig.addCollection("exhibition-winter", function(collectionApi) {
    return collectionApi.getFilteredByTags("artwork", "exhibition-winter");
  });

  eleventyConfig.addCollection("exhibitions", function(collectionApi) {
    return collectionApi.getFilteredByGlob("./src/posts/exhibitions/*.md");
  });

  // Artwork grouped by category, each sorted newest-first, for the atelier page
  eleventyConfig.addCollection("artworkByCategory", function(collectionApi) {
    const artworks = collectionApi.getFilteredByGlob("./src/posts/artwork/**/*.md")
      .filter(notDraft)
      .sort((a, b) => (b.date || 0) - (a.date || 0));

    const map = new Map();
    for (const item of artworks) {
      const cats = item.data.categories;
      const arr  = Array.isArray(cats) ? cats : (cats ? [cats] : []);
      for (const cat of arr) {
        if (!map.has(cat)) map.set(cat, []);
        map.get(cat).push(item);
      }
    }

    return Array.from(map.entries())
      .map(([name, items]) => ({ name, artworks: items }))
      .sort((a, b) => ((b.artworks[0] || {}).date || 0) - ((a.artworks[0] || {}).date || 0));
  });

  // Games collection: pick up explicit posts placed under src/posts/games/
  const notDraft = item => !item.data.draft;

  eleventyConfig.addCollection("games", function(collectionApi) {
    return collectionApi.getFilteredByGlob("./src/posts/games/*.md").filter(notDraft).sort((a,b) => (b.date || 0) - (a.date || 0));
  });

  // Artwork collection
  eleventyConfig.addCollection("artwork", function(collectionApi) {
    return collectionApi.getFilteredByGlob("./src/posts/artwork/**/*.md").filter(notDraft).sort((a,b) => (b.date || 0) - (a.date || 0));
  });

  // Combined post collection for archive and RSS
  eleventyConfig.addCollection("post", function(collectionApi) {
    return collectionApi.getFilteredByGlob("./src/posts/writing/*.md")
      .filter(notDraft)
      .sort((a, b) => (a.date || 0) - (b.date || 0));
  });

  // Combined collection for the main RSS feed
  eleventyConfig.addCollection("allFeeds", function(collectionApi) {
    return collectionApi.getFilteredByGlob([
      "./src/posts/writing/*.md",
      "./src/posts/artwork/**/*.md",
      "./src/posts/games/*.md"
    ]).filter(notDraft).sort((a, b) => (b.date || 0) - (a.date || 0));
  });

  // Directory / template configuration
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
