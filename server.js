const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const path = require("path");
const https = require("https");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const settingsPath = path.join(__dirname, "server-settings.json");
const trustProxy = Number(process.env.TRUST_PROXY || 1) === 1;
const disableLocalSSL = Number(process.env.WT_DISABLE_LOCAL_SSL || 0) === 1;
const corsOriginsRaw = String(process.env.WT_CORS_ORIGINS || "").trim();
const corsOrigins = corsOriginsRaw
  ? corsOriginsRaw.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const apiRateWindowMs = Math.max(1000, Number(process.env.WT_API_RATE_WINDOW_MS || 60000));
const apiRateMax = Math.max(20, Number(process.env.WT_API_RATE_MAX || 600));
const loginRateWindowMs = Math.max(60000, Number(process.env.WT_LOGIN_RATE_WINDOW_MS || 900000));
const loginRateMaxAttempts = Math.max(3, Number(process.env.WT_LOGIN_RATE_MAX_ATTEMPTS || 5));
const loginBlockMs = Math.max(60000, Number(process.env.WT_LOGIN_BLOCK_MS || 900000));

// Middleware
if (trustProxy) app.set("trust proxy", 1);

app.use(
  cors(
    corsOrigins.length
      ? {
          origin(origin, cb) {
            // allow non-browser clients/no-origin requests
            if (!origin) return cb(null, true);
            if (corsOrigins.includes(origin)) return cb(null, true);
            return cb(new Error("CORS origin denied"));
          },
        }
      : undefined
  )
);
app.use(bodyParser.json());
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self)");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});
app.use(express.static("public"));

const apiRateState = new Map();
function getClientIp(req) {
  return String(
    req.headers["cf-connecting-ip"] ||
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    "unknown"
  )
    .split(",")[0]
    .trim() || "unknown";
}

function apiRateLimitMiddleware(req, res, next) {
  const pathValue = String(req.path || "");
  if (pathValue === "/health" || pathValue === "/ready") return next();

  const now = Date.now();
  const key = getClientIp(req);
  const rec = apiRateState.get(key) || { count: 0, resetAt: now + apiRateWindowMs };

  if (now > rec.resetAt) {
    rec.count = 0;
    rec.resetAt = now + apiRateWindowMs;
  }

  rec.count += 1;
  apiRateState.set(key, rec);

  if (rec.count > apiRateMax) {
    res.setHeader("Retry-After", String(Math.ceil((rec.resetAt - now) / 1000)));
    return res.status(429).json({ error: "Rate limit exceeded. Please retry shortly." });
  }

  return next();
}

app.use("/api", apiRateLimitMiddleware);

function requireWriteRole(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  const allowed = new Set(["owner", "admin", "ops"]);
  if (!allowed.has(role)) {
    return res.status(403).json({ error: "Insufficient role for write operation" });
  }
  return next();
}

function requireAdminRole(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  const allowed = new Set(["owner", "admin"]);
  if (!allowed.has(role)) {
    return res.status(403).json({ error: "Admin role required" });
  }
  return next();
}

// Check if SSL certificates exist
const sslKeyPath = path.join(__dirname, "ssl", "key.pem");
const sslCertPath = path.join(__dirname, "ssl", "cert.pem");
const hasSSL = fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath);
const useLocalSSL = hasSSL && !disableLocalSSL;

// Create servers (HTTP always; HTTPS optional)
const httpServer = http.createServer(app);
let httpsServer = null;

if (useLocalSSL) {
  const sslOptions = {
    key: fs.readFileSync(sslKeyPath),
    cert: fs.readFileSync(sslCertPath),
  };
  httpsServer = https.createServer(sslOptions, app);
}

// Socket.IO attached to the server users actually visit
const { Server } = require("socket.io");
const io = new Server(useLocalSSL ? httpsServer : httpServer);

// Socket.IO connection handling
let connectedClients = 0;
io.on("connection", (socket) => {
  connectedClients++;
  console.log(`✓ Device connected (${connectedClients} total)`);

  socket.on("disconnect", () => {
    connectedClients--;
    console.log(`✗ Device disconnected (${connectedClients} remaining)`);
  });
});

// Helper to broadcast inventory changes to all connected clients
function broadcastInventoryChange(action, data) {
  try {
    console.log(`📡 Broadcasting: ${action}`);
    const payload = { action, data, timestamp: Date.now() };
    io.emit("inventory_update", payload);
    // Backward-compat for older client listeners
    io.emit("db_updated", payload);
  } catch (e) {
    console.error("Broadcast failed:", e);
  }
}

function safeParseParts(partsValue) {
  if (!partsValue) return null;
  try {
    return JSON.parse(partsValue);
  } catch {
    return null;
  }
}

