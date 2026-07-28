import { readFile, writeFile } from "node:fs/promises";

const sourcePath = new URL("../emby-icons.json", import.meta.url);
const outputPath = new URL("../public/emby-icons.seed.json", import.meta.url);

const source = await readFile(sourcePath, "utf8");
const document = JSON.parse(source);

if (!document || typeof document !== "object" || !Array.isArray(document.icons)) {
  throw new Error("emby-icons.json 必须包含 icons 数组");
}

for (const [index, icon] of document.icons.entries()) {
  if (!icon || typeof icon.name !== "string" || typeof icon.url !== "string") {
    throw new Error(`emby-icons.json 中的 icons[${index}] 格式无效`);
  }
}

await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.log(`已生成 public/emby-icons.seed.json，共 ${document.icons.length} 个图标`);
