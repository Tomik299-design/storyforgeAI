const express = require("express");
const cors    = require("cors");
const path    = require("path");
const crypto  = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

// ── CONFIG ────────────────────────────────────────────────
const JWT_SECRET  = process.env.JWT_SECRET   || "storyforge-secret-2024";
const ADMIN_KEY   = process.env.ADMIN_KEY    || "storyforge-admin-2024";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL  || "storyforgeai26@gmail.com";
const BREVO_KEY   = process.env.BREVO_KEY    || "";
const FROM_EMAIL  = process.env.FROM_EMAIL   || "StoryForge AI <storyforgeai26@gmail.com>";
const APP_URL     = process.env.APP_URL      || "https://storyforgeai.onrender.com";

const SUPA_URL    = process.env.SUPABASE_URL || "https://ucmbvqoltivmyaingthl.supabase.co";
const SUPA_KEY    = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVjbWJ2cW9sdGl2bXlhaW5ndGhsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDU0MzUwMSwiZXhwIjoyMDk2MTE5NTAxfQ._3rwZ5lf97cOAGU4odEngUNrhcg6PClgEP8vBHhv9dw";

// ── SUPABASE REST HELPER ──────────────────────────────────
const supa = {
  headers: {
    "Content-Type": "application/json",
    "apikey": SUPA_KEY,
    "Authorization": "Bearer " + SUPA_KEY,
    "Prefer": "return=representation",
  },

  async select(table, query = "") {
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}${query}`, { headers: this.headers });
    const text = await r.text();
    if (!r.ok) throw new Error(`Supabase SELECT ${table} failed (${r.status}): ${text}`);
    return JSON.parse(text);
  },

  async insert(table, data) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
      method: "POST", headers: this.headers, body: JSON.stringify(data),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Supabase INSERT ${table} failed (${r.status}): ${text}`);
    const result = JSON.parse(text);
    return Array.isArray(result) ? result[0] : result;
  },

  async update(table, query, data) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}${query}`, {
      method: "PATCH", headers: this.headers, body: JSON.stringify(data),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Supabase UPDATE ${table} failed (${r.status}): ${text}`);
    const result = JSON.parse(text);
    return Array.isArray(result) ? result[0] : result;
  },

  async upsert(table, data, onConflict) {
    const headers = { ...this.headers, "Prefer": "return=representation,resolution=merge-duplicates" };
    const url = onConflict
      ? `${SUPA_URL}/rest/v1/${table}?on_conflict=${onConflict}`
      : `${SUPA_URL}/rest/v1/${table}`;
    const r = await fetch(url, {
      method: "POST", headers, body: JSON.stringify(data),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Supabase UPSERT ${table} failed (${r.status}): ${text}`);
    const result = JSON.parse(text);
    return Array.isArray(result) ? result[0] : result;
  },

  async delete(table, query) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}${query}`, {
      method: "DELETE", headers: this.headers,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Supabase DELETE ${table} failed (${r.status}): ${text}`);
    return true;
  },

  async rpc(fn, params = {}) {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
      method: "POST", headers: this.headers, body: JSON.stringify(params),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Supabase RPC ${fn} failed (${r.status}): ${text}`);
    return JSON.parse(text);
  },
};

// ── JWT HELPERS ───────────────────────────────────────────
function jwtSign(payload) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body   = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now()/1000) }));
  const sig    = crypto.createHmac("sha256", JWT_SECRET).update(header+"."+body).digest("base64url");
  return `${header}.${body}.${sig}`;
}
function jwtVerify(token) {
  try {
    const [h, b, s] = token.split(".");
    const expected = crypto.createHmac("sha256", JWT_SECRET).update(h+"."+b).digest("base64url");
    if (s !== expected) return null;
    return JSON.parse(Buffer.from(b, "base64url").toString());
  } catch { return null; }
}
function b64url(str) { return Buffer.from(str).toString("base64url"); }
function hashPwd(pwd) {
  return crypto.createHmac("sha256", JWT_SECRET + "salt").update(pwd).digest("hex");
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────
function authMw(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const payload = jwtVerify(token);
  if (!payload) return res.status(401).json({ error: "Nepřihlášen" });
  req.user = payload;
  next();
}
function adminMw(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ══════════════════════════════════════════════════════════
// AUTH ENDPOINTS
// ══════════════════════════════════════════════════════════

// REGISTER
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Vyplň všechna pole" });
  if (password.length < 6) return res.status(400).json({ error: "Heslo musí mít alespoň 6 znaků" });
  try {
    const existing = await supa.select("users", `?email=eq.${encodeURIComponent(email.toLowerCase().trim())}`);
    if (existing.length > 0) return res.status(400).json({ error: "Email je již zaregistrován" });
    const user = await supa.insert("users", {
      id: crypto.randomUUID(),
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hashPwd(password),
      is_pro: false,
      pro_expires: null,
      created_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      book_count: 0,
      external_translations: 0,
    });
    const token = jwtSign({ id: user.id, email: user.email, name: user.name, isPro: false });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, isPro: false } });
  } catch (e) {
    console.error("Register error:", e.message);
    res.status(500).json({ error: "Chyba serveru: " + e.message });
  }
});