function readServerSettings() {
  try {
    if (!fs.existsSync(settingsPath)) return {};
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeServerSettings(nextSettings) {
  const safe = nextSettings && typeof nextSettings === "object" ? nextSettings : {};
  fs.writeFileSync(settingsPath, JSON.stringify(safe, null, 2), "utf8");
}

function isAuthDisabled() {
  const settings = readServerSettings();
  return Number(settings.authDisabled || 0) === 1;
}

function getSharedUser() {
  return {
    id: 0,
    username: "shared",
    role: "owner",
    display_name: "Warehouse Team",
    customer_scope: "*",
    must_reset_password: 0,
    token: "shared-mode",
  };
}

let sheetsAutoSyncTimer = null;
let sheetsAutoSyncState = { enabled: false, minutes: 15, next_run_at: null, last_run_at: null, last_error: "" };

function loadActivePalletsForSheets() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT
         id,
         customer_name,
         product_id,
         location,
         pallet_quantity,
         product_quantity,
         current_units,
         parts,
         date_added,
         scanned_by
       FROM pallets
       WHERE status = 'active'
       ORDER BY customer_name ASC, product_id ASC, location ASC`,
      [],
      (err, rows) => {
        if (err) return reject(err);
        const mapped = (rows || []).map((r) => ({
          id: r.id,
          customer_name: r.customer_name || "Unknown",
          product_id: r.product_id || "",
          location: r.location || "",
          pallet_quantity: Number(r.pallet_quantity || 0),
          product_quantity: Number(r.product_quantity || 0),
          current_units: Number(r.current_units || 0),
          parts: safeParseParts(r.parts) || [],
          date_added: r.date_added || nowIso(),
          scanned_by: r.scanned_by || "",
        }));
        resolve(mapped);
      }
    );
  });
}


function loadFloorMetricsForSheets() {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT l.id, l.floor_area_sqm, l.location_type, GROUP_CONCAT(DISTINCT p.customer_name) AS customers_csv, COUNT(DISTINCT p.customer_name) AS customer_count FROM locations l LEFT JOIN pallets p ON p.location = l.id AND p.status = 'active' WHERE LOWER(COALESCE(l.location_type, '')) IN ('floor_space', 'rack_floor') GROUP BY l.id, l.floor_area_sqm, l.location_type",
      [],
      (err, rows) => {
        if (err) return reject(err);
        const locationRows = Array.isArray(rows) ? rows : [];
        const byCustomer = {};
        let siteFloorTotalSqm = 0;
        let siteFloorUsedSqm = 0;

        locationRows.forEach((r) => {
          const sqm = Number(r.floor_area_sqm || 0);
          if (!Number.isFinite(sqm) || sqm <= 0) return;
          siteFloorTotalSqm += sqm;

          const customers = String(r.customers_csv || "")
            .split(",")
            .map((c) => String(c || "").trim())
            .filter(Boolean);

          if (!customers.length) return;
          siteFloorUsedSqm += sqm;
          const share = sqm / customers.length;
          customers.forEach((name) => {
            if (!byCustomer[name]) byCustomer[name] = 0;
            byCustomer[name] += share;
          });
        });

        const roundedByCustomer = Object.fromEntries(
          Object.entries(byCustomer).map(([k, v]) => [k, Number(v.toFixed(2))])
        );

        resolve({
          site_floor_total_sqm: Number(siteFloorTotalSqm.toFixed(2)),
          site_floor_used_sqm: Number(siteFloorUsedSqm.toFixed(2)),
          by_customer_sqm_used: roundedByCustomer,
        });
      }
    );
  });
}

async function triggerSheetsSyncInternal(trigger = "manual-sync") {
  const settings = readServerSettings();
  const url = String(settings.googleSheetsUrl || settings.appsScriptUrl || "").trim();
  if (!url) throw new Error("Google Sheets URL not configured in server-settings.json");
  const pallets = await loadActivePalletsForSheets();
  const floorMetrics = await loadFloorMetricsForSheets();

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "sync_all",
      data: {
        trigger,
        source: "warehouse-tracker",
        synced_at: nowIso(),
        pallets,
        floor_metrics: floorMetrics,
      },
    }),
  });
  if (!response.ok) throw new Error(`Sheets sync failed (${response.status})`);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (body && typeof body === "object" && body.success === false) {
    throw new Error(`Sheets sync rejected: ${body.message || "Unknown Apps Script error"}`);
  }
  return { ok: true, rows: pallets.length, floor_metrics: floorMetrics, response: body };
}

function startSheetsAutoSync(minutes) {
  const mins = Math.max(1, Math.min(1440, Number(minutes) || 15));
  if (sheetsAutoSyncTimer) clearInterval(sheetsAutoSyncTimer);
  sheetsAutoSyncState.enabled = true;
  sheetsAutoSyncState.minutes = mins;
  sheetsAutoSyncState.next_run_at = new Date(Date.now() + mins * 60 * 1000).toISOString();
  sheetsAutoSyncState.last_error = "";

  sheetsAutoSyncTimer = setInterval(async () => {
    try {
      await triggerSheetsSyncInternal("auto-interval");
      sheetsAutoSyncState.last_run_at = new Date().toISOString();
      sheetsAutoSyncState.last_error = "";
    } catch (e) {
      sheetsAutoSyncState.last_error = e.message || "Auto sync failed";
    } finally {
      sheetsAutoSyncState.next_run_at = new Date(Date.now() + mins * 60 * 1000).toISOString();
    }
  }, mins * 60 * 1000);
}

function stopSheetsAutoSync() {
  if (sheetsAutoSyncTimer) clearInterval(sheetsAutoSyncTimer);
  sheetsAutoSyncTimer = null;
  sheetsAutoSyncState.enabled = false;
  sheetsAutoSyncState.next_run_at = null;
}

function configureSheetsAutoSyncFromSettings() {
  const s = readServerSettings();
  const enabled = Number(s.autoSheetsSyncEnabled || 0) === 1;
  const minutes = Math.max(1, Math.min(1440, Number(s.autoSheetsSyncMinutes) || 15));
  if (enabled) startSheetsAutoSync(minutes);
  else stopSheetsAutoSync();
}

function hashPassword(password, salt) {
  const normalized = String(password || "");
  const normalizedSalt = String(salt || "");
  return crypto.pbkdf2Sync(normalized, normalizedSalt, 120000, 64, "sha512").toString("hex");
}

function makeSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function makeSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function nowIso() {
  return new Date().toISOString();
}

const loginAttempts = new Map();
function isLoginBlocked(key) {
  const rec = loginAttempts.get(key);
  if (!rec) return false;
  if (Date.now() > rec.blockedUntil) {
    loginAttempts.delete(key);
    return false;
  }
  return true;
}
function registerLoginFailure(key) {
  const now = Date.now();
  const rec = loginAttempts.get(key) || { attempts: [], blockedUntil: 0 };
  rec.attempts = rec.attempts.filter((t) => now - t < loginRateWindowMs);
  rec.attempts.push(now);
  if (rec.attempts.length >= loginRateMaxAttempts) {
    rec.blockedUntil = now + loginBlockMs;
  }
  loginAttempts.set(key, rec);
}
function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

const ALL4_RACK_LAYOUT = {
  A: 8,
  B: 8,
  C: 8,
  D: 8,
  E: 8,
  F: 11,
  G: 11,
  H: 14,
  I: 14,
  J: 19,
};

function normalizeLocationId(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function canonicalizeLegacyLocation(value) {
  const v = normalizeLocationId(value);
  const m = v.match(/^([A-Z])\s*(\d+)\s*-\s*L\d+$/i);
  if (m) return `${m[1].toUpperCase()}${Number(m[2])}`;
  return v;
}

function parseAisleRackFromId(id) {
  const m = String(id || "").match(/^([A-Z])(\d+)(?:\s+FLOOR)?$/);
  if (!m) return { aisle: null, rack: null };
  return { aisle: m[1], rack: Number(m[2]) || null };
}

function generateAll4LocationRows() {
  const rows = [];
  Object.entries(ALL4_RACK_LAYOUT).forEach(([aisle, maxRack]) => {
    for (let rack = 1; rack <= Number(maxRack); rack++) {
      const rackId = `${aisle}${rack}`;
      const floorId = `${aisle}${rack} FLOOR`;
      rows.push({ id: rackId, aisle, rack, level: 1, capacity_pallets: 12, floor_area_sqm: null, location_type: "rack" });
      rows.push({ id: floorId, aisle, rack, level: 99, capacity_pallets: null, floor_area_sqm: null, location_type: "rack_floor" });
    }
  });

  rows.push({ id: "FLOOR SPACE", aisle: "FLOOR", rack: null, level: 500, capacity_pallets: null, floor_area_sqm: null, location_type: "floor_space" });
  return rows;
}

function rebuildLocationsToAll4Layout(done) {
  const baseRows = generateAll4LocationRows();
  const idSet = new Set(baseRows.map((r) => r.id));

  db.all('SELECT id, location FROM pallets WHERE status = "active"', (pErr, pallets) => {
    if (pErr) {
      const msg = String(pErr.message || "").toLowerCase();
      if (!msg.includes("no such table: pallets")) return done(pErr);
      pallets = [];
    }

    const updates = [];
    const extraRows = [];

    (pallets || []).forEach((p) => {
      const raw = normalizeLocationId(p.location);
      const canon = canonicalizeLegacyLocation(raw);
      const finalLoc = canon || raw;
      if (finalLoc && finalLoc !== raw) updates.push({ palletId: p.id, to: finalLoc });

      if (finalLoc && !idSet.has(finalLoc)) {
        idSet.add(finalLoc);
        const parsed = parseAisleRackFromId(finalLoc);
        extraRows.push({
          id: finalLoc,
          aisle: parsed.aisle,
          rack: parsed.rack,
          level: 999,
          capacity_pallets: parsed.rack ? 12 : null,
          floor_area_sqm: null,
          location_type: parsed.rack ? "rack" : "custom",
        });
      }
    });

    const runUpdates = (idx, cb) => {
      if (idx >= updates.length) return cb();
      const u = updates[idx];
      db.run("UPDATE pallets SET location = ? WHERE id = ?", [u.to, u.palletId], (uErr) => {
        if (uErr) return cb(uErr);
        runUpdates(idx + 1, cb);
      });
    };

    const allRows = [...baseRows, ...extraRows];

    db.serialize(() => {
      db.run("BEGIN TRANSACTION");
      runUpdates(0, (updErr) => {
        if (updErr) {
          db.run("ROLLBACK");
          return done(updErr);
        }

        db.run("DELETE FROM locations", (delErr) => {
          if (delErr) {
            db.run("ROLLBACK");
            return done(delErr);
          }

          const stmt = db.prepare("INSERT INTO locations (id, aisle, rack, level, is_occupied, capacity_pallets, floor_area_sqm, location_type) VALUES (?, ?, ?, ?, 0, ?, ?, ?)");
          allRows.forEach((r) => {
            stmt.run([r.id, r.aisle, r.rack, r.level, r.capacity_pallets, r.floor_area_sqm, r.location_type]);
          });

          stmt.finalize((insErr) => {
            if (insErr) {
              db.run("ROLLBACK");
              return done(insErr);
            }

            db.all('SELECT location FROM pallets WHERE status = "active" GROUP BY location', (occErr, occRows) => {
              if (occErr) {
                const occMsg = String(occErr.message || "").toLowerCase();
                if (!occMsg.includes("no such table: pallets")) {
                  db.run("ROLLBACK");
                  return done(occErr);
                }
                occRows = [];
              }

              const occupied = new Set((occRows || []).map((r) => normalizeLocationId(r.location)).filter(Boolean));
              const rowsArr = Array.from(occupied);

              const markOccupied = (i, markDone) => {
                if (i >= rowsArr.length) return markDone();
                db.run("UPDATE locations SET is_occupied = 1 WHERE id = ?", [rowsArr[i]], (mErr) => {
                  if (mErr) return markDone(mErr);
                  markOccupied(i + 1, markDone);
                });
              };

              markOccupied(0, (markErr) => {
                if (markErr) {
                  db.run("ROLLBACK");
                  return done(markErr);
                }

                db.run("COMMIT", (cErr) => {
                  if (cErr) {
                    db.run("ROLLBACK");
                    return done(cErr);
                  }
                  return done(null, {
                    total_locations: allRows.length,
                    normalized_pallet_locations: updates.length,
                    preserved_custom_locations: extraRows.length,
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

function getAuditContext(req, fallbackScannedBy = "Unknown") {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const scannedBy = String(body.scanned_by || req.headers["x-scanned-by"] || fallbackScannedBy || "Unknown").trim() || "Unknown";
  const actorId = String(body.actor_id || req.user?.username || req.headers["x-actor-id"] || "anonymous").trim() || "anonymous";
  const clientSessionId = String(body.client_session_id || req.headers["x-client-session-id"] || "unknown").trim() || "unknown";
  const idempotencyKey = String(body.idempotency_key || req.headers["x-idempotency-key"] || "").trim();
  return { scannedBy, actorId, clientSessionId, idempotencyKey };
}

function checkIdempotencyDuplicate(idempotencyKey, done) {
  if (!idempotencyKey) return done(null, false);
  db.get("SELECT id FROM activity_log WHERE idempotency_key = ? LIMIT 1", [idempotencyKey], (err, row) => {
    if (err) return done(err);
    return done(null, Boolean(row));
  });
}

function checkRecentDuplicateAction({ palletId, action, location, quantityChanged }, done) {
  db.get(
    `SELECT id FROM activity_log
     WHERE pallet_id = ?
       AND action = ?
       AND COALESCE(location, '') = COALESCE(?, '')
       AND COALESCE(quantity_changed, 0) = COALESCE(?, 0)
       AND datetime(timestamp) >= datetime('now', '-4 seconds')
     LIMIT 1`,
    [palletId, action, location || "", Number(quantityChanged) || 0],
    (err, row) => {
      if (err) return done(err);
      return done(null, Boolean(row));
    }
  );
}

// Initialize database
const db = new sqlite3.Database("./warehouse.db", (err) => {
  if (err) console.error("Database connection error:", err);
  else console.log("✓ Connected to warehouse database");
});

function getAuthTokenFromRequest(req) {
  const auth = String(req.headers.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const headerToken = String(req.headers["x-auth-token"] || "").trim();
  if (headerToken) return headerToken;
  return "";
}

function requireAuth(req, res, next) {
  if (isAuthDisabled()) {
    req.user = getSharedUser();
    return next();
  }
  const token = getAuthTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: "Authentication required" });

  db.get(
    `SELECT s.token, s.user_id, s.expires_at, u.username, u.role, u.display_name, u.customer_scope, u.is_active, u.must_reset_password
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`,
    [token],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(401).json({ error: "Invalid session" });
      if (String(row.is_active || "1") !== "1") return res.status(401).json({ error: "User inactive" });
      if (Date.parse(String(row.expires_at || "")) < Date.now()) {
        db.run("DELETE FROM user_sessions WHERE token = ?", [token]);
        return res.status(401).json({ error: "Session expired" });
      }

      db.run("UPDATE user_sessions SET last_seen_at = ? WHERE token = ?", [nowIso(), token]);

      req.user = {
        id: row.user_id,
        username: row.username,
        role: row.role,
        display_name: row.display_name || row.username,
        customer_scope: row.customer_scope || "*",
        must_reset_password: Number(row.must_reset_password || 0),
        token,
      };
      return next();
    }
  );
}

function getScopedCustomers(req) {
  const scopeRaw = String(req.user?.customer_scope || "*").trim();
  if (!scopeRaw || scopeRaw === "*") return null;
  const items = scopeRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

function applyCustomerScope({ requestedCustomer, scopedCustomers }) {
  const reqCust = String(requestedCustomer || "").trim();
  if (!scopedCustomers || scopedCustomers.length === 0) return reqCust || null;
  if (reqCust) {
    return scopedCustomers.includes(reqCust) ? reqCust : "__FORBIDDEN_SCOPE__";
  }
  return scopedCustomers;
}

function isCustomerAllowedForUser(req, customerName) {
  const scoped = getScopedCustomers(req);
  if (!scoped || scoped.length === 0) return true;
  return scoped.includes(String(customerName || "").trim());
}

// Create tables
db.serialize(() => {
  // Check and migrate pallets table
  db.all("PRAGMA table_info(pallets)", (err, columns) => {
    if (err) {
      console.error("Error checking table structure:", err);
      return;
    }

    if (columns.length > 0) {
      const hasQuantity = columns.some((col) => col.name === "quantity");
      const hasPalletQuantity = columns.some((col) => col.name === "pallet_quantity");
      const hasParts = columns.some((col) => col.name === "parts");
      const hasCurrentUnits = columns.some((col) => col.name === "current_units");
      const hasScannedBy = columns.some((col) => col.name === "scanned_by");
      const hasVersion = columns.some((col) => col.name === "version");

      if (hasQuantity && !hasPalletQuantity) {
        console.log("🔄 Migrating database to new schema...");

        db.run("ALTER TABLE pallets ADD COLUMN pallet_quantity INTEGER DEFAULT 1");
        db.run("ALTER TABLE pallets ADD COLUMN product_quantity INTEGER DEFAULT 0");

        setTimeout(() => {
          db.run(
            "UPDATE pallets SET pallet_quantity = quantity WHERE pallet_quantity IS NULL OR pallet_quantity = 0"
          );
          db.run("UPDATE pallets SET product_quantity = 0 WHERE product_quantity IS NULL");
          console.log("✓ Migration complete");
        }, 500);
      }

      if (!hasParts) {
        console.log("🔄 Adding parts column...");
        db.run("ALTER TABLE pallets ADD COLUMN parts TEXT", (err) => {
          if (err) console.error("Error adding parts column:", err);
          else console.log("✓ Parts column added");
        });
      }

      if (!hasCurrentUnits) {
        console.log("🔄 Adding current_units column...");
        db.run("ALTER TABLE pallets ADD COLUMN current_units INTEGER DEFAULT 0", (err) => {
          if (err) console.error("Error adding current_units column:", err);
          else {
            console.log("✓ current_units column added");
            setTimeout(() => {
              db.run(
                "UPDATE pallets SET current_units = product_quantity * pallet_quantity WHERE current_units IS NULL OR current_units = 0",
                (err) => {
                  if (err) console.error("Error initializing current_units:", err);
                  else console.log("✓ current_units initialized");
                }
              );
            }, 500);
          }
        });
      }

      if (!hasScannedBy) {
        console.log("🔄 Adding scanned_by column...");
        db.run("ALTER TABLE pallets ADD COLUMN scanned_by TEXT DEFAULT 'Unknown'", (err) => {
          if (err) console.error("Error adding scanned_by column:", err);
          else console.log("✓ scanned_by column added");
        });
      }

      if (!hasVersion) {
        console.log("🔄 Adding version column...");
        db.run("ALTER TABLE pallets ADD COLUMN version INTEGER NOT NULL DEFAULT 0", (err) => {
          if (err) console.error("Error adding version column:", err);
          else console.log("✓ version column added");
        });
      }
    }
  });
  // Locations table
  db.run(
    `CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      aisle TEXT,
      rack INTEGER,
      level INTEGER,
      is_occupied INTEGER DEFAULT 0,
      capacity_pallets INTEGER,
      floor_area_sqm REAL,
      location_type TEXT DEFAULT 'rack'
    )`,
    (err) => {
      if (err) console.error("Error creating locations table:", err);
      else console.log("✓ Locations table ready");
  db.all("PRAGMA table_info(locations)", (err, columns) => {
    if (err || !columns) return;
    const hasCapacity = columns.some((col) => col.name === "capacity_pallets");
    const hasFloorArea = columns.some((col) => col.name === "floor_area_sqm");
    const hasLocationType = columns.some((col) => col.name === "location_type");
    if (!hasCapacity) db.run("ALTER TABLE locations ADD COLUMN capacity_pallets INTEGER");
    if (!hasFloorArea) db.run("ALTER TABLE locations ADD COLUMN floor_area_sqm REAL");
    if (!hasLocationType) db.run("ALTER TABLE locations ADD COLUMN location_type TEXT DEFAULT 'rack'");
  });

    }
  );

  // Activity/History table
  db.run(
    `CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pallet_id TEXT,
      customer_name TEXT,
      product_id TEXT,
      action TEXT,
      quantity_changed INTEGER,
      quantity_before INTEGER,
      quantity_after INTEGER,
      location TEXT,
      notes TEXT,
      scanned_by TEXT DEFAULT 'Unknown',
      actor_id TEXT DEFAULT 'anonymous',
      client_session_id TEXT DEFAULT 'unknown',
      idempotency_key TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    (err) => {
      if (err) console.error("Error creating activity_log table:", err);
      else console.log("✓ Activity log table ready");
    }
  );

  // Add scanned_by column to activity_log if it doesn't exist
  db.all("PRAGMA table_info(activity_log)", (err, columns) => {
    if (!err && columns) {
      const hasScannedBy = columns.some((col) => col.name === "scanned_by");
      const hasActorId = columns.some((col) => col.name === "actor_id");
      const hasClientSessionId = columns.some((col) => col.name === "client_session_id");
      const hasIdempotencyKey = columns.some((col) => col.name === "idempotency_key");
      if (!hasScannedBy) {
        console.log("🔄 Adding scanned_by to activity_log...");
        db.run("ALTER TABLE activity_log ADD COLUMN scanned_by TEXT DEFAULT 'Unknown'", (err) => {
          if (err) console.error("Error adding scanned_by to activity_log:", err);
          else console.log("✓ scanned_by column added to activity_log");
        });
      }
      if (!hasActorId) {
        db.run("ALTER TABLE activity_log ADD COLUMN actor_id TEXT DEFAULT 'anonymous'");
      }
      if (!hasClientSessionId) {
        db.run("ALTER TABLE activity_log ADD COLUMN client_session_id TEXT DEFAULT 'unknown'");
      }
      if (!hasIdempotencyKey) {
        db.run("ALTER TABLE activity_log ADD COLUMN idempotency_key TEXT");
      }
    }
  });

  // Auth users table
  db.run(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'ops',
     display_name TEXT,
     customer_scope TEXT NOT NULL DEFAULT '*',
     is_active INTEGER NOT NULL DEFAULT 1,
      must_reset_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  );

  db.all("PRAGMA table_info(users)", (err, columns) => {
    if (err || !columns) return;
    const hasMustReset = columns.some((c) => c.name === "must_reset_password");
    if (!hasMustReset) {
      db.run("ALTER TABLE users ADD COLUMN must_reset_password INTEGER NOT NULL DEFAULT 0");
    }
  });

  // Auth sessions table
  db.run(
    `CREATE TABLE IF NOT EXISTS user_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`
  );

  // Ensure there is at least one bootstrap admin
  db.get("SELECT COUNT(*) AS c FROM users", (err, row) => {
    if (err) return;
    if (Number(row?.c || 0) > 0) return;

    const adminUser = String(process.env.WT_BOOTSTRAP_USER || "admin").trim() || "admin";
    const adminPass = String(process.env.WT_BOOTSTRAP_PASS || "admin123!").trim() || "admin123!";
    const salt = makeSalt();
    const hash = hashPassword(adminPass, salt);
    db.run(
      "INSERT INTO users (username, password_hash, password_salt, role, display_name, customer_scope, is_active, must_reset_password) VALUES (?, ?, ?, 'owner', 'Owner', '*', 1, 0)",
      [adminUser, hash, salt],
      (insErr) => {
        if (!insErr) {
          console.log(`✓ Bootstrap login created: ${adminUser} / ${adminPass}`);
        }
      }
    );
  });

  // Populate locations if empty (or reseed on boot if enabled)
  db.get("SELECT COUNT(*) as count FROM locations", (err, row) => {
    if (err) {
      console.error("Error checking locations:", err);
      return;
    }

    const shouldReseedOnBoot = Number(process.env.WT_RESEED_LOCATIONS_ON_BOOT || 0) === 1;
    if (Number(row?.count || 0) === 0 || shouldReseedOnBoot) {
      rebuildLocationsToAll4Layout((seedErr, summary) => {
        if (seedErr) {
          console.error("Error initializing ALL4 locations:", seedErr);
          return;
        }
        console.log(
          `✓ ALL4 locations ready (${summary?.total_locations || 0} total, ` +
          `${summary?.normalized_pallet_locations || 0} pallet location updates, ` +
          `${summary?.preserved_custom_locations || 0} custom preserved)`
        );
      });
    } else {
      console.log(`✓ Found ${row.count} existing locations`);
    }
  });
});

