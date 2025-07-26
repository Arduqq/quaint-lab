import { defineConfig } from "tinacms";

// Your hosting provider likely exposes this as an environment variable
const branch =
  process.env.GITHUB_BRANCH ||
  process.env.VERCEL_GIT_COMMIT_REF ||
  process.env.HEAD ||
  "main";

export default defineConfig({
  branch,

  // Get this from tina.io
  clientId: process.env.NEXT_PUBLIC_TINA_CLIENT_ID,
  // Get this from tina.io
  token: process.env.TINA_TOKEN,

  build: {
    outputFolder: "admin",
    publicFolder: "dist",
  },
  media: {
    tina: {
      mediaRoot: "images/artwork",
      publicFolder: "dist",
    },
  },
  // See docs on content modeling for more info on how to setup new content models: https://tina.io/docs/schema/
  schema: {
    collections: [
      {
        name: "post",
        label: "Writing",
        path: "src/posts/writing",
        fields: [
          {
            type: "string",
            name: "posttitle",
            label: "Title",
            isTitle: true,
            required: true,
          },
          {
            type: "string",
            name: "excerpt",
            label: "Excerpt",
            isTitle: false,
            required: true,
          },
          {
            type: "string",
            name: "tags",
            label: "Tags",
            isTitle: false,
            required: true,
          },
          {
            type: "string",
            name: "vibe",
            label: "Vibe",
            isTitle: false,
            required: true,
          },
          {
            type: "rich-text",
            name: "body",
            label: "Body",
            isBody: true,
          },
        ],
      },
      {
        name: "artwork",
        label: "Artwork",
        path: "src/posts/artwork",
        fields: [
          {
            type: "string",
            name: "posttitle",
            label: "Title",
            isTitle: true,
            required: true,
          },
          {
            type: "string",
            name: "comment",
            label: "Comment",
            isTitle: false,
            required: true,
          },
          {
            type: "string",
            name: "tags",
            label: "Tags",
            isTitle: false,
            required: true,
          },
          {
            type: "string",
            name: "categories",
            label: "Categories",
            isTitle: false,
            required: true,
          },
          {
            type: "image",
            name: "image",
            label: "Image",
            required: true,
          },
          {
            type: "rich-text",
            name: "body",
            label: "Body",
            isBody: true,
          },
        ],
      }
    ],
  },
});
