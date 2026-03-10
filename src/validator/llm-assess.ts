import { fetch } from "undici";

/**
 * Optional LLM-based assessment for code quality and intent alignment.
 * Uses OpenAI API when OPENAI_API_KEY is set.
 */
export async function llmAssess(
  summary: string,
  intent: string,
  constraints: string[]
): Promise<number | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const prompt = `You are a code review validator. Assess how well this agent output aligns with the intent and constraints.

INTENT: ${intent}

CONSTRAINTS:
${constraints.map((c) => `- ${c}`).join("\n")}

AGENT SUMMARY:
${summary || "(no summary)"}

Respond with a single number between 0 and 1 (e.g., 0.85) indicating confidence that the output satisfies the intent and constraints. Only output the number.`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 10,
      }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const score = parseFloat(content);
    return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null;
  } catch {
    return null;
  }
}