// =====================
// API ROUTES
// =====================

app.post("/api/auth/login", (req, res) => {
  if (isAuthDisabled()) {
    return res.json({
      ok: true,
      token: "shared-mode",
      user: {
        id: 0,
        username: "shared",
        role: "owner",
        display_name: "Warehouse Team",
        customer_scope: "*",
        must_reset_password: 0,
      },
      expires_at: null,
    });
  }

  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown");
  const loginKey = `${ip}::${username.toLowerCase()}`;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }
  if (isLoginBlocked(loginKey)) {
    return res.status(429).json({ error: `Too many login attempts. Try again in ${Math.ceil(loginBlockMs / 60000)} minutes.` });
  }

  db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!user || Number(user.is_active || 0) !== 1) {
      registerLoginFailure(loginKey);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const expected = hashPassword(password, user.password_salt);
    if (expected !== user.password_hash) {
      registerLoginFailure(loginKey);
      return res.status(401).json({ error: "Invalid credentials" });
    }
    clearLoginFailures(loginKey);

    const token = makeSessionToken();
    const expiresAt = new Date(Date.now() + (8 * 60 * 60 * 1000)).toISOString(); // 8h
    db.run(
      "INSERT INTO user_sessions (token, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
      [token, user.id, expiresAt, nowIso(), nowIso()],
      (insErr) => {
        if (insErr) return res.status(500).json({ error: "DB error" });
        return res.json({
          ok: true,
          token,
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
            display_name: user.display_name || user.username,
            customer_scope: user.customer_scope || "*",
            must_reset_password: Number(user.must_reset_password || 0),
          },
          expires_at: expiresAt,
        });
      }
    );
  });
});

app.use("/api", (req, res, next) => {
  if (req.path === "/auth/login") return next();
  return requireAuth(req, res, next);
});

app.get("/api/auth/me", (req, res) => {
  return res.json({
    ok: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      display_name: req.user.display_name || req.user.username,
      customer_scope: req.user.customer_scope || "*",
      must_reset_password: Number(req.user.must_reset_password || 0),
    },
  });
});

app.post("/api/auth/logout", (req, res) => {
  const token = req.user?.token || getAuthTokenFromRequest(req);
  if (!token) return res.json({ ok: true });
  db.run("DELETE FROM user_sessions WHERE token = ?", [token], () => {
    return res.json({ ok: true });
  });
});

app.post("/api/auth/logout-all", (req, res) => {
  db.run("DELETE FROM user_sessions WHERE user_id = ?", [req.user.id], (err) => {
    if (err) return res.status(500).json({ error: "DB error" });
    return res.json({ ok: true });
  });
});

app.get("/api/auth/users", requireAdminRole, (req, res) => {
  db.all(
    "SELECT id, username, role, display_name, customer_scope, is_active, must_reset_password, created_at FROM users ORDER BY id ASC",
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      return res.json(rows || []);
    }
  );
});

app.post("/api/admin/locations/reseed-all4", requireAdminRole, (req, res) => {
  rebuildLocationsToAll4Layout((err, summary) => {
    if (err) return res.status(500).json({ error: err.message || "Location reseed failed" });
    return res.json({ ok: true, layout: "ALL4", summary });
  });
});

app.post("/api/admin/locations/upsert", requireAdminRole, (req, res) => {
  const id = normalizeLocationId(req.body?.id);
  if (!id) return res.status(400).json({ error: "Location id is required" });

  const aisleRaw = req.body?.aisle;
  const rackRaw = req.body?.rack;
  const levelRaw = req.body?.level;
  const capacityRaw = req.body?.capacity_pallets;
  const floorAreaRaw = req.body?.floor_area_sqm;
  const typeRaw = String(req.body?.location_type || "custom").trim().toLowerCase() || "custom";

  const aisle = aisleRaw == null || aisleRaw === "" ? null : String(aisleRaw).trim().toUpperCase();
  const rack = rackRaw == null || rackRaw === "" ? null : Number(rackRaw);
  const level = levelRaw == null || levelRaw === "" ? null : Number(levelRaw);
  const capacity = capacityRaw == null || capacityRaw === "" ? null : Number(capacityRaw);
  const floorArea = floorAreaRaw == null || floorAreaRaw === "" ? null : Number(floorAreaRaw);

  if (rack != null && (!Number.isFinite(rack) || rack <= 0)) return res.status(400).json({ error: "Invalid rack" });
  if (level != null && (!Number.isFinite(level) || level < 0)) return res.status(400).json({ error: "Invalid level" });
  if (capacity != null && (!Number.isFinite(capacity) || capacity < 0)) return res.status(400).json({ error: "Invalid capacity_pallets" });
  if (floorArea != null && (!Number.isFinite(floorArea) || floorArea < 0)) return res.status(400).json({ error: "Invalid floor_area_sqm" });

  db.run(
    `INSERT INTO locations (id, aisle, rack, level, is_occupied, capacity_pallets, floor_area_sqm, location_type)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       aisle = excluded.aisle,
       rack = excluded.rack,
       level = excluded.level,
       capacity_pallets = excluded.capacity_pallets,
       floor_area_sqm = excluded.floor_area_sqm,
       location_type = excluded.location_type`,
    [id, aisle, rack, level, capacity, floorArea, typeRaw],
    (err) => {
      if (err) return res.status(500).json({ error: err.message || "Unable to upsert location" });
      db.get("SELECT * FROM locations WHERE id = ?", [id], (selErr, row) => {
        if (selErr) return res.status(500).json({ error: "DB error" });
        return res.json({ ok: true, location: row });
      });
    }
  );
});

app.post("/api/auth/users", requireAdminRole, (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const role = String(req.body?.role || "ops").trim().toLowerCase();
  const displayName = String(req.body?.display_name || username).trim();
  const customerScope = String(req.body?.customer_scope || "*").trim() || "*";
  const isActive = Number(req.body?.is_active ?? 1) ? 1 : 0;
  const mustReset = Number(req.body?.must_reset_password ?? 1) ? 1 : 0;
  const allowedRoles = new Set(["owner", "admin", "ops", "viewer"]);

  if (!username || !password) return res.status(400).json({ error: "username and password are required" });
  if (!allowedRoles.has(role)) return res.status(400).json({ error: "Invalid role" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const salt = makeSalt();
  const hash = hashPassword(password, salt);
  db.run(
    "INSERT INTO users (username, password_hash, password_salt, role, display_name, customer_scope, is_active, must_reset_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [username, hash, salt, role, displayName, customerScope, isActive, mustReset],
    function onInsert(err) {
      if (err) return res.status(400).json({ error: err.message || "Unable to create user" });
      return res.json({ ok: true, id: this.lastID });
    }
  );
});

app.patch("/api/auth/users/:id", requireAdminRole, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid user id" });

  db.get("SELECT * FROM users WHERE id = ?", [id], (err, user) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!user) return res.status(404).json({ error: "User not found" });

    const allowedRoles = new Set(["owner", "admin", "ops", "viewer"]);
    const roleRaw = req.body?.role;
    const displayRaw = req.body?.display_name;
    const scopeRaw = req.body?.customer_scope;
    const activeRaw = req.body?.is_active;
    const mustResetRaw = req.body?.must_reset_password;
    const passwordRaw = req.body?.password;

    const updates = [];
    const params = [];

    if (roleRaw !== undefined) {
      const role = String(roleRaw || "").trim().toLowerCase();
      if (!allowedRoles.has(role)) return res.status(400).json({ error: "Invalid role" });
      updates.push("role = ?");
      params.push(role);
    }

    if (displayRaw !== undefined) {
      updates.push("display_name = ?");
      params.push(String(displayRaw || "").trim());
    }

    if (scopeRaw !== undefined) {
      const scope = String(scopeRaw || "*").trim() || "*";
      updates.push("customer_scope = ?");
      params.push(scope);
    }

    if (activeRaw !== undefined) {
      const isActive = Number(activeRaw) ? 1 : 0;
      updates.push("is_active = ?");
      params.push(isActive);
    }

    if (mustResetRaw !== undefined) {
      const mustReset = Number(mustResetRaw) ? 1 : 0;
      updates.push("must_reset_password = ?");
      params.push(mustReset);
    }

    if (passwordRaw !== undefined && String(passwordRaw).length > 0) {
      const nextPassword = String(passwordRaw);
      if (nextPassword.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
      const salt = makeSalt();
      const hash = hashPassword(nextPassword, salt);
      updates.push("password_hash = ?", "password_salt = ?", "must_reset_password = ?");
      params.push(hash, salt, 1);
    }

    if (!updates.length) return res.status(400).json({ error: "No update fields provided" });

    const requestedRole = roleRaw !== undefined ? String(roleRaw || "").trim().toLowerCase() : String(user.role || "").toLowerCase();
    const requestedActive = activeRaw !== undefined ? (Number(activeRaw) ? 1 : 0) : Number(user.is_active || 0);
    const wouldDemoteOrDisableOwner = String(user.role || "").toLowerCase() === "owner" && (requestedRole !== "owner" || requestedActive !== 1);

    const runUpdate = () => {
      params.push(id);
      db.run(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, params, function onUpdate(upErr) {
        if (upErr) return res.status(500).json({ error: "DB error" });
        if (this.changes === 0) return res.status(404).json({ error: "User not found" });
        db.get(
          "SELECT id, username, role, display_name, customer_scope, is_active, must_reset_password, created_at FROM users WHERE id = ?",
          [id],
          (selErr, row) => {
            if (selErr) return res.status(500).json({ error: "DB error" });
            return res.json({ ok: true, user: row });
          }
        );
      });
    };

    if (!wouldDemoteOrDisableOwner) return runUpdate();

    db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'owner' AND is_active = 1", (countErr, countRow) => {
      if (countErr) return res.status(500).json({ error: "DB error" });
      if (Number(countRow?.c || 0) <= 1) {
        return res.status(400).json({ error: "At least one active owner is required" });
      }
      return runUpdate();
    });
  });
});

