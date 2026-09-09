import { Type, FunctionCallingConfigMode } from "@google/genai";
import { genai, MODEL } from "./llm";
import { withRetry } from "./retry";
import { PageText, ExtractedFact } from "./types";

const EXTRACTION_FUNCTION = {
  name: "record_facts",
  description:
    "Record every meaningful, checkable fact found in the given document pages.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      facts: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            statement: {
              type: Type.STRING,
              description:
                "A clear, self-contained, human-readable statement of the fact.",
            },
            entity: {
              type: Type.STRING,
              description:
                "The primary subject the fact is about (a company, country, person, or named thing).",
            },
            metric: {
              type: Type.STRING,
              description:
                "A short, normalized snake_case key identifying WHAT is being measured or stated, chosen so that the same underlying fact in a different document would get the same key (e.g. 'total_revenue', 'cpi_inflation_rate', 'ceo_name', 'director_status'). Do not include the entity or period in this key.",
            },
            value: {
              type: Type.STRING,
              nullable: true,
              description:
                "The numeric or key value of the fact, as a plain string preserving the original figure (e.g. '7510.4', '5.4', 'Sandeep Barasia'). Null if not a value-bearing fact.",
            },
            unit: {
              type: Type.STRING,
              nullable: true,
              description: "Unit of the value if any, e.g. 'INR crore', '%', 'USD million'. Null if not applicable.",
            },
            period: {
              type: Type.STRING,
              nullable: true,
              description:
                "The time period or as-of date/scope the fact applies to, exactly as it can be inferred from the text, e.g. 'FY2023-24', 'Q4 FY24', 'as of 31 March 2025'. Null if not time-bound.",
            },
            quote: {
              type: Type.STRING,
              description:
                "A short verbatim excerpt (ideally under 25 words) from the page text that directly supports this fact. This is the evidence trail.",
            },
            page: {
              type: Type.NUMBER,
              description:
                "The page number (matching the '--- PAGE N ---' marker) that this fact and quote came from.",
            },
            confidence: {
              type: Type.STRING,
              enum: ["high", "medium", "low"],
              description:
                "How directly the page text supports this fact. 'low' if inferred or ambiguous.",
            },
            category: {
              type: Type.STRING,
              description:
                "A short free-form label for what kind of fact this is, e.g. 'financial', 'governance', 'operational', 'macroeconomic'. Invent categories as needed; do not force-fit.",
            },
          },
          required: ["statement", "entity", "metric", "quote", "page", "confidence", "category"],
        },
      },
    },
    required: ["facts"],
  },
};

const SYSTEM_PROMPT = `You are a meticulous fact-extraction engine for a due-diligence / research tool.

Given raw text extracted from consecutive pages of a real-world document (a company filing, annual report, earnings deck, or economic/institutional report), extract every meaningful, checkable fact: numeric figures (revenue, growth rates, headcount, inflation, GDP, etc.), named entities and their roles/status (e.g. a director's status), dates, and other concrete claims.

Rules:
- Only extract facts that are actually stated or directly computable from the given text. Do not invent or infer facts not grounded in the text.
- Every fact must include a short verbatim "quote" copied from the given text that supports it, and the correct page number.
- Choose "metric" keys that would match across different documents describing the SAME kind of fact, even if worded differently, so facts can later be compared. Keep metric keys entity-agnostic and period-agnostic (the entity and period go in their own fields).
- Skip boilerplate, headers, footers, page numbers, and purely navigational text (table of contents entries, etc.) unless they are themselves factual claims.
- If a page has no extractable facts (e.g. it's a cover page or blank), return no facts for it.
- Do not deduplicate against other documents — you only see this document's pages. Extract everything relevant here.
- Extracted text is noisy raw PDF text (spacing/line breaks may be imperfect) — do your best to interpret it.
- You MUST call the record_facts function with your results. Always call it, even if the facts array is empty.`;

/**
 * Sends one chunk of consecutive pages to Gemini and gets back structured facts.
 * Each page is clearly delimited with its page number so the model can cite it.
 */
export async function extractFactsFromChunk(pages: PageText[]): Promise<{
  facts: ExtractedFact[];
  raw: any;
}> {
  const pageBlocks = pages
    .map((p) => `--- PAGE ${p.page} ---\n${p.text || "(no extractable text on this page)"}`)
    .join("\n\n");

  const response = await withRetry(() =>
    genai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [{ text: `Extract facts from the following pages:\n\n${pageBlocks}` }],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: [EXTRACTION_FUNCTION] }],
        toolConfig: {
          functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ["record_facts"] },
        },
      },
    })
  );

  const call = response.functionCalls?.[0];
  if (!call || !call.args) {
    return { facts: [], raw: response };
  }

  const rawFacts = (call.args as any).facts || [];
  const facts: ExtractedFact[] = rawFacts.map((f: any) => ({
    statement: f.statement,
    entity: f.entity,
    metric: normalizeMetricKey(f.metric),
    value: f.value ?? null,
    unit: f.unit ?? null,
    period: f.period ?? null,
    quote: f.quote,
    page: inferPage(f, pages),
    confidence: f.confidence || "medium",
    category: f.category || "general",
  }));

  return { facts, raw: response };
}

function normalizeMetricKey(metric: string): string {
  return (metric || "unknown")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Safety net: if the model's page number is missing or out of range for this
// chunk, fall back to matching the quote against the chunk's pages, then
// default to the first page in the chunk.
function inferPage(f: any, pages: PageText[]): number {
  if (typeof f.page === "number" && pages.some((p) => p.page === f.page)) {
    return f.page;
  }
  if (f.quote) {
    const hit = pages.find((p) => p.text.includes(f.quote.slice(0, 20)));
    if (hit) return hit.page;
  }
  return pages[0]?.page ?? 0;
}