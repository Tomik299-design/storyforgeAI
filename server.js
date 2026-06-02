const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

// ── DATA STORAGE ──────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}
function getDB() {
  return readJSON("db.json") || { users: {}, books: [], subscriptions: [], stats: { pageViews: 0, generationsTotal: 0 } };
}
function saveDB(db) { writeJSON("db.json", db); }

// ── ADMIN AUTH ────────────────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_KEY || "storyforge-admin-2024";
function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── TRACK USER / SESSION ──────────────────────────────────
app.post("/api/track", (req, res) => {
  const { event, user, bookTitle, bookId, bookGenre } = req.body;
  const db = getDB();
  const now = new Date().toISOString();

  if (event === "login" && user?.email) {
    if (!db.users[user.email]) {
      db.users[user.email] = { name: user.name, email: user.email, firstSeen: now, lastSeen: now, isPro: false, bookCount: 0 };
    } else {
      db.users[user.email].lastSeen = now;
      db.users[user.email].name = user.name;
    }
    db.stats.pageViews = (db.stats.pageViews || 0) + 1;
  }

  if (event === "book_created" && user?.email) {
    db.books.push({ id: bookId || Date.now(), title: bookTitle, genre: bookGenre, author: user.name, email: user.email, createdAt: now });
    db.stats.generationsTotal = (db.stats.generationsTotal || 0) + 1;
    if (db.users[user.email]) db.users[user.email].bookCount = (db.users[user.email].bookCount || 0) + 1;
  }

  saveDB(db);
  res.json({ ok: true });
});

// ── SUBSCRIPTION ──────────────────────────────────────────
app.post("/api/subscribe", (req, res) => {
  const { email, months, note } = req.body;
  if (!email || !months) return res.status(400).json({ error: "email and months required" });
  const db = getDB();
  const now = new Date();
  const expires = new Date(now);
  expires.setMonth(expires.getMonth() + parseInt(months));

  const sub = { email, months: parseInt(months), activatedAt: now.toISOString(), expiresAt: expires.toISOString(), note: note || "", active: true };
  db.subscriptions.push(sub);
  if (db.users[email]) { db.users[email].isPro = true; db.users[email].proExpires = expires.toISOString(); }
  saveDB(db);
  res.json({ ok: true, expiresAt: expires.toISOString() });
});

// ── ADMIN API ─────────────────────────────────────────────
app.get("/api/admin/stats", adminAuth, (req, res) => {
  const db = getDB();
  const users = Object.values(db.users);
  const proUsers = users.filter(u => u.isPro);
  const activeSubCount = db.subscriptions.filter(s => s.active && new Date(s.expiresAt) > new Date()).length;
  res.json({
    totalUsers: users.length,
    proUsers: proUsers.length,
    freeUsers: users.length - proUsers.length,
    totalBooks: db.books.length,
    totalGenerations: db.stats.generationsTotal || 0,
    pageViews: db.stats.pageViews || 0,
    activeSubscriptions: activeSubCount,
    revenue: db.subscriptions.reduce((s, x) => s + x.months * 199, 0),
  });
});

app.get("/api/admin/users", adminAuth, (req, res) => {
  const db = getDB();
  res.json(Object.values(db.users).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen)));
});

app.get("/api/admin/books", adminAuth, (req, res) => {
  const db = getDB();
  res.json(db.books.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.get("/api/admin/subscriptions", adminAuth, (req, res) => {
  const db = getDB();
  res.json(db.subscriptions.sort((a, b) => new Date(b.activatedAt) - new Date(a.activatedAt)));
});

app.post("/api/admin/subscribe", adminAuth, (req, res) => {
  const { email, months, note } = req.body;
  if (!email || !months) return res.status(400).json({ error: "email and months required" });
  const db = getDB();
  const now = new Date();
  const expires = new Date(now);
  expires.setMonth(expires.getMonth() + parseInt(months));
  db.subscriptions.push({ email, months: parseInt(months), activatedAt: now.toISOString(), expiresAt: expires.toISOString(), note: note || "admin", active: true });
  if (!db.users[email]) db.users[email] = { name: email, email, firstSeen: now.toISOString(), lastSeen: now.toISOString(), isPro: true, bookCount: 0 };
  db.users[email].isPro = true;
  db.users[email].proExpires = expires.toISOString();
  saveDB(db);
  res.json({ ok: true, expiresAt: expires.toISOString() });
});

app.delete("/api/admin/subscribe/:email", adminAuth, (req, res) => {
  const db = getDB();
  const email = decodeURIComponent(req.params.email);
  db.subscriptions.filter(s => s.email === email).forEach(s => s.active = false);
  if (db.users[email]) { db.users[email].isPro = false; db.users[email].proExpires = null; }
  saveDB(db);
  res.json({ ok: true });
});

// ── MISTRAL AI PROXY ──────────────────────────────────────
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
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({ model: "mistral-small-latest", messages: mistralMessages, max_tokens: max_tokens || 4000, temperature: 0.9 }),
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const text = data.choices?.[0]?.message?.content || "";
    res.json({ content: [{ type: "text", text }] });
  } catch (err) {
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
      body: JSON.stringify({ model: "mistral-small-latest", messages: [{ role: "user", content: "Řekni ahoj česky jednou větou." }], max_tokens: 50 }),
    });
    const d = await r.json();
    if (d.error) return res.json({ status: "ERROR", reason: d.error.message });
    res.json({ status: "OK", response: d.choices?.[0]?.message?.content });
  } catch (e) {
    res.json({ status: "ERROR", reason: e.message });
  }
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StoryForge AI running on port ${PORT}`));