app.get("/api/health", (req, res) => {
  db.get("SELECT COUNT(*) AS c FROM users WHERE is_active = 1", (uErr, uRow) => {
    if (uErr) return res.status(500).json({ error: "DB error" });
    db.get("SELECT COUNT(*) AS c FROM user_sessions", (sErr, sRow) => {
      if (sErr) return res.status(500).json({ error: "DB error" });
      return res.json({
        ok: true,
        uptime_sec: Math.round(process.uptime()),
        active_users: Number(uRow?.c || 0),
        sessions: Number(sRow?.c || 0),
        timestamp: nowIso(),
      });
    });
  });
});

app.get("/api/ready", (req, res) => {
  db.get("SELECT 1 AS ok", (err) => {
    if (err) return res.status(500).json({ ok: false, ready: false, error: "DB not ready" });
    return res.json({
      ok: true,
      ready: true,
      uptime_sec: Math.round(process.uptime()),
      auth_disabled: Number(readServerSettings().authDisabled || 0) === 1,
      timestamp: nowIso(),
    });
  });
});

app.post("/api/admin/backup-db", requireAdminRole, (req, res) => {
  const backupDir = path.join(__dirname, "backups");
  try {
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  } catch (e) {
    return res.status(500).json({ error: `Unable to create backup directory: ${e.message}` });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `warehouse-backup-${stamp}.db`;
  const fullPath = path.join(backupDir, fileName);
  const sourcePath = path.join(__dirname, "warehouse.db");

  db.get("PRAGMA wal_checkpoint(FULL)", () => {
    fs.copyFile(sourcePath, fullPath, (err) => {
      if (err) return res.status(500).json({ error: `Backup failed: ${err.message}` });
      return res.json({ ok: true, file: fileName, path: fullPath });
    });
  });
});

app.get("/api/admin/backups/latest", requireAdminRole, (req, res) => {
  const backupDir = path.join(__dirname, "backups");
  try {
    if (!fs.existsSync(backupDir)) return res.json({ ok: true, latest: null });
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.endsWith(".db") && f.startsWith("warehouse-backup-"))
      .map((file) => {
        const fullPath = path.join(backupDir, file);
        const st = fs.statSync(fullPath);
        return {
          file,
          path: fullPath,
          size_bytes: Number(st.size || 0),
          mtime: st.mtime ? st.mtime.toISOString() : null,
        };
      })
      .sort((a, b) => Date.parse(String(b.mtime || "")) - Date.parse(String(a.mtime || "")));

    return res.json({ ok: true, latest: files[0] || null });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unable to read backups directory" });
  }
});

app.post("/api/auth/change-password", requireAuth, (req, res) => {
  const currentPassword = String(req.body?.current_password || "");
  const newPassword = String(req.body?.new_password || "");
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "current_password and new_password are required" });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  }

  db.get("SELECT * FROM users WHERE id = ?", [req.user.id], (err, user) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!user) return res.status(404).json({ error: "User not found" });

    const expected = hashPassword(currentPassword, user.password_salt);
    if (expected !== user.password_hash) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const salt = makeSalt();
    const hash = hashPassword(newPassword, salt);
    db.run(
      "UPDATE users SET password_hash = ?, password_salt = ?, must_reset_password = 0 WHERE id = ?",
      [hash, salt, req.user.id],
      (upErr) => {
        if (upErr) return res.status(500).json({ error: "DB error" });
        return res.json({ ok: true });
      }
    );
  });
});

// Get all active pallets
app.get("/api/pallets", (req, res) => {
  const { customer } = req.query;
  const scopedCustomers = getScopedCustomers(req);
  const scoped = applyCustomerScope({ requestedCustomer: customer, scopedCustomers });
  if (scoped === "__FORBIDDEN_SCOPE__") return res.json([]);

  let query = 'SELECT * FROM pallets WHERE status = "active"';
  let params = [];

  if (Array.isArray(scoped)) {
    query += ` AND customer_name IN (${scoped.map(() => "?").join(",")})`;
    params.push(...scoped);
  } else if (scoped) {
    query += " AND customer_name = ?";
    params.push(scoped);
  }

  query += " ORDER BY date_added DESC";

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const palletsWithParts = rows.map((row) => ({
      ...row,
      parts: safeParseParts(row.parts),
    }));

    res.json(palletsWithParts);
  });
});

// Search pallets
app.get("/api/pallets/search", (req, res) => {
  const { q } = req.query;
  const scopedCustomers = getScopedCustomers(req);
  let query = 'SELECT * FROM pallets WHERE status = "active" AND (product_id LIKE ? OR location LIKE ? OR customer_name LIKE ?)';
  const params = [`%${q}%`, `%${q}%`, `%${q}%`];
  if (Array.isArray(scopedCustomers)) {
    query += ` AND customer_name IN (${scopedCustomers.map(() => "?").join(",")})`;
    params.push(...scopedCustomers);
  }
  query += " ORDER BY date_added DESC";
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const palletsWithParts = rows.map((row) => ({
      ...row,
      parts: safeParseParts(row.parts),
    }));

    res.json(palletsWithParts);
  });
});

// Check in a pallet
app.post("/api/pallets", requireWriteRole, (req, res) => {
  const {
    id,
    customer_name,
    product_id,
    pallet_quantity,
    product_quantity,
    location,
    parts,
    scanned_by,
  } = req.body;

  if (!customer_name || !product_id || !location) {
    return res.status(400).json({ error: "Customer name, Product ID and location required" });
  }
  if (!isCustomerAllowedForUser(req, customer_name)) {
    return res.status(403).json({ error: "Customer outside your scope" });
  }

  const palletId = id || `PLT-${Date.now()}`;
  const partsJson = parts ? JSON.stringify(parts) : null;
  const palletQty = Number(pallet_quantity) || 1;
  const unitsPerPallet = Number(product_quantity) || 0;
  const currentUnits = palletQty * unitsPerPallet;
  const audit = getAuditContext(req, scanned_by || "Unknown");
  const scannedByPerson = audit.scannedBy;

  checkIdempotencyDuplicate(audit.idempotencyKey, (dupErr, isDup) => {
    if (dupErr) return res.status(500).json({ error: dupErr.message });
    if (isDup) return res.json({ ok: true, deduped: true, message: "Duplicate request ignored" });

    db.run(
      "INSERT INTO pallets (id, customer_name, product_id, pallet_quantity, product_quantity, current_units, location, parts, scanned_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        palletId,
        customer_name,
        product_id,
        palletQty,
        unitsPerPallet,
        currentUnits,
        location,
        partsJson,
        scannedByPerson,
      ],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });

        db.run("UPDATE locations SET is_occupied = 1 WHERE id = ?", [location]);

        db.run(
          "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_after, location, scanned_by, actor_id, client_session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            palletId,
            customer_name,
            product_id,
            "CHECK_IN",
            palletQty,
            palletQty,
            location,
            scannedByPerson,
            audit.actorId,
            audit.clientSessionId,
            audit.idempotencyKey || null,
          ]
        );

        res.json({
          id: palletId,
          customer_name,
          product_id,
          pallet_quantity: palletQty,
          product_quantity: unitsPerPallet,
          location,
          parts: parts || null,
          message: "Pallet checked in successfully",
        });

        broadcastInventoryChange("add_pallet", {
          id: palletId,
          customer_name,
          product_id,
          pallet_quantity: palletQty,
          product_quantity: unitsPerPallet,
          current_units: currentUnits,
          location,
          parts,
          scanned_by: scannedByPerson,
        });
      }
    );
  });
});

// Move a pallet to a different location
app.post("/api/pallets/:id/move", requireWriteRole, (req, res) => {
  const id = req.params.id;
  const toLocation = String(req.body?.to_location || "").trim().toUpperCase();
  const audit = getAuditContext(req, "Scan");
  const scannedBy = audit.scannedBy;

  if (!toLocation) {
    return res.status(400).json({ error: "to_location is required" });
  }

  checkIdempotencyDuplicate(audit.idempotencyKey, (dupErr, isDup) => {
    if (dupErr) return res.status(500).json({ error: dupErr.message });
    if (isDup) return res.json({ ok: true, deduped: true, message: "Duplicate request ignored" });

    db.get(
      'SELECT * FROM pallets WHERE (id = ? OR product_id = ?) AND status = "active"',
      [id, id],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Pallet not found or already removed" });

      const palletId = row.id;
      const fromLocation = String(row.location || "").toUpperCase();
      if (!isCustomerAllowedForUser(req, row.customer_name)) {
        return res.status(403).json({ error: "Customer outside your scope" });
      }

        if (!fromLocation) {
          return res.status(400).json({ error: "Pallet has no current location" });
        }
        if (fromLocation === toLocation) {
          return res.json({
            ok: true,
            id: palletId,
            from_location: fromLocation,
            to_location: toLocation,
            message: "Pallet already in that location",
          });
        }

        checkRecentDuplicateAction(
          { palletId, action: "MOVE", location: toLocation, quantityChanged: 0 },
          (recentErr, isRecentDup) => {
            if (recentErr) return res.status(500).json({ error: recentErr.message });
            if (isRecentDup) return res.json({ ok: true, deduped: true, message: "Duplicate move ignored" });

            db.get("SELECT id FROM locations WHERE id = ?", [toLocation], (locErr, locRow) => {
              if (locErr) return res.status(500).json({ error: locErr.message });
              if (!locRow) return res.status(400).json({ error: `Unknown location: ${toLocation}` });

              db.get(
                'SELECT COUNT(*) AS cnt FROM pallets WHERE status = "active" AND location = ? AND id != ?',
                [toLocation, palletId],
                (occErr, occRow) => {
                  if (occErr) return res.status(500).json({ error: occErr.message });
                  if (Number(occRow?.cnt || 0) > 0) {
                    return res.status(409).json({ error: `Target location ${toLocation} is occupied` });
                  }

                  db.run(
                    "UPDATE pallets SET location = ?, version = version + 1 WHERE id = ? AND version = ?",
                    [toLocation, palletId, Number(row.version) || 0],
                    function onMove(moveErr) {
                      if (moveErr) return res.status(500).json({ error: moveErr.message });
                      if (this.changes === 0) {
                        return res.status(409).json({ error: "Pallet was updated by another user. Refresh and retry." });
                      }

                      db.get(
                        'SELECT COUNT(*) AS cnt FROM pallets WHERE status = "active" AND location = ?',
                        [fromLocation],
                        (oldCntErr, oldCntRow) => {
                          if (oldCntErr) return res.status(500).json({ error: oldCntErr.message });
                          const oldOccupied = Number(oldCntRow?.cnt || 0) > 0 ? 1 : 0;

                          db.run("UPDATE locations SET is_occupied = ? WHERE id = ?", [oldOccupied, fromLocation]);
                          db.run("UPDATE locations SET is_occupied = 1 WHERE id = ?", [toLocation]);

                          db.run(
                            "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, quantity_after, location, notes, scanned_by, actor_id, client_session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            [
                              palletId,
                              row.customer_name,
                              row.product_id,
                              "MOVE",
                              0,
                              Number(row.pallet_quantity) || 0,
                              Number(row.pallet_quantity) || 0,
                              toLocation,
                              `Moved from ${fromLocation} to ${toLocation}`,
                              scannedBy,
                              audit.actorId,
                              audit.clientSessionId,
                              audit.idempotencyKey || null,
                            ]
                          );

                          const payload = {
                            id: palletId,
                            customer_name: row.customer_name,
                            product_id: row.product_id,
                            pallet_quantity: Number(row.pallet_quantity) || 0,
                            product_quantity: Number(row.product_quantity) || 0,
                            from_location: fromLocation,
                            to_location: toLocation,
                            scanned_by: scannedBy,
                          };

                          broadcastInventoryChange("move_pallet", payload);
                          return res.json({ ok: true, ...payload, message: "Pallet moved successfully" });
                        }
                      );
                    }
                  );
                }
              );
            });
          }
        );
      }
    );
  });
});