// LOGIN
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Vyplň email a heslo" });
  try {
    const rows = await supa.select("users", `?email=eq.${encodeURIComponent(email.toLowerCase().trim())}`);
    const user = rows[0];
    if (!user || user.password !== hashPwd(password)) {
      return res.status(401).json({ error: "Špatný email nebo heslo" });
    }
    const isPro = user.is_pro && (!user.pro_expires || new Date(user.pro_expires) > new Date());
    await supa.update("users", `?id=eq.${user.id}`, {
      last_seen: new Date().toISOString(),
      is_pro: isPro,
    });
    const token = jwtSign({ id: user.id, email: user.email, name: user.name, isPro });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, isPro, proExpires: user.pro_expires } });
  } catch (e) {
    res.status(500).json({ error: "Chyba serveru: " + e.message });
  }
});

// ME
app.get("/api/auth/me", authMw, async (req, res) => {
  try {
    const rows = await supa.select("users", `?id=eq.${req.user.id}`);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "Uživatel nenalezen" });
    const isPro = user.is_pro && (!user.pro_expires || new Date(user.pro_expires) > new Date());
    res.json({ id: user.id, name: user.name, email: user.email, isPro, proExpires: user.pro_expires, bookCount: user.book_count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// UPDATE TRANSLATION COUNT
app.post("/api/auth/update-translations", authMw, async (req, res) => {
  try {
    const rows = await supa.select("users", `?id=eq.${req.user.id}`);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "Uživatel nenalezen" });
    const newCount = (user.external_translations || 0) + 1;
    await supa.update("users", `?id=eq.${user.id}`, { external_translations: newCount });
    res.json({ ok: true, externalTranslations: newCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET translation count
app.get("/api/auth/translations", authMw, async (req, res) => {
  try {
    const rows = await supa.select("users", `?id=eq.${req.user.id}&select=external_translations`);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "Uživatel nenalezen" });
    res.json({ externalTranslations: user.external_translations || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
// BOOKS ENDPOINTS
// ══════════════════════════════════════════════════════════

// GET user's books
app.get("/api/books", authMw, async (req, res) => {
  try {
    const books = await supa.select("books", `?user_id=eq.${req.user.id}&order=updated_at.desc`);
    // Map snake_case → camelCase for frontend compatibility
    res.json(books.map(dbBookToClient));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SAVE book (create or update)
app.post("/api/books", authMw, async (req, res) => {
  const { book } = req.body;
  if (!book) return res.status(400).json({ error: "Chybí kniha" });
  try {
    const isNew = !(await supa.select("books", `?id=eq.${book.id}&user_id=eq.${req.user.id}`)).length;
    const record = clientBookToDB(book, req.user.id);
    await supa.upsert("books", record, "id");
    if (isNew) {
      // Increment book_count
      const rows = await supa.select("users", `?id=eq.${req.user.id}&select=book_count`);
      const cnt = (rows[0]?.book_count || 0) + 1;
      await supa.update("users", `?id=eq.${req.user.id}`, { book_count: cnt });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE book
app.delete("/api/books/:id", authMw, async (req, res) => {
  try {
    await supa.delete("books", `?id=eq.${req.params.id}&user_id=eq.${req.user.id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Book field mappers ────────────────────────────────────
function dbBookToClient(b) {
  return {
    id: b.id, userId: b.user_id, title: b.title, subtitle: b.subtitle,
    annotation: b.annotation, genre: b.genre, theme: b.theme,
    setting: b.setting, style: b.style, wordCount: b.word_count,
    chapters: b.chapters || [], isFavorite: b.is_favorite,
    createdAt: b.created_at, updatedAt: b.updated_at,
  };
}
function clientBookToDB(b, userId) {
  return {
    id: b.id, user_id: userId, title: b.title, subtitle: b.subtitle || "",
    annotation: b.annotation || "", genre: b.genre || "",
    theme: b.theme || "", setting: b.setting || "", style: b.style || "",
    word_count: b.wordCount || 0, chapters: b.chapters || [],
    is_favorite: b.isFavorite || false,
    created_at: b.createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ══════════════════════════════════════════════════════════

app.get("/api/admin/stats", adminMw, async (req, res) => {
  try {
    const [users, books] = await Promise.all([
      supa.select("users", ""),
      supa.select("books", "?select=id"),
    ]);
    const proUsers = users.filter(u => u.is_pro && (!u.pro_expires || new Date(u.pro_expires) > new Date()));
    res.json({
      totalUsers: users.length,
      proUsers: proUsers.length,
      freeUsers: users.length - proUsers.length,
      totalBooks: books.length,
      totalGenerations: books.length,
      pageViews: users.length,
      activeSubscriptions: proUsers.length,
      revenue: proUsers.length * 199,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/users", adminMw, async (req, res) => {
  try {
    const users = await supa.select("users", "?order=last_seen.desc");
    res.json(users.map(u => ({
      id: u.id, name: u.name, email: u.email,
      isPro: u.is_pro, proExpires: u.pro_expires,
      createdAt: u.created_at, lastSeen: u.last_seen,
      bookCount: u.book_count,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/books", adminMw, async (req, res) => {
  try {
    const [users, books] = await Promise.all([
      supa.select("users", "?select=id,name,email"),
      supa.select("books", "?order=created_at.desc"),
    ]);
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));
    res.json(books.map(b => ({
      ...dbBookToClient(b),
      author: userMap[b.user_id]?.name || "—",
      email: userMap[b.user_id]?.email || "—",
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/subscriptions", adminMw, async (req, res) => {
  try {
    const users = await supa.select("users", "?or=(is_pro.eq.true,pro_expires.not.is.null)");
    res.json(users.map(u => ({
      email: u.email, name: u.name, months: u.sub_months || 1,
      activatedAt: u.pro_activated_at || u.created_at,
      expiresAt: u.pro_expires,
      active: u.is_pro && (!u.pro_expires || new Date(u.pro_expires) > new Date()),
      note: u.pro_note || "admin",
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/subscribe", adminMw, async (req, res) => {
  const { email, months, note } = req.body;
  if (!email || !months) return res.status(400).json({ error: "email and months required" });
  try {
    const rows = await supa.select("users", `?email=eq.${encodeURIComponent(email.toLowerCase())}`);
    if (!rows.length) return res.status(404).json({ error: "Uživatel nenalezen. Musí se nejdřív zaregistrovat." });
    const expires = new Date();
    expires.setMonth(expires.getMonth() + parseInt(months));
    await supa.update("users", `?id=eq.${rows[0].id}`, {
      is_pro: true, pro_expires: expires.toISOString(),
      pro_activated_at: new Date().toISOString(),
      sub_months: parseInt(months), pro_note: note || "admin",
    });
    res.json({ ok: true, expiresAt: expires.toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/subscribe/:email", adminMw, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    await supa.update("users", `?email=eq.${encodeURIComponent(email)}`, { is_pro: false, pro_expires: null });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
// EMAIL HELPERS — Brevo API
// ══════════════════════════════════════════════════════════
async function sendEmail({ to, subject, html }) {
  if (!BREVO_KEY) { console.warn("⚠️  BREVO_KEY není nastaven — email nebyl odeslán:", subject); return; }
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": BREVO_KEY },
    body: JSON.stringify({
      sender: { name: "StoryForge AI", email: FROM_EMAIL.match(/<(.+)>/)?.[1] || FROM_EMAIL },
      to: [{ email: to }], subject, htmlContent: html,
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error("Brevo error: " + JSON.stringify(data));
  console.log(`📧 Email odeslán na ${to}: ${subject}`);
}

// ══════════════════════════════════════════════════════════
// PASSWORD RESET
// ══════════════════════════════════════════════════════════
const resetTokens = new Map();

app.post("/api/auth/reset-request", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  res.json({ ok: true });
  try {
    const rows = await supa.select("users", `?email=eq.${encodeURIComponent(email.toLowerCase().trim())}`);
    const user = rows[0];
    if (!user) return;
    const token = crypto.randomBytes(32).toString("hex");
    resetTokens.set(token, { email: user.email, expires: Date.now() + 60 * 60 * 1000 });
    const resetUrl = `${APP_URL}?reset=${token}`;
    await sendEmail({
      to: user.email, subject: "StoryForge — reset hesla",
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a0a0f;color:#e8e8f0;border-radius:12px">
        <h1 style="font-size:22px;margin-bottom:8px">🔑 Reset hesla</h1>
        <p style="color:#9898b8;margin-bottom:24px">Ahoj <b style="color:#e8e8f0">${user.name}</b>, dostali jsme žádost o reset hesla.</p>
        <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#8b5cf6);color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:15px">Resetovat heslo →</a>
        <p style="color:#5a5a80;font-size:12px;margin-top:24px">Odkaz je platný <b>1 hodinu</b>.</p>
        <hr style="border:none;border-top:1px solid #2a2a40;margin:24px 0">
        <p style="color:#5a5a80;font-size:11px">StoryForge AI · ${resetUrl}</p>
      </div>`,
    });
  } catch (e) { console.error("Reset request error:", e.message); }
});

app.post("/api/auth/reset-confirm", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "Token and password required" });
  if (password.length < 6) return res.status(400).json({ error: "Heslo musí mít alespoň 6 znaků" });
  const entry = resetTokens.get(token);
  if (!entry) return res.status(400).json({ error: "Neplatný nebo vypršelý reset odkaz" });
  if (Date.now() > entry.expires) { resetTokens.delete(token); return res.status(400).json({ error: "Reset odkaz vypršel" }); }
  try {
    const rows = await supa.select("users", `?email=eq.${encodeURIComponent(entry.email)}`);
    if (!rows.length) return res.status(404).json({ error: "Uživatel nenalezen" });
    await supa.update("users", `?id=eq.${rows[0].id}`, { password: hashPwd(password) });
    resetTokens.delete(token);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PDF TEXT EXTRACTION ───────────────────────────────────
app.post("/api/extract-pdf", authMw, async (req, res) => {
  const { base64 } = req.body;
  if (!base64) return res.status(400).json({ error: "Chybí PDF data" });
  try {
    let pdfParse;
    try { pdfParse = require("pdf-parse"); } catch (e) {
      return res.status(500).json({ error: "pdf-parse není nainstalován. Přidej do package.json a restartuj." });
    }
    const data = await pdfParse(Buffer.from(base64, "base64"));
    const text = data.text || "";
    if (!text.trim()) return res.status(422).json({ error: "PDF neobsahuje extrahovatelný text." });
    res.json({ ok: true, text, pages: data.numpages, chars: text.length });
  } catch (e) { res.status(500).json({ error: "Chyba při čtení PDF: " + e.message }); }
});

// ══════════════════════════════════════════════════════════
// PRO REQUEST
// ══════════════════════════════════════════════════════════
app.post("/api/pro-request", async (req, res) => {
  const { email, name } = req.body;
  res.json({ ok: true });
  try {
    await sendEmail({
      to: ADMIN_EMAIL, subject: `⭐ Nový PRO request — ${name || email}`,
      html: `<div style="font-family:sans-serif;max-width:500px;padding:32px;background:#0a0a0f;color:#e8e8f0;border-radius:12px">
        <h1 style="font-size:20px">⭐ Nový PRO request</h1>
        <p>Jméno: <b>${name||"—"}</b><br>Email: <b>${email||"—"}</b><br>Čas: ${new Date().toLocaleString("cs-CZ")}</p>
        <a href="${APP_URL}/admin" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px">Otevřít admin →</a>
      </div>`,
    });
    if (email) await sendEmail({
      to: email, subject: "StoryForge — žádost o PRO přijata",
      html: `<div style="font-family:sans-serif;max-width:500px;padding:32px;background:#0a0a0f;color:#e8e8f0;border-radius:12px">
        <h1 style="font-size:22px">⚡ Žádost přijata!</h1>
        <p style="color:#9898b8">Ahoj <b style="color:#e8e8f0">${name||""}</b>, přístup bude aktivován do 24 hodin.</p>
      </div>`,
    });
  } catch (e) { console.error("PRO request email error:", e.message); }
});

// ══════════════════════════════════════════════════════════
// MISTRAL AI PROXY
// ══════════════════════════════════════════════════════════
app.post("/api/claude", async (req, res) => {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing MISTRAL_API_KEY" });
  try {
    const { system, messages, prompt, max_tokens } = req.body;
    const mistralMessages = [];
    if (system) mistralMessages.push({ role: "system", content: system });
    if (messages) for (const msg of messages) mistralMessages.push(msg);
    else if (prompt) mistralMessages.push({ role: "user", content: prompt });
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({ model: "mistral-small-latest", messages: mistralMessages, max_tokens: max_tokens || 4000, temperature: 0.9 }),
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json({ content: [{ type: "text", text: data.choices?.[0]?.message?.content || "" }] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/test", async (req, res) => {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) return res.json({ status: "ERROR", reason: "MISTRAL_API_KEY not set" });
  try {
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({ model: "mistral-small-latest", messages: [{ role: "user", content: "Řekni ahoj česky." }], max_tokens: 50 }),
    });
    const d = await r.json();
    if (d.error) return res.json({ status: "ERROR", reason: d.error.message });
    res.json({ status: "OK", response: d.choices?.[0]?.message?.content });
  } catch (e) { res.json({ status: "ERROR", reason: e.message }); }
});

// ══════════════════════════════════════════════════════════
// COMMUNITY
// ══════════════════════════════════════════════════════════

// GET feed
app.get("/api/community", async (req, res) => {
  try {
    const posts = await supa.select("community_posts",
      "?select=id,book_id,user_id,author_name,title,subtitle,annotation,genre,word_count,chapter_count,message,shared_at,likes,comments&order=shared_at.desc&limit=50");
    res.json({ posts: posts.map(dbPostToClient) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET single post with full chapters
app.get("/api/community/:id", async (req, res) => {
  try {
    const rows = await supa.select("community_posts", `?id=eq.${req.params.id}`);
    if (!rows.length) return res.status(404).json({ error: "Příspěvek nenalezen" });
    res.json(dbPostToClient(rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SHARE book — pokud již sdílena, vrátí existující postId
app.post("/api/community", authMw, async (req, res) => {
  const { bookId, message } = req.body;
  if (!bookId) return res.status(400).json({ error: "Chybí bookId" });
  try {
    // Check if already shared → vrátíme existující post
    const existing = await supa.select("community_posts",
      `?book_id=eq.${bookId}&user_id=eq.${req.user.id}&select=id`);
    if (existing.length) {
      return res.json({ ok: true, postId: existing[0].id, alreadyShared: true });
    }

    // Load book
    const books = await supa.select("books", `?id=eq.${bookId}&user_id=eq.${req.user.id}`);
    if (!books.length) return res.status(404).json({ error: "Kniha nenalezena" });
    const book = books[0];

    const post = await supa.insert("community_posts", {
      id: crypto.randomUUID(),
      book_id: String(book.id),
      user_id: req.user.id,
      author_name: req.user.name,
      title: book.title,
      subtitle: book.subtitle || "",
      annotation: book.annotation || "",
      genre: book.genre || "",
      word_count: book.word_count || 0,
      chapter_count: (book.chapters || []).length,
      chapters: book.chapters || [],
      message: (message || "").slice(0, 300),
      shared_at: new Date().toISOString(),
      likes: [],
      comments: [],
    });
    res.json({ ok: true, postId: post.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE / unshare
app.delete("/api/community/:id", authMw, async (req, res) => {
  try {
    await supa.delete("community_posts", `?id=eq.${req.params.id}&user_id=eq.${req.user.id}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// LIKE / unlike
app.post("/api/community/:id/like", authMw, async (req, res) => {
  try {
    const rows = await supa.select("community_posts", `?id=eq.${req.params.id}&select=id,likes`);
    if (!rows.length) return res.status(404).json({ error: "Příspěvek nenalezen" });
    const post = rows[0];
    const likes = post.likes || [];
    const idx = likes.indexOf(req.user.id);
    if (idx === -1) likes.push(req.user.id);
    else likes.splice(idx, 1);
    await supa.update("community_posts", `?id=eq.${post.id}`, { likes });
    res.json({ ok: true, likes: likes.length, liked: idx === -1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ADD comment
app.post("/api/community/:id/comment", authMw, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "Prázdný komentář" });
  try {
    const rows = await supa.select("community_posts", `?id=eq.${req.params.id}&select=id,comments`);
    if (!rows.length) return res.status(404).json({ error: "Příspěvek nenalezen" });
    const post = rows[0];
    const comment = {
      id: crypto.randomUUID(), userId: req.user.id,
      authorName: req.user.name, text: text.trim().slice(0, 500),
      createdAt: new Date().toISOString(),
    };
    const comments = [...(post.comments || []), comment];
    await supa.update("community_posts", `?id=eq.${post.id}`, { comments });
    res.json({ ok: true, comment });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE comment
app.delete("/api/community/:postId/comment/:commentId", authMw, async (req, res) => {
  try {
    const rows = await supa.select("community_posts", `?id=eq.${req.params.postId}&select=id,comments`);
    if (!rows.length) return res.status(404).json({ error: "Příspěvek nenalezen" });
    const post = rows[0];
    const comments = (post.comments || []).filter(c => !(c.id === req.params.commentId && c.userId === req.user.id));
    await supa.update("community_posts", `?id=eq.${post.id}`, { comments });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function dbPostToClient(p) {
  return {
    id: p.id, bookId: p.book_id, userId: p.user_id,
    authorName: p.author_name, title: p.title, subtitle: p.subtitle,
    annotation: p.annotation, genre: p.genre, wordCount: p.word_count,
    chapterCount: p.chapter_count, chapters: p.chapters,
    message: p.message, sharedAt: p.shared_at,
    likes: p.likes || [], comments: p.comments || [],
  };
}

// ══════════════════════════════════════════════════════════
// STATIC
// ══════════════════════════════════════════════════════════
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("*",     (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 StoryForge AI running on port ${PORT}`);
  console.log(`✅ Supabase URL: ${SUPA_URL}`);
  if (BREVO_KEY) console.log("✅ Brevo API key nastaven");
  else console.warn("⚠️  BREVO_KEY není nastaven — emaily nebudou chodit!");
});
