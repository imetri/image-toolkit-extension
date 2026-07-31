import {
  createReadStream,
  createWriteStream,
} from "node:fs";
import {
  copyFile,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";

const serverDirectory = new URL("../dist/server/", import.meta.url);
const hostingDirectory = new URL("../dist/.openai/", import.meta.url);
const modelDirectory = new URL(
  "../dist/models/studioludens/birefnet-lite-512/onnx/",
  import.meta.url,
);
const modelFile = new URL("model_fp16.onnx", modelDirectory);
const modelParts = Array.from(
  { length:13 },
  (_, index) => new URL(`model_fp16.onnx.part-${index}`, modelDirectory),
);

await mkdir(serverDirectory, { recursive: true });
await mkdir(hostingDirectory, { recursive: true });
await writeFile(
  new URL("index.js", serverDirectory),
  `export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
`,
);
await copyFile(
  new URL("../.openai/hosting.json", import.meta.url),
  new URL("hosting.json", hostingDirectory),
);
await writeFile(modelFile, new Uint8Array());
for (const part of modelParts) {
  await pipeline(
    createReadStream(part),
    createWriteStream(modelFile, { flags:"a" }),
  );
  await rm(part);
}