// Partial quantity removal
app.post("/api/pallets/:id/remove-quantity", requireWriteRole, (req, res) => {
  const { id } = req.params;
  const { quantity_to_remove, scanned_by } = req.body;
  const audit = getAuditContext(req, scanned_by || "Unknown");
  const scannedByPerson = audit.scannedBy;

  if (!quantity_to_remove || quantity_to_remove <= 0) {
    return res.status(400).json({ error: "Valid quantity required" });
  }

  checkIdempotencyDuplicate(audit.idempotencyKey, (dupErr, isDup) => {
    if (dupErr) return res.status(500).json({ error: dupErr.message });
    if (isDup) return res.json({ ok: true, deduped: true, message: "Duplicate request ignored" });

    db.get(
      'SELECT * FROM pallets WHERE (id = ? OR product_id = ?) AND status = "active"',
      [id, id],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Pallet not found" });

        const quantityBefore = Number(row.pallet_quantity) || 0;
        const qtyToRemove = Number(quantity_to_remove) || 0;
        const quantityAfter = quantityBefore - qtyToRemove;
        if (!isCustomerAllowedForUser(req, row.customer_name)) {
          return res.status(403).json({ error: "Customer outside your scope" });
        }

        if (quantityAfter < 0) {
          return res.status(400).json({ error: "Cannot remove more than available quantity" });
        }

        checkRecentDuplicateAction(
          { palletId: row.id, action: "PARTIAL_REMOVE", location: row.location, quantityChanged: qtyToRemove },
          (recentErr, isRecentDup) => {
            if (recentErr) return res.status(500).json({ error: recentErr.message });
            if (isRecentDup) return res.json({ ok: true, deduped: true, message: "Duplicate removal ignored" });

            if (quantityAfter === 0) {
              db.run(
                'UPDATE pallets SET status = "removed", date_removed = CURRENT_TIMESTAMP, pallet_quantity = 0, version = version + 1 WHERE id = ? AND version = ?',
                [row.id, Number(row.version) || 0],
                function onRemoveAll(err) {
                  if (err) return res.status(500).json({ error: err.message });
                  if (this.changes === 0) {
                    return res.status(409).json({ error: "Pallet was updated by another user. Refresh and retry." });
                  }

                  db.run("UPDATE locations SET is_occupied = 0 WHERE id = ?", [row.location]);

                  db.run(
                    "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, quantity_after, location, notes, scanned_by, actor_id, client_session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                      row.id,
                      row.customer_name,
                      row.product_id,
                      "PARTIAL_REMOVE",
                      qtyToRemove,
                      quantityBefore,
                      0,
                      row.location,
                      "Pallet emptied and removed",
                      scannedByPerson,
                      audit.actorId,
                      audit.clientSessionId,
                      audit.idempotencyKey || null,
                    ]
                  );

                  res.json({
                    message: "All pallets removed. Location freed.",
                    quantity_removed: qtyToRemove,
                    quantity_remaining: 0,
                    pallet_removed: true,
                  });

                  broadcastInventoryChange("delete_pallet", {
                    customer_name: row.customer_name,
                    product_id: row.product_id,
                    location: row.location,
                    quantity_removed: qtyToRemove,
                    scanned_by: scannedByPerson,
                  });
                }
              );
            } else {
              db.run(
                "UPDATE pallets SET pallet_quantity = ?, version = version + 1 WHERE id = ? AND version = ?",
                [quantityAfter, row.id, Number(row.version) || 0],
                function onRemoveSome(err) {
                  if (err) return res.status(500).json({ error: err.message });
                  if (this.changes === 0) {
                    return res.status(409).json({ error: "Pallet was updated by another user. Refresh and retry." });
                  }

                  db.run(
                    "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, quantity_after, location, scanned_by, actor_id, client_session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                      row.id,
                      row.customer_name,
                      row.product_id,
                      "PARTIAL_REMOVE",
                      qtyToRemove,
                      quantityBefore,
                      quantityAfter,
                      row.location,
                      scannedByPerson,
                      audit.actorId,
                      audit.clientSessionId,
                      audit.idempotencyKey || null,
                    ]
                  );

                  res.json({
                    message: `Removed ${qtyToRemove} pallet(s). ${quantityAfter} remaining.`,
                    quantity_removed: qtyToRemove,
                    quantity_remaining: quantityAfter,
                    pallet_removed: false,
                  });

                  broadcastInventoryChange("remove_pallets", {
                    customer_name: row.customer_name,
                    product_id: row.product_id,
                    location: row.location,
                    quantity_removed: qtyToRemove,
                    quantity_remaining: quantityAfter,
                    scanned_by: scannedByPerson,
                  });
                }
              );
            }
          }
        );
      }
    );
  });
});

// Remove partial units from pallet
app.post("/api/pallets/:id/remove-units", requireWriteRole, (req, res) => {
  const { id } = req.params;
  const { units_to_remove, scanned_by } = req.body;
  const audit = getAuditContext(req, scanned_by || "Unknown");
  const scannedByPerson = audit.scannedBy;

  if (!units_to_remove || units_to_remove <= 0) {
    return res.status(400).json({ error: "Valid unit quantity required" });
  }

  checkIdempotencyDuplicate(audit.idempotencyKey, (dupErr, isDup) => {
    if (dupErr) return res.status(500).json({ error: dupErr.message });
    if (isDup) return res.json({ ok: true, deduped: true, message: "Duplicate request ignored" });

    db.get(
      'SELECT * FROM pallets WHERE (id = ? OR product_id = ?) AND status = "active"',
      [id, id],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Pallet not found" });

        if (!row.product_quantity || row.product_quantity === 0) {
          return res.status(400).json({
            error: "This pallet does not track individual units. Use remove-quantity endpoint instead.",
          });
        }

        const totalUnits = Number(row.current_units) || 0;
        const unitsToRemove = Number(units_to_remove) || 0;
        const unitsAfter = totalUnits - unitsToRemove;
        if (!isCustomerAllowedForUser(req, row.customer_name)) {
          return res.status(403).json({ error: "Customer outside your scope" });
        }

        if (unitsAfter < 0) {
          return res.status(400).json({
            error: `Cannot remove ${unitsToRemove} units. Only ${totalUnits} units available.`,
          });
        }

        checkRecentDuplicateAction(
          { palletId: row.id, action: "UNITS_REMOVE", location: row.location, quantityChanged: unitsToRemove },
          (recentErr, isRecentDup) => {
            if (recentErr) return res.status(500).json({ error: recentErr.message });
            if (isRecentDup) return res.json({ ok: true, deduped: true, message: "Duplicate removal ignored" });

            if (unitsAfter === 0) {
              db.run(
                'UPDATE pallets SET status = "removed", date_removed = CURRENT_TIMESTAMP, pallet_quantity = 0, product_quantity = 0, current_units = 0, version = version + 1 WHERE id = ? AND version = ?',
                [row.id, Number(row.version) || 0],
                function onRemoveAll(err) {
                  if (err) return res.status(500).json({ error: err.message });
                  if (this.changes === 0) {
                    return res.status(409).json({ error: "Pallet was updated by another user. Refresh and retry." });
                  }

                  db.run("UPDATE locations SET is_occupied = 0 WHERE id = ?", [row.location]);

                  db.run(
                    "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, quantity_after, location, notes, scanned_by, actor_id, client_session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                      row.id,
                      row.customer_name,
                      row.product_id,
                      "UNITS_REMOVE",
                      unitsToRemove,
                      totalUnits,
                      0,
                      row.location,
                      "All units removed. Pallet cleared.",
                      scannedByPerson,
                      audit.actorId,
                      audit.clientSessionId,
                      audit.idempotencyKey || null,
                    ]
                  );

                  res.json({
                    message: "All units removed. Location freed.",
                    units_removed: unitsToRemove,
                    units_remaining: 0,
                    pallets_remaining: 0,
                    pallet_removed: true,
                  });

                  broadcastInventoryChange("delete_pallet", {
                    customer_name: row.customer_name,
                    product_id: row.product_id,
                    location: row.location,
                    units_removed: unitsToRemove,
                    scanned_by: scannedByPerson,
                  });
                }
              );
            } else {
              db.run(
                "UPDATE pallets SET current_units = ?, version = version + 1 WHERE id = ? AND version = ?",
                [unitsAfter, row.id, Number(row.version) || 0],
                function onRemoveSome(err) {
                  if (err) return res.status(500).json({ error: err.message });
                  if (this.changes === 0) {
                    return res.status(409).json({ error: "Pallet was updated by another user. Refresh and retry." });
                  }

                  db.run(
                    "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, quantity_after, location, notes, scanned_by, actor_id, client_session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                      row.id,
                      row.customer_name,
                      row.product_id,
                      "UNITS_REMOVE",
                      unitsToRemove,
                      totalUnits,
                      unitsAfter,
                      row.location,
                      `Removed ${unitsToRemove} units. ${unitsAfter} total units remaining.`,
                      scannedByPerson,
                      audit.actorId,
                      audit.clientSessionId,
                      audit.idempotencyKey || null,
                    ]
                  );

                  res.json({
                    message: `Removed ${unitsToRemove} units. ${unitsAfter} total units remaining.`,
                    units_removed: unitsToRemove,
                    units_remaining: unitsAfter,
                    pallets_remaining: row.pallet_quantity,
                    units_per_pallet: row.product_quantity,
                    current_units: unitsAfter,
                    pallet_removed: false,
                  });

                  broadcastInventoryChange("remove_units", {
                    customer_name: row.customer_name,
                    product_id: row.product_id,
                    location: row.location,
                    units_removed: unitsToRemove,
                    units_remaining: unitsAfter,
                    scanned_by: scannedByPerson,
                  });
                }
              );
            }
          }
        );
      }
    );
  });
});

// Check out a pallet
app.delete("/api/pallets/:id", requireWriteRole, (req, res) => {
  const { id } = req.params;
  const audit = getAuditContext(req, "Scan");

  checkIdempotencyDuplicate(audit.idempotencyKey, (dupErr, isDup) => {
    if (dupErr) return res.status(500).json({ error: dupErr.message });
    if (isDup) return res.json({ ok: true, deduped: true, message: "Duplicate request ignored" });

    db.get(
      'SELECT * FROM pallets WHERE (id = ? OR product_id = ?) AND status = "active"',
      [id, id],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Pallet not found" });
        if (!isCustomerAllowedForUser(req, row.customer_name)) {
          return res.status(403).json({ error: "Customer outside your scope" });
        }

        checkRecentDuplicateAction(
          { palletId: row.id, action: "CHECK_OUT", location: row.location, quantityChanged: Number(row.pallet_quantity) || 0 },
          (recentErr, isRecentDup) => {
            if (recentErr) return res.status(500).json({ error: recentErr.message });
            if (isRecentDup) return res.json({ ok: true, deduped: true, message: "Duplicate check-out ignored" });

            db.run(
              'UPDATE pallets SET status = "removed", date_removed = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ? AND version = ?',
              [row.id, Number(row.version) || 0],
              function onCheckout(err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) {
                  return res.status(409).json({ error: "Pallet was updated by another user. Refresh and retry." });
                }

                db.run("UPDATE locations SET is_occupied = 0 WHERE id = ?", [row.location]);

                db.run(
                  "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, location, notes, scanned_by, actor_id, client_session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                  [
                    row.id,
                    row.customer_name,
                    row.product_id,
                    "CHECK_OUT",
                    row.pallet_quantity,
                    row.pallet_quantity,
                    row.location,
                    "Full pallet removed",
                    audit.scannedBy,
                    audit.actorId,
                    audit.clientSessionId,
                    audit.idempotencyKey || null,
                  ]
                );

                res.json({ message: "Pallet checked out successfully" });

                broadcastInventoryChange("delete_pallet", {
                  customer_name: row.customer_name,
                  product_id: row.product_id,
                  location: row.location,
                  scanned_by: audit.scannedBy,
                });
              }
            );
          }
        );
      }
    );
  });
});

