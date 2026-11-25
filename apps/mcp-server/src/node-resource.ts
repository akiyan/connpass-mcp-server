import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname =
  typeof import.meta.dirname === "string"
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

export function loadConnpassHtml(): string {
  try {
    // 本番ビルド: dist 配下に同梱された HTML を読む
    const htmlPath = join(__dirname, "mcp-app.html");
    return readFileSync(htmlPath, "utf-8");
  } catch {
    try {
      // 開発時: node_modules の connpass-ui ビルド成果物を参照する
      const htmlPath = join(
        __dirname,
        "..",
        "node_modules",
        "@kajidog",
        "connpass-ui",
        "dist",
        "mcp-app.html",
      );
      return readFileSync(htmlPath, "utf-8");
    } catch {
      console.error(
        "Warning: connpass-ui HTML not found. Please build @kajidog/connpass-ui first.",
      );
      return "<html><body><p>Connpass UI not available. Please build @kajidog/connpass-ui.</p></body></html>";
    }
  }
}
