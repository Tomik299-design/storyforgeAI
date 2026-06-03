const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

// ── CONFIG ────────────────────────────────────────────────
const JSONBIN_KEY  = process.env.JSONBIN_KEY  || "$2a$10$Lqc8f5pMIW0fmsjFVvOJlu2/KeVbio0LHWcMZv.WorXnw6W4TFizS";
const JWT_SECRET   = process.env.JWT_SECRET   || "storyforge-secret-2024";
const ADMIN_KEY    = process.env.ADMIN_KEY    || "storyforge-admin-2024";
const ADMIN_EMAIL  = process.env.ADMIN_EMAIL  || "storyforgeai26@gmail.com";
const GMAIL_USER   = process.env.GMAIL_USER   || "storyforgeai26@gmail.com";
const GMAIL_PASS   = process.env.GMAIL_PASS   || "uhuubojzbalpLGVW".toLowerCase().replace(/\s+/g, "");
const APP_URL      = process.env.APP_URL      || "https://storyforge.onrender.com";
const JSONBIN_URL  = "https://api.jsonbin.io/v3";

// ── GMAIL SMTP ────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // STARTTLS
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  tls: { rejectUnauthorized: false },
});


// Bin IDs — vytvoří se automaticky při prvním spuštění
let BIN_USERS = process.env.BIN_USERS || null;
let BIN_BOOKS = process.env.BIN_BOOKS || null;

// ── JSONBIN HELPERS ───────────────────────────────────────
function jsonbinHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "X-Master-Key": JSONBIN_KEY,
    "X-Access-Key": JSONBIN_KEY,
    "User-Agent": "StoryForge/1.0",
    ...extra,
  };
}

async function binGet(binId) {
  const r = await fetch(`${JSONBIN_URL}/b/${binId}/latest`, {
    headers: jsonbinHeaders(),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`JSONBin GET failed (${r.status}): ${text}`);
  return JSON.parse(text).record;
}

async function binSet(binId, data) {
  const r = await fetch(`${JSONBIN_URL}/b/${binId}`, {
    method: "PUT",
    headers: jsonbinHeaders(),
    body: JSON.stringify(data),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`JSONBin PUT failed (${r.status}): ${text}`);
  return JSON.parse(text).record;
}

async function binCreate(name, initial) {
  const r = await fetch(`${JSONBIN_URL}/b`, {
    method: "POST",
    headers: jsonbinHeaders({ "X-Bin-Name": name, "X-Bin-Private": "true" }),
    body: JSON.stringify(initial),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`JSONBin CREATE failed (${r.status}): ${text}`);
  return JSON.parse(text).metadata.id;
}

// ── INIT BINS ─────────────────────────────────────────────
async function initBins() {
  console.log("🔄 Initializing JSONBin...");
  console.log("   JSONBIN_KEY set:", !!JSONBIN_KEY);
  console.log("   BIN_USERS env:", process.env.BIN_USERS || "not set");
  console.log("   BIN_BOOKS env:", process.env.BIN_BOOKS || "not set");
  try {
    if (!BIN_USERS) {
      console.log("   Creating users bin...");
      BIN_USERS = await binCreate("storyforge-users", { users: [] });
      console.log("✅ Created users bin:", BIN_USERS);
      console.log("👉 Add to Render env: BIN_USERS=" + BIN_USERS);
    } else {
      // verify it works
      await binGet(BIN_USERS);
      console.log("✅ Users bin OK:", BIN_USERS);
    }
    if (!BIN_BOOKS) {
      console.log("   Creating books bin...");
      BIN_BOOKS = await binCreate("storyforge-books", { books: [] });
      console.log("✅ Created books bin:", BIN_BOOKS);
      console.log("👉 Add to Render env: BIN_BOOKS=" + BIN_BOOKS);
    } else {
      await binGet(BIN_BOOKS);
      console.log("✅ Books bin OK:", BIN_BOOKS);
    }
    console.log("✅ JSONBin fully ready.");
  } catch (e) {
    console.error("❌ JSONBin init FAILED:", e.message);
    console.error("   This means DB calls will fail. Check JSONBIN_KEY and bin IDs.");
  }
}

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

// ── PASSWORD HASH (simple, no bcrypt dep needed) ──────────
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
    const db = await binGet(BIN_USERS);
    if (db.users.find(u => u.email === email.toLowerCase())) {
      return res.status(400).json({ error: "Email je již zaregistrován" });
    }
    const user = {
      id: crypto.randomUUID(),
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hashPwd(password),
      isPro: false,
      proExpires: null,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      bookCount: 0,
    };
    db.users.push(user);
    await binSet(BIN_USERS, db);
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
    const db = await binGet(BIN_USERS);
    const user = db.users.find(u => u.email === email.toLowerCase().trim());
    if (!user || user.password !== hashPwd(password)) {
      return res.status(401).json({ error: "Špatný email nebo heslo" });
    }
    // Check PRO expiry
    const isPro = user.isPro && (!user.proExpires || new Date(user.proExpires) > new Date());
    if (user.isPro && !isPro) { user.isPro = false; } // expired
    user.lastSeen = new Date().toISOString();
    await binSet(BIN_USERS, db);
    const token = jwtSign({ id: user.id, email: user.email, name: user.name, isPro });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, isPro, proExpires: user.proExpires } });
  } catch (e) {
    res.status(500).json({ error: "Chyba serveru: " + e.message });
  }
});