// Locations
app.get("/api/locations", (req, res) => {
  db.all("SELECT * FROM locations ORDER BY aisle, rack, level", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Stats
app.get("/api/stats", (req, res) => {
  const { customer } = req.query;
  const scopedCustomers = getScopedCustomers(req);
  const scoped = applyCustomerScope({ requestedCustomer: customer, scopedCustomers });
  if (scoped === "__FORBIDDEN_SCOPE__") {
    return res.json({ total_pallets: 0, occupied_locations: 0, total_locations: 0 });
  }

  let palletQuery = 'SELECT COUNT(*) as total_pallets FROM pallets WHERE status = "active"';
  let params = [];

  if (Array.isArray(scoped)) {
    palletQuery += ` AND customer_name IN (${scoped.map(() => "?").join(",")})`;
    params.push(...scoped);
  } else if (scoped) {
    palletQuery += " AND customer_name = ?";
    params.push(scoped);
  }

  db.get(palletQuery, params, (err, palletRow) => {
    if (err) return res.status(500).json({ error: err.message });

    db.get(
      `SELECT 
        (SELECT COUNT(*) FROM locations WHERE is_occupied = 1) as occupied_locations,
        (SELECT COUNT(*) FROM locations) as total_locations`,
      (err, locationRow) => {
        if (err) return res.status(500).json({ error: err.message });

        res.json({
          total_pallets: palletRow.total_pallets,
          occupied_locations: locationRow.occupied_locations,
          total_locations: locationRow.total_locations,
        });
      }
    );
  });
});

// Activity log
app.get("/api/activity", (req, res) => {
  const { customer, limit } = req.query;
  const scopedCustomers = getScopedCustomers(req);
  const scoped = applyCustomerScope({ requestedCustomer: customer, scopedCustomers });
  if (scoped === "__FORBIDDEN_SCOPE__") return res.json([]);

  let query = "SELECT * FROM activity_log";
  let params = [];

  if (Array.isArray(scoped)) {
    query += ` WHERE customer_name IN (${scoped.map(() => "?").join(",")})`;
    params.push(...scoped);
  } else if (scoped) {
    query += " WHERE customer_name = ?";
    params.push(scoped);
  }

  query += " ORDER BY timestamp DESC";

  if (limit) {
    query += " LIMIT ?";
    params.push(parseInt(limit));
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Per-pallet activity timeline for Info modal
app.get("/api/pallets/:id/history", (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "Invalid pallet id" });

  db.get("SELECT customer_name FROM pallets WHERE id = ? LIMIT 1", [id], (pErr, pRow) => {
    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!pRow) return res.status(404).json({ error: "Pallet not found" });
    if (!isCustomerAllowedForUser(req, pRow.customer_name)) {
      return res.status(403).json({ error: "Customer outside your scope" });
    }

    db.all(
      `SELECT id, pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, quantity_after, location, notes, scanned_by, actor_id, timestamp
       FROM activity_log
       WHERE pallet_id = ?
       ORDER BY datetime(timestamp) DESC
       LIMIT 200`,
      [id],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        return res.json(rows || []);
      }
    );
  });
});

// Export to CSV
app.get("/api/export", (req, res) => {
  const { customer } = req.query;
  const scopedCustomers = getScopedCustomers(req);
  const scoped = applyCustomerScope({ requestedCustomer: customer, scopedCustomers });
  if (scoped === "__FORBIDDEN_SCOPE__") return res.send("Customer,Product ID,Pallet Qty,Product Qty,Location,Date Added");

  let query = 'SELECT * FROM pallets WHERE status = "active"';
  let params = [];

  if (Array.isArray(scoped)) {
    query += ` AND customer_name IN (${scoped.map(() => "?").join(",")})`;
    params.push(...scoped);
  } else if (scoped) {
    query += " AND customer_name = ?";
    params.push(scoped);
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const csv = ["Customer,Product ID,Pallet Qty,Product Qty,Location,Date Added"]
      .concat(
        rows.map(
          (p) =>
            `${p.customer_name},${p.product_id},${p.pallet_quantity},${p.product_quantity},${p.location},${p.date_added}`
        )
      )
      .join("\n");

    res.header("Content-Type", "text/csv");
    res.attachment("inventory.csv");
    res.send(csv);
  });
});

// Customers
app.get("/api/customers", (req, res) => {
  const scopedCustomers = getScopedCustomers(req);
  if (Array.isArray(scopedCustomers)) return res.json(scopedCustomers);
  db.all('SELECT DISTINCT customer_name FROM pallets WHERE status = "active" ORDER BY customer_name', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map((r) => r.customer_name));
  });
});

app.get("/api/settings", (req, res) => {
  const settings = readServerSettings();
  res.json({
    googleSheetsUrl: settings.googleSheetsUrl || settings.appsScriptUrl || "",
    appsScriptUrl: settings.appsScriptUrl || settings.googleSheetsUrl || "",
    companyName: String(settings.companyName || "Warehouse Tracker"),
    appTagline: String(settings.appTagline || "Live inventory • PWA"),
    logoUrl: String(settings.logoUrl || ""),
    accentColor: String(settings.accentColor || "#3b82f6"),
    authDisabled: Number(settings.authDisabled || 0),
    autoSheetsSyncEnabled: Number(settings.autoSheetsSyncEnabled || 0),
    autoSheetsSyncMinutes: Math.max(1, Math.min(1440, Number(settings.autoSheetsSyncMinutes) || 15)),
    autoSheetsSyncState: sheetsAutoSyncState,
  });
});

app.post("/api/settings/google-sheets", requireAdminRole, (req, res) => {
  const urlRaw = String(req.body?.url || "").trim();
  if (urlRaw && !/^https:\/\//i.test(urlRaw)) {
    return res.status(400).json({ error: "Google Sheets URL must start with https://" });
  }

  const settings = readServerSettings();
  const next = {
    ...settings,
    googleSheetsUrl: urlRaw,
    appsScriptUrl: urlRaw,
  };

  try {
    writeServerSettings(next);
    return res.json({ ok: true, googleSheetsUrl: urlRaw, appsScriptUrl: urlRaw });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unable to save Google Sheets URL" });
  }
});

app.post("/api/settings/branding", requireAdminRole, (req, res) => {
  const companyName = String(req.body?.companyName || "").trim() || "Warehouse Tracker";
  const appTagline = String(req.body?.appTagline || "").trim() || "Live inventory • PWA";
  const logoUrl = String(req.body?.logoUrl || "").trim();
  const accentColorRaw = String(req.body?.accentColor || "").trim();
  const accentColor = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(accentColorRaw) ? accentColorRaw : "#3b82f6";

  const settings = readServerSettings();
  const next = {
    ...settings,
    companyName,
    appTagline,
    logoUrl,
    accentColor,
  };

  try {
    writeServerSettings(next);
    return res.json({ ok: true, companyName, appTagline, logoUrl, accentColor });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unable to save branding settings" });
  }
});

