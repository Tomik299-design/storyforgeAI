const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const MODELS = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
  "gemini-pro",
];

async function callGemini(apiKey, model, contents, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: { maxOutputTokens: maxTokens || 4000, temperature: 0.9 },
    }),
  });
  const data = await res.json();
  return { status: res.status, data };
}

app.post("/api/claude", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing GEMINI_API_KEY" });

  const { system, messages, max_tokens } = req.body;
  const contents = [];
  if (system) {
    contents.push({ role: "user", parts: [{ text: "Systémový pokyn: " + system }] });
    contents.push({ role: "model", parts: [{ text: "Rozumím." }] });
  }
  for (const msg of messages) {
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    });
  }

  // Try each model until one works
  for (const model of MODELS) {
    try {
      console.log("Trying model:", model);
      const { status, data } = await callGemini(apiKey, model, contents, max_tokens);
      if (data.error) { console.log(model, "error:", data.error.message); continue; }
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!text) { console.log(model, "no text"); continue; }
      console.log("Success with:", model, "length:", text.length);
      return res.json({ content: [{ type: "text", text }] });
    } catch (e) {
      console.log(model, "exception:", e.message);
    }
  }

  res.status(500).json({ error: "Žádný Gemini model není dostupný. Zkontroluj API klíč na aistudio.google.com" });
});

// Test endpoint - lists working models
app.get("/api/test", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.json({ status: "ERROR", reason: "GEMINI_API_KEY not set" });

  const results = {};
  for (const model of MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Hi" }] }] }),
      });
      const d = await r.json();
      results[model] = d.error ? "❌ " + d.error.message.slice(0, 60) : "✅ OK";
    } catch (e) {
      results[model] = "❌ " + e.message;
    }
  }
  res.json(results);
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StoryForge AI running on port ${PORT}`));
