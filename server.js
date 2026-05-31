const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Free models on OpenRouter to try in order
const FREE_MODELS = [
  "google/gemini-2.0-flash-exp:free",
  "google/gemma-3-27b-it:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "meta-llama/llama-3.1-70b-instruct:free",
  "mistralai/mistral-7b-instruct:free",
  "microsoft/phi-3-mini-128k-instruct:free",
  "qwen/qwen-2.5-72b-instruct:free",
];

async function tryModel(apiKey, model, messages, maxTokens) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
      "HTTP-Referer": "https://storyforgeai.onrender.com",
      "X-Title": "StoryForge AI",
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens || 4000, temperature: 0.9 }),
  });
  const data = await r.json();
  return data;
}

app.post("/api/claude", async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing OPENROUTER_API_KEY" });

  const { system, messages, max_tokens } = req.body;
  const openaiMessages = [];
  if (system) openaiMessages.push({ role: "system", content: system });
  for (const msg of messages) openaiMessages.push(msg);

  for (const model of FREE_MODELS) {
    try {
      console.log("Trying:", model);
      const data = await tryModel(apiKey, model, openaiMessages, max_tokens);
      if (data.error) { console.log("Error:", data.error.message?.slice(0, 80)); continue; }
      const text = data.choices?.[0]?.message?.content || "";
      if (!text) { console.log("No text from", model); continue; }
      console.log("OK:", model, "len:", text.length);
      return res.json({ content: [{ type: "text", text }] });
    } catch (e) {
      console.log("Exception:", e.message);
    }
  }

  res.status(500).json({ error: "Žádný free model není dostupný. Zkus znovu za chvíli." });
});

app.get("/api/test", async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.json({ status: "ERROR", reason: "OPENROUTER_API_KEY not set" });
  const results = {};
  for (const model of FREE_MODELS) {
    try {
      const data = await tryModel(apiKey, model, [{ role: "user", content: "Hi" }], 20);
      results[model] = data.error ? "❌ " + data.error.message?.slice(0, 60) : "✅ " + (data.choices?.[0]?.message?.content || "no text");
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