app.post("/api/settings/sheets-auto", requireAdminRole, (req, res) => {
  const enabled = Number(req.body?.enabled || 0) ? 1 : 0;
  const minutes = Math.max(1, Math.min(1440, Number(req.body?.minutes) || 15));

  const settings = readServerSettings();
  const next = {
    ...settings,
    autoSheetsSyncEnabled: enabled,
    autoSheetsSyncMinutes: minutes,
  };

  try {
    writeServerSettings(next);
    configureSheetsAutoSyncFromSettings();
    return res.json({
      ok: true,
      autoSheetsSyncEnabled: enabled,
      autoSheetsSyncMinutes: minutes,
      autoSheetsSyncState: sheetsAutoSyncState,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unable to save settings" });
  }
});

app.post("/api/sheets/test", async (req, res) => {
  const settings = readServerSettings();
  const url = String(settings.googleSheetsUrl || settings.appsScriptUrl || "").trim();
  if (!url) {
    return res.status(400).json({ error: "Google Sheets URL not configured in server-settings.json" });
  }

  try {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      return res.status(502).json({ error: `Sheets endpoint responded ${response.status}` });
    }
    return res.json({ ok: true, message: "Google Sheets endpoint reachable" });
  } catch (err) {
    return res.status(502).json({ error: err.message || "Failed to reach Google Sheets endpoint" });
  }
});

app.post("/api/sheets/sync", async (req, res) => {
  try {
    await triggerSheetsSyncInternal("manual-sync");
    return res.json({ ok: true, message: "Sync request sent to Google Sheets" });
  } catch (err) {
    return res.status(502).json({ error: err.message || "Failed to call Google Sheets sync endpoint" });
  }
});

// -----------------------------
// Invoicing (v2) - weekly billing with customer rates + handling fees
// -----------------------------
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS customer_rates (
    customer_name TEXT PRIMARY KEY,
    rate_per_pallet_week REAL NOT NULL DEFAULT 0,
    handling_fee_flat REAL NOT NULL DEFAULT 0,
    handling_fee_per_pallet REAL NOT NULL DEFAULT 0,
    payment_terms_days INTEGER NOT NULL DEFAULT 7,
    currency TEXT NOT NULL DEFAULT 'GBP',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.all("PRAGMA table_info(customer_rates)", (err, columns) => {
    if (err || !columns) return;
    const hasWeekRate = columns.some((c) => c.name === "rate_per_pallet_week");
    const hasDayRate = columns.some((c) => c.name === "rate_per_pallet_day");
    const hasHandlingFlat = columns.some((c) => c.name === "handling_fee_flat");
    const hasHandlingPerPallet = columns.some((c) => c.name === "handling_fee_per_pallet");
    const hasPaymentTermsDays = columns.some((c) => c.name === "payment_terms_days");
    const hasCurrency = columns.some((c) => c.name === "currency");

    if (!hasWeekRate) {
      db.run("ALTER TABLE customer_rates ADD COLUMN rate_per_pallet_week REAL NOT NULL DEFAULT 0");
      if (hasDayRate) {
        db.run("UPDATE customer_rates SET rate_per_pallet_week = rate_per_pallet_day * 7 WHERE rate_per_pallet_week = 0");
      }
    }
    if (!hasHandlingFlat) db.run("ALTER TABLE customer_rates ADD COLUMN handling_fee_flat REAL NOT NULL DEFAULT 0");
    if (!hasHandlingPerPallet) db.run("ALTER TABLE customer_rates ADD COLUMN handling_fee_per_pallet REAL NOT NULL DEFAULT 0");
    if (!hasPaymentTermsDays) db.run("ALTER TABLE customer_rates ADD COLUMN payment_terms_days INTEGER NOT NULL DEFAULT 7");
    if (!hasCurrency) db.run("ALTER TABLE customer_rates ADD COLUMN currency TEXT NOT NULL DEFAULT 'GBP'");
  });

  db.run(`CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    billing_cycle TEXT NOT NULL DEFAULT 'WEEKLY',
    pallet_days INTEGER NOT NULL,
    rate_per_pallet_day REAL NOT NULL DEFAULT 0,
    rate_per_pallet_week REAL NOT NULL DEFAULT 0,
    handling_fee_flat REAL NOT NULL DEFAULT 0,
    handling_fee_per_pallet REAL NOT NULL DEFAULT 0,
    handled_pallets INTEGER NOT NULL DEFAULT 0,
    base_total REAL NOT NULL DEFAULT 0,
    handling_total REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'GBP',
    payment_terms_days INTEGER NOT NULL DEFAULT 7,
    due_date TEXT,
    amount_paid REAL NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'UNPAID',
    payments_json TEXT,
    last_payment_at TEXT,
    details_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.all("PRAGMA table_info(invoices)", (err, columns) => {
    if (err || !columns) return;
    const has = (name) => columns.some((c) => c.name === name);
    if (!has("billing_cycle")) db.run("ALTER TABLE invoices ADD COLUMN billing_cycle TEXT NOT NULL DEFAULT 'WEEKLY'");
    if (!has("rate_per_pallet_week")) db.run("ALTER TABLE invoices ADD COLUMN rate_per_pallet_week REAL NOT NULL DEFAULT 0");
    if (!has("handling_fee_flat")) db.run("ALTER TABLE invoices ADD COLUMN handling_fee_flat REAL NOT NULL DEFAULT 0");
    if (!has("handling_fee_per_pallet")) db.run("ALTER TABLE invoices ADD COLUMN handling_fee_per_pallet REAL NOT NULL DEFAULT 0");
    if (!has("handled_pallets")) db.run("ALTER TABLE invoices ADD COLUMN handled_pallets INTEGER NOT NULL DEFAULT 0");
    if (!has("base_total")) db.run("ALTER TABLE invoices ADD COLUMN base_total REAL NOT NULL DEFAULT 0");
    if (!has("handling_total")) db.run("ALTER TABLE invoices ADD COLUMN handling_total REAL NOT NULL DEFAULT 0");
    if (!has("currency")) db.run("ALTER TABLE invoices ADD COLUMN currency TEXT NOT NULL DEFAULT 'GBP'");
    if (!has("payment_terms_days")) db.run("ALTER TABLE invoices ADD COLUMN payment_terms_days INTEGER NOT NULL DEFAULT 7");
    if (!has("due_date")) db.run("ALTER TABLE invoices ADD COLUMN due_date TEXT");
    if (!has("amount_paid")) db.run("ALTER TABLE invoices ADD COLUMN amount_paid REAL NOT NULL DEFAULT 0");
    if (!has("payment_status")) db.run("ALTER TABLE invoices ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'UNPAID'");
    if (!has("payments_json")) db.run("ALTER TABLE invoices ADD COLUMN payments_json TEXT");
    if (!has("last_payment_at")) db.run("ALTER TABLE invoices ADD COLUMN last_payment_at TEXT");
    if (!has("details_json")) db.run("ALTER TABLE invoices ADD COLUMN details_json TEXT");
    if (!has("status")) db.run("ALTER TABLE invoices ADD COLUMN status TEXT NOT NULL DEFAULT 'DRAFT'");
    if (!has("sent_at")) db.run("ALTER TABLE invoices ADD COLUMN sent_at TEXT");
    if (!has("paid_at")) db.run("ALTER TABLE invoices ADD COLUMN paid_at TEXT");
  });
});

function parseYmdToUtcDate(ymd) {
  const s = String(ymd || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function formatYmdUtc(dateObj) {
  return new Date(dateObj).toISOString().slice(0, 10);
}

function addDaysYmd(ymd, daysToAdd) {
  const d = parseYmdToUtcDate(ymd);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + daysToAdd);
  return formatYmdUtc(d);
}

function endOfDayIso(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59)).toISOString();
}

function calculateInvoiceMetrics(customerName, startDate, endDate, done) {
  const start = parseYmdToUtcDate(startDate);
  const end = parseYmdToUtcDate(endDate);
  if (!start || !end || end < start) return done(new Error("Invalid date range"));

  db.all(
    `SELECT pallet_id, action, quantity_after, timestamp
     FROM activity_log
     WHERE customer_name = ?
       AND datetime(timestamp) <= datetime(?)
     ORDER BY datetime(timestamp) ASC`,
    [customerName, `${endDate}T23:59:59Z`],
    (err, rows) => {
      if (err) return done(err);

      const state = new Map();
      let idx = 0;
      const dayMs = 24 * 60 * 60 * 1000;
      const days = Math.floor((end - start) / dayMs) + 1;
      let palletDays = 0;

      for (let di = 0; di < days; di++) {
        const day = new Date(start.getTime() + di * dayMs);
        const cutoff = endOfDayIso(day);

        while (idx < rows.length && new Date(rows[idx].timestamp).toISOString() <= cutoff) {
          const r = rows[idx];
          const qty = Number(r.quantity_after) || 0;

          if (r.action === "CHECK_IN") state.set(r.pallet_id, qty);
          else if (r.action === "CHECK_OUT") state.delete(r.pallet_id);
          else if (r.action === "PARTIAL_REMOVE") (qty > 0 ? state.set(r.pallet_id, qty) : state.delete(r.pallet_id));

          idx++;
        }

        let occ = 0;
        for (const q of state.values()) occ += (Number(q) || 0);
        palletDays += occ;
      }

      db.get(
        `SELECT COALESCE(SUM(quantity_changed), 0) AS handled
         FROM activity_log
         WHERE customer_name = ?
           AND action = 'CHECK_IN'
           AND datetime(timestamp) >= datetime(?)
           AND datetime(timestamp) <= datetime(?)`,
        [customerName, `${startDate}T00:00:00Z`, `${endDate}T23:59:59Z`],
        (err2, row2) => {
          if (err2) return done(err2);
          return done(null, {
            pallet_days: palletDays,
            days_in_range: days,
            handled_pallets: Number(row2?.handled || 0),
            pallet_weeks: palletDays / 7,
          });
        }
      );
    }
  );
}

function buildInvoicePreview(input, done) {
  const customerName = String(input?.customer_name || "").trim();
  const startDate = String(input?.start_date || "").trim();
  const endDate = String(input?.end_date || "").trim();
  const rateOverrideRaw = input?.rate_per_pallet_week;
  const handlingFlatOverrideRaw = input?.handling_fee_flat;
  const handlingPerPalletOverrideRaw = input?.handling_fee_per_pallet;
  const paymentTermsOverrideRaw = input?.payment_terms_days;

  const rateOverride = Number(rateOverrideRaw);
  const handlingFlatOverride = Number(handlingFlatOverrideRaw);
  const handlingPerPalletOverride = Number(handlingPerPalletOverrideRaw);
  const paymentTermsOverride = Number(paymentTermsOverrideRaw);

  if (!customerName || !startDate || !endDate) {
    return done(new Error("customer_name, start_date, end_date are required"));
  }

  calculateInvoiceMetrics(customerName, startDate, endDate, (err, metrics) => {
    if (err) return done(err);

    db.get("SELECT * FROM customer_rates WHERE customer_name = ?", [customerName], (rateErr, rateRow) => {
      if (rateErr) return done(rateErr);

      const hasRateOverride = rateOverrideRaw !== undefined && rateOverrideRaw !== null && rateOverrideRaw !== "";
      const hasFlatOverride = handlingFlatOverrideRaw !== undefined && handlingFlatOverrideRaw !== null && handlingFlatOverrideRaw !== "";
      const hasPerPalletOverride = handlingPerPalletOverrideRaw !== undefined && handlingPerPalletOverrideRaw !== null && handlingPerPalletOverrideRaw !== "";
      const hasTermsOverride = paymentTermsOverrideRaw !== undefined && paymentTermsOverrideRaw !== null && paymentTermsOverrideRaw !== "";

      const ratePerWeek = hasRateOverride ? rateOverride : Number(rateRow?.rate_per_pallet_week || 0);
      const handlingFlat = hasFlatOverride ? handlingFlatOverride : Number(rateRow?.handling_fee_flat || 0);
      const handlingPerPallet = hasPerPalletOverride ? handlingPerPalletOverride : Number(rateRow?.handling_fee_per_pallet || 0);
      const paymentTermsDays = hasTermsOverride ? paymentTermsOverride : Number(rateRow?.payment_terms_days ?? 7);
      const currency = String(rateRow?.currency || "GBP");

      if (!Number.isFinite(ratePerWeek) || ratePerWeek < 0) {
        return done(new Error("No valid customer weekly rate found. Set /api/rates first or pass rate_per_pallet_week."));
      }
      if (!Number.isFinite(handlingFlat) || handlingFlat < 0) {
        return done(new Error("handling_fee_flat must be a valid number >= 0"));
      }
      if (!Number.isFinite(handlingPerPallet) || handlingPerPallet < 0) {
        return done(new Error("handling_fee_per_pallet must be a valid number >= 0"));
      }
      if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 365) {
        return done(new Error("payment_terms_days must be an integer between 0 and 365"));
      }

      const baseTotal = Number((metrics.pallet_weeks * ratePerWeek).toFixed(2));
      const handlingTotal = Number((handlingFlat + (handlingPerPallet * metrics.handled_pallets)).toFixed(2));
      const grandTotal = Number((baseTotal + handlingTotal).toFixed(2));
      const dueDate = addDaysYmd(endDate, paymentTermsDays);

      return done(null, {
        ok: true,
        billing_cycle: "WEEKLY",
        customer_name: customerName,
        start_date: startDate,
        end_date: endDate,
        days_in_range: metrics.days_in_range,
        pallet_days: metrics.pallet_days,
        pallet_weeks: Number(metrics.pallet_weeks.toFixed(4)),
        handled_pallets: metrics.handled_pallets,
        rate_per_pallet_week: ratePerWeek,
        handling_fee_flat: handlingFlat,
        handling_fee_per_pallet: handlingPerPallet,
        payment_terms_days: paymentTermsDays,
        due_date: dueDate,
        currency,
        base_total: baseTotal,
        handling_total: handlingTotal,
        total: grandTotal,
      });
    });
  });
}

app.get("/api/rates", (req, res) => {
  const customer = String(req.query.customer || "").trim();
  const scopedCustomers = getScopedCustomers(req);
  const scoped = applyCustomerScope({ requestedCustomer: customer, scopedCustomers });
  if (scoped === "__FORBIDDEN_SCOPE__") return res.status(404).json({ error: "Rate not found" });
  if (customer) {
    db.get("SELECT * FROM customer_rates WHERE customer_name = ?", [scoped], (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(404).json({ error: "Rate not found" });
      return res.json(row);
    });
    return;
  }
  const sql = Array.isArray(scopedCustomers)
    ? `SELECT * FROM customer_rates WHERE customer_name IN (${scopedCustomers.map(() => "?").join(",")}) ORDER BY customer_name ASC`
    : "SELECT * FROM customer_rates ORDER BY customer_name ASC";
  db.all(sql, Array.isArray(scopedCustomers) ? scopedCustomers : [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    res.json(rows || []);
  });
});

app.post("/api/rates", requireWriteRole, (req, res) => {
  const customerName = String(req.body?.customer_name || "").trim();
  const ratePerWeek = Number(req.body?.rate_per_pallet_week);
  const handlingFlat = Number(req.body?.handling_fee_flat || 0);
  const handlingPerPallet = Number(req.body?.handling_fee_per_pallet || 0);
  const paymentTermsDays = Number(req.body?.payment_terms_days ?? 7);
  const currency = String(req.body?.currency || "GBP").trim() || "GBP";

  if (!customerName || !Number.isFinite(ratePerWeek) || ratePerWeek < 0) {
    return res.status(400).json({ error: "customer_name and valid rate_per_pallet_week are required" });
  }
  if (!isCustomerAllowedForUser(req, customerName)) {
    return res.status(403).json({ error: "Customer outside your scope" });
  }
  if (!Number.isFinite(handlingFlat) || handlingFlat < 0) {
    return res.status(400).json({ error: "handling_fee_flat must be a valid number >= 0" });
  }
  if (!Number.isFinite(handlingPerPallet) || handlingPerPallet < 0) {
    return res.status(400).json({ error: "handling_fee_per_pallet must be a valid number >= 0" });
  }
  if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 365) {
    return res.status(400).json({ error: "payment_terms_days must be an integer between 0 and 365" });
  }

  db.run(
    `INSERT INTO customer_rates (customer_name, rate_per_pallet_week, handling_fee_flat, handling_fee_per_pallet, payment_terms_days, currency, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(customer_name) DO UPDATE SET
       rate_per_pallet_week = excluded.rate_per_pallet_week,
       handling_fee_flat = excluded.handling_fee_flat,
       handling_fee_per_pallet = excluded.handling_fee_per_pallet,
       payment_terms_days = excluded.payment_terms_days,
       currency = excluded.currency,
       updated_at = datetime('now')`,
    [customerName, ratePerWeek, handlingFlat, handlingPerPallet, paymentTermsDays, currency],
    (err) => {
      if (err) return res.status(500).json({ error: "DB error" });
      db.get("SELECT * FROM customer_rates WHERE customer_name = ?", [customerName], (err2, row) => {
        if (err2) return res.status(500).json({ error: "DB error" });
        res.json({ ok: true, rate: row });
      });
    }
  );
});

app.get("/api/invoices", (req, res) => {
  const customer = String(req.query.customer || "").trim();
  const scopedCustomers = getScopedCustomers(req);
  const scoped = applyCustomerScope({ requestedCustomer: customer, scopedCustomers });
  if (scoped === "__FORBIDDEN_SCOPE__") return res.json([]);

  let sql = "SELECT * FROM invoices";
  const params = [];
  if (Array.isArray(scoped)) {
    sql += ` WHERE customer_name IN (${scoped.map(() => "?").join(",")})`;
    params.push(...scoped);
  } else if (scoped) {
    sql += " WHERE customer_name = ?";
    params.push(scoped);
  }
  sql += " ORDER BY id DESC LIMIT 200";

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    res.json(rows || []);
  });
});

app.get("/api/invoices/aging", (req, res) => {
  const scopedCustomers = getScopedCustomers(req);
  const sql = Array.isArray(scopedCustomers)
    ? `SELECT * FROM invoices WHERE customer_name IN (${scopedCustomers.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1000`
    : "SELECT * FROM invoices ORDER BY id DESC LIMIT 1000";
  db.all(sql, Array.isArray(scopedCustomers) ? scopedCustomers : [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });

    const today = new Date();
    const todayUtcStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const buckets = {
      current: { count: 0, amount: 0 },
      d1_30: { count: 0, amount: 0 },
      d31_60: { count: 0, amount: 0 },
      d61_plus: { count: 0, amount: 0 },
    };

    for (const inv of rows || []) {
      const total = Number(inv.total || 0);
      const paid = Number(inv.amount_paid || 0);
      const balance = Number((total - paid).toFixed(2));
      const status = String(inv.status || "").toUpperCase();
      if (balance <= 0 || status === "PAID") continue;

      const due = String(inv.due_date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
        buckets.current.count += 1;
        buckets.current.amount = Number((buckets.current.amount + balance).toFixed(2));
        continue;
      }

      const dueMs = Date.parse(`${due}T00:00:00Z`);
      if (!Number.isFinite(dueMs) || dueMs >= todayUtcStart) {
        buckets.current.count += 1;
        buckets.current.amount = Number((buckets.current.amount + balance).toFixed(2));
        continue;
      }

      const days = Math.floor((todayUtcStart - dueMs) / (24 * 60 * 60 * 1000));
      if (days <= 30) {
        buckets.d1_30.count += 1;
        buckets.d1_30.amount = Number((buckets.d1_30.amount + balance).toFixed(2));
      } else if (days <= 60) {
        buckets.d31_60.count += 1;
        buckets.d31_60.amount = Number((buckets.d31_60.amount + balance).toFixed(2));
      } else {
        buckets.d61_plus.count += 1;
        buckets.d61_plus.amount = Number((buckets.d61_plus.amount + balance).toFixed(2));
      }
    }

    const total_outstanding = Number(
      (buckets.current.amount + buckets.d1_30.amount + buckets.d31_60.amount + buckets.d61_plus.amount).toFixed(2)
    );
    const total_count = buckets.current.count + buckets.d1_30.count + buckets.d31_60.count + buckets.d61_plus.count;

    return res.json({ ok: true, buckets, total_outstanding, total_count });
  });
});

app.post("/api/invoices/preview", (req, res) => {
  const customerName = String(req.body?.customer_name || "").trim();
  if (customerName && !isCustomerAllowedForUser(req, customerName)) {
    return res.status(403).json({ error: "Customer outside your scope" });
  }
  buildInvoicePreview(req.body || {}, (err, preview) => {
    if (err) return res.status(400).json({ error: err.message || "Invalid invoice inputs" });
    res.json(preview);
  });
});

app.post("/api/invoices/generate", requireWriteRole, (req, res) => {
  const customerName = String(req.body?.customer_name || "").trim();
  let startDate = String(req.body?.start_date || "").trim();
  let endDate = String(req.body?.end_date || "").trim();

  if (!startDate && req.body?.week_start) {
    startDate = String(req.body.week_start).trim();
    endDate = addDaysYmd(startDate, 6) || "";
  }

  if (!customerName || !startDate || !endDate) {
    return res.status(400).json({ error: "customer_name and either (start_date + end_date) or week_start are required" });
  }
  if (!isCustomerAllowedForUser(req, customerName)) {
    return res.status(403).json({ error: "Customer outside your scope" });
  }

  const previewInput = {
    customer_name: customerName,
    start_date: startDate,
    end_date: endDate,
    rate_per_pallet_week: req.body?.rate_per_pallet_week,
    handling_fee_flat: req.body?.handling_fee_flat,
    handling_fee_per_pallet: req.body?.handling_fee_per_pallet,
    payment_terms_days: req.body?.payment_terms_days,
  };

  buildInvoicePreview(previewInput, (previewErr, preview) => {
    if (previewErr) return res.status(400).json({ error: previewErr.message || "Invalid invoice inputs" });

    const detailsJson = JSON.stringify({
      days_in_range: preview.days_in_range,
      pallet_weeks: preview.pallet_weeks,
      handled_pallets: preview.handled_pallets,
    });

    db.run(
      `INSERT INTO invoices (
          customer_name, start_date, end_date, billing_cycle, pallet_days,
          rate_per_pallet_day, rate_per_pallet_week,
          handling_fee_flat, handling_fee_per_pallet, handled_pallets,
          base_total, handling_total, total, currency, payment_terms_days, due_date, details_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        preview.customer_name,
        preview.start_date,
        preview.end_date,
        "WEEKLY",
        preview.pallet_days,
        Number((preview.rate_per_pallet_week / 7).toFixed(6)),
        preview.rate_per_pallet_week,
        preview.handling_fee_flat,
        preview.handling_fee_per_pallet,
        preview.handled_pallets,
        preview.base_total,
        preview.handling_total,
        preview.total,
        preview.currency || "GBP",
        preview.payment_terms_days,
        preview.due_date,
        detailsJson,
        "DRAFT",
      ],
      function insertInvoice(err) {
        if (err) return res.status(500).json({ error: "DB error" });
        res.json({
          ok: true,
          invoice_id: this.lastID,
          ...preview,
        });
      }
    );
  });
});

app.post("/api/invoices/:id/status", requireWriteRole, (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || "").trim().toUpperCase();
  const allowed = new Set(["DRAFT", "SENT", "PAID"]);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid invoice id" });
  }
  if (!allowed.has(status)) {
    return res.status(400).json({ error: "status must be one of DRAFT, SENT, PAID" });
  }

  db.get("SELECT * FROM invoices WHERE id = ?", [id], (getErr, current) => {
    if (getErr) return res.status(500).json({ error: "DB error" });
    if (!current) return res.status(404).json({ error: "Invoice not found" });
    if (!isCustomerAllowedForUser(req, current.customer_name)) {
      return res.status(403).json({ error: "Customer outside your scope" });
    }

    const nowIso = new Date().toISOString();
    let sentAt = current.sent_at || null;
    let paidAt = current.paid_at || null;

    if (status === "DRAFT") {
      sentAt = null;
      paidAt = null;
    } else if (status === "SENT") {
      sentAt = sentAt || nowIso;
      paidAt = null;
    } else if (status === "PAID") {
      sentAt = sentAt || nowIso;
      paidAt = nowIso;
    }

    db.run(
      `UPDATE invoices
       SET status = ?, sent_at = ?, paid_at = ?
       WHERE id = ?`,
      [status, sentAt, paidAt, id],
      function onStatusUpdated(err) {
        if (err) return res.status(500).json({ error: "DB error" });
        if (this.changes === 0) return res.status(404).json({ error: "Invoice not found" });

        db.get("SELECT * FROM invoices WHERE id = ?", [id], (err2, row) => {
          if (err2) return res.status(500).json({ error: "DB error" });
          return res.json({ ok: true, invoice: row });
        });
      }
    );
  });
});

