import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { db } from "./db";
import { processDocument, refreshAllRelations } from "./pipeline";
import { DocumentRow, FactRow, RelationRow, FailureLogRow } from "./types";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    cb(null, safe);
  },
});
const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDF files are accepted"));
    }
    cb(null, true);
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// --- Upload a new PDF -------------------------------------------------
app.post("/api/documents", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const insert = db.prepare(
    `INSERT INTO documents (filename, original_name, status) VALUES (?, ?, 'pending')`
  );
  const result = insert.run(req.file.filename, req.file.originalname);
  const documentId = result.lastInsertRowid as number;

  // Fire and forget: processing happens async, client polls for status.
  processDocument(documentId, req.file.path).catch((err) => {
    console.error(`Pipeline crashed for document ${documentId}:`, err);
  });

  res.status(202).json({ id: documentId, status: "pending" });
});

// --- List documents -----------------------------------------------------
app.get("/api/documents", (_req, res) => {
  const docs = db.prepare(`SELECT * FROM documents ORDER BY id DESC`).all() as DocumentRow[];
  res.json(docs);
});

app.get("/api/documents/:id", (req, res) => {
  const doc = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(req.params.id) as DocumentRow | undefined;
  if (!doc) return res.status(404).json({ error: "Not found" });
  const factCount = (
    db.prepare(`SELECT COUNT(*) as c FROM facts WHERE document_id = ?`).get(req.params.id) as { c: number }
  ).c;
  res.json({ ...doc, fact_count: factCount });
});

// --- Facts ---------------------------------------------------------------
app.get("/api/facts", (req, res) => {
  const { document_id, metric, entity, q } = req.query;
  let sql = `SELECT * FROM facts WHERE 1=1`;
  const params: any[] = [];
  if (document_id) {
    sql += ` AND document_id = ?`;
    params.push(document_id);
  }
  if (metric) {
    sql += ` AND metric = ?`;
    params.push(metric);
  }
  if (entity) {
    sql += ` AND entity LIKE ?`;
    params.push(`%${entity}%`);
  }
  if (q) {
    sql += ` AND (statement LIKE ? OR quote LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ` ORDER BY id DESC LIMIT 500`;
  const facts = db.prepare(sql).all(...params) as FactRow[];
  res.json(facts);
});

app.get("/api/metrics", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT metric, COUNT(*) as fact_count, COUNT(DISTINCT document_id) as doc_count FROM facts GROUP BY metric ORDER BY doc_count DESC, fact_count DESC`
    )
    .all();
  res.json(rows);
});

// --- Relations -------------------------------------------------------------
app.get("/api/relations", (req, res) => {
  const { relation_type, metric } = req.query;
  let sql = `
    SELECT r.*,
      fa.statement as fact_a_statement, fa.entity as fact_a_entity, fa.metric as fact_a_metric,
      fa.value as fact_a_value, fa.unit as fact_a_unit, fa.period as fact_a_period,
      fa.quote as fact_a_quote, fa.page as fact_a_page, fa.document_id as fact_a_doc_id,
      fb.statement as fact_b_statement, fb.entity as fact_b_entity, fb.metric as fact_b_metric,
      fb.value as fact_b_value, fb.unit as fact_b_unit, fb.period as fact_b_period,
      fb.quote as fact_b_quote, fb.page as fact_b_page, fb.document_id as fact_b_doc_id,
      da.original_name as fact_a_doc_name, db.original_name as fact_b_doc_name
    FROM relations r
    JOIN facts fa ON fa.id = r.fact_a_id
    JOIN facts fb ON fb.id = r.fact_b_id
    JOIN documents da ON da.id = fa.document_id
    JOIN documents db ON db.id = fb.document_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (relation_type) {
    sql += ` AND r.relation_type = ?`;
    params.push(relation_type);
  }
  if (metric) {
    sql += ` AND fa.metric = ?`;
    params.push(metric);
  }
  sql += ` ORDER BY r.id DESC LIMIT 500`;
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// --- Failure log (case #4: extraction/reasoning failures) ------------------
app.get("/api/failures", (_req, res) => {
  const rows = db.prepare(`SELECT * FROM failure_log ORDER BY id DESC LIMIT 200`).all() as FailureLogRow[];
  res.json(rows);
});

// --- Manual full relink (useful after tweaking prompts) --------------------
app.post("/api/relink", async (_req, res) => {
  res.status(202).json({ status: "relinking" });
  refreshAllRelations().catch((err) => console.error("Relink failed:", err));
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Fact Knowledge Layer running at http://localhost:${PORT}`);
});
