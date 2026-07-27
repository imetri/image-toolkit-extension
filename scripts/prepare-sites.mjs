import { mkdir, writeFile } from "node:fs/promises";

const serverDirectory = new URL("../dist/server/", import.meta.url);

await mkdir(serverDirectory, { recursive: true });
await writeFile(
  new URL("index.js", serverDirectory),
  `export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
`,
);
