const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.post("/api/claude", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;

  console.log("=== /api/claude called ===");
  console.log("API key present:", !!apiKey);
  console.log("API key prefix:", apiKey ? apiKey.slice(0, 8) + "..." : "MISSING");

  if (!apiKey) return res.status(500).json({ error: "Missing GEMINI_API_KEY env variable" });

  try {
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    console.log("Calling Gemini...");

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: { maxOutputTokens: max_tokens || 4000, temperature: 0.9 },
      }),
    });

    const data = await response.json();
    console.log("Gemini status:", response.status);
    console.log("Gemini response keys:", Object.keys(data));

    if (data.error) {
      console.error("Gemini error:", JSON.stringify(data.error));
      return res.status(500).json({ error: data.error.message });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log("Text length:", text.length);
    res.json({ content: [{ type: "text", text }] });

  } catch (err) {
    console.error("Server error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Test endpoint
app.get("/api/test", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.json({ status: "ERROR", reason: "GEMINI_API_KEY not set" });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Řekni ahoj." }] }] }),
      }
    );
    const data = await response.json();
    if (data.error) return res.json({ status: "ERROR", gemini: data.error.message });
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    res.json({ status: "OK", response: text });
  } catch (e) {
    res.json({ status: "ERROR", reason: e.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StoryForge AI running on port ${PORT}`));
