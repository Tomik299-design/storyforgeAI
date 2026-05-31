const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.post("/api/claude", async (req, res) => {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing MISTRAL_API_KEY" });

  try {
    const { system, messages, max_tokens } = req.body;

    const mistralMessages = [];
    if (system) mistralMessages.push({ role: "system", content: system });
    for (const msg of messages) mistralMessages.push(msg);

    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: mistralMessages,
        max_tokens: max_tokens || 4000,
        temperature: 0.9,
      }),
    });

    const data = await response.json();
    console.log("Mistral status:", response.status);

    if (data.error) {
      console.error("Mistral error:", data.error);
      return res.status(500).json({ error: data.error.message });
    }

    const text = data.choices?.[0]?.message?.content || "";
    console.log("OK, length:", text.length);
    res.json({ content: [{ type: "text", text }] });

  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/test", async (req, res) => {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) return res.json({ status: "ERROR", reason: "MISTRAL_API_KEY not set" });
  try {
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: [{ role: "user", content: "Řekni ahoj česky jednou větou." }],
        max_tokens: 50,
      }),
    });
    const d = await r.json();
    if (d.error) return res.json({ status: "ERROR", reason: d.error.message });
    res.json({ status: "OK", response: d.choices?.[0]?.message?.content });
  } catch (e) {
    res.json({ status: "ERROR", reason: e.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StoryForge AI running on port ${PORT}`));
