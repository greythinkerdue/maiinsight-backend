// Reproducible GenAI recommendation experiment for Maiin Gandaria customer segments.
// Uses the exact model + SDK recovered in GEMINI_IMPLEMENTATION_AUDIT.md (gemini-2.5-flash, @google/genai).
// Reads GEMINI_API_KEY from this project's .env WITHOUT printing it.
// Inputs are the CSV-authoritative segment statistics (window Jan 2024 - May 2026, ref 2026-05-31).
import { GoogleGenAI } from "@google/genai";
import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Backend is maiin-gandaria-project/maiinsight-backend; outputs go to maiin-gandaria-project/AI_VALIDATION
const OUT_DIR = path.resolve(__dirname, "../../AI_VALIDATION");

const API_KEY = process.env.GEMINI_API_KEY || "";
if (!API_KEY) {
  console.error("GEMINI_API_KEY not set. Run inside maiinsight-backend so dotenv loads .env");
  process.exit(1);
}

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const SYSTEM_INSTRUCTION =
  "You are a decision-support assistant for a sport facility business. " +
  "Transform structured customer-segment analytics into practical marketing and " +
  "customer-management recommendations. Use only the supplied data. " +
  "Do not invent demographic information, financial outcomes, customer preferences, " +
  "or causal effects. Recommendations are advisory and require human managerial review.";

const PROMPT_TEMPLATE = `Segment Name: {segment_name}
Customer Count: {customer_count}
Customer Percentage: {customer_percentage}
Average Recency: {avg_recency}
Average Frequency: {avg_frequency}
Average Monetary: {avg_monetary}
Revenue Contribution: {revenue_contribution}
Revenue Share: {revenue_share}
Preferred Facility: {preferred_facility_if_available}

Generate JSON:
{
  "segment_summary": "",
  "primary_business_objective": "",
  "recommended_actions": [
    {
      "action": "",
      "rationale": "",
      "expected_business_role": ""
    }
  ],
  "risks_or_considerations": [],
  "human_review_required": true
}

Rules:
- Use only supplied analytical information.
- Do not claim recommendations will increase revenue.
- Do not invent customer characteristics.
- Keep recommendations consistent with the RFM profile.
- Clearly treat recommendations as decision support.`;

// CSV-authoritative segment statistics.
const SEGMENTS = [
  { fileKey: "prime_players", segment_name: "Prime Players", customer_count: "39", customer_percentage: "2.5%", avg_recency: "166.5 days", avg_frequency: "43.18 bookings", avg_monetary: "IDR 32,081,037", revenue_contribution: "IDR 1,251,160,462", revenue_share: "37.5%", preferred_facility_if_available: "not available" },
  { fileKey: "routine_players", segment_name: "Routine Players", customer_count: "429", customer_percentage: "27.9%", avg_recency: "150.0 days", avg_frequency: "2.69 bookings", avg_monetary: "IDR 2,024,758", revenue_contribution: "IDR 868,621,352", revenue_share: "26.1%", preferred_facility_if_available: "not available" },
  { fileKey: "growth_players", segment_name: "Growth Players", customer_count: "498", customer_percentage: "32.4%", avg_recency: "455.3 days", avg_frequency: "1.62 bookings", avg_monetary: "IDR 1,204,301", revenue_contribution: "IDR 599,741,937", revenue_share: "18.0%", preferred_facility_if_available: "not available" },
  { fileKey: "reengagement_players", segment_name: "Re-Engagement Players", customer_count: "573", customer_percentage: "37.2%", avg_recency: "738.7 days", avg_frequency: "1.42 bookings", avg_monetary: "IDR 1,072,587", revenue_contribution: "IDR 614,592,625", revenue_share: "18.4%", preferred_facility_if_available: "not available" },
];

function fillTemplate(segment) {
  return Object.keys(segment)
    .filter((k) => k !== "fileKey")
    .reduce((tpl, k) => tpl.replaceAll("{" + k + "}", segment[k]), PROMPT_TEMPLATE);
}

async function generate(segment) {
  const ai = new GoogleGenAI({ apiKey: API_KEY });
  const prompt = fillTemplate(segment);
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 0.3,
      maxOutputTokens: 1100,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const text = response?.text || "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw_response: text, parse_error: "Gemini returned non-JSON text" };
  }
  return { parsed, text };
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

fs.writeFileSync(
  path.join(OUT_DIR, "prompt_template.txt"),
  `${MODEL}\n\n# SYSTEM INSTRUCTION\n${SYSTEM_INSTRUCTION}\n\n# PROMPT TEMPLATE\n${PROMPT_TEMPLATE}\n`,
  "utf8"
);

for (const segment of SEGMENTS) {
  const { parsed, text } = await generate(segment);
  const out = {
    model: MODEL,
    segment_name: segment.segment_name,
    generated_at: new Date().toISOString(),
    input: { ...segment, fileKey: undefined },
    output: parsed,
  };
  fs.writeFileSync(path.join(OUT_DIR, `${segment.fileKey}_output.json`), JSON.stringify(out, null, 2), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, `${segment.fileKey}_raw.txt`), text, "utf8");
  console.log(`WROTE ${segment.fileKey}_output.json (model=${MODEL})`);
}

console.log("DONE. Files written to", OUT_DIR);
