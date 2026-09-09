# Fact Knowledge Layer

A system that extracts facts from PDFs, grounds each fact in the exact page/quote it came from, and cross-checks facts across documents to surface corroboration, contradiction, and context-based reconciliation.

Built for the Superjoin VIT 2026 Engineering Intern assignment.

---

## Setup and Run Instructions

**Requirements:** Node.js 18+, a free Gemini API key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey) — no credit card required, sign in with a Google account).

```bash
git clone <your-repo-url>
cd superjoin-fact-layer
npm install
cp .env.example .env
# edit .env and paste your GEMINI_API_KEY
npm run build
npm start
```

Open `http://localhost:3000`. Upload a PDF from the UI, or process a folder of PDFs in bulk from the command line:

```bash
npm run process -- /path/to/folder-of-pdfs
```

(For development with auto-reload: `npm run dev` instead of `build` + `start`.)

The UI has three tabs:
- **Facts** — every extracted fact, with its source document, page, and verbatim evidence quote.
- **Relations** — pairs of facts across documents classified as corroborating, contradicting, or reconciled-by-context, each with the model's stated reasoning.
- **Extraction failures** — a running log of chunks/documents that failed to extract cleanly, so failures are visible rather than silently swallowed.

## Video Demo

<!-- TODO: record a ≤3 minute screen capture showing: upload a PDF, wait for it to process,
then walk through one example each of: corroboration, contradiction, contextual reconciliation,
and a real extraction/reasoning failure (see "Limitations" below for one to point at). -->

Link: `TODO`

## Approach

**Pipeline:** PDF → per-page text extraction (`pdfjs-dist`) → pages chunked into ~6-page windows → each chunk sent to Gemini with a forced function-call schema to extract structured facts (`statement`, `entity`, `metric`, `value`, `unit`, `period`, `quote`, `page`, `confidence`, `category`) → facts stored in SQLite → facts grouped by their normalized `metric` key across *all* documents → any metric touched by 2+ documents is sent back to Claude to classify pairwise relations (`corroborates` / `contradicts` / `reconciled` / `related`) with a reasoning string.

**Key decisions:**

- **No hardcoded schema.** `metric` and `category` are free-text keys the model assigns per-fact, not a fixed enum I wrote. This is what lets the same code run against completely different document types (financial filings vs. macroeconomic reports) without document-specific rules — the brief explicitly requires this.
- **Grounding is enforced at the schema level.** The extraction function call requires a verbatim `quote` and `page` for every fact, so nothing enters the database without evidence attached. It's a much stronger guarantee than asking the model to "cite sources" in prose.
- **Relations are computed by grouping, not O(n²) comparison.** Instead of comparing every fact to every other fact (expensive, noisy), facts are bucketed by their normalized metric key first. Only genuinely comparable groups (same kind of fact, 2+ documents) go to the LLM for relation classification. This keeps the number of LLM calls proportional to the number of *distinct fact types*, not the number of facts — which is what makes the "many PDFs in the same knowledge layer" extension realistic.
- **Gemini free tier over a paid API.** The extraction/reasoning engine is Google's Gemini API (`gemini-2.5-flash`), chosen specifically because its free tier requires no credit card or billing setup — this keeps the whole project runnable by anyone evaluating it with zero cost, which matters more here than a marginal quality difference between providers.
- **Incremental by construction.** Uploading a new document only re-runs relation detection for the metrics that new document actually touched (see `refreshRelationsForMetric` in `src/pipeline.ts`), not the whole corpus. Existing documents' facts and relations for untouched metrics are left alone.
- **Failures are a first-class table, not swallowed exceptions.** `failure_log` records per-chunk extraction failures and per-metric relation-detection failures, surfaced directly in the UI, because the assignment explicitly asks for a failure case and how it was handled.
- **SQLite + relational tables over a graph DB.** The brief explicitly warns that "a graph database or visualization alone is not the solution" — a `facts` table plus a `relations` join table gives the same corroborates/contradicts/reconciled structure a graph would, without the extra infrastructure, and it's trivial to inspect and debug.

**AI tools used:** Claude (via this conversation, in Claude.ai) for architecture, code, and this README; the Gemini API (`gemini-2.5-flash`) is the extraction/reasoning engine inside the running application itself.

## Limitations and Next Steps

<!-- TODO after you've run this against the real PDFs tonight, fill in specifics:
     - Which fact came back with a wrong page number or malformed quote?
     - Did any chunk hit a rate limit or return zero facts?
     - Any metric key mismatch where two documents' facts about the "same" thing
       didn't get grouped because the model picked different metric strings?
     This last one is a very likely and very honest failure mode worth calling out
     explicitly — the metric-key matching is exact-string, not semantic, so
     "total_revenue" vs "revenue_total" won't be linked. That's a great answer
     to Case #4 if you hit it. -->

- Metric-key matching across documents is **exact string match**, not semantic — if the model names the same underlying fact `total_revenue` in one document and `revenue_total` in another, they won't be grouped for comparison. A fix: embed metric keys and cluster near-duplicates before grouping, or give the model the existing metric vocabulary as context so it reuses keys.
- Page-level chunking means a fact whose full context spans a chunk boundary can be extracted with a locally-correct but globally-misleading reading. A fix: overlap chunks by 1 page.
- No OCR fallback — scanned/image-only PDFs with no text layer will extract zero pages of text and log a failure rather than attempting OCR.
- Relation detection is capped at 6 facts per document per metric group to keep prompts small; a metric with many facts per document could miss comparisons beyond the cap.
- Confidence scores are self-reported by the model, not independently validated.

## Additional Notes

- `npm run process -- <folder>` is a convenience CLI for bulk-loading the starter dataset without clicking "upload" repeatedly during testing/demo prep.
- Re-running relation detection for everything (e.g. after tweaking a prompt) is available via the "Re-run relation detection" button in the UI, or `POST /api/relink`.
- All facts and relations are queryable directly via the API (`GET /api/facts`, `GET /api/relations`, `GET /api/metrics`, `GET /api/failures`) if you want to inspect raw output beyond the UI.
