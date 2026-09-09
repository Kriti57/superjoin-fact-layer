export interface DocumentRow {
  id: number;
  filename: string;
  original_name: string;
  page_count: number;
  uploaded_at: string;
  status: "pending" | "extracting" | "linking" | "done" | "error";
  error_message: string | null;
}

export interface PageText {
  page: number;
  text: string;
}

// A single extracted fact, as returned by the LLM tool call.
export interface ExtractedFact {
  statement: string; // human-readable statement of the fact, e.g. "Delhivery reported total revenue of INR 7,510 crore"
  entity: string; // primary subject the fact is about, e.g. "Delhivery", "India"
  metric: string; // normalized snake_case key for matching across documents, e.g. "total_revenue", "cpi_inflation_rate"
  value: string | null; // the numeric or key value, kept as string to preserve formatting, e.g. "7510", "5.4"
  unit: string | null; // e.g. "INR crore", "%", "USD million"
  period: string | null; // time period/scope the fact applies to, e.g. "FY2023-24", "Q4 FY24", "as of March 2025"
  quote: string; // short verbatim quote from the page supporting the fact (evidence)
  page: number; // page number within the source document
  confidence: "high" | "medium" | "low";
  category: string; // free-form category the LLM assigns, e.g. "financial", "governance", "macroeconomic"
}

export interface FactRow {
  id: number;
  document_id: number;
  statement: string;
  entity: string;
  metric: string;
  value: string | null;
  unit: string | null;
  period: string | null;
  quote: string;
  page: number;
  confidence: string;
  category: string;
  created_at: string;
}

export type RelationType = "corroborates" | "contradicts" | "reconciled" | "related";

export interface ExtractedRelation {
  fact_a_id: number;
  fact_b_id: number;
  relation_type: RelationType;
  reasoning: string;
}

export interface RelationRow extends ExtractedRelation {
  id: number;
  created_at: string;
}

export interface FailureLogRow {
  id: number;
  document_id: number | null;
  stage: string; // "extraction" | "relation"
  description: string;
  created_at: string;
}
