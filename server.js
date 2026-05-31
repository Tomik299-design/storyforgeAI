const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Proxy endpoint → Google Gemini API
app.post("/api/claude", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing GEMINI_API_KEY" });

  try {
    const { system, messages, max_tokens } = req.body;

    // Convert Anthropic format → Gemini format
    const contents = [];

    // Add system prompt as first user message if present
    if (system) {
      contents.push({ role: "user", parts: [{ text: "Systémový pokyn: " + system }] });
      contents.push({ role: "model", parts: [{ text: "Rozumím, budu se řídit těmito pokyny." }] });
    }

    for (const msg of messages) {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: {
            maxOutputTokens: max_tokens || 4000,
            temperature: 0.9,
          },
        }),
      }
    );

    const data = await response.json();

    if (data.error) return res.status(500).json({ error: data.error.message });

    // Convert Gemini response → Anthropic-like format (so frontend works unchanged)
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    res.json({ content: [{ type: "text", text }] });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback → index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StoryForge AI running on port ${PORT}`));
