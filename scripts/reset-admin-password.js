#!/usr/bin/env node

const path = require("path");
const crypto = require("crypto");
const sqlite3 = require("sqlite3").verbose();

const root = path.resolve(__dirname, "..");
const dbPath = process.env.WT_DB_PATH || path.join(root, "warehouse.db");
const username = String(process.env.WT_ADMIN_USER || "admin").trim() || "admin";
const password = String(process.env.WT_ADMIN_PASS || "admin123!").trim() || "admin123!";

function makeSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function hashPassword(pass, salt) {
  return crypto.pbkdf2Sync(String(pass || ""), String(salt || ""), 120000, 64, "sha512").toString("hex");
}

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      must_reset_password INTEGER NOT NULL DEFAULT 0
    )`,
    (createErr) => {
      if (createErr) {
        console.error("Failed to ensure users table:", createErr.message || createErr);
        process.exitCode = 1;
        return db.close();
      }

      const salt = makeSalt();
      const hash = hashPassword(password, salt);

      db.get("SELECT id FROM users WHERE username = ?", [username], (selErr, row) => {
        if (selErr) {
          console.error("Failed to query users:", selErr.message || selErr);
          process.exitCode = 1;
          return db.close();
        }

        if (row && row.id) {
          db.run(
            `UPDATE users
             SET password_hash = ?, password_salt = ?, role = 'owner', display_name = 'Site Manager', customer_scope = '*', is_active = 1, must_reset_password = 0
             WHERE id = ?`,
            [hash, salt, row.id],
            (updErr) => {
              if (updErr) {
                console.error("Failed to update admin user:", updErr.message || updErr);
                process.exitCode = 1;
              } else {
                console.log(`Admin credentials reset: ${username} / ${password}`);
              }
              db.close();
            }
          );
        } else {
          db.run(
            `INSERT INTO users (username, password_hash, password_salt, role, display_name, customer_scope, is_active, must_reset_password)
             VALUES (?, ?, ?, 'owner', 'Site Manager', '*', 1, 0)`,
            [username, hash, salt],
            (insErr) => {
              if (insErr) {
                console.error("Failed to create admin user:", insErr.message || insErr);
                process.exitCode = 1;
              } else {
                console.log(`Admin user created: ${username} / ${password}`);
              }
              db.close();
            }
          );
        }
      });
    }
  );
});
