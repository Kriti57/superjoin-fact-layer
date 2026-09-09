import { db } from "./db";
import { extractPdfPages, chunkPages } from "./pdfExtract";
import { extractFactsFromChunk } from "./factExtraction";
import { detectRelationsForMetric, getAllDistinctMetrics } from "./relationDetection";

const PAGES_PER_CHUNK = parseInt(process.env.PAGES_PER_CHUNK || "6", 10);

const insertFact = db.prepare(`
  INSERT INTO facts (document_id, statement, entity, metric, value, unit, period, quote, page, confidence, category)
  VALUES (@document_id, @statement, @entity, @metric, @value, @unit, @period, @quote, @page, @confidence, @category)
`);

const insertRelation = db.prepare(`
  INSERT INTO relations (fact_a_id, fact_b_id, relation_type, reasoning)
  VALUES (@fact_a_id, @fact_b_id, @relation_type, @reasoning)
`);

const insertFailure = db.prepare(`
  INSERT INTO failure_log (document_id, stage, description)
  VALUES (@document_id, @stage, @description)
`);

const updateDocStatus = db.prepare(`UPDATE documents SET status = ?, error_message = ?, page_count = ? WHERE id = ?`);

/**
 * Full pipeline for one newly uploaded document:
 * 1. Extract text per page.
 * 2. Chunk pages and extract facts per chunk via the LLM.
 * 3. Re-run relation detection across ALL metrics touched by this document
 *    (so it gets compared against every existing document, and existing
 *    documents' relations for that metric get refreshed).
 *
 * Runs asynchronously after the upload response is sent; status is polled
 * via GET /api/documents/:id.
 */
export async function processDocument(documentId: number, filePath: string) {
  try {
    updateDocStatus.run("extracting", null, 0, documentId);

    const pages = await extractPdfPages(filePath);
    updateDocStatus.run("extracting", null, pages.length, documentId);

    if (pages.length === 0) {
      insertFailure.run({
        document_id: documentId,
        stage: "extraction",
        description: "PDF produced zero pages of extractable text (likely a scanned/image-only PDF with no OCR layer).",
      });
    }

    const chunks = chunkPages(pages, PAGES_PER_CHUNK);
    const touchedMetrics = new Set<string>();

    for (const chunk of chunks) {
      try {
        const { facts } = await extractFactsFromChunk(chunk);
        for (const f of facts) {
          insertFact.run({
            document_id: documentId,
            statement: f.statement,
            entity: f.entity,
            metric: f.metric,
            value: f.value,
            unit: f.unit,
            period: f.period,
            quote: f.quote,
            page: f.page,
            confidence: f.confidence,
            category: f.category,
          });
          touchedMetrics.add(f.metric);
        }
      } catch (err: any) {
        // A single chunk failing (rate limit, malformed tool call, etc.)
        // should not kill the whole document — log it and continue. This
        // is exactly the kind of "extraction failure" case #4 asks about.
        insertFailure.run({
          document_id: documentId,
          stage: "extraction",
          description: `Chunk pages ${chunk[0]?.page}-${chunk[chunk.length - 1]?.page} failed: ${err?.message || err}`,
        });
      }
      // Small pacing delay to stay comfortably under free-tier per-minute
      // rate limits when a document has many chunks.
      await new Promise((res) => setTimeout(res, 1200));
    }

    updateDocStatus.run("linking", null, pages.length, documentId);

    // Re-run relation detection for every metric this document touched.
    // Simplest correct approach: delete old relations for these metrics'
    // facts and recompute, so relations stay consistent as new docs arrive
    // (this is what lets a document be added incrementally rather than
    // forcing a full rebuild of unrelated metrics).
    for (const metric of touchedMetrics) {
      await refreshRelationsForMetric(metric);
    }

    updateDocStatus.run("done", null, pages.length, documentId);
  } catch (err: any) {
    updateDocStatus.run("error", err?.message || String(err), 0, documentId);
    insertFailure.run({
      document_id: documentId,
      stage: "extraction",
      description: `Document-level failure: ${err?.message || err}`,
    });
  }
}

export async function refreshRelationsForMetric(metric: string) {
  const factIds = (db.prepare(`SELECT id FROM facts WHERE metric = ?`).all(metric) as { id: number }[]).map(
    (r) => r.id
  );
  if (factIds.length === 0) return;

  const placeholders = factIds.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM relations WHERE fact_a_id IN (${placeholders}) OR fact_b_id IN (${placeholders})`
  ).run(...factIds, ...factIds);

  try {
    const { relations } = await detectRelationsForMetric(metric);
    for (const r of relations) {
      insertRelation.run(r);
    }
  } catch (err: any) {
    insertFailure.run({
      document_id: null,
      stage: "relation",
      description: `Relation detection failed for metric "${metric}": ${err?.message || err}`,
    });
  }
}

/** Recomputes relations across every metric currently in the DB. Useful for a manual re-link. */
export async function refreshAllRelations() {
  const metrics = getAllDistinctMetrics();
  for (const m of metrics) {
    await refreshRelationsForMetric(m);
  }
}
