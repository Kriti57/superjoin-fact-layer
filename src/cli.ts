import "dotenv/config";
import fs from "fs";
import path from "path";
import { db } from "./db";
import { processDocument } from "./pipeline";

/**
 * Usage: npm run process -- /path/to/folder-of-pdfs
 * Registers and processes every .pdf in the given folder, sequentially
 * (sequential keeps things simple and avoids hammering the API rate limit).
 */
async function main() {
  const folder = process.argv[2];
  if (!folder) {
    console.error("Usage: npm run process -- /path/to/folder-of-pdfs");
    process.exit(1);
  }

  const files = fs
    .readdirSync(folder)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => path.join(folder, f));

  if (files.length === 0) {
    console.error(`No PDFs found in ${folder}`);
    process.exit(1);
  }

  console.log(`Found ${files.length} PDF(s). Processing sequentially...\n`);

  const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const insert = db.prepare(
    `INSERT INTO documents (filename, original_name, status) VALUES (?, ?, 'pending')`
  );

  for (const file of files) {
    const originalName = path.basename(file);
    const destName = `${Date.now()}-${originalName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const destPath = path.join(UPLOAD_DIR, destName);
    fs.copyFileSync(file, destPath);

    const result = insert.run(destName, originalName);
    const documentId = result.lastInsertRowid as number;

    console.log(`[${documentId}] Processing ${originalName}...`);
    await processDocument(documentId, destPath);
    console.log(`[${documentId}] Done.\n`);
  }

  console.log("All documents processed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
