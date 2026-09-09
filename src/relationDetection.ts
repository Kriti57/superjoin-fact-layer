import { Type, FunctionCallingConfigMode } from "@google/genai";
import { genai, MODEL } from "./llm";
import { withRetry } from "./retry";
import { db } from "./db";
import { FactRow, ExtractedRelation, RelationType } from "./types";

const RELATION_FUNCTION = {
  name: "record_relations",
  description:
    "Classify the relationship between pairs of facts that appear to be about the same underlying thing.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      relations: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            fact_a_id: { type: Type.NUMBER },
            fact_b_id: { type: Type.NUMBER },
            relation_type: {
              type: Type.STRING,
              enum: ["corroborates", "contradicts", "reconciled", "related"],
              description:
                "'corroborates' = the two facts state the same thing, possibly in different words/units, with no meaningful discrepancy. 'contradicts' = the two facts genuinely conflict with no obvious explanation. 'reconciled' = the facts look contradictory at first glance but are explained by context such as different time periods, scope, units, or definitions. 'related' = the facts are about the same metric/entity but don't clearly corroborate or contradict (e.g. too vague to compare).",
            },
            reasoning: {
              type: Type.STRING,
              description:
                "A concise explanation of WHY this relation was chosen, referencing the specific values/periods/units involved. For 'reconciled', explicitly name the contextual difference (e.g. different fiscal year, standalone vs consolidated, % vs absolute).",
            },
          },
          required: ["fact_a_id", "fact_b_id", "relation_type", "reasoning"],
        },
      },
    },
    required: ["relations"],
  },
};

const SYSTEM_PROMPT = `You are a careful fact-checking analyst. You are given a group of facts extracted from different documents that share the same normalized metric key (meaning they are likely about the same kind of thing, e.g. all "total_revenue" facts). Some facts in the group may be about different entities or genuinely unrelated despite sharing a metric key.

For each PAIR of facts in the group that are genuinely comparable (same or closely related entity, same underlying real-world quantity), decide whether they:
- corroborate each other (consistent, just phrased/rounded differently or in different units that convert consistently),
- contradict each other (genuinely inconsistent, with no clear explanation from period/scope/unit/definition differences),
- are reconciled by context (look contradictory but a clear reason like different fiscal periods, standalone vs consolidated figures, different denominators, or different as-of dates explains the difference), or
- are merely related (same topic, not directly comparable, e.g. too vague or about different sub-scopes).

Only emit a relation for pairs you are reasonably confident are actually about the same real-world fact. Do not force a relation between facts that are only superficially similar. It is fine to return zero relations if nothing in the group is genuinely comparable.

You MUST call the record_relations function with your results, even if the relations array is empty.`;

/**
 * Groups facts across ALL documents by metric key, then for any group with
 * facts from 2+ different documents, asks the LLM to classify pairwise
 * relations. This is what surfaces corroboration / contradiction /
 * reconciliation across the corpus, without any hardcoded fact schema.
 */
export async function detectRelationsForMetric(metric: string): Promise<{
  relations: ExtractedRelation[];
  factCount: number;
}> {
  const facts = db
    .prepare(
      `SELECT * FROM facts WHERE metric = ? ORDER BY document_id, page`
    )
    .all(metric) as FactRow[];

  const distinctDocs = new Set(facts.map((f) => f.document_id));
  if (facts.length < 2 || distinctDocs.size < 2) {
    return { relations: [], factCount: facts.length };
  }

  // Cap group size sent to the LLM to keep prompts small; if a metric has an
  // unusually large number of facts, take a representative sample per document.
  const capped = capPerDocument(facts, 6);

  const factList = capped
    .map(
      (f) =>
        `- id=${f.id} | doc=${f.document_id} | entity="${f.entity}" | value=${f.value ?? "N/A"} ${f.unit ?? ""} | period=${f.period ?? "N/A"} | statement="${f.statement}"`
    )
    .join("\n");

  const response = await withRetry(() =>
    genai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Metric group: "${metric}"\n\nFacts:\n${factList}\n\nClassify relations between comparable pairs. Use the exact numeric "id" values shown above for fact_a_id / fact_b_id.`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: [RELATION_FUNCTION] }],
        toolConfig: {
          functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ["record_relations"] },
        },
      },
    })
  );

  const call = response.functionCalls?.[0];
  if (!call || !call.args) return { relations: [], factCount: facts.length };

  const validIds = new Set(capped.map((f) => f.id));
  const rawRelations = (call.args as any).relations || [];
  const relations: ExtractedRelation[] = rawRelations
    .filter((r: any) => validIds.has(r.fact_a_id) && validIds.has(r.fact_b_id))
    .map((r: any) => ({
      fact_a_id: r.fact_a_id,
      fact_b_id: r.fact_b_id,
      relation_type: r.relation_type as RelationType,
      reasoning: r.reasoning,
    }));

  return { relations, factCount: facts.length };
}

function capPerDocument(facts: FactRow[], maxPerDoc: number): FactRow[] {
  const byDoc = new Map<number, FactRow[]>();
  for (const f of facts) {
    if (!byDoc.has(f.document_id)) byDoc.set(f.document_id, []);
    byDoc.get(f.document_id)!.push(f);
  }
  const out: FactRow[] = [];
  for (const [, list] of byDoc) {
    out.push(...list.slice(0, maxPerDoc));
  }
  return out;
}

export function getAllDistinctMetrics(): string[] {
  const rows = db.prepare(`SELECT DISTINCT metric FROM facts`).all() as { metric: string }[];
  return rows.map((r) => r.metric);
}
