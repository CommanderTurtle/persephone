export type EnsembleDecision =
  | { action: "skip"; reason: string }
  | { action: "comment"; body: string };

export type DreamDecision =
  | { action: "skip"; reason: string }
  | { action: "propose"; title: string; issueBody: string; rationale: string; implementationBrief: string };

export function parseEnsembleDecision(text: string): EnsembleDecision {
  const value = parseJsonObject(text, "Ensemble");
  if (value.action === "skip") return { action: "skip", reason: String(value.reason || "No distinct useful take").slice(0, 500) };
  const body = String(value.body || "").trim();
  if (value.action !== "comment" || body.length < 20 || body.length > 1200) {
    throw new Error("Ensemble comment failed the bounded output contract");
  }
  return { action: "comment", body };
}

export function parseDreamDecision(text: string): DreamDecision {
  const value = parseJsonObject(text, "Dream");
  if (value.action === "skip") return { action: "skip", reason: String(value.reason || "No useful proposal").slice(0, 500) };
  const title = String(value.title || "").trim();
  const issueBody = String(value.issueBody || "").trim();
  const rationale = String(value.rationale || "").trim();
  const implementationBrief = String(value.implementationBrief || "").trim();
  if (value.action !== "propose" || !/^but what about\b/i.test(title) || title.length > 256) {
    throw new Error("Dream title must begin with 'But what about' and fit GitHub's title limit");
  }
  if (issueBody.length < 100 || issueBody.length > 40_000) throw new Error("Dream issueBody must contain 100..40000 characters");
  if (rationale.length < 20 || rationale.length > 5_000) throw new Error("Dream rationale must contain 20..5000 characters");
  if (implementationBrief.length < 40 || implementationBrief.length > 10_000) throw new Error("Dream implementationBrief must contain 40..10000 characters");
  return { action: "propose", title, issueBody, rationale, implementationBrief };
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`${label} output was not a JSON object`);
  const value = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} output was not a JSON object`);
  return value as Record<string, unknown>;
}