// ME — verify token + refresh user data
app.get("/api/auth/me", authMw, async (req, res) => {
  try {
    const db = await binGet(BIN_USERS);
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: "Uživatel nenalezen" });
    const isPro = user.isPro && (!user.proExpires || new Date(user.proExpires) > new Date());
    res.json({ id: user.id, name: user.name, email: user.email, isPro, proExpires: user.proExpires, bookCount: user.bookCount });
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
    const db = await binGet(BIN_BOOKS);
    const books = db.books.filter(b => b.userId === req.user.id);
    res.json(books);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SAVE book (create or update)
app.post("/api/books", authMw, async (req, res) => {
  const { book } = req.body;
  if (!book) return res.status(400).json({ error: "Chybí kniha" });
  try {
    const db = await binGet(BIN_BOOKS);
    const idx = db.books.findIndex(b => b.id === book.id && b.userId === req.user.id);
    const record = { ...book, userId: req.user.id, updatedAt: new Date().toISOString() };
    if (idx >= 0) {
      db.books[idx] = record;
    } else {
      record.createdAt = record.createdAt || new Date().toISOString();
      db.books.push(record);
      // increment bookCount
      const udb = await binGet(BIN_USERS);
      const u = udb.users.find(u => u.id === req.user.id);
      if (u) { u.bookCount = (u.bookCount || 0) + 1; await binSet(BIN_USERS, udb); }
    }
    await binSet(BIN_BOOKS, db);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE book
app.delete("/api/books/:id", authMw, async (req, res) => {
  try {
    const db = await binGet(BIN_BOOKS);
    const before = db.books.length;
    db.books = db.books.filter(b => !(b.id === parseInt(req.params.id) && b.userId === req.user.id));
    if (db.books.length === before) return res.status(404).json({ error: "Kniha nenalezena" });
    await binSet(BIN_BOOKS, db);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ══════════════════════════════════════════════════════════

app.get("/api/admin/stats", adminMw, async (req, res) => {
  try {
    const [udb, bdb] = await Promise.all([binGet(BIN_USERS), binGet(BIN_BOOKS)]);
    const users = udb.users;
    const proUsers = users.filter(u => u.isPro && (!u.proExpires || new Date(u.proExpires) > new Date()));
    res.json({
      totalUsers: users.length,
      proUsers: proUsers.length,
      freeUsers: users.length - proUsers.length,
      totalBooks: bdb.books.length,
      totalGenerations: bdb.books.length,
      pageViews: users.length,
      activeSubscriptions: proUsers.length,
      revenue: users.filter(u => u.isPro).length * 199,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/users", adminMw, async (req, res) => {
  try {
    const db = await binGet(BIN_USERS);
    res.json(db.users.map(u => ({ ...u, password: undefined })).sort((a,b) => new Date(b.lastSeen)-new Date(a.lastSeen)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/books", adminMw, async (req, res) => {
  try {
    const [udb, bdb] = await Promise.all([binGet(BIN_USERS), binGet(BIN_BOOKS)]);
    const books = bdb.books.map(b => {
      const u = udb.users.find(u => u.id === b.userId);
      return { ...b, author: u?.name || "—", email: u?.email || "—" };
    }).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt));
    res.json(books);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/subscriptions", adminMw, async (req, res) => {
  try {
    const db = await binGet(BIN_USERS);
    const subs = db.users.filter(u => u.isPro || u.proExpires).map(u => ({
      email: u.email, name: u.name, months: u.subMonths || 1,
      activatedAt: u.proActivatedAt || u.createdAt,
      expiresAt: u.proExpires, active: u.isPro && (!u.proExpires || new Date(u.proExpires) > new Date()),
      note: u.proNote || "admin"
    }));
    res.json(subs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/subscribe", adminMw, async (req, res) => {
  const { email, months, note } = req.body;
  if (!email || !months) return res.status(400).json({ error: "email and months required" });
  try {
    const db = await binGet(BIN_USERS);
    let user = db.users.find(u => u.email === email.toLowerCase());
    if (!user) return res.status(404).json({ error: "Uživatel nenalezen. Musí se nejdřív zaregistrovat." });
    const expires = new Date();
    expires.setMonth(expires.getMonth() + parseInt(months));
    user.isPro = true;
    user.proExpires = expires.toISOString();
    user.proActivatedAt = new Date().toISOString();
    user.subMonths = parseInt(months);
    user.proNote = note || "admin";
    await binSet(BIN_USERS, db);
    res.json({ ok: true, expiresAt: expires.toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/subscribe/:email", adminMw, async (req, res) => {
  try {
    const db = await binGet(BIN_USERS);
    const user = db.users.find(u => u.email === decodeURIComponent(req.params.email));
    if (!user) return res.status(404).json({ error: "Uživatel nenalezen" });
    user.isPro = false; user.proExpires = null;
    await binSet(BIN_USERS, db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
// EMAIL HELPERS
// ══════════════════════════════════════════════════════════
async function sendEmail({ to, subject, html }) {
  const info = await mailer.sendMail({
    from: `"StoryForge AI" <${GMAIL_USER}>`,
    to,
    subject,
    html,
  });
  console.log(`📧 Email sent to ${to}: ${subject} (id: ${info.messageId})`);
  return info;
}

// ══════════════════════════════════════════════════════════
// PASSWORD RESET
// ══════════════════════════════════════════════════════════
const resetTokens = new Map();

app.post("/api/auth/reset-request", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  res.json({ ok: true }); // always 200 — don't reveal if email exists
  try {
    const db = await binGet(BIN_USERS);
    const user = db.users.find(u => u.email === email.toLowerCase().trim());
    if (!user) return;
    const token = crypto.randomBytes(32).toString("hex");
    resetTokens.set(token, { email: user.email, expires: Date.now() + 60 * 60 * 1000 });
    const resetUrl = `${APP_URL}?reset=${token}`;
    await sendEmail({
      to: user.email,
      subject: "StoryForge — reset hesla",
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a0a0f;color:#e8e8f0;border-radius:12px">
          <h1 style="font-size:22px;margin-bottom:8px">🔑 Reset hesla</h1>
          <p style="color:#9898b8;margin-bottom:24px">Ahoj <b style="color:#e8e8f0">${user.name}</b>, dostali jsme žádost o reset hesla pro tvůj účet.</p>
          <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#8b5cf6);color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:15px">Resetovat heslo →</a>
          <p style="color:#5a5a80;font-size:12px;margin-top:24px">Odkaz je platný <b>1 hodinu</b>. Pokud jsi o reset nežádal/a, tento email ignoruj.</p>
          <hr style="border:none;border-top:1px solid #2a2a40;margin:24px 0">
          <p style="color:#5a5a80;font-size:11px">StoryForge AI · Pokud tlačítko nefunguje, zkopíruj tento odkaz: ${resetUrl}</p>
        </div>`
    });
  } catch (e) {
    console.error("Reset request error:", e.message);
  }
});

app.post("/api/auth/reset-confirm", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "Token and password required" });
  if (password.length < 6) return res.status(400).json({ error: "Heslo musí mít alespoň 6 znaků" });
  const entry = resetTokens.get(token);
  if (!entry) return res.status(400).json({ error: "Neplatný nebo vypršelý reset odkaz" });
  if (Date.now() > entry.expires) {
    resetTokens.delete(token);
    return res.status(400).json({ error: "Reset odkaz vypršel, požádej o nový" });
  }
  try {
    const db = await binGet(BIN_USERS);
    const user = db.users.find(u => u.email === entry.email);
    if (!user) return res.status(404).json({ error: "Uživatel nenalezen" });
    user.password = hashPwd(password);
    await binSet(BIN_USERS, db);
    resetTokens.delete(token);
    console.log(`✅ Password reset completed for ${entry.email}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
// PRO REQUEST
// ══════════════════════════════════════════════════════════
app.post("/api/pro-request", async (req, res) => {
  const { email, name } = req.body;
  res.json({ ok: true });
  console.log(`⭐ PRO REQUEST: ${name} <${email}>`);
  try {
    // Notify admin
    await sendEmail({
      to: ADMIN_EMAIL,
      subject: `⭐ Nový PRO request — ${name || email}`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a0a0f;color:#e8e8f0;border-radius:12px">
          <h1 style="font-size:20px;margin-bottom:16px">⭐ Nový PRO request</h1>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="color:#9898b8;padding:6px 0">Jméno:</td><td><b>${name || "—"}</b></td></tr>
            <tr><td style="color:#9898b8;padding:6px 0">Email:</td><td><b>${email || "—"}</b></td></tr>
            <tr><td style="color:#9898b8;padding:6px 0">Čas:</td><td>${new Date().toLocaleString("cs-CZ")}</td></tr>
          </table>
          <p style="margin-top:20px;color:#9898b8;font-size:13px">Pro aktivaci přejdi na admin panel a přidej předplatné pro tento email.</p>
          <a href="${APP_URL}/admin" style="display:inline-block;margin-top:12px;background:#7c3aed;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:700;font-size:13px">Otevřít admin panel →</a>
        </div>`
    });
    // Confirm to user
    if (email) {
      await sendEmail({
        to: email,
        subject: "StoryForge — žádost o PRO přijata",
        html: `
          <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a0a0f;color:#e8e8f0;border-radius:12px">
            <h1 style="font-size:22px;margin-bottom:8px">⚡ Žádost přijata!</h1>
            <p style="color:#9898b8;margin-bottom:16px">Ahoj <b style="color:#e8e8f0">${name || ""}</b>, tvoje žádost o PRO předplatné byla přijata.</p>
            <div style="background:#12121a;border:1px solid #2a2a40;border-radius:10px;padding:16px;margin-bottom:20px">
              <p style="margin:0;font-size:14px">✅ Přístup bude aktivován do <b>24 hodin</b><br>
              📧 Po aktivaci dostaneš potvrzovací email<br>
              💬 Otázky? Odpověz na tento email</p>
            </div>
            <p style="color:#5a5a80;font-size:12px">StoryForge AI — piš příběhy bez hranic</p>
          </div>`
      });
    }
  } catch (e) {
    console.error("PRO request email error:", e.message);
  }
});

// ══════════════════════════════════════════════════════════
// MISTRAL AI PROXY
// ══════════════════════════════════════════════════════════
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (e) { res.json({ status: "ERROR", reason: e.message }); }
});

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`StoryForge AI running on port ${PORT}`);
  await initBins();
  // Ověření SMTP spojení
  try {
    await mailer.verify();
    console.log('✅ Gmail SMTP ready — emaily budou fungovat');
  } catch (e) {
    console.error('❌ Gmail SMTP FAILED:', e.message);
    console.error('   Zkontroluj GMAIL_USER a GMAIL_PASS (app password bez mezer, 2FA zapnuté)');
  }
});