app.post("/api/invoices/:id/payments", requireWriteRole, (req, res) => {
  const id = Number(req.params.id);
  const amount = Number(req.body?.amount);
  const note = String(req.body?.note || "").trim();
  const paidAt = String(req.body?.paid_at || "").trim() || new Date().toISOString();

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid invoice id" });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "amount must be > 0" });
  }

  db.get("SELECT * FROM invoices WHERE id = ?", [id], (getErr, inv) => {
    if (getErr) return res.status(500).json({ error: "DB error" });
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (!isCustomerAllowedForUser(req, inv.customer_name)) {
      return res.status(403).json({ error: "Customer outside your scope" });
    }

    const total = Number(inv.total || 0);
    const currentPaid = Number(inv.amount_paid || 0);
    const nextPaid = Number((currentPaid + amount).toFixed(2));
    const balance = Number((total - nextPaid).toFixed(2));

    let payments = [];
    try {
      const parsed = JSON.parse(inv.payments_json || "[]");
      payments = Array.isArray(parsed) ? parsed : [];
    } catch {
      payments = [];
    }
    payments.push({
      amount: Number(amount.toFixed(2)),
      note,
      paid_at: paidAt,
    });

    const paymentStatus = balance <= 0 ? "PAID" : "PARTIAL";
    const nextInvoiceStatus = balance <= 0 ? "PAID" : (String(inv.status || "").toUpperCase() === "DRAFT" ? "SENT" : String(inv.status || "").toUpperCase() || "SENT");
    const paidFullAt = balance <= 0 ? paidAt : null;
    const sentAt = inv.sent_at || paidAt;

    db.run(
      `UPDATE invoices
       SET amount_paid = ?, payment_status = ?, payments_json = ?, last_payment_at = ?,
           status = ?, sent_at = ?, paid_at = ?
       WHERE id = ?`,
      [
        nextPaid,
        paymentStatus,
        JSON.stringify(payments),
        paidAt,
        nextInvoiceStatus,
        sentAt,
        paidFullAt,
        id,
      ],
      function onPaid(updateErr) {
        if (updateErr) return res.status(500).json({ error: "DB error" });
        if (this.changes === 0) return res.status(404).json({ error: "Invoice not found" });

        db.get("SELECT * FROM invoices WHERE id = ?", [id], (err2, row) => {
          if (err2) return res.status(500).json({ error: "DB error" });
          return res.json({
            ok: true,
            invoice: row,
            payment: { amount: Number(amount.toFixed(2)), note, paid_at: paidAt },
            balance_due: Number((Number(row.total || 0) - Number(row.amount_paid || 0)).toFixed(2)),
          });
        });
      }
    );
  });
});

// Local IP helper
function getLocalIPs() {
  const { networkInterfaces } = require("os");
  const nets = networkInterfaces();
  const results = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) results.push(net.address);
    }
  }
  return results;
}

// Redirect HTTP -> HTTPS if SSL exists
if (useLocalSSL) {
  app.use((req, res, next) => {
    if (!req.secure) {
      const host = req.headers.host ? req.headers.host.split(":")[0] : req.hostname;
      return res.redirect(301, `https://${host}:${HTTPS_PORT}${req.originalUrl}`);
    }
    next();
  });
}

// Start servers
configureSheetsAutoSyncFromSettings();

if (useLocalSSL) {
httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
    console.log("\n🔒 HTTPS Warehouse Server Running (with WebSocket)!");
    console.log(`\n📱 Secure access (recommended):`);
    console.log(`   Local: https://localhost:${HTTPS_PORT}`);

    const ips = getLocalIPs();
    ips.forEach((ip) => console.log(`   Network: https://${ip}:${HTTPS_PORT}`));

    console.log("\n✅ Camera scanning works over HTTPS (accept self-signed cert warning if shown).\n");
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP redirect server listening on http://localhost:${PORT} -> HTTPS`);
  });
} else {
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log("\n🚀 Warehouse Server Running (HTTP with WebSocket)!");
    console.log(`\n📱 Access from devices on network:`);
    console.log(`   Local: http://localhost:${PORT}`);

    const ips = getLocalIPs();
    ips.forEach((ip) => console.log(`   Network: http://${ip}:${PORT}`));

    console.log("\n⚠️  HTTPS not enabled - camera features may require HTTPS in some browsers.");
    console.log("   To enable HTTPS, run: npm run generate-ssl\n");
  });
}
