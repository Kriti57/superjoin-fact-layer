import fs from "fs";
import { PageText } from "./types";

// pdfjs-dist ships an ESM-ish legacy build that works fine in Node with
// require() at runtime. We use dynamic import to keep this file CJS-friendly
// under ts-node while still loading the legacy Node build.
async function loadPdfJs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

/**
 * Extracts text from every page of a PDF, page by page, so each fact
 * we later extract can be grounded to a specific page number.
 */
export async function extractPdfPages(filePath: string): Promise<PageText[]> {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(fs.readFileSync(filePath));

  const loadingTask = pdfjs.getDocument({
    data,
    // Avoid trying to fetch external fonts/resources over the network.
    disableFontFace: true,
    useSystemFonts: true,
  });
  const doc = await loadingTask.promise;

  const pages: PageText[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const text = content.items
      .map((item: any) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push({ page: pageNum, text });
  }

  return pages;
}

/**
 * Groups consecutive pages into chunks so we don't send one LLM call per
 * page (slow, expensive) or the whole 100-page doc in one call (context
 * limits, worse grounding). Each chunk keeps page boundaries so facts can
 * still be attributed to an exact page.
 */
export function chunkPages(pages: PageText[], pagesPerChunk: number): PageText[][] {
  const chunks: PageText[][] = [];
  for (let i = 0; i < pages.length; i += pagesPerChunk) {
    chunks.push(pages.slice(i, i + pagesPerChunk));
  }
  return chunks;
}
