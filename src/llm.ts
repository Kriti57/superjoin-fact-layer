import { GoogleGenAI } from "@google/genai";

if (!process.env.GEMINI_API_KEY) {
  console.warn(
    "[warn] GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey and set it in .env before processing documents."
  );
}

export const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// gemini-3.6-flash is on Google's free tier (no billing required) and
// supports forced function calling, which is what the extraction and
// relation-detection pipelines rely on for structured output.
export const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
