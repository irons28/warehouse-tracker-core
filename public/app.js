/* Warehouse Tracker - Locked Working SaaS UI (single-file app.js)
   - Sidebar layout
   - Modal system (manual entry + generate pallet QR)
   - Pallet QR payload supports autofill (customer/product/units)
   - Location QR generation + print
   - Table tracker view
   - Scanner flow using html5-qrcode
*/
(() => {
  // Prevent double execution (common with SW cache or duplicate script tags)
  if (window.__WT_APP_LOADED__) {
    console.warn("Warehouse Tracker: app.js already loaded (skipping duplicate).");
    return;
  }
  window.__WT_APP_LOADED__ = true;
  window.__WT_APP_BOOT_OK__ = false;

  const API_URL = window.location.origin;

  // --------------------------
  // QR payload helpers (v1)
  // --------------------------
  const WT_QR_PREFIX = "WT|PALLET|v1|";

  function wtBase64UrlEncode(str) {
    const b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  function wtBase64UrlDecode(b64url) {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const txt = atob(b64 + pad);
    return decodeURIComponent(escape(txt));
  }

  function wtMakePalletQrPayload(data) {
    const payload = {
      id: String(data.id || "").trim(),       // required
      c: String(data.customer || "").trim(),  // customer
      p: String(data.productId || "").trim(), // product id
      u: Number(data.unitsPerPallet || 0) || 0, // units/pallet
    };
    return WT_QR_PREFIX + wtBase64UrlEncode(JSON.stringify(payload));
  }

  function wtParsePalletQr(text) {
    if (!text || typeof text !== "string") return null;

    if (text.startsWith(WT_QR_PREFIX)) {
      try {
        const raw = text.slice(WT_QR_PREFIX.length);
        const json = wtBase64UrlDecode(raw);
        const obj = JSON.parse(json);
        if (!obj?.id) return null;
        return {
          id: String(obj.id),
          customer: String(obj.c || ""),
          productId: String(obj.p || ""),
          unitsPerPallet: Number(obj.u || 0) || 0,
          hasUnitsPerPallet: Object.prototype.hasOwnProperty.call(obj, "u"),
          _format: "wt-v1",
        };
      } catch {
        return null;
      }
    }

    // legacy fallback: treat the whole text as pallet id
    return { id: text.trim(), customer: "", productId: "", unitsPerPallet: 0, _format: "legacy" };
  }

  function wtCurrentWeekRange() {
    const now = new Date();
    const utcDay = now.getUTCDay(); // 0=Sun
    const daysFromMonday = (utcDay + 6) % 7;
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    monday.setUTCDate(monday.getUTCDate() - daysFromMonday);
    const sunday = new Date(monday);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    return {
      start: monday.toISOString().slice(0, 10),
      end: sunday.toISOString().slice(0, 10),
    };
  }

  // --------------------------
  // Safe fetch helpers
  // --------------------------
  async function apiFetch(path, opts = {}) {
    const url = path.startsWith("http") ? path : `${API_URL}${path}`;
    let userRole = "ops";
    let actorId = "ops-user";
    let authToken = "";
    try {
      userRole = localStorage.getItem("wt_user_role") || userRole;
      actorId = localStorage.getItem("wt_actor_id") || actorId;
      authToken = localStorage.getItem("wt_auth_token") || "";
    } catch {
      // ignore
    }
    const headers = Object.assign(
      {
        "Content-Type": "application/json",
        "x-user-role": userRole,
        "x-actor-id": actorId,
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      opts.headers || {}
    );

    let res;
    try {
      res = await fetch(url, {
        ...opts,
        headers,
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch (err) {
      const msg = String(err?.message || "").toLowerCase();
      if (msg.includes("load failed") || msg.includes("failed to fetch") || msg.includes("network")) {
        throw new Error("Network connection failed. Check that your tunnel/server is running, then reload.");
      }
      throw err;
    }

    const ct = res.headers.get("content-type") || "";
    const isJson = ct.includes("application/json");

    if (!res.ok) {
      if (res.status === 401) {
        try {
          localStorage.removeItem("wt_auth_token");
        } catch {}
        window.dispatchEvent(new CustomEvent("wt-auth-required"));
      }
      let msg = `${res.status} ${res.statusText}`;
      if (isJson) {
        try {
          const j = await res.json();
          msg = j?.error || j?.message || msg;
        } catch {}
      } else {
        try {
          msg = (await res.text()) || msg;
        } catch {}
      }
      throw new Error(msg);
    }

    if (isJson) return res.json();
    return res.text();
  }

  // --------------------------
  // App
  // --------------------------
  const app = {
    // state
    view: "dashboard",
    sidebarOpen: false,
    mobileMode: false,
    authDisabled: false,

    pallets: [],
    activityLog: [],
    locations: [],
    customers: [],
    stats: {},
    selectedCustomer: "",
    searchTerm: "",

    // scanner
    scanMode: null,            // 'checkin-pallet' | 'checkin-location' | 'checkout' | 'checkout-units' | 'move-pallet' | 'move-location'
    _scannedPallet: null,      // holds pallet QR payload between scans
    scanner: null,
    _scanBusy: false,
    _lastScanText: "",
    _lastScanAt: 0,
    _toastDedup: new Map(),

    // QR views
    tempPallet: null,          // used for single QR view

    // settings
    googleSheetsUrl: "",       // loaded from server (/api/settings) in Option B setups
    autoSheetsSyncEnabled: false,
    autoSheetsSyncMinutes: "15",
    autoSheetsSyncState: null,
    companyName: "Warehouse Tracker",
    appTagline: "Live inventory • PWA",
    logoUrl: "",
    accentColor: "#3b82f6",

    // websocket
    socket: null,
    connState: "is-warn",
    connText: "Connecting…",

    // ui
    lastUpdatedAt: "",
    loading: false,
    trackerDensity: "comfy", // "comfy" | "compact"
    currentUser: null,
    authLoading: true,
    forcePasswordReset: false,
    identityMode: "account",
    operatorName: "",
    actorId: "ops-user",
    clientSessionId: "",
    rates: [],
    invoices: [],
    authUsers: [],
    systemHealth: null,
    latestBackup: null,
    invoiceAging: { buckets: { current: { count: 0, amount: 0 }, d1_30: { count: 0, amount: 0 }, d31_60: { count: 0, amount: 0 }, d61_plus: { count: 0, amount: 0 } }, total_outstanding: 0, total_count: 0 },
    invoicePreview: null,
    invoiceForm: {
      customer_name: "",
      start_date: "",
      end_date: "",
      rate_per_pallet_week: "",
      handling_fee_flat: "0",
      handling_fee_per_pallet: "0",
      payment_terms_days: "7",
      currency: "GBP",
    },
    invoiceFilterCustomer: "",
    invoiceFilterStatus: "",
    locationEditId: "",
    locationEditCapacity: "",
    locationEditFloorArea: "",

    // --------------------------
    // UI: Toasts
    // --------------------------
    showToast(message, type = "info") {
      const container = document.getElementById("toast-container");
      if (!container) return;

      const toast = document.createElement("div");
      toast.className = `toast ${type}`;
      const icon = type === "success" ? "✓" : type === "error" ? "✗" : "ℹ";
      toast.innerHTML = `
        <div style="font-size: 20px; line-height: 1;">${icon}</div>
        <div style="flex:1;">${String(message || "")}</div>
      `;
      while (container.children.length >= 2) {
        container.removeChild(container.firstElementChild);
      }
      container.appendChild(toast);

      setTimeout(() => {
        toast.classList.add("hiding");
        setTimeout(() => toast.remove(), 250);
      }, 2800);
    },

    showToastDedup(message, type = "info", cooldownMs = 1800) {
      const key = `${type}|${String(message || "")}`;
      const now = Date.now();
      const lastAt = Number(this._toastDedup.get(key) || 0);
      if (now - lastAt < cooldownMs) return;
      this._toastDedup.set(key, now);
      this.showToast(message, type);
    },

    // --------------------------
    // UI: Modal (returns {action, fields} or cancelled)
    // --------------------------
    showModal(title, contentHtml, buttons = []) {
  return new Promise((resolve) => {
    const container = document.getElementById("modal-container");
    if (!container) {
      console.error("Missing modal container. Add <div id='modal-container'></div> to index.html");
      resolve({ cancelled: true, action: "cancel", fields: {} });
      return;
    }

    // Clear any existing modal
    container.innerHTML = "";

    const backdrop = document.createElement("div");
    backdrop.className = "wt-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "wt-modal";

    const normalizedButtons = (buttons || []).map((b, i) => {
      const label = b.label ?? b.text ?? `Button ${i + 1}`;
      const value = b.value ?? label;
      const className =
        b.className ??
        (b.primary
          ? "rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700"
          : "rounded-xl bg-slate-100 px-4 py-2 font-semibold text-slate-800 hover:bg-slate-200");
      return { label, value, className };
    });

    modal.innerHTML = `
      <div class="p-6">
        <div class="flex items-start justify-between gap-4">
          <h3 class="text-xl font-bold text-slate-900">${title}</h3>
          <button type="button" class="wt-modal-close" data-modal-x aria-label="Close">✕</button>
        </div>

        <div class="mt-4">${contentHtml}</div>

        <div class="mt-6 flex gap-2 justify-end">
          ${normalizedButtons
            .map(
              (btn, i) => `
              <button type="button" data-modal-btn="${i}" class="${btn.className}">
                ${btn.label}
              </button>`
            )
            .join("")}
        </div>
      </div>
    `;

    const close = (actionValue) => {
      const fields = {};
      modal.querySelectorAll("[data-modal-field]").forEach((el) => {
        const key = el.getAttribute("data-modal-field");
        fields[key] =
          el.type === "checkbox" ? el.checked : (el.value ?? "").toString();
      });

      container.innerHTML = "";
      resolve({
        cancelled: actionValue === "cancel" || actionValue === "Cancel",
        action: actionValue,
        fields,
      });
    };

    // Click handlers
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close("cancel");
    });
    modal.querySelector("[data-modal-x]")?.addEventListener("click", () => close("cancel"));

    modal.querySelectorAll("[data-modal-btn]").forEach((btnEl) => {
      btnEl.addEventListener("click", () => {
        const idx = Number(btnEl.getAttribute("data-modal-btn"));
        const actionValue = normalizedButtons[idx]?.value ?? "ok";
        close(actionValue);
      });
    });

    backdrop.appendChild(modal);
    container.appendChild(backdrop);
  });
},


    // convenience prompts built on showModal
    async prompt(title, message, defaultValue = "") {
      const html = `
        <p class="text-sm text-slate-600 mb-4">${message || ""}</p>
        <input data-modal-field="v" class="w-full rounded-xl border border-slate-300 px-3 py-2" value="${String(defaultValue ?? "")}" />
      `;
      const res = await this.showModal(title, html, [
        { label: "Cancel", value: "cancel" },
        { label: "OK", value: "ok", className: "rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700" },
      ]);
      if (!res || res.cancelled || res.action !== "ok") return null;
      return res.fields?.v ?? "";
    },

    async confirm(title, message) {
      const html = `<p class="text-sm text-slate-700">${message || ""}</p>`;
      const res = await this.showModal(title, html, [
        { label: "No", value: "no" },
        { label: "Yes", value: "yes", className: "rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700" },
      ]);
      return !!(res && !res.cancelled && res.action === "yes");
    },

    async promptMultiline(title, message, defaultValue = "") {
      const html = `
        <p class="text-sm text-slate-600 mb-4">${message || ""}</p>
        <textarea data-modal-field="v" rows="7" class="w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm">${String(defaultValue ?? "")}</textarea>
        <p class="mt-2 text-xs text-slate-500">Example: PART-001 x10 (one per line)</p>
      `;
      const res = await this.showModal(title, html, [
        { label: "Cancel", value: "cancel" },
        { label: "Save", value: "ok", className: "rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700" },
      ]);
      if (!res || res.cancelled || res.action !== "ok") return null;
      return res.fields?.v ?? "";
    },

    parsePartsList(text) {
      const lines = String(text || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      const parts = [];
      for (const line of lines) {
        // accept: "ABC123 x10" OR "ABC123 10" OR "ABC123"
        const m = line.match(/^(.+?)(?:\s*[xX]\s*(\d+))?$/);
        if (!m) continue;
        const part_number = String(m[1] || "").trim();
        const quantity = m[2] ? Number(m[2]) : 1;
        if (!part_number) continue;
        parts.push({ part_number, quantity: Number.isFinite(quantity) ? quantity : 1 });
      }
      return parts;
    },

    // --------------------------
    // Navigation / shell
    // --------------------------
    setView(view) {
      if (this.mobileMode && (view === "history" || view === "settings")) {
        view = "scan";
      }
      this.view = view;
      this.sidebarOpen = false;
      this.scanMode = null;
      this._scannedPallet = null;
      this.render();
    },

    wtToggleSidebar() {
      this.sidebarOpen = !this.sidebarOpen;
      this.render();
    },
    wtCloseSidebar() {
      this.sidebarOpen = false;
      this.render();
    },

    _brandName() {
      return String(this.companyName || "Warehouse Tracker");
    },

    _brandTagline() {
      return String(this.appTagline || "Live inventory • PWA");
    },

    _brandLogoHtml(size = 36) {
      const logo = String(this.logoUrl || "").trim();
      if (logo) {
        return `
          <span style="position:relative;display:inline-grid;place-items:center;width:${size}px;height:${size}px;">
            <img src="${logo}" alt="Company logo"
              style="width:${size}px;height:${size}px;object-fit:contain;border-radius:10px;border:1px solid var(--border);background:#fff;"
              onerror="this.style.display='none'; this.nextElementSibling.style.display='grid';" />
            <span class="wt-brand-emoji" style="display:none;position:absolute;inset:0;">📦</span>
          </span>
        `;
      }
      return `<span class="wt-brand-emoji">📦</span>`;
    },

    applyBrandingTheme() {
      try {
        const color = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(this.accentColor || "").trim())
          ? String(this.accentColor || "").trim()
          : "#3b82f6";
        document.documentElement.style.setProperty("--accent", color);
      } catch {
        // ignore
      }
    },

    _detectMobileMode() {
      const next = typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(max-width: 980px)").matches
        : false;
      const changed = next !== this.mobileMode;
      this.mobileMode = next;
      return changed;
    },

    setTrackerDensity(mode) {
      const next = mode === "compact" ? "compact" : "comfy";
      this.trackerDensity = next;
      try {
        localStorage.setItem("wt_tracker_density", next);
      } catch {
        // ignore
      }
      this.render();
    },

    toggleTrackerDensity() {
      this.setTrackerDensity(this.trackerDensity === "compact" ? "comfy" : "compact");
    },

    renderAuth() {
      return `
        <div class="min-h-screen flex items-center justify-center p-6">
          <div class="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div class="text-sm font-semibold text-slate-600">Phase 3 Access</div>
            <h1 class="mt-1 text-2xl font-extrabold text-slate-900">Sign in</h1>
            <p class="mt-2 text-sm text-slate-600">Use your warehouse tracker account to continue.</p>

            <div class="mt-4 space-y-3">
              <div>
                <label class="text-sm font-semibold text-slate-700">Username</label>
                <input id="auth-username" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" placeholder="username" />
              </div>
              <div>
                <label class="text-sm font-semibold text-slate-700">Password</label>
                <input id="auth-password" type="password" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" placeholder="password" />
              </div>
            </div>

            <div class="mt-5 flex gap-2">
              <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                onclick="app.loginFromForm().catch(e=>app.showToast(e.message || 'Login failed','error'))">
                Sign in
              </button>
            </div>
          </div>
        </div>
      `;
    },

    renderForcePasswordReset() {
      const username = this.currentUser?.username || "";
      return `
        <div class="min-h-screen flex items-center justify-center p-6">
          <div class="w-full max-w-md rounded-2xl border border-amber-200 bg-white p-6 shadow-sm">
            <div class="text-sm font-semibold text-amber-700">Security Update Required</div>
            <h1 class="mt-1 text-2xl font-extrabold text-slate-900">Reset your password</h1>
            <p class="mt-2 text-sm text-slate-600">Your admin required a password change for <span class="font-semibold">${username}</span>.</p>

            <div class="mt-4 space-y-3">
              <div>
                <label class="text-sm font-semibold text-slate-700">Current password</label>
                <input id="pw-current" type="password" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label class="text-sm font-semibold text-slate-700">New password</label>
                <input id="pw-new" type="password" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
              </div>
            </div>

            <div class="mt-5 flex gap-2">
              <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                onclick="app.changeOwnPasswordFromForm().catch(e=>app.showToast(e.message || 'Password update failed','error'))">
                Update Password
              </button>
              <button class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                onclick="app.logout().catch(()=>{})">
                Logout
              </button>
            </div>
          </div>
        </div>
      `;
    },

    renderShell(contentHtml) {
      const sidebarOpen = !!this.sidebarOpen;

      return `
        <div class="wt-shell ${sidebarOpen ? "sidebar-open" : ""}">
          <div class="wt-topbar">
            <button class="wt-icon-btn wt-menu-btn" aria-label="Open menu" onclick="app.wtToggleSidebar()">☰</button>
            <div class="wt-brand">
              ${this._brandLogoHtml(36)}
              <div class="wt-brand-text">
                <div class="wt-brand-title">${this._brandName()}</div>
                <div class="wt-brand-sub">${this._brandTagline()}</div>
              </div>
            </div>
            <div class="wt-topbar-right">
              <span class="wt-pill wt-pill-gray" id="wt-conn-pill">
                <span id="wt-dot-inline" class="wt-dot is-warn"></span>
                <span id="wt-conn-text">Connecting…</span>
              </span>
              <span class="wt-pill wt-pill-gray" id="wt-last-pill" title="Last refresh time">
                <span class="wt-dot is-ok"></span>
                <span id="wt-last-text">—</span>
              </span>
              <span class="wt-pill wt-pill-gray" title="Signed in user">
                ${this.currentUser ? `${this.currentUser.display_name || this.currentUser.username} (${this.currentUser.role})` : "Guest"}
              </span>
              ${this.authDisabled ? "" : `<button class="wt-icon-btn" onclick="app.logout().catch(()=>{})">Logout</button>`}
            </div>
          </div>

          <div class="wt-body">
            <aside class="wt-sidebar" aria-label="Navigation">
              <div class="wt-sidebar-inner">
                <button class="wt-nav-btn" data-nav="dashboard" onclick="app.setView('dashboard')">Dashboard</button>
                <button class="wt-nav-btn" data-nav="scan" onclick="app.setView('scan')">Scan</button>
                <button class="wt-nav-btn" data-nav="tracker" onclick="app.setView('tracker')">Tracker</button>
                <button class="wt-nav-btn" data-nav="invoices" onclick="app.setView('invoices')">Invoices</button>
                <button class="wt-nav-btn" data-nav="history" onclick="app.setView('history')">History</button>
                <button class="wt-nav-btn" data-nav="settings" onclick="app.setView('settings')">Settings</button>

                <div class="wt-sidebar-sep"></div>

                <div class="wt-sidebar-meta">
                  <div class="wt-meta-row">
                    <span class="wt-meta-label">Server</span>
                    <span class="wt-meta-value">${API_URL}</span>
                  </div>
                  <div class="wt-meta-row">
                    <span class="wt-meta-label">Sync</span>
                    <span class="wt-meta-value" id="wt-status-text">Connecting…</span>
                  </div>
                </div>
              </div>
            </aside>

            <main class="wt-main">
              <div class="wt-main-inner">
                ${contentHtml}
              </div>
            </main>
          </div>

          <button class="wt-backdrop" aria-label="Close menu" onclick="app.wtCloseSidebar()"></button>
        </div>
      `;
    },

    renderMobileShell(contentHtml) {
      return `
        <div class="wt-mobile-shell">
          <div class="wt-mobile-topbar">
            <div class="wt-mobile-brand">
              ${this._brandLogoHtml(32)}
              <div>
                <div class="wt-brand-title">${this._brandName()}</div>
                <div class="wt-mobile-sub">${this.currentUser ? (this.currentUser.display_name || this.currentUser.username) : "Guest"}</div>
              </div>
            </div>
            <div class="wt-mobile-right">
              <span class="wt-mobile-pill" id="wt-conn-pill">
                <span id="wt-dot-inline" class="wt-dot is-warn"></span>
                <span id="wt-conn-text">Connecting…</span>
              </span>
              ${this.authDisabled ? `<button class="wt-icon-btn" onclick="app.setOperatorNameFlow().catch(()=>{})">Name</button>` : ""}
              ${this.authDisabled ? "" : `<button class="wt-icon-btn" onclick="app.logout().catch(()=>{})">Logout</button>`}
            </div>
          </div>

          <main class="wt-mobile-main">
            <div class="wt-mobile-main-inner">
              ${contentHtml}
            </div>
          </main>

          <nav class="wt-mobile-nav" aria-label="Mobile navigation">
            <button class="wt-mnav-btn" data-nav="dashboard" onclick="app.setView('dashboard')">Home</button>
            <button class="wt-mnav-btn wt-mnav-primary" data-nav="scan" onclick="app.setView('scan')">Scan</button>
            <button class="wt-mnav-btn" data-nav="tracker" onclick="app.setView('tracker')">Tracker</button>
            <button class="wt-mnav-btn" data-nav="invoices" onclick="app.setView('invoices')">Invoices</button>
            <button class="wt-mnav-btn" onclick="app.setOperatorNameFlow().catch(()=>{})">Name</button>
          </nav>
        </div>
      `;
    },

    // --------------------------
    // Render
    // --------------------------
    render() {
      const appEl = document.getElementById("app");
      if (!appEl) return;
      this._detectMobileMode();
      this.applyBrandingTheme();

      if (this.authLoading) {
        appEl.innerHTML = `<div class="min-h-screen flex items-center justify-center text-slate-600">Loading…</div>`;
        return;
      }

      if (!this.currentUser) {
        appEl.innerHTML = this.renderAuth();
        return;
      }

      if (this.forcePasswordReset) {
        appEl.innerHTML = this.renderForcePasswordReset();
        return;
      }

      if (this.scanMode) {
        appEl.innerHTML = this.renderScanner();
        this._postRender();
        return;
      }

      try {
        const content =
          this.view === "dashboard" ? this.renderDashboard() :
          this.view === "scan" ? this.renderScan() :
          this.view === "tracker" ? this.renderTracker() :
          this.view === "invoices" ? this.renderInvoices() :
          this.view === "history" ? this.renderHistory() :
          this.view === "settings" ? this.renderSettings() :
          this.view === "location-qrs" ? this.renderLocationQRs() :
          this.view === "single-qr" ? this.renderSingleQR() :
          `<div class="text-slate-600">Unknown view.</div>`;

        appEl.innerHTML = this.mobileMode ? this.renderMobileShell(content) : this.renderShell(content);
        this._postRender();
      } catch (e) {
        console.error("Render error:", e);
        appEl.innerHTML = `
          <div class="min-h-screen flex items-center justify-center p-6">
            <div class="w-full max-w-xl rounded-2xl border border-red-200 bg-red-50 p-5 text-red-900">
              <div class="text-lg font-bold">View failed to render</div>
              <div class="mt-2 text-sm">Try refreshing the app. If this persists, contact support and mention the view: <span class="font-semibold">${this.view}</span>.</div>
              <button class="mt-4 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800" onclick="window.location.reload()">Reload</button>
            </div>
          </div>
        `;
      }
    },

    _applyConnectionStatus() {
      const state = this.connState || "is-warn";
      const text = this.connText || "Connecting…";
      const dot = document.getElementById("wt-dot-inline");
      const t1 = document.getElementById("wt-conn-text");
      const t2 = document.getElementById("wt-status-text");

      if (dot) {
        dot.classList.remove("is-ok", "is-warn", "is-bad");
        dot.classList.add(state);
      }
      if (t1) t1.textContent = text;
      if (t2) t2.textContent = text;
    },

    _postRender() {
      // active nav highlight
      document.querySelectorAll(".wt-nav-btn, .wt-mnav-btn").forEach((b) => {
        const v = b.getAttribute("data-nav");
        b.classList.toggle("is-active", v === this.view);
      });

      // last refresh badge
      this._updateTopRightLastUpdated();
      this._applyConnectionStatus();

      // tracker bindings
      if (this.view === "tracker") {
        const form = document.getElementById("tracker-search-form");
        if (form && !form.__wtBound) {
          form.__wtBound = true;
          form.addEventListener("submit", (e) => {
            e.preventDefault();
            this.applyTrackerSearchFromInput();
          });
        }
        const cust = document.getElementById("customer-filter");
        if (cust && !cust.__wtBound) {
          cust.__wtBound = true;
          cust.value = this.selectedCustomer || "";
          cust.addEventListener("change", (e) => {
            this.selectedCustomer = String(e.target.value || "");
            this.refreshAll().catch(() => {});
          });
        }
      }

      // history filter
      if (this.view === "history") {
        const cust = document.getElementById("history-customer-filter");
        if (cust && !cust.__wtBound) {
          cust.__wtBound = true;
          cust.value = this.selectedCustomer || "";
          cust.addEventListener("change", (e) => {
            this.selectedCustomer = String(e.target.value || "");
            this.refreshAll().catch(() => {});
          });
        }
      }

      // QR render: single pallet
      if (this.view === "single-qr" && this.tempPallet) {
        const text = this.tempPallet._qrText || wtMakePalletQrPayload({
          id: this.tempPallet.id,
          customer: this.tempPallet.customer || "",
          productId: this.tempPallet.product || "",
          unitsPerPallet: this.tempPallet.productQty || 0,
        });

        const canvas = document.getElementById("single-qr-canvas");
        if (canvas) {
          // store payload in title for quick inspection
          canvas.title = text;
          this.generateQRCode(text, "single-qr-canvas").catch(() => {});
        }
      }

      // QR render: location sheet
      if (this.view === "location-qrs") {
        this._renderLocationQrCanvas().catch(() => {});
      }
    },

    _updateTopRightLastUpdated() {
      const el = document.getElementById("wt-last-text");
      if (el) el.textContent = this.lastUpdatedAt || "—";
    },

    // --------------------------
    // Views
    // --------------------------
    renderDashboard() {
      const pallets = Array.isArray(this.pallets) ? this.pallets : [];
      const activity = Array.isArray(this.activityLog) ? this.activityLog : [];
      const invoices = Array.isArray(this.invoices) ? this.invoices : [];

      const totalRows = pallets.length;
      const totalPalletQty = pallets.reduce((sum, p) => sum + (Number(p.pallet_quantity) || 0), 0);
      const totalUnits = pallets.reduce((sum, p) => sum + (Number(p.current_units) || 0), 0);
      const occupied = Number(this.stats?.occupied_locations || 0);
      const totalLocations = Number(this.stats?.total_locations || 0);
      const locationRows = Array.isArray(this.locations) ? this.locations : [];
      const totalPalletCapacity = locationRows.reduce((sum, loc) => {
        const cap = Number(loc?.capacity_pallets);
        return Number.isFinite(cap) && cap > 0 ? sum + cap : sum;
      }, 0);
      const usedPalletCapacity = Math.max(0, totalPalletQty);
      const utilization = totalPalletCapacity > 0
        ? ((usedPalletCapacity / totalPalletCapacity) * 100).toFixed(1)
        : "0.0";
      const floorSpaceRows = locationRows.filter((loc) => {
        const t = String(loc?.location_type || "").toLowerCase();
        return t === "floor_space" || t === "rack_floor";
      });
      const floorTotalSqm = floorSpaceRows.reduce((sum, loc) => {
        const sqm = Number(loc?.floor_area_sqm);
        return Number.isFinite(sqm) && sqm > 0 ? sum + sqm : sum;
      }, 0);
      const floorUsedSqm = floorSpaceRows.reduce((sum, loc) => {
        if (!Number(loc?.is_occupied)) return sum;
        const sqm = Number(loc?.floor_area_sqm);
        return Number.isFinite(sqm) && sqm > 0 ? sum + sqm : sum;
      }, 0);
      const floorUtilization = floorTotalSqm > 0
        ? ((floorUsedSqm / floorTotalSqm) * 100).toFixed(1)
        : "0.0";
      const customers = new Set(pallets.map((p) => String(p.customer_name || "").trim()).filter(Boolean));

      const now = Date.now();
      const in24h = activity.filter((a) => {
        const t = Date.parse(a.timestamp || "");
        return Number.isFinite(t) && (now - t) <= 24 * 60 * 60 * 1000;
      }).length;

      const invoice30d = invoices.filter((i) => {
        const t = Date.parse(i.created_at || "");
        return Number.isFinite(t) && (now - t) <= 30 * 24 * 60 * 60 * 1000;
      });
      const overdueInvoices = invoices.filter((inv) => this._invoiceIsOverdue(inv));
      const overdueAmount = overdueInvoices.reduce((sum, inv) => sum + Math.max(0, (Number(inv.total) || 0) - (Number(inv.amount_paid) || 0)), 0);
      const revenue30d = invoice30d.reduce((sum, i) => sum + (Number(i.total) || 0), 0);
      const handling30d = invoice30d.reduce((sum, i) => sum + (Number(i.handling_total) || 0), 0);
      const handlingShare30d = revenue30d > 0 ? ((handling30d / revenue30d) * 100).toFixed(1) : "0.0";
      const avgInvoice30d = invoice30d.length > 0 ? (revenue30d / invoice30d.length) : 0;

      const invoiceByCustomer = Array.from(
        invoices.reduce((map, inv) => {
          const key = String(inv.customer_name || "Unassigned").trim() || "Unassigned";
          map.set(key, (map.get(key) || 0) + (Number(inv.total) || 0));
          return map;
        }, new Map())
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);

      const topCustomers = Array.from(
        pallets.reduce((map, p) => {
          const key = String(p.customer_name || "Unassigned").trim() || "Unassigned";
          const next = (map.get(key) || 0) + (Number(p.pallet_quantity) || 0);
          map.set(key, next);
          return map;
        }, new Map())
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);

      const recent = activity.slice(0, 8);
      const recentInvoices = invoices.slice(0, 8);
      const dashboardCurrency = recentInvoices[0]?.currency || "GBP";
      const aging = this.invoiceAging || {};
      const agingBuckets = aging.buckets || {};
      const health = this.systemHealth || {};
      const backup = this.latestBackup || null;
      const uptimeMins = Number(health.uptime_sec || 0) > 0 ? Math.round(Number(health.uptime_sec || 0) / 60) : 0;

      return `
        <div class="space-y-5 fade-in">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div class="text-sm font-semibold text-slate-600">Dashboard</div>
              <h2 class="mt-1 text-2xl font-extrabold text-slate-900">Operations Overview</h2>
              <p class="mt-1 text-slate-600 text-sm">Real-time occupancy, inventory velocity, customer mix, and billing pulse.</p>
            </div>
            <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              onclick="app.refreshAll().catch(()=>{})">
              Refresh
            </button>
          </div>

          <div class="wt-dash-kpi-grid">
            <div class="wt-dash-kpi-card">
              <div class="wt-dash-kpi-label">Active Records</div>
              <div class="wt-dash-kpi-value">${totalRows}</div>
            </div>
            <div class="wt-dash-kpi-card">
              <div class="wt-dash-kpi-label">Pallet Quantity</div>
              <div class="wt-dash-kpi-value">${totalPalletQty}</div>
            </div>
            <div class="wt-dash-kpi-card">
              <div class="wt-dash-kpi-label">Total Units</div>
              <div class="wt-dash-kpi-value">${totalUnits}</div>
            </div>
            <div class="wt-dash-kpi-card">
              <div class="wt-dash-kpi-label">Space Utilization</div>
              <div class="wt-dash-kpi-value">${utilization}%</div>
              <div class="wt-dash-kpi-sub">${usedPalletCapacity} / ${totalPalletCapacity} pallet slots used${totalLocations > 0 ? ` • ${occupied} locations active` : ""}</div>
            </div>
            <div class="wt-dash-kpi-card">
              <div class="wt-dash-kpi-label">Floor Space Utilization</div>
              <div class="wt-dash-kpi-value">${floorUtilization}%</div>
              <div class="wt-dash-kpi-sub">${floorUsedSqm.toFixed(2)} / ${floorTotalSqm.toFixed(2)} sqm in use</div>
            </div>
            <div class="wt-dash-kpi-card">
              <div class="wt-dash-kpi-label">Revenue (30d)</div>
              <div class="wt-dash-kpi-value">${dashboardCurrency} ${revenue30d.toFixed(2)}</div>
              <div class="wt-dash-kpi-sub">${invoice30d.length} invoices • avg ${dashboardCurrency} ${avgInvoice30d.toFixed(2)}</div>
            </div>
            <div class="wt-dash-kpi-card">
              <div class="wt-dash-kpi-label">Handling Share (30d)</div>
              <div class="wt-dash-kpi-value">${handlingShare30d}%</div>
              <div class="wt-dash-kpi-sub">${dashboardCurrency} ${handling30d.toFixed(2)} handling total</div>
            </div>
            <div class="wt-dash-kpi-card">
              <div class="wt-dash-kpi-label">Overdue A/R</div>
              <div class="wt-dash-kpi-value">${dashboardCurrency} ${overdueAmount.toFixed(2)}</div>
              <div class="wt-dash-kpi-sub">${overdueInvoices.length} overdue invoices (unpaid)</div>
            </div>
          </div>

          <div class="wt-dash-grid">
            <section class="wt-dash-panel">
              <div class="wt-dash-panel-head">
                <div class="wt-dash-panel-title">Customer Mix</div>
                <div class="wt-dash-panel-meta">${customers.size} active customers</div>
              </div>
              <div class="wt-dash-list">
                ${
                  topCustomers.length
                    ? topCustomers.map(([name, qty]) => `
                        <div class="wt-dash-list-row">
                          <span>${name}</span>
                          <span class="wt-dash-list-value">${qty}</span>
                        </div>
                      `).join("")
                    : `<div class="text-slate-500 text-sm">No customer data yet.</div>`
                }
              </div>
            </section>

            <section class="wt-dash-panel">
              <div class="wt-dash-panel-head">
                <div class="wt-dash-panel-title">Revenue by Customer</div>
                <div class="wt-dash-panel-meta">${invoices.length} invoices total</div>
              </div>
              <div class="wt-dash-list">
                ${
                  invoiceByCustomer.length
                    ? invoiceByCustomer.map(([name, total]) => `
                        <div class="wt-dash-list-row">
                          <span>${name}</span>
                          <span class="wt-dash-list-value">${dashboardCurrency} ${Number(total).toFixed(2)}</span>
                        </div>
                      `).join("")
                    : `<div class="text-slate-500 text-sm">No invoice totals yet.</div>`
                }
              </div>
            </section>

            <section class="wt-dash-panel">
              <div class="wt-dash-panel-head">
                <div class="wt-dash-panel-title">Activity Pulse</div>
                <div class="wt-dash-panel-meta">${in24h} events in last 24h</div>
              </div>
              <div class="wt-dash-list">
                ${
                  recent.length
                    ? recent.map((a) => {
                        const ts = a.timestamp ? new Date(a.timestamp).toLocaleString() : "";
                        return `
                          <div class="wt-dash-activity-row">
                            <div class="wt-dash-activity-main">${a.action || "EVENT"} • ${a.product_id || "N/A"}</div>
                            <div class="wt-dash-activity-sub">${a.customer_name || "Unknown"} • ${a.location || "N/A"} • ${ts}</div>
                          </div>
                        `;
                      }).join("")
                    : `<div class="text-slate-500 text-sm">No activity yet.</div>`
                }
              </div>
            </section>

            <section class="wt-dash-panel">
              <div class="wt-dash-panel-head">
                <div class="wt-dash-panel-title">Recent Invoices</div>
                <div class="wt-dash-panel-meta">Latest billing output</div>
              </div>
              <div class="wt-dash-list">
                ${
                  recentInvoices.length
                    ? recentInvoices.map((inv) => `
                        <div class="wt-dash-activity-row">
                          <div class="wt-dash-activity-main">#${inv.id || "—"} • ${inv.customer_name || "Unknown"} • ${inv.currency || "GBP"} ${Number(inv.total || 0).toFixed(2)}</div>
                          <div class="wt-dash-activity-sub">${inv.start_date || ""} → ${inv.end_date || ""} • ${inv.created_at ? new Date(inv.created_at).toLocaleString() : ""}</div>
                        </div>
                      `).join("")
                    : `<div class="text-slate-500 text-sm">No invoices generated yet.</div>`
                }
              </div>
            </section>

            <section class="wt-dash-panel">
              <div class="wt-dash-panel-head">
                <div class="wt-dash-panel-title">A/R Aging</div>
                <div class="wt-dash-panel-meta">${dashboardCurrency} ${Number(aging.total_outstanding || 0).toFixed(2)} outstanding</div>
              </div>
              <div class="wt-dash-list">
                <div class="wt-dash-list-row"><span>Current</span><span class="wt-dash-list-value">${dashboardCurrency} ${Number(agingBuckets.current?.amount || 0).toFixed(2)}</span></div>
                <div class="wt-dash-list-row"><span>1-30 overdue</span><span class="wt-dash-list-value">${dashboardCurrency} ${Number(agingBuckets.d1_30?.amount || 0).toFixed(2)}</span></div>
                <div class="wt-dash-list-row"><span>31-60 overdue</span><span class="wt-dash-list-value">${dashboardCurrency} ${Number(agingBuckets.d31_60?.amount || 0).toFixed(2)}</span></div>
                <div class="wt-dash-list-row"><span>61+ overdue</span><span class="wt-dash-list-value">${dashboardCurrency} ${Number(agingBuckets.d61_plus?.amount || 0).toFixed(2)}</span></div>
              </div>
            </section>

            <section class="wt-dash-panel">
              <div class="wt-dash-panel-head">
                <div class="wt-dash-panel-title">System</div>
                <div class="wt-dash-panel-meta">${health.ok ? "Healthy" : "Unknown"}</div>
              </div>
              <div class="wt-dash-list">
                <div class="wt-dash-list-row"><span>Uptime</span><span class="wt-dash-list-value">${uptimeMins ? `${uptimeMins} min` : "—"}</span></div>
                <div class="wt-dash-list-row"><span>Active users</span><span class="wt-dash-list-value">${Number(health.active_users || 0)}</span></div>
                <div class="wt-dash-list-row"><span>Sessions</span><span class="wt-dash-list-value">${Number(health.sessions || 0)}</span></div>
                <div class="wt-dash-list-row"><span>Latest backup</span><span class="wt-dash-list-value">${backup?.mtime ? new Date(backup.mtime).toLocaleString() : "None"}</span></div>
                ${
                  backup?.file
                    ? `<div class="wt-dash-list-row"><span>Backup file</span><span class="wt-dash-list-value">${backup.file}</span></div>`
                    : ""
                }
              </div>
            </section>
          </div>
        </div>
      `;
    },

    renderScan() {
      const scanTitleClass = this.mobileMode ? "mt-1 text-2xl font-extrabold tracking-tight text-slate-900" : "mt-1 text-3xl font-extrabold tracking-tight text-slate-900";
      const cardGridClass = this.mobileMode ? "grid grid-cols-1 gap-3 p-4" : "grid grid-cols-1 gap-4 p-6 sm:grid-cols-2";
      const operatorBanner = this.authDisabled
        ? `<div class="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
             <span class="font-semibold">Operator:</span> ${this.operatorName ? this.operatorName : "Not set"}
             <button class="ml-2 rounded-lg border border-blue-300 bg-white px-2 py-1 text-xs font-semibold" onclick="app.setOperatorNameFlow().catch(()=>{})">Set name</button>
           </div>`
        : "";
      return `
        <div class="fade-in">
          <div class="mx-auto max-w-5xl">
            <div class="mb-6">
              <div class="text-sm font-semibold text-slate-600">Scan</div>
              <h2 class="${scanTitleClass}">Quick actions</h2>
              <p class="mt-2 text-slate-600">Fast check-in, check-out and partial unit removal.</p>
            </div>
            ${operatorBanner}

            <div class="rounded-2xl border border-slate-200 bg-white/80 shadow-sm backdrop-blur">
              <div class="flex items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
                <div>
                  <div class="text-sm font-semibold text-slate-700">Pallet operations</div>
                  <div class="text-sm text-slate-500">Use camera scanning or manual entry.</div>
                </div>
                <span class="inline-flex items-center rounded-full bg-slate-900/5 px-3 py-1 text-xs font-semibold text-slate-700">
                  Recommended
                </span>
              </div>

              <div class="${cardGridClass}">
                <button type="button" onclick="app.startScanner('checkin-pallet')"
                  class="group w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <div class="flex items-start gap-4">
                    <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-700">
                      <span class="text-lg font-black">IN</span>
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <div class="text-base font-bold text-slate-900">Check in</div>
                        <span class="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-700">scan</span>
                      </div>
                      <div class="mt-1 text-sm text-slate-600">Scan pallet QR, then scan a location.</div>
                    </div>
                  </div>
                </button>

                <button type="button" onclick="app.startScanner('checkout')"
                  class="group w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <div class="flex items-start gap-4">
                    <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-rose-500/10 text-rose-700">
                      <span class="text-lg font-black">OUT</span>
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <div class="text-base font-bold text-slate-900">Check out</div>
                        <span class="rounded-full bg-rose-500/10 px-2 py-0.5 text-xs font-semibold text-rose-700">remove</span>
                      </div>
                      <div class="mt-1 text-sm text-slate-600">Remove a whole pallet entry from inventory.</div>
                    </div>
                  </div>
                </button>

                <button type="button" onclick="app.startScanner('checkout-units')"
                  class="group w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <div class="flex items-start gap-4">
                    <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 text-amber-800">
                      <span class="text-lg font-black">−</span>
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <div class="text-base font-bold text-slate-900">Remove units</div>
                        <span class="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-800">partial</span>
                      </div>
                      <div class="mt-1 text-sm text-slate-600">Scan a pallet and remove units (partial).</div>
                    </div>
                  </div>
                </button>

                <button type="button" onclick="app.startScanner('move-pallet')"
                  class="group w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <div class="flex items-start gap-4">
                    <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-700">
                      <span class="text-lg font-black">MV</span>
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <div class="text-base font-bold text-slate-900">Move pallet</div>
                        <span class="rounded-full bg-indigo-500/10 px-2 py-0.5 text-xs font-semibold text-indigo-700">relocate</span>
                      </div>
                      <div class="mt-1 text-sm text-slate-600">Scan pallet QR, then scan the new location.</div>
                    </div>
                  </div>
                </button>

                <button type="button" onclick="app.showManualEntry()"
                  class="group w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <div class="flex items-start gap-4">
                    <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-500/10 text-blue-700">
                      <span class="text-lg font-black">✎</span>
                    </div>
                    <div class="min-w-0">
                      <div class="text-base font-bold text-slate-900">Manual entry</div>
                      <div class="mt-1 text-sm text-slate-600">Enter pallet + location without scanning.</div>
                    </div>
                  </div>
                </button>
              </div>
            </div>

            <div class="mt-6 rounded-2xl border border-slate-200 bg-white/80 p-6 shadow-sm backdrop-blur">
              <div class="mb-4">
                <div class="text-sm font-semibold text-slate-700">QR tools</div>
                <div class="text-sm text-slate-500">Print labels for pallets and locations.</div>
              </div>

              <div class="flex flex-wrap gap-3">
                <button type="button" onclick="app.generatePalletQR()"
                  class="rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  Generate pallet QR
                </button>
                <button type="button" onclick="app.generateLocationQRs()"
                  class="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  Location QR codes
                </button>
              </div>
            </div>

            <div class="mt-6 text-xs text-slate-500">
              Tip: pallets with multiple parts can include a parts list (Manual entry).
            </div>
          </div>
        </div>
      `;
    },

    renderScanner() {
      const msg = this._scanTitle();
      const hint = this._scanHint();

      return `
        <div class="wt-scanner-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div class="wt-scanner-panel w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl">
            <div class="mb-3 flex items-center justify-between">
              <div id="wt-scan-title" class="text-lg font-extrabold text-slate-900">${msg}</div>
              <button class="wt-icon-btn" onclick="app.stopScanner()" aria-label="Close">×</button>
            </div>
            <div id="wt-scan-hint" class="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              ${hint}
            </div>
            <div id="qr-reader" class="wt-qr-reader overflow-hidden rounded-xl border border-slate-200"></div>
            <div class="mt-4 flex gap-2">
              <button class="wt-scan-cancel rounded-xl bg-slate-100 px-4 py-2 font-semibold text-slate-800 hover:bg-slate-200" onclick="app.stopScanner()">
                Cancel
              </button>
              <div class="ml-auto text-xs text-slate-500 flex items-center">
                Ensure camera permission is allowed.
              </div>
            </div>
          </div>
        </div>
      `;
    },

    _scanTitle() {
      return this.scanMode === "checkin-pallet" ? "Scan pallet QR" :
        this.scanMode === "checkin-location" ? "Scan location QR" :
        this.scanMode === "checkout" ? "Scan pallet to check out" :
        this.scanMode === "checkout-units" ? "Scan pallet to remove units" :
        this.scanMode === "move-pallet" ? "Scan pallet to move" :
        this.scanMode === "move-location" ? "Scan destination location QR" : "Scan";
    },

    _scanHint() {
      return this.scanMode === "checkin-pallet" ? "Step 1 of 2: Scan the pallet label." :
        this.scanMode === "checkin-location" ? "Step 2 of 2: Scan the location label (e.g. A1 or A1 Floor)." :
        this.scanMode === "move-pallet" ? "Step 1 of 2: Scan the pallet you want to move." :
        this.scanMode === "move-location" ? "Step 2 of 2: Scan destination location label." :
        this.scanMode === "checkout" ? "Scan pallet label to remove from storage." :
        this.scanMode === "checkout-units" ? "Scan pallet label to remove part units." : "Scan QR code.";
    },

    _syncScannerUi() {
      const title = document.getElementById("wt-scan-title");
      const hint = document.getElementById("wt-scan-hint");
      if (title) title.textContent = this._scanTitle();
      if (hint) hint.textContent = this._scanHint();
    },

    renderTracker() {
      let pallets = Array.isArray(this.pallets) ? this.pallets.slice() : [];

      const term = String(this.searchTerm || "").toLowerCase().trim();
      if (term) {
        pallets = pallets.filter((p) => {
          const a = String(p.product_id || "").toLowerCase();
          const b = String(p.location || "").toLowerCase();
          const c = String(p.customer_name || "").toLowerCase();
          return a.includes(term) || b.includes(term) || c.includes(term);
        });
      }

      const totalPallets = pallets.reduce((sum, p) => sum + (Number(p.pallet_quantity) || 0), 0);
      const totalUnits = pallets.reduce((sum, p) => sum + (Number(p.current_units) || 0), 0);
      const trackerResultsHtml = this.mobileMode
        ? `
          <div class="wt-mobile-tracker-cards">
            ${
              pallets.length
                ? pallets.map((p) => {
                    const pq = Number(p.pallet_quantity) || 0;
                    const up = Number(p.product_quantity) || 0;
                    const total = up > 0 ? (p.current_units ?? (pq * up)) : "";
                    const added = p.date_added ? new Date(p.date_added).toLocaleDateString() : "";
                    return `
                      <article class="wt-mobile-card">
                        <div class="wt-mobile-card-id">${p.id || ""}</div>
                        <div class="wt-mobile-card-grid">
                          <div><span class="wt-mobile-card-k">Product</span><span class="wt-mobile-card-v">${p.product_id || ""}</span></div>
                          <div><span class="wt-mobile-card-k">Customer</span><span class="wt-mobile-card-v">${p.customer_name || ""}</span></div>
                          <div><span class="wt-mobile-card-k">Location</span><span class="wt-mobile-card-v">${p.location || ""}</span></div>
                          <div><span class="wt-mobile-card-k">Pallets</span><span class="wt-mobile-card-v">${pq}</span></div>
                          <div><span class="wt-mobile-card-k">Units/Pallet</span><span class="wt-mobile-card-v">${up || ""}</span></div>
                          <div><span class="wt-mobile-card-k">Total Units</span><span class="wt-mobile-card-v">${total}</span></div>
                          <div><span class="wt-mobile-card-k">Added</span><span class="wt-mobile-card-v">${added}</span></div>
                        </div>
                        <div class="wt-mobile-card-actions">
                          <button class="wt-btn wt-btn-purple" onclick="app.reprintPalletQR('${p.id}')">Reprint</button>
                          ${up > 0 ? `<button class="wt-btn wt-btn-yellow" onclick="app.removePartialUnits('${p.id}')">Remove units</button>` : ""}
                          <button class="wt-btn wt-btn-blue" onclick="app.showProductInfo('${p.id}')">Info</button>
                        </div>
                      </article>
                    `;
                  }).join("")
                : `<div class="rounded-xl border border-slate-200 bg-white p-6 text-center text-slate-500">No pallets found.</div>`
            }
          </div>
        `
        : `
          <div class="wt-table-wrap">
            <table class="wt-table ${this.trackerDensity === "compact" ? "wt-density-compact" : "wt-density-comfy"}">
              <thead>
                <tr>
                  <th class="wt-th-sticky-left">Pallet ID</th>
                  <th>Product</th>
                  <th>Customer</th>
                  <th>Location</th>
                  <th class="wt-th-num">Pallets</th>
                  <th class="wt-th-num">Units/Pallet</th>
                  <th class="wt-th-num">Total Units</th>
                  <th>Added</th>
                  <th class="wt-th-sticky-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${
                  pallets.length
                    ? pallets.map((p) => {
                        const pq = Number(p.pallet_quantity) || 0;
                        const up = Number(p.product_quantity) || 0;
                        const total = up > 0 ? (p.current_units ?? (pq * up)) : "";
                        const added = p.date_added ? new Date(p.date_added).toLocaleDateString() : "";
                        return `
                          <tr class="wt-row">
                            <td class="wt-cell wt-strong wt-td-sticky-left">${p.id || ""}</td>
                            <td class="wt-cell wt-strong">${p.product_id || ""}</td>
                            <td class="wt-cell">${p.customer_name || ""}</td>
                            <td class="wt-cell">${p.location || ""}</td>
                            <td class="wt-cell wt-num">${pq}</td>
                            <td class="wt-cell wt-num">${up || ""}</td>
                            <td class="wt-cell wt-num">${total}</td>
                            <td class="wt-cell">${added}</td>
                            <td class="wt-cell wt-actions wt-td-sticky-right">
                              <button class="wt-btn wt-btn-purple" onclick="app.reprintPalletQR('${p.id}')">Reprint</button>
                              ${up > 0 ? `<button class="wt-btn wt-btn-yellow" onclick="app.removePartialUnits('${p.id}')">Remove units</button>` : ""}
                              <button class="wt-btn wt-btn-blue" onclick="app.showProductInfo('${p.id}')">Info</button>
                            </td>
                          </tr>
                        `;
                      }).join("")
                    : `
                      <tr>
                        <td class="wt-cell" colspan="9">
                          <div class="py-10 text-center text-slate-500">
                            <div class="text-4xl mb-2">📦</div>
                            No pallets found.
                          </div>
                        </td>
                      </tr>
                    `
                }
              </tbody>
            </table>
          </div>
        `;

      return `
        <div class="space-y-5 fade-in">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div class="text-sm font-semibold text-slate-600">Tracker</div>
              <h2 class="mt-1 text-2xl font-extrabold text-slate-900">Inventory</h2>
              <p class="mt-1 text-slate-600 text-sm">All pallets currently stored.</p>
            </div>
            <div class="flex gap-2">
              <button class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                onclick="app.toggleTrackerDensity()">
                ${this.trackerDensity === "compact" ? "Comfy rows" : "Compact rows"}
              </button>
              <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                onclick="app.refreshAll().catch(()=>{})">
                Refresh
              </button>
            </div>
          </div>

          <div class="wt-tracker-kpis">
            <div class="wt-kpi-chip">
              <span class="wt-kpi-label">Rows</span>
              <span class="wt-kpi-value">${pallets.length}</span>
            </div>
            <div class="wt-kpi-chip">
              <span class="wt-kpi-label">Pallet Qty</span>
              <span class="wt-kpi-value">${totalPallets}</span>
            </div>
            <div class="wt-kpi-chip">
              <span class="wt-kpi-label">Units</span>
              <span class="wt-kpi-value">${totalUnits}</span>
            </div>
          </div>

          <div class="flex flex-wrap gap-3 items-center">
            <select id="customer-filter" class="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900">
              <option value="">All customers</option>
              ${(this.customers || []).map((c) => `<option value="${c}">${c}</option>`).join("")}
            </select>

            <form id="tracker-search-form" class="min-w-[240px] flex-1 flex gap-2">
              <input id="search-input" type="text" value="${this.searchTerm || ""}"
                placeholder="Search product / location / customer..."
                class="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm" />
              <button type="submit" class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">Search</button>
              <button type="button" class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50" onclick="app.clearTrackerSearch()">Clear</button>
            </form>

            <a class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
              href="${API_URL}/api/export${this.selectedCustomer ? `?customer=${encodeURIComponent(this.selectedCustomer)}` : ""}"
              download>
              Export CSV
            </a>
          </div>

          ${trackerResultsHtml}
        </div>
      `;
    },

    renderInvoices() {
      const rows = Array.isArray(this.invoices) ? this.invoices.slice() : [];
      const filterCustomer = String(this.invoiceFilterCustomer || "").trim().toLowerCase();
      const filterStatus = String(this.invoiceFilterStatus || "").trim().toUpperCase();

      const normalized = rows.map((r) => {
        const rawStatus = String(r.status || "").trim().toUpperCase();
        const status = rawStatus === "PAID" ? "PAID" : (rawStatus === "SENT" ? "SENT" : "DRAFT");
        return { ...r, status };
      });

      const filtered = normalized.filter((r) => {
        if (filterCustomer && !String(r.customer_name || "").toLowerCase().includes(filterCustomer)) return false;
        if (filterStatus && r.status !== filterStatus) return false;
        return true;
      });

      const countDraft = normalized.filter((r) => r.status === "DRAFT").length;
      const countSent = normalized.filter((r) => r.status === "SENT").length;
      const countPaid = normalized.filter((r) => r.status === "PAID").length;
      const invoiceCurrency = normalized[0]?.currency || "GBP";
      const outstanding = normalized
        .filter((r) => r.status !== "PAID")
        .reduce((sum, r) => sum + Math.max(0, (Number(r.total) || 0) - (Number(r.amount_paid) || 0)), 0);
      const overdue = normalized
        .filter((r) => this._invoiceIsOverdue(r))
        .reduce((sum, r) => sum + Math.max(0, (Number(r.total) || 0) - (Number(r.amount_paid) || 0)), 0);

      return `
        <div class="space-y-5 fade-in">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div class="text-sm font-semibold text-slate-600">Invoices</div>
              <h2 class="mt-1 text-2xl font-extrabold text-slate-900">Billing History</h2>
              <p class="mt-1 text-slate-600 text-sm">Generated weekly invoices and totals.</p>
            </div>
            <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              onclick="app.refreshAll().catch(()=>{})">
              Refresh
            </button>
          </div>

          <div class="wt-tracker-kpis">
            <div class="wt-kpi-chip"><span class="wt-kpi-label">Draft</span><span class="wt-kpi-value">${countDraft}</span></div>
            <div class="wt-kpi-chip"><span class="wt-kpi-label">Sent</span><span class="wt-kpi-value">${countSent}</span></div>
            <div class="wt-kpi-chip"><span class="wt-kpi-label">Paid</span><span class="wt-kpi-value">${countPaid}</span></div>
            <div class="wt-kpi-chip"><span class="wt-kpi-label">Outstanding</span><span class="wt-kpi-value">${invoiceCurrency} ${Number(outstanding).toFixed(2)}</span></div>
            <div class="wt-kpi-chip"><span class="wt-kpi-label">Overdue</span><span class="wt-kpi-value">${invoiceCurrency} ${Number(overdue).toFixed(2)}</span></div>
          </div>

          <div class="flex flex-wrap gap-3 items-center">
            <input type="text"
              value="${this.invoiceFilterCustomer || ""}"
              oninput="app.invoiceFilterCustomer=this.value;app.render();"
              placeholder="Filter by customer..."
              class="min-w-[240px] flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm" />
            <select
              class="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              onchange="app.invoiceFilterStatus=this.value;app.render();"
            >
              <option value="" ${this.invoiceFilterStatus ? "" : "selected"}>All statuses</option>
              <option value="DRAFT" ${this.invoiceFilterStatus === "DRAFT" ? "selected" : ""}>Draft</option>
              <option value="SENT" ${this.invoiceFilterStatus === "SENT" ? "selected" : ""}>Sent</option>
              <option value="PAID" ${this.invoiceFilterStatus === "PAID" ? "selected" : ""}>Paid</option>
            </select>
          </div>

          <div class="wt-table-wrap">
            <table class="wt-table wt-density-compact">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Customer</th>
                  <th>Range</th>
                  <th class="wt-th-num">Pallet Days</th>
                  <th class="wt-th-num">Rate/Week</th>
                  <th class="wt-th-num">Handling</th>
                  <th class="wt-th-num">Total</th>
                  <th class="wt-th-num">Paid</th>
                  <th class="wt-th-num">Balance</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${
                  filtered.length
                    ? filtered.map((r) => `
                        <tr class="wt-row">
                          <td class="wt-cell wt-strong">${r.id || ""}</td>
                          <td class="wt-cell">${r.customer_name || ""}</td>
                          <td class="wt-cell">${r.start_date || ""} → ${r.end_date || ""}</td>
                          <td class="wt-cell wt-num">${Number(r.pallet_days || 0)}</td>
                          <td class="wt-cell wt-num">${r.currency || "GBP"} ${Number(r.rate_per_pallet_week || 0).toFixed(2)}</td>
                          <td class="wt-cell wt-num">${r.currency || "GBP"} ${Number(r.handling_total || 0).toFixed(2)}</td>
                          <td class="wt-cell wt-num wt-strong">${r.currency || "GBP"} ${Number(r.total || 0).toFixed(2)}</td>
                          <td class="wt-cell wt-num">${r.currency || "GBP"} ${Number(r.amount_paid || 0).toFixed(2)}</td>
                          <td class="wt-cell wt-num wt-strong">${r.currency || "GBP"} ${Math.max(0, Number(r.total || 0) - Number(r.amount_paid || 0)).toFixed(2)}</td>
                          <td class="wt-cell">
                            <span class="wt-status-badge wt-status-${String(r.status || "DRAFT").toLowerCase()}">${r.status || "DRAFT"}</span>
                          </td>
                          <td class="wt-cell">${this._invoiceDueLabel(r)}</td>
                          <td class="wt-cell">${r.created_at ? new Date(r.created_at).toLocaleString() : ""}</td>
                          <td class="wt-cell">
                            <div class="wt-actions">
                              ${r.status !== "SENT" ? `<button class="wt-btn wt-btn-blue" onclick="app.setInvoiceStatus(${Number(r.id)}, 'SENT')">Mark Sent</button>` : ""}
                              ${r.status !== "PAID" ? `<button class="wt-btn wt-btn-green" onclick="app.setInvoiceStatus(${Number(r.id)}, 'PAID')">Mark Paid</button>` : ""}
                              ${r.status !== "DRAFT" ? `<button class="wt-btn wt-btn-slate" onclick="app.setInvoiceStatus(${Number(r.id)}, 'DRAFT')">Set Draft</button>` : ""}
                              ${Math.max(0, Number(r.total || 0) - Number(r.amount_paid || 0)) > 0 ? `<button class="wt-btn wt-btn-orange" onclick="app.recordInvoicePayment(${Number(r.id)})">Record Payment</button>` : ""}
                              <button class="wt-btn wt-btn-purple" onclick="app.exportInvoiceCsv(${Number(r.id)})">CSV</button>
                            </div>
                          </td>
                        </tr>
                      `).join("")
                    : `
                      <tr>
                        <td class="wt-cell" colspan="13">
                          <div class="py-10 text-center text-slate-500">
                            <div class="text-4xl mb-2">🧾</div>
                            No invoices yet.
                          </div>
                        </td>
                      </tr>
                    `
                }
              </tbody>
            </table>
          </div>
        </div>
      `;
    },

    renderHistory() {
      const logs = Array.isArray(this.activityLog) ? this.activityLog : [];
      return `
        <div class="space-y-5 fade-in">
          <div>
            <div class="text-sm font-semibold text-slate-600">History</div>
            <h2 class="mt-1 text-2xl font-extrabold text-slate-900">Activity</h2>
            <p class="mt-1 text-slate-600 text-sm">Latest events (check-in, check-out, units removed).</p>
          </div>

          <div class="flex flex-wrap gap-3 items-center">
            <select id="history-customer-filter" class="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900">
              <option value="">All customers</option>
              ${(this.customers || []).map((c) => `<option value="${c}">${c}</option>`).join("")}
            </select>
            <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              onclick="app.refreshAll().catch(()=>{})">
              Refresh
            </button>
          </div>

          <div class="space-y-2">
            ${
              logs.length
                ? logs.slice(0, 100).map((a) => {
                    const ts = a.timestamp ? new Date(a.timestamp).toLocaleString() : "";
                    return `
                      <div class="rounded-2xl border border-slate-200 bg-white p-4">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                          <div class="font-bold text-slate-900">${a.product_id || ""}</div>
                          <div class="text-xs text-slate-500">${ts}</div>
                        </div>
                        <div class="mt-1 text-sm text-slate-700">
                          <span class="font-semibold">${a.customer_name || ""}</span>
                          • ${a.location || ""}
                          • <span class="font-semibold">${a.action || ""}</span>
                          ${a.quantity_changed != null ? ` • Δ ${a.quantity_changed}` : ""}
                        </div>
                        ${a.notes ? `<div class="mt-2 text-xs text-slate-500">${a.notes}</div>` : ""}
                      </div>
                    `;
                  }).join("")
                : `<div class="text-slate-500">No activity yet.</div>`
            }
          </div>
        </div>
      `;
    },

    renderSettings() {
      const url = this.googleSheetsUrl || "";
      this.ensureInvoiceFormDefaults();
      const isAdmin = ["owner", "admin"].includes(String(this.currentUser?.role || "").toLowerCase());
      const knownCustomers = Array.from(new Set([
        ...(this.customers || []),
        ...((this.rates || []).map((r) => r.customer_name).filter(Boolean)),
      ])).sort();
      const preview = this.invoicePreview;
      const users = Array.isArray(this.authUsers) ? this.authUsers : [];
      const locationRows = Array.isArray(this.locations)
        ? [...this.locations].sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")))
        : [];
      const currentLocationEditId = this.locationEditId || String(locationRows[0]?.id || "");
      const currentLocationRow = locationRows.find((r) => String(r.id || "") === currentLocationEditId) || null;
      const editCapacity = this.locationEditId
        ? this.locationEditCapacity
        : (currentLocationRow?.capacity_pallets == null ? "" : String(currentLocationRow.capacity_pallets));
      const editFloorArea = this.locationEditId
        ? this.locationEditFloorArea
        : (currentLocationRow?.floor_area_sqm == null ? "" : String(currentLocationRow.floor_area_sqm));
      return `
        <div class="space-y-5 fade-in">
          <div>
            <div class="text-sm font-semibold text-slate-600">Settings</div>
            <h2 class="mt-1 text-2xl font-extrabold text-slate-900">Integrations</h2>
            <p class="mt-1 text-slate-600 text-sm">Google Sheets server-side sync (Option B) is controlled by the server.</p>
          </div>

          ${
            isAdmin
              ? `
                <div class="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
                  <div class="font-bold text-slate-900">Branding (White-label)</div>
                  <div class="text-sm text-slate-600">Set company name/logo/colors for this install.</div>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label class="text-sm font-semibold text-slate-700">Company name</label>
                      <input id="brand-company-name" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" value="${this.companyName || "Warehouse Tracker"}" />
                    </div>
                    <div>
                      <label class="text-sm font-semibold text-slate-700">Tagline</label>
                      <input id="brand-tagline" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" value="${this.appTagline || "Live inventory • PWA"}" />
                    </div>
                    <div>
                      <label class="text-sm font-semibold text-slate-700">Logo URL (optional)</label>
                      <input id="brand-logo-url" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" value="${this.logoUrl || ""}" placeholder="https://.../logo.png" />
                      <div class="mt-1 text-xs text-slate-500">Use an HTTPS public image URL, or <code>/logo.png</code> if placed in <code>/public</code>.</div>
                    </div>
                    <div>
                      <label class="text-sm font-semibold text-slate-700">Accent color</label>
                      <input id="brand-accent-color" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" value="${this.accentColor || "#3b82f6"}" placeholder="#3b82f6 or #0af" />
                      <div class="mt-1 text-xs text-slate-500">Affects active navigation highlights and primary mobile action.</div>
                    </div>
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                      onclick="app.saveBrandingSettings().catch(e=>app.showToast(e.message || 'Branding save failed','error'))">
                      Save branding
                    </button>
                  </div>
                </div>
              `
              : ""
          }

          <div class="rounded-2xl border border-slate-200 bg-white p-5">
            <div class="font-bold text-slate-900">Google Sheets</div>
            <div class="mt-2 text-sm text-slate-600">Apps Script URL:</div>
            ${
              isAdmin
                ? `
                  <div class="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input id="gs-url-input" class="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono"
                      value="${url || ""}" placeholder="https://script.google.com/macros/s/.../exec" />
                    <button class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                      onclick="app.saveGoogleSheetsUrl().catch(e=>app.showToast(e.message || 'URL save failed','error'))">
                      Save URL
                    </button>
                  </div>
                `
                : `<div class="mt-2 break-all rounded-xl bg-slate-50 p-3 text-sm font-mono text-slate-800">${url || "Not set"}</div>`
            }
            <div class="mt-4 flex flex-wrap gap-2">
              <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                onclick="app.testGoogleSheetsConnection()">
                Test connection
              </button>
              <button class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                onclick="app.syncAllToGoogleSheets()">
                Smart sync
              </button>
            </div>
            ${
              isAdmin
                ? `
                  <div class="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3">
                    <div class="text-sm font-semibold text-slate-800">Auto sync every N minutes</div>
                    <div class="flex flex-wrap items-center gap-3">
                      <label class="inline-flex items-center gap-2 text-sm text-slate-700">
                        <input type="checkbox"
                          ${this.autoSheetsSyncEnabled ? "checked" : ""}
                          onchange="app.autoSheetsSyncEnabled=this.checked;app.render();" />
                        Enable auto sync
                      </label>
                      <input type="number" min="1" max="1440"
                        class="w-28 rounded-xl border border-slate-300 px-3 py-2 text-sm"
                        value="${this.autoSheetsSyncMinutes || "15"}"
                        oninput="app.autoSheetsSyncMinutes=this.value" />
                      <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                        onclick="app.saveAutoSheetsSync().catch(e=>app.showToast(e.message || 'Auto sync save failed','error'))">
                        Save auto sync
                      </button>
                    </div>
                    <div class="text-xs text-slate-500">
                      Status:
                      ${
                        this.autoSheetsSyncState?.enabled
                          ? `Enabled • every ${Number(this.autoSheetsSyncState.minutes || 15)} min • next ${this.autoSheetsSyncState.next_run_at ? new Date(this.autoSheetsSyncState.next_run_at).toLocaleString() : "—"}`
                          : "Disabled"
                      }
                      ${this.autoSheetsSyncState?.last_error ? ` • last error: ${this.autoSheetsSyncState.last_error}` : ""}
                    </div>
                  </div>
                `
                : ""
            }
          </div>

          <div class="rounded-2xl border border-slate-200 bg-white p-5">
            <div class="font-bold text-slate-900">PWA</div>
            <div class="mt-2 text-sm text-slate-600">
              If you’re testing updates, use a hard refresh and ensure you’re not serving an old cached app.js.
            </div>
          </div>

          <div class="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
            <div class="font-bold text-slate-900">Identity Attribution</div>
            <div class="text-sm text-slate-600">
              Choose whether actions are attributed to signed-in account or a per-action operator name.
            </div>
            <div class="flex flex-wrap gap-3 items-center">
              <select class="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                onchange="app.setIdentityMode(this.value)"
              >
                <option value="account" ${this.identityMode === "account" ? "selected" : ""}>Use signed-in account</option>
                <option value="operator_prompt" ${this.identityMode === "operator_prompt" ? "selected" : ""}>Ask operator name per action</option>
              </select>
              <input class="min-w-[220px] rounded-xl border border-slate-300 px-3 py-2 text-sm"
                placeholder="Default operator name (optional)"
                value="${this.operatorName || ""}"
                oninput="app.setOperatorName(this.value)" />
            </div>
          </div>

          ${
            isAdmin
              ? `
                <div class="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
                  <div>
                    <div class="font-bold text-slate-900">Location Capacity & Floor Space</div>
                    <div class="mt-1 text-sm text-slate-600">Rack locations default to 12 pallets. Floor-space sqm can be added now or later.</div>
                  </div>

                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label class="text-sm font-semibold text-slate-700">Location</label>
                      <select id="loc-edit-id" class="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                        onchange="app.selectLocationForEdit(this.value)">
                        ${locationRows.map((r) => `<option value="${String(r.id || "")}" ${String(r.id || "") === currentLocationEditId ? "selected" : ""}>${String(r.id || "")}${r.location_type ? ` (${r.location_type})` : ""}</option>`).join("")}
                      </select>
                    </div>
                    <div>
                      <label class="text-sm font-semibold text-slate-700">Type</label>
                      <input class="mt-1 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm"
                        value="${String(currentLocationRow?.location_type || "")}" readonly />
                    </div>
                    <div>
                      <label class="text-sm font-semibold text-slate-700">Capacity (pallets)</label>
                      <input id="loc-edit-capacity" type="number" min="0" step="1" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                        value="${editCapacity}"
                        oninput="app.setLocationEditField('capacity', this.value)" />
                    </div>
                    <div>
                      <label class="text-sm font-semibold text-slate-700">Floor area (sqm)</label>
                      <input id="loc-edit-floor-area" type="number" min="0" step="0.01" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                        value="${editFloorArea}"
                        oninput="app.setLocationEditField('floor_area', this.value)" />
                    </div>
                  </div>

                  <div class="flex flex-wrap gap-2">
                    <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                      onclick="app.saveLocationMetadataFromSettings().catch(e=>app.showToast(e.message || 'Location save failed','error'))">
                      Save location metadata
                    </button>
                    <button class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                      onclick="app.selectLocationForEdit(document.getElementById('loc-edit-id')?.value || '')">
                      Reset from DB
                    </button>
                  </div>
                </div>
              `
              : ""
          }

          <div class="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
            <div class="font-bold text-slate-900">Security & Release</div>
            <div class="text-sm text-slate-600">Run session controls and database backup from here.</div>
            <div class="flex flex-wrap gap-2">
              <button class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                onclick="app.logoutAllSessions().catch(e=>app.showToast(e.message || 'Logout-all failed','error'))">
                Logout all my sessions
              </button>
              ${
                isAdmin
                  ? `<button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                      onclick="app.runDbBackup().catch(e=>app.showToast(e.message || 'Backup failed','error'))">
                      Create DB backup
                    </button>`
                  : ""
              }
            </div>
          </div>

          <div class="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
            <div>
              <div class="font-bold text-slate-900">Invoicing Groundwork (Weekly)</div>
              <div class="mt-1 text-sm text-slate-600">Per-customer weekly rate + handling fees (flat + per pallet handled).</div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label class="text-sm font-semibold text-slate-700">Customer</label>
                <input id="inv-customer" list="inv-customer-list" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                  value="${this.invoiceForm.customer_name || ""}"
                  onchange="app.onInvoiceCustomerChange(this.value)"
                  placeholder="e.g. COUNCIL" />
                <datalist id="inv-customer-list">
                  ${knownCustomers.map((c) => `<option value="${c}"></option>`).join("")}
                </datalist>
              </div>
              <div>
                <label class="text-sm font-semibold text-slate-700">Currency</label>
                <input id="inv-currency" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                  value="${this.invoiceForm.currency || "GBP"}"
                  oninput="app.setInvoiceFormField('currency', this.value)" />
              </div>
              <div>
                <label class="text-sm font-semibold text-slate-700">Start date</label>
                <input id="inv-start" type="date" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                  value="${this.invoiceForm.start_date || ""}"
                  oninput="app.setInvoiceFormField('start_date', this.value)" />
              </div>
              <div>
                <label class="text-sm font-semibold text-slate-700">End date</label>
                <input id="inv-end" type="date" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                  value="${this.invoiceForm.end_date || ""}"
                  oninput="app.setInvoiceFormField('end_date', this.value)" />
              </div>
              <div>
                <label class="text-sm font-semibold text-slate-700">Rate / pallet / week</label>
                <input id="inv-rate-week" type="number" min="0" step="0.01" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                  value="${this.invoiceForm.rate_per_pallet_week || ""}"
                  oninput="app.setInvoiceFormField('rate_per_pallet_week', this.value)" />
              </div>
              <div>
                <label class="text-sm font-semibold text-slate-700">Handling fee (flat)</label>
                <input id="inv-handling-flat" type="number" min="0" step="0.01" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                  value="${this.invoiceForm.handling_fee_flat || "0"}"
                  oninput="app.setInvoiceFormField('handling_fee_flat', this.value)" />
              </div>
              <div>
                <label class="text-sm font-semibold text-slate-700">Handling fee (per pallet handled)</label>
                <input id="inv-handling-pallet" type="number" min="0" step="0.01" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                  value="${this.invoiceForm.handling_fee_per_pallet || "0"}"
                  oninput="app.setInvoiceFormField('handling_fee_per_pallet', this.value)" />
              </div>
              <div>
                <label class="text-sm font-semibold text-slate-700">Payment terms (days)</label>
                <input id="inv-payment-terms" type="number" min="0" max="365" step="1" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                  value="${this.invoiceForm.payment_terms_days || "7"}"
                  oninput="app.setInvoiceFormField('payment_terms_days', this.value)" />
              </div>
            </div>

            <div class="flex flex-wrap gap-2">
              <button class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                onclick="app.saveCustomerRate().catch(e=>app.showToast(e.message || 'Save rate failed','error'))">
                Save Customer Rate
              </button>
              <button class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                onclick="app.previewInvoice().catch(e=>app.showToast(e.message || 'Preview failed','error'))">
                Preview Invoice
              </button>
              <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                onclick="app.generateInvoice().catch(e=>app.showToast(e.message || 'Generate failed','error'))">
                Generate Invoice
              </button>
            </div>

            ${
              preview
                ? `
                  <div class="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                    <div class="font-bold text-slate-900 mb-2">Invoice Preview ${preview.invoice_id ? `#${preview.invoice_id}` : ""}</div>
                    <div>Customer: <span class="font-semibold">${preview.customer_name}</span></div>
                    <div>Range: <span class="font-semibold">${preview.start_date}</span> to <span class="font-semibold">${preview.end_date}</span></div>
                    <div>Pallet days: <span class="font-semibold">${preview.pallet_days}</span></div>
                    <div>Pallet weeks: <span class="font-semibold">${preview.pallet_weeks}</span></div>
                    <div>Handled pallets: <span class="font-semibold">${preview.handled_pallets}</span></div>
                    <div>Base total: <span class="font-semibold">${preview.currency} ${preview.base_total}</span></div>
                    <div>Handling total: <span class="font-semibold">${preview.currency} ${preview.handling_total}</span></div>
                    <div>Terms: <span class="font-semibold">${preview.payment_terms_days} days</span></div>
                    <div>Due date: <span class="font-semibold">${preview.due_date || "—"}</span></div>
                    <div class="mt-2 text-base">Grand total: <span class="font-extrabold">${preview.currency} ${preview.total}</span></div>
                  </div>
                `
                : ""
            }
          </div>

          ${
            isAdmin
              ? `
                <div class="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
                  <div class="flex items-end justify-between gap-3">
                    <div>
                      <div class="font-bold text-slate-900">User Management (Phase 3.1)</div>
                      <div class="mt-1 text-sm text-slate-600">Create users, set role/scope, and activate/deactivate accounts.</div>
                    </div>
                    <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                      onclick="app.createUserFlow().catch(e=>app.showToast(e.message || 'Create user failed','error'))">
                      New User
                    </button>
                  </div>

                  <div class="wt-table-wrap">
                    <table class="wt-table wt-density-compact">
                      <thead>
                        <tr>
                          <th>ID</th>
                          <th>Username</th>
                          <th>Name</th>
                          <th>Role</th>
                                  <th>Scope</th>
                                  <th>Status</th>
                                  <th>PW Reset</th>
                                  <th>Actions</th>
                                </tr>
                              </thead>
                      <tbody>
                        ${
                          users.length
                            ? users.map((u) => `
                                <tr class="wt-row">
                                  <td class="wt-cell wt-strong">${u.id}</td>
                                  <td class="wt-cell">${u.username || ""}</td>
                                  <td class="wt-cell">${u.display_name || ""}</td>
                                  <td class="wt-cell">${u.role || ""}</td>
                                  <td class="wt-cell">${u.customer_scope || "*"}</td>
                                  <td class="wt-cell">${Number(u.is_active) ? "Active" : "Disabled"}</td>
                                  <td class="wt-cell">${Number(u.must_reset_password || 0) ? "Required" : "No"}</td>
                                  <td class="wt-cell">
                                    <div class="wt-actions">
                                      <button class="wt-btn wt-btn-blue" onclick="app.editUserFlow(${Number(u.id)}).catch(e=>app.showToast(e.message || 'Edit user failed','error'))">Edit</button>
                                      <button class="wt-btn wt-btn-orange" onclick="app.resetUserPasswordFlow(${Number(u.id)}).catch(e=>app.showToast(e.message || 'Reset password failed','error'))">Reset PW</button>
                                      ${Number(u.must_reset_password || 0) ? "" : `<button class="wt-btn wt-btn-yellow" onclick="app.requireUserPasswordReset(${Number(u.id)}).catch(e=>app.showToast(e.message || 'Require reset failed','error'))">Require Reset</button>`}
                                      <button class="wt-btn ${Number(u.is_active) ? "wt-btn-slate" : "wt-btn-green"}" onclick="app.toggleUserActive(${Number(u.id)}, ${Number(u.is_active) ? 0 : 1}).catch(e=>app.showToast(e.message || 'Update status failed','error'))">
                                        ${Number(u.is_active) ? "Disable" : "Enable"}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              `).join("")
                            : `
                              <tr>
                                <td class="wt-cell" colspan="8">
                                  <div class="py-8 text-center text-slate-500">No users found.</div>
                                </td>
                              </tr>
                            `
                        }
                      </tbody>
                    </table>
                  </div>
                </div>
              `
              : ""
          }
        </div>
      `;
    },

    renderLocationQRs() {
      return `
        <div class="space-y-5 fade-in">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div class="text-sm font-semibold text-slate-600">QR tools</div>
              <h2 class="mt-1 text-2xl font-extrabold text-slate-900">Location QR codes</h2>
              <p class="mt-1 text-slate-600 text-sm">Print location labels for scanning.</p>
            </div>
            <div class="flex gap-2">
              <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800" onclick="window.print()">
                Print
              </button>
              <button class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50" onclick="app.setView('scan')">
                Back
              </button>
            </div>
          </div>

          <div id="wt-location-qr-grid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3"></div>
        </div>
      `;
    },

    renderSingleQR() {
      const p = this.tempPallet;
      if (!p) return `<div class="text-slate-600">No pallet selected.</div>`;

      return `
        <div class="max-w-2xl mx-auto space-y-6 fade-in">
          <div class="flex justify-between items-center print:hidden">
            <h2 class="text-2xl font-extrabold text-slate-900">Pallet label</h2>
            <div class="flex gap-2">
              <button onclick="window.print()"
                class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
                Print
              </button>
              <button onclick="app.setView('scan')"
                class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50">
                Back
              </button>
            </div>
          </div>

          <div class="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
            <div id="single-qr-canvas" class="flex justify-center mb-5"></div>
            <div class="text-xl font-extrabold text-slate-900">${p.id}</div>
            <div class="mt-2 space-y-1 text-sm text-slate-700">
              <div><span class="font-semibold">Customer:</span> ${p.customer || ""}</div>
              ${p.product ? `<div><span class="font-semibold">Product:</span> ${p.product}</div>` : ""}
              <div><span class="font-semibold">Pallet qty:</span> ${p.palletQty || 1}</div>
              ${p.productQty > 0 ? `<div><span class="font-semibold">Units/pallet:</span> ${p.productQty}</div>` : ""}
            </div>
          </div>
        </div>
      `;
    },

    // --------------------------
    // Actions
    // --------------------------
    async refreshAll() {
      try {
        this.ensureInvoiceFormDefaults();
        await Promise.allSettled([
          this.loadPallets(),
          this.loadActivity(),
          this.loadLocations(),
          this.loadStats(),
          this.loadSettings(),
          this.loadRates(),
          this.loadInvoices(),
          this.loadInvoiceAging(),
          this.loadAuthUsers(),
          this.loadSystemHealth(),
          this.loadLatestBackup(),
        ]);
        this.lastUpdatedAt = new Date().toLocaleTimeString();
        this._updateTopRightLastUpdated();
        this.render();
      } catch (e) {
        this.showToast(e.message || "Refresh failed", "error");
      }
    },

    async loadPallets() {
      const q = this.selectedCustomer ? `?customer=${encodeURIComponent(this.selectedCustomer)}` : "";
      const data = await apiFetch(`/api/pallets${q}${q ? "&" : "?"}_t=${Date.now()}`.replace("?&", "?"));
      this.pallets = Array.isArray(data) ? data : [];
      this.customers = Array.from(new Set(this.pallets.map((p) => p.customer_name).filter(Boolean))).sort();
    },

    async loadActivity() {
      const q = this.selectedCustomer ? `?customer=${encodeURIComponent(this.selectedCustomer)}` : "";
      const data = await apiFetch(`/api/activity${q}${q ? "&" : "?"}_t=${Date.now()}`.replace("?&", "?"));
      this.activityLog = Array.isArray(data) ? data : [];
    },

    async loadLocations() {
      const data = await apiFetch(`/api/locations?_t=${Date.now()}`);
      this.locations = Array.isArray(data) ? data : [];
    },

    async loadStats() {
      const q = this.selectedCustomer ? `?customer=${encodeURIComponent(this.selectedCustomer)}` : "";
      const data = await apiFetch(`/api/stats${q}${q ? "&" : "?"}_t=${Date.now()}`.replace("?&", "?"));
      this.stats = data || {};
    },

    async loadSettings() {
      try {
        const s = await apiFetch(`/api/settings?_t=${Date.now()}`);
        this.googleSheetsUrl = s?.googleSheetsUrl || s?.appsScriptUrl || this.googleSheetsUrl || "";
        this.companyName = String(s?.companyName || this.companyName || "Warehouse Tracker");
        this.appTagline = String(s?.appTagline || this.appTagline || "Live inventory • PWA");
        this.logoUrl = String(s?.logoUrl || this.logoUrl || "");
        this.accentColor = String(s?.accentColor || this.accentColor || "#3b82f6");
        this.authDisabled = Number(s?.authDisabled || 0) === 1;
        this.autoSheetsSyncEnabled = Number(s?.autoSheetsSyncEnabled || 0) === 1;
        this.autoSheetsSyncMinutes = String(Number(s?.autoSheetsSyncMinutes || 15));
        this.autoSheetsSyncState = s?.autoSheetsSyncState || null;
        if (this.authDisabled) this.identityMode = "operator_prompt";
        this.applyBrandingTheme();
      } catch {
        // non-fatal
      }
    },

    async saveBrandingSettings() {
      const companyName = String(document.getElementById("brand-company-name")?.value || "").trim() || "Warehouse Tracker";
      const appTagline = String(document.getElementById("brand-tagline")?.value || "").trim() || "Live inventory • PWA";
      const logoUrl = String(document.getElementById("brand-logo-url")?.value || "").trim();
      const accentColorRaw = String(document.getElementById("brand-accent-color")?.value || "").trim();
      const accentColor = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(accentColorRaw) ? accentColorRaw : "#3b82f6";
      if (logoUrl && /^http:\/\//i.test(logoUrl)) {
        this.showToast("Use an HTTPS logo URL (http:// logos are blocked on secure app pages).", "error");
        return;
      }

      const res = await apiFetch("/api/settings/branding", {
        method: "POST",
        body: JSON.stringify({ companyName, appTagline, logoUrl, accentColor }),
      });
      this.companyName = String(res?.companyName || companyName);
      this.appTagline = String(res?.appTagline || appTagline);
      this.logoUrl = String(res?.logoUrl || logoUrl);
      this.accentColor = String(res?.accentColor || accentColor);
      this.applyBrandingTheme();
      this.showToast("Branding settings saved", "success");
      this.render();
    },

    async saveGoogleSheetsUrl() {
      const input = document.getElementById("gs-url-input");
      const url = String(input?.value || "").trim();
      if (url && !/^https:\/\//i.test(url)) {
        throw new Error("Google Sheets URL must start with https://");
      }
      const res = await apiFetch("/api/settings/google-sheets", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      this.googleSheetsUrl = String(res?.googleSheetsUrl || "");
      this.showToast(this.googleSheetsUrl ? "Google Sheets URL saved" : "Google Sheets URL cleared", "success");
      this.render();
    },

    async saveAutoSheetsSync() {
      const minutes = Math.max(1, Math.min(1440, Number(this.autoSheetsSyncMinutes || 15) || 15));
      const enabled = this.autoSheetsSyncEnabled ? 1 : 0;
      const res = await apiFetch("/api/settings/sheets-auto", {
        method: "POST",
        body: JSON.stringify({ enabled, minutes }),
      });
      this.autoSheetsSyncEnabled = Number(res?.autoSheetsSyncEnabled || 0) === 1;
      this.autoSheetsSyncMinutes = String(Number(res?.autoSheetsSyncMinutes || minutes));
      this.autoSheetsSyncState = res?.autoSheetsSyncState || null;
      this.showToast(`Auto sync ${this.autoSheetsSyncEnabled ? "enabled" : "disabled"} (${this.autoSheetsSyncMinutes} min)`, "success");
      this.render();
    },

    selectLocationForEdit(locationId) {
      const selectedId = String(locationId || "").trim();
      const rows = Array.isArray(this.locations) ? this.locations : [];
      const fallbackId = String(rows[0]?.id || "");
      const nextId = selectedId || fallbackId;
      const row = rows.find((r) => String(r.id || "") === nextId) || null;

      this.locationEditId = nextId;
      this.locationEditCapacity = row?.capacity_pallets == null ? "" : String(row.capacity_pallets);
      this.locationEditFloorArea = row?.floor_area_sqm == null ? "" : String(row.floor_area_sqm);
      this.render();
    },

    setLocationEditField(field, value) {
      if (field === "capacity") {
        this.locationEditCapacity = String(value ?? "");
        return;
      }
      if (field === "floor_area") {
        this.locationEditFloorArea = String(value ?? "");
      }
    },

    async saveLocationMetadataFromSettings() {
      const selectEl = document.getElementById("loc-edit-id");
      const selectedId = String(selectEl?.value || this.locationEditId || "").trim();
      if (!selectedId) throw new Error("Select a location first");

      const rows = Array.isArray(this.locations) ? this.locations : [];
      const current = rows.find((r) => String(r.id || "") === selectedId) || null;
      const capacityText = String(this.locationEditCapacity ?? "").trim();
      const floorAreaText = String(this.locationEditFloorArea ?? "").trim();

      if (capacityText !== "" && !/^\d+$/.test(capacityText)) {
        throw new Error("Capacity must be a whole number or blank");
      }
      if (floorAreaText !== "" && !/^\d+(?:\.\d{1,2})?$/.test(floorAreaText)) {
        throw new Error("Floor area must be a number (up to 2 decimals) or blank");
      }

      const payload = {
        id: selectedId,
        aisle: current?.aisle ?? null,
        rack: current?.rack ?? null,
        level: current?.level ?? null,
        location_type: String(current?.location_type || "custom").trim().toLowerCase() || "custom",
        capacity_pallets: capacityText === "" ? null : Number(capacityText),
        floor_area_sqm: floorAreaText === "" ? null : Number(floorAreaText),
      };

      const res = await apiFetch("/api/admin/locations/upsert", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      await this.loadLocations();
      this.locationEditId = selectedId;
      const row = this.locations.find((r) => String(r.id || "") === selectedId) || res?.location || null;
      this.locationEditCapacity = row?.capacity_pallets == null ? "" : String(row.capacity_pallets);
      this.locationEditFloorArea = row?.floor_area_sqm == null ? "" : String(row.floor_area_sqm);
      this.showToast("Location " + selectedId + " saved", "success");
      this.render();
    },
    async loadCurrentUser() {
      try {
        const me = await apiFetch(`/api/auth/me?_t=${Date.now()}`);
        if (me?.user) {
          this.currentUser = me.user;
          this.forcePasswordReset = Number(me.user.must_reset_password || 0) === 1;
          this.actorId = me.user.username || this.actorId || "ops-user";
          try {
            localStorage.setItem("wt_actor_id", this.actorId);
            localStorage.setItem("wt_user_role", String(me.user.role || "ops"));
          } catch {}
          return true;
        }
      } catch {
        // ignore
      }
      this.currentUser = null;
      this.forcePasswordReset = false;
      return false;
    },

    async loadAuthUsers() {
      try {
        const role = String(this.currentUser?.role || "").toLowerCase();
        if (!["owner", "admin"].includes(role)) {
          this.authUsers = [];
          return;
        }
        const users = await apiFetch(`/api/auth/users?_t=${Date.now()}`);
        this.authUsers = Array.isArray(users) ? users : [];
      } catch {
        this.authUsers = [];
      }
    },

    async loadSystemHealth() {
      try {
        const h = await apiFetch(`/api/health?_t=${Date.now()}`);
        this.systemHealth = h && typeof h === "object" ? h : null;
      } catch {
        this.systemHealth = null;
      }
    },

    async loadLatestBackup() {
      try {
        const role = String(this.currentUser?.role || "").toLowerCase();
        if (!["owner", "admin"].includes(role)) {
          this.latestBackup = null;
          return;
        }
        const r = await apiFetch(`/api/admin/backups/latest?_t=${Date.now()}`);
        this.latestBackup = r?.latest || null;
      } catch {
        this.latestBackup = null;
      }
    },

    async login(username, password) {
      const u = String(username || "").trim();
      const p = String(password || "");
      if (!u || !p) throw new Error("Username and password are required");

      const res = await apiFetch(`/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ username: u, password: p }),
      });
      if (!res?.token || !res?.user) throw new Error("Invalid login response");
      try {
        localStorage.setItem("wt_auth_token", res.token);
        localStorage.setItem("wt_actor_id", String(res.user.username || "ops-user"));
        localStorage.setItem("wt_user_role", String(res.user.role || "ops"));
      } catch {}
      this.currentUser = res.user;
      this.forcePasswordReset = Number(res.user.must_reset_password || 0) === 1;
      this.actorId = String(res.user.username || "ops-user");
      this.authLoading = false;
      if (!this.forcePasswordReset) {
        await this.refreshAll();
        if (!this.socket) this.connectSocket();
      }
      this.render();
    },

    async loginFromForm() {
      const u = document.getElementById("auth-username");
      const p = document.getElementById("auth-password");
      const username = String(u?.value || "").trim();
      const password = String(p?.value || "");
      await this.login(username, password);
      this.showToast(`Signed in as ${username}`, "success");
    },

    async logout() {
      if (this.authDisabled) {
        this.showToast("Shared mode is enabled. Sign-out is disabled.", "info");
        return;
      }
      try {
        await apiFetch(`/api/auth/logout`, { method: "POST", body: JSON.stringify({}) });
      } catch {
        // ignore
      }
      try {
        if (this.socket) {
          this.socket.disconnect();
          this.socket = null;
        }
      } catch {}
      try {
        localStorage.removeItem("wt_auth_token");
      } catch {}
      this.currentUser = null;
      this.forcePasswordReset = false;
      this.authLoading = false;
      this.scanMode = null;
      this.render();
    },

    async logoutAllSessions() {
      await apiFetch(`/api/auth/logout-all`, { method: "POST", body: JSON.stringify({}) });
      this.showToast("All sessions logged out. Please sign in again.", "success");
      await this.logout();
    },

    async runDbBackup() {
      const res = await apiFetch(`/api/admin/backup-db`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await this.loadLatestBackup();
      await this.loadSystemHealth();
      this.showToast(`Backup created: ${res.file || "ok"}`, "success");
      this.render();
    },

    setIdentityMode(mode) {
      const next = mode === "operator_prompt" ? "operator_prompt" : "account";
      this.identityMode = next;
      try {
        localStorage.setItem("wt_identity_mode", next);
      } catch {}
      this.render();
    },

    setOperatorName(name) {
      this.operatorName = String(name || "");
      try {
        localStorage.setItem("wt_operator_name", this.operatorName);
      } catch {}
    },

    async changeOwnPassword(currentPassword, newPassword) {
      const current = String(currentPassword || "");
      const next = String(newPassword || "");
      if (!current || !next) throw new Error("Current and new passwords are required");
      if (next.length < 8) throw new Error("New password must be at least 8 characters");

      await apiFetch("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          current_password: current,
          new_password: next,
        }),
      });
      const ok = await this.loadCurrentUser();
      this.forcePasswordReset = false;
      if (ok) {
        await this.refreshAll();
        if (!this.socket) this.connectSocket();
      }
      this.showToast("Password updated", "success");
      this.render();
    },

    async changeOwnPasswordFromForm() {
      const cur = document.getElementById("pw-current");
      const nxt = document.getElementById("pw-new");
      await this.changeOwnPassword(String(cur?.value || ""), String(nxt?.value || ""));
    },

    _findAuthUser(userId) {
      const id = Number(userId);
      return (this.authUsers || []).find((u) => Number(u.id) === id) || null;
    },

    async createUserFlow() {
      const username = await this.prompt("New user", "Username:");
      if (username === null) return;
      const cleanUsername = String(username || "").trim();
      if (!cleanUsername) return this.showToast("Username is required", "error");

      const displayName = await this.prompt("New user", "Display name:", cleanUsername);
      if (displayName === null) return;

      const role = await this.prompt("New user", "Role (owner/admin/ops/viewer):", "ops");
      if (role === null) return;
      const cleanRole = String(role || "").trim().toLowerCase();

      const scope = await this.prompt("New user", "Customer scope (* or comma list):", "*");
      if (scope === null) return;

      const password = await this.prompt("New user", "Temporary password (min 8 chars):", "");
      if (password === null) return;
      const cleanPassword = String(password || "");
      if (cleanPassword.length < 8) return this.showToast("Password must be at least 8 characters", "error");

      await apiFetch("/api/auth/users", {
        method: "POST",
        body: JSON.stringify({
          username: cleanUsername,
          password: cleanPassword,
          role: cleanRole,
          display_name: String(displayName || "").trim() || cleanUsername,
          customer_scope: String(scope || "*").trim() || "*",
          is_active: 1,
        }),
      });

      await this.loadAuthUsers();
      this.showToast(`User ${cleanUsername} created`, "success");
      this.render();
    },

    async editUserFlow(userId) {
      const user = this._findAuthUser(userId);
      if (!user) return this.showToast("User not found", "error");

      const displayName = await this.prompt("Edit user", `Display name for ${user.username}:`, user.display_name || user.username);
      if (displayName === null) return;

      const role = await this.prompt("Edit user", `Role for ${user.username}:`, user.role || "ops");
      if (role === null) return;

      const scope = await this.prompt("Edit user", `Customer scope for ${user.username}:`, user.customer_scope || "*");
      if (scope === null) return;

      await apiFetch(`/api/auth/users/${Number(user.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          display_name: String(displayName || "").trim(),
          role: String(role || "").trim().toLowerCase(),
          customer_scope: String(scope || "*").trim() || "*",
        }),
      });

      await this.loadAuthUsers();
      this.showToast(`User ${user.username} updated`, "success");
      this.render();
    },

    async resetUserPasswordFlow(userId) {
      const user = this._findAuthUser(userId);
      if (!user) return this.showToast("User not found", "error");
      const password = await this.prompt("Reset password", `New password for ${user.username}:`, "");
      if (password === null) return;
      const cleanPassword = String(password || "");
      if (cleanPassword.length < 8) return this.showToast("Password must be at least 8 characters", "error");

      await apiFetch(`/api/auth/users/${Number(user.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ password: cleanPassword }),
      });

      await this.loadAuthUsers();
      this.showToast(`Password reset for ${user.username}`, "success");
      this.render();
    },

    async requireUserPasswordReset(userId) {
      const user = this._findAuthUser(userId);
      if (!user) return this.showToast("User not found", "error");

      await apiFetch(`/api/auth/users/${Number(user.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ must_reset_password: 1 }),
      });

      await this.loadAuthUsers();
      this.showToast(`Password reset required for ${user.username}`, "success");
      this.render();
    },

    async toggleUserActive(userId, nextActive) {
      const user = this._findAuthUser(userId);
      if (!user) return this.showToast("User not found", "error");
      if (Number(user.id) === Number(this.currentUser?.id) && !Number(nextActive)) {
        return this.showToast("You cannot disable your own account", "error");
      }

      await apiFetch(`/api/auth/users/${Number(user.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: Number(nextActive) ? 1 : 0 }),
      });

      await this.loadAuthUsers();
      this.showToast(`User ${user.username} ${Number(nextActive) ? "enabled" : "disabled"}`, "success");
      this.render();
    },

    async loadRates() {
      try {
        const data = await apiFetch(`/api/rates?_t=${Date.now()}`);
        this.rates = Array.isArray(data) ? data : [];
      } catch {
        this.rates = [];
      }
    },

    async loadInvoices() {
      try {
        const data = await apiFetch(`/api/invoices?_t=${Date.now()}`);
        this.invoices = Array.isArray(data) ? data : [];
      } catch {
        this.invoices = [];
      }
    },

    async loadInvoiceAging() {
      try {
        const data = await apiFetch(`/api/invoices/aging?_t=${Date.now()}`);
        this.invoiceAging = data && typeof data === "object" ? data : this.invoiceAging;
      } catch {
        this.invoiceAging = this.invoiceAging || { buckets: {}, total_outstanding: 0, total_count: 0 };
      }
    },

    _normalizedInvoiceStatus(status) {
      const s = String(status || "").trim().toUpperCase();
      if (s === "PAID") return "PAID";
      if (s === "SENT") return "SENT";
      return "DRAFT";
    },

    _parseYmdToUtcMs(ymd) {
      const s = String(ymd || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
      return Date.parse(`${s}T00:00:00Z`);
    },

    _invoiceIsOverdue(inv) {
      const status = this._normalizedInvoiceStatus(inv?.status);
      if (status === "PAID") return false;
      const balance = Math.max(0, (Number(inv?.total) || 0) - (Number(inv?.amount_paid) || 0));
      if (balance <= 0) return false;
      const dueMs = this._parseYmdToUtcMs(inv?.due_date);
      if (!Number.isFinite(dueMs)) return false;
      const now = new Date();
      const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      return dueMs < todayStartMs;
    },

    _invoiceDueLabel(inv) {
      const due = String(inv?.due_date || "").trim();
      if (!due) return "—";
      if (!this._invoiceIsOverdue(inv)) return due;
      const dueMs = this._parseYmdToUtcMs(due);
      if (!Number.isFinite(dueMs)) return due;
      const now = new Date();
      const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const days = Math.max(1, Math.floor((todayStartMs - dueMs) / (24 * 60 * 60 * 1000)));
      return `${due} (${days}d overdue)`;
    },

    ensureInvoiceFormDefaults() {
      const week = wtCurrentWeekRange();
      if (!this.invoiceForm.start_date) this.invoiceForm.start_date = week.start;
      if (!this.invoiceForm.end_date) this.invoiceForm.end_date = week.end;
      if (!this.invoiceForm.currency) this.invoiceForm.currency = "GBP";
      if (!this.invoiceForm.payment_terms_days) this.invoiceForm.payment_terms_days = "7";
      if (this.invoiceForm.handling_fee_flat === "") this.invoiceForm.handling_fee_flat = "0";
      if (this.invoiceForm.handling_fee_per_pallet === "") this.invoiceForm.handling_fee_per_pallet = "0";
    },

    setInvoiceFormField(key, value) {
      if (!this.invoiceForm || typeof this.invoiceForm !== "object") return;
      this.invoiceForm[key] = String(value ?? "");
    },

    onInvoiceCustomerChange(value) {
      const customerName = String(value || "").trim();
      this.setInvoiceFormField("customer_name", customerName);
      if (!customerName) {
        this.render();
        return;
      }

      const match = (this.rates || []).find(
        (r) => String(r.customer_name || "").toLowerCase() === customerName.toLowerCase()
      );
      if (match) {
        this.invoiceForm.rate_per_pallet_week = String(Number(match.rate_per_pallet_week || 0));
        this.invoiceForm.handling_fee_flat = String(Number(match.handling_fee_flat || 0));
        this.invoiceForm.handling_fee_per_pallet = String(Number(match.handling_fee_per_pallet || 0));
        this.invoiceForm.payment_terms_days = String(Number(match.payment_terms_days ?? 7));
        this.invoiceForm.currency = String(match.currency || "GBP");
      }
      this.render();
    },

    _readInvoiceInputs() {
      this.ensureInvoiceFormDefaults();

      const customerName = String(this.invoiceForm.customer_name || "").trim();
      const startDate = String(this.invoiceForm.start_date || "").trim();
      const endDate = String(this.invoiceForm.end_date || "").trim();
      const ratePerWeekRaw = String(this.invoiceForm.rate_per_pallet_week || "").trim();
      const handlingFlatRaw = String(this.invoiceForm.handling_fee_flat || "").trim();
      const handlingPerPalletRaw = String(this.invoiceForm.handling_fee_per_pallet || "").trim();
      const paymentTermsRaw = String(this.invoiceForm.payment_terms_days || "").trim();
      const currency = String(this.invoiceForm.currency || "GBP").trim() || "GBP";

      return {
        customer_name: customerName,
        start_date: startDate,
        end_date: endDate,
        rate_per_pallet_week: ratePerWeekRaw === "" ? undefined : Number(ratePerWeekRaw),
        handling_fee_flat: handlingFlatRaw === "" ? undefined : Number(handlingFlatRaw),
        handling_fee_per_pallet: handlingPerPalletRaw === "" ? undefined : Number(handlingPerPalletRaw),
        payment_terms_days: paymentTermsRaw === "" ? undefined : Number(paymentTermsRaw),
        currency,
      };
    },

    async saveCustomerRate() {
      const payload = this._readInvoiceInputs();
      if (!payload.customer_name) return this.showToast("Customer is required", "error");
      if (!Number.isFinite(payload.rate_per_pallet_week) || payload.rate_per_pallet_week < 0) {
        return this.showToast("Enter a valid weekly rate", "error");
      }
      if (payload.handling_fee_flat != null && (!Number.isFinite(payload.handling_fee_flat) || payload.handling_fee_flat < 0)) {
        return this.showToast("Enter a valid flat handling fee", "error");
      }
      if (payload.handling_fee_per_pallet != null && (!Number.isFinite(payload.handling_fee_per_pallet) || payload.handling_fee_per_pallet < 0)) {
        return this.showToast("Enter a valid per-pallet handling fee", "error");
      }
      if (!Number.isInteger(payload.payment_terms_days) || payload.payment_terms_days < 0 || payload.payment_terms_days > 365) {
        return this.showToast("Payment terms must be 0-365 days", "error");
      }

      await apiFetch("/api/rates", {
        method: "POST",
        body: JSON.stringify({
          customer_name: payload.customer_name,
          rate_per_pallet_week: payload.rate_per_pallet_week,
          handling_fee_flat: payload.handling_fee_flat || 0,
          handling_fee_per_pallet: payload.handling_fee_per_pallet || 0,
          payment_terms_days: payload.payment_terms_days,
          currency: payload.currency || "GBP",
        }),
      });

      this.showToast("Customer rate saved", "success");
      await this.loadRates();
      this.render();
    },

    async previewInvoice() {
      const payload = this._readInvoiceInputs();
      if (!payload.customer_name || !payload.start_date || !payload.end_date) {
        return this.showToast("Customer + start/end dates are required", "error");
      }

      const preview = await apiFetch("/api/invoices/preview", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      this.invoicePreview = preview;
      this.showToast("Invoice preview updated", "success");
      this.render();
    },

    async generateInvoice() {
      const payload = this._readInvoiceInputs();
      if (!payload.customer_name || !payload.start_date || !payload.end_date) {
        return this.showToast("Customer + start/end dates are required", "error");
      }

      const generated = await apiFetch("/api/invoices/generate", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      await this.loadInvoices();
      await this.loadInvoiceAging();
      this.invoicePreview = generated;
      this.showToast(`Invoice #${generated.invoice_id} created`, "success");
      this.render();
    },

    async setInvoiceStatus(invoiceId, status) {
      const id = Number(invoiceId);
      if (!Number.isInteger(id) || id <= 0) return;
      const nextStatus = this._normalizedInvoiceStatus(status);

      await apiFetch(`/api/invoices/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: nextStatus }),
      });

      await this.loadInvoices();
      await this.loadInvoiceAging();
      this.showToast(`Invoice #${id} set to ${nextStatus}`, "success");
      this.render();
    },

    async recordInvoicePayment(invoiceId) {
      const id = Number(invoiceId);
      const inv = (this.invoices || []).find((r) => Number(r.id) === id);
      if (!inv) return this.showToast("Invoice not found", "error");

      const balance = Math.max(0, Number(inv.total || 0) - Number(inv.amount_paid || 0));
      if (balance <= 0) return this.showToast("Invoice already fully paid", "info");

      const amountStr = await this.prompt("Record payment", `Amount received for invoice #${id} (max ${inv.currency || "GBP"} ${balance.toFixed(2)}):`, balance.toFixed(2));
      if (amountStr === null) return;
      const amount = Number(amountStr);
      if (!Number.isFinite(amount) || amount <= 0) return this.showToast("Enter a valid payment amount", "error");

      const note = await this.prompt("Payment note (optional)", "Reference / bank note:", "");
      if (note === null) return;

      await apiFetch(`/api/invoices/${id}/payments`, {
        method: "POST",
        body: JSON.stringify({
          amount,
          note: String(note || "").trim(),
        }),
      });

      await this.loadInvoices();
      await this.loadInvoiceAging();
      this.showToast(`Payment recorded on invoice #${id}`, "success");
      this.render();
    },

    exportInvoiceCsv(invoiceId) {
      const id = Number(invoiceId);
      const inv = (this.invoices || []).find((r) => Number(r.id) === id);
      if (!inv) {
        this.showToast("Invoice not found", "error");
        return;
      }

      let details = {};
      try {
        details = inv.details_json ? JSON.parse(inv.details_json) : {};
      } catch {
        details = {};
      }

      const rows = [
        ["invoice_id", inv.id],
        ["status", this._normalizedInvoiceStatus(inv.status)],
        ["customer_name", inv.customer_name || ""],
        ["start_date", inv.start_date || ""],
        ["end_date", inv.end_date || ""],
        ["currency", inv.currency || "GBP"],
        ["pallet_days", Number(inv.pallet_days || 0)],
        ["pallet_weeks", Number(details.pallet_weeks || (Number(inv.pallet_days || 0) / 7)).toFixed(4)],
        ["handled_pallets", Number(inv.handled_pallets || details.handled_pallets || 0)],
        ["rate_per_pallet_week", Number(inv.rate_per_pallet_week || 0).toFixed(2)],
        ["base_total", Number(inv.base_total || 0).toFixed(2)],
        ["handling_total", Number(inv.handling_total || 0).toFixed(2)],
        ["total", Number(inv.total || 0).toFixed(2)],
        ["payment_terms_days", Number(inv.payment_terms_days || 7)],
        ["due_date", inv.due_date || ""],
        ["amount_paid", Number(inv.amount_paid || 0).toFixed(2)],
        ["balance_due", Math.max(0, Number(inv.total || 0) - Number(inv.amount_paid || 0)).toFixed(2)],
        ["payment_status", inv.payment_status || ""],
        ["created_at", inv.created_at || ""],
        ["sent_at", inv.sent_at || ""],
        ["paid_at", inv.paid_at || ""],
      ];

      const csv = rows
        .map(([k, v]) => `${JSON.stringify(String(k))},${JSON.stringify(String(v ?? ""))}`)
        .join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice-${inv.id || "export"}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      this.showToast(`Invoice #${inv.id} exported`, "success");
    },

    search(term) {
      this.searchTerm = String(term || "");
      this.render();
    },

    applyTrackerSearchFromInput() {
      const input = document.getElementById("search-input");
      this.search(input ? String(input.value || "") : "");
    },

    clearTrackerSearch() {
      this.search("");
    },

    async testGoogleSheetsConnection() {
      try {
        await apiFetch("/api/sheets/test", { method: "POST", body: JSON.stringify({}) });
        this.showToast("Google Sheets: connection OK", "success");
      } catch (e) {
        this.showToast(`Google Sheets test failed: ${e.message}`, "error");
      }
    },

    async syncAllToGoogleSheets() {
      try {
        await apiFetch("/api/sheets/sync", { method: "POST", body: JSON.stringify({}) });
        this.showToast("Google Sheets: sync triggered", "success");
      } catch (e) {
        this.showToast(`Sync failed: ${e.message}`, "error");
      }
    },

    // --------------------------
    // Manual entry (includes parts list)
    // --------------------------

  async showManualEntry() {
    const modalHtml = `
      <p class="text-sm text-slate-600 mb-5">
        Create a new pallet record without scanning (same as a pallet check-in).
      </p>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label class="text-sm font-semibold text-slate-700">Customer</label>
          <input data-modal-field="customer" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="e.g. COUNCIL" />
        </div>

        <div>
          <label class="text-sm font-semibold text-slate-700">Product ID</label>
          <input data-modal-field="productId" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="e.g. 715326" />
        </div>

        <div>
          <label class="text-sm font-semibold text-slate-700">Pallet qty</label>
          <input data-modal-field="palletQty" type="number" min="1"
            class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
            value="1" />
        </div>

        <div>
          <label class="text-sm font-semibold text-slate-700">Units / pallet (optional)</label>
          <input data-modal-field="unitsPerPallet" type="number" min="0"
            class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
            value="0" />
        </div>

        <div class="md:col-span-2">
          <label class="text-sm font-semibold text-slate-700">Location</label>
          <input data-modal-field="location" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="e.g. A1-L3" />
        </div>

        <div class="md:col-span-2">
          <label class="text-sm font-semibold text-slate-700">Parts list (optional)</label>
          <textarea data-modal-field="partsText" rows="5"
            class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm"
            placeholder="One per line (e.g.)
PART-001 x 10
PART-ABC x 2"></textarea>
          <div class="mt-1 text-xs text-slate-500">This will be saved with the pallet record.</div>
        </div>
      </div>
    `;

    const res = await this.showModal("Manual entry", modalHtml, [
      { label: "Cancel", value: "cancel", className: "rounded-xl bg-slate-100 px-4 py-2 font-semibold text-slate-800 hover:bg-slate-200" },
      { label: "Create", value: "create", className: "rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700" },
    ]);

    if (!res || res.cancelled || res.action !== "create") return;

    const customerName = (res.fields.customer || "").trim();
    const productId = (res.fields.productId || "").trim();
    const palletQuantity = Number(res.fields.palletQty || 1) || 1;
    const productQuantity = Number(res.fields.unitsPerPallet || 0) || 0;
    const location = (res.fields.location || "").trim();
    const partsText = (res.fields.partsText || "").trim();

    if (!customerName) return this.showToast("Customer is required", "error");
    if (!productId) return this.showToast("Product ID is required", "error");
    if (!location) return this.showToast("Location is required", "error");

    const parts = partsText ? this.parsePartsList(partsText) : null;

    await this.checkIn(customerName, productId, palletQuantity, productQuantity, location, parts, "Manual entry");
  },

    // --------------------------
    // Generate pallet QR (modal)
    // --------------------------
    async generatePalletQR() {
      const suggestedId = `P-${Date.now()}`;

      const modalHtml = `
        <p class="text-sm text-slate-600 mb-5">
          Create a printable pallet label. Customer + product can be stored in the QR for fast check-in.
        </p>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="text-sm font-semibold text-slate-700">Pallet ID</label>
            <input data-modal-field="palletId" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
              value="${suggestedId}" />
            <div class="mt-1 text-xs text-slate-500">Leave as suggested unless you already have an ID.</div>
          </div>

          <div>
            <label class="text-sm font-semibold text-slate-700">Pallet qty</label>
            <input data-modal-field="palletQty" type="number" min="1"
              class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
              value="1" />
          </div>

          <div>
            <label class="text-sm font-semibold text-slate-700">Customer (stored in QR)</label>
            <input data-modal-field="customer" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="e.g. COUNCIL" />
          </div>

          <div>
            <label class="text-sm font-semibold text-slate-700">Product ID (stored in QR)</label>
            <input data-modal-field="productId" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="e.g. 715326" />
          </div>

          <div class="md:col-span-2">
            <label class="text-sm font-semibold text-slate-700">Units per pallet (optional)</label>
            <input data-modal-field="unitsPerPallet" type="number" min="0"
              class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
              value="0" />
          </div>
        </div>

        <div class="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          Tip: storing customer + product in the QR means staff can scan the pallet and most fields can auto-fill on check-in.
        </div>
      `;

      const res = await this.showModal("Generate pallet QR", modalHtml, [
        { label: "Cancel", value: "cancel", className: "rounded-xl bg-slate-100 px-4 py-2 font-semibold text-slate-800 hover:bg-slate-200" },
        { label: "Create QR", value: "create", className: "rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700" },
      ]);

      if (!res || res.cancelled || res.action !== "create") return;

      const palletId = String(res.fields.palletId || "").trim();
      const customer = String(res.fields.customer || "").trim();
      const productId = String(res.fields.productId || "").trim();
      const palletQty = Number(res.fields.palletQty || 1) || 1;
      const unitsPerPallet = Number(res.fields.unitsPerPallet || 0) || 0;

      if (!palletId) {
        this.showToast("Pallet ID is required", "error");
        return;
      }

      const qrText = wtMakePalletQrPayload({ id: palletId, customer, productId, unitsPerPallet });

      this.tempPallet = {
        id: palletId,
        customer,
        product: productId,
        palletQty,
        productQty: unitsPerPallet,
        _qrText: qrText,
      };

      this.setView("single-qr");
    },

    generateLocationQRs() {
      this.setView("location-qrs");
    },

    // --------------------------
    // Scanner flow
    // --------------------------
    async startScanner(mode) {
      await this.stopScanner(true);

      this.scanMode = mode;
      this._scannedPallet = null;
      this._scanBusy = false;
      this._lastScanText = "";
      this._lastScanAt = 0;
      this.render();

      // Must exist globally: Html5Qrcode
      if (typeof Html5Qrcode === "undefined") {
        this.showToast("html5-qrcode library not loaded", "error");
        return;
      }

      const el = document.getElementById("qr-reader");
      if (!el) return;

      this.scanner = new Html5Qrcode("qr-reader");

      const onScanSuccess = async (decodedText) => {
        try {
          await this._handleScan(decodedText);
        } catch (e) {
          this.showToastDedup(e.message || "Scan failed", "error", 2500);
        }
      };

      try {
        await this.scanner.start(
          { facingMode: "environment" },
          { fps: 8, qrbox: { width: 240, height: 240 } },
          onScanSuccess
        );
      } catch (e) {
        this.showToast(`Camera start failed: ${e.message || e}`, "error");
        this.scanMode = null;
        this.render();
      }
    },

    async stopScanner(silent = false) {
      try {
        if (this.scanner) {
          const s = this.scanner;
          this.scanner = null;
          if (s.isScanning) await s.stop();
          await s.clear();
        }
      } catch {
        // ignore
      } finally {
        this.scanMode = null;
        this._scannedPallet = null;
        this._scanBusy = false;
        this._lastScanText = "";
        this._lastScanAt = 0;
        if (!silent) this.render();
      }
    },

    async _handleScan(text) {
      const raw = String(text || "").trim();
      if (!raw || this._scanBusy) return;

      const now = Date.now();
      if (this._lastScanText === raw && now - this._lastScanAt < 1200) return;

      this._scanBusy = true;
      this._lastScanText = raw;
      this._lastScanAt = now;

      try {
      const parsedPallet = wtParsePalletQr(raw);
      const looksLikePalletQr = !!parsedPallet?.id && parsedPallet?._format === "wt-v1";

      // CHECK IN FLOW
      if (this.scanMode === "checkin-pallet") {
        const payload = parsedPallet;
        if (!payload?.id) {
          this.showToastDedup("Invalid pallet QR", "error");
          return;
        }
        this._scannedPallet = payload;
        this.showToastDedup(`Pallet scanned: ${payload.id}`, "success", 1200);

        // next step: location scan
        this.scanMode = "checkin-location";
        this._syncScannerUi();
        return;
      }

      if (this.scanMode === "checkin-location") {
        if (looksLikePalletQr) {
          this.showToastDedup("That is a pallet QR. Now scan the location label.", "info", 2500);
          return;
        }
        const loc = String(raw || "").trim().replace(/\s+/g, " ").toUpperCase();
        if (!loc) return;

        const pal = this._scannedPallet;
        if (!pal?.id) {
          this.showToast("Missing pallet step. Scan pallet first.", "error");
          return;
        }

        const knownLocations = new Set((this.locations || []).map((x) => String(x.id || "").toUpperCase()).filter(Boolean));
        if (knownLocations.size > 0 && !knownLocations.has(loc)) {
          this.showToastDedup(`Unknown location: ${loc}`, "error", 2500);
          return;
        }

        // Stop camera before opening prompts to avoid duplicate scans.
        await this.stopScanner(true);

        // If QR includes customer/product/units, use them. Otherwise prompt user.
        let customer = pal.customer || "";
        let productId = pal.productId || "";
        let unitsPerPallet = pal.unitsPerPallet || 0;

        if (!customer) {
          const v = await this.prompt("Customer Name", "Customer name:");
          if (v === null) return this.setView("scan");
          customer = String(v).trim();
        }
        if (!productId) {
          const v = await this.prompt("Product ID", "Product ID:");
          if (v === null) return this.setView("scan");
          productId = String(v).trim();
        }
        if (!pal.hasUnitsPerPallet) {
          const v = await this.prompt("Units per pallet (optional)", "Units per pallet (0 if not tracking):", "0");
          if (v === null) return this.setView("scan");
          unitsPerPallet = Number(v) || 0;
        }

        const palletQtyStr = await this.prompt("Pallet quantity", "How many pallets for this entry?", "1");
        if (palletQtyStr === null) return this.setView("scan");
        const palletQty = parseInt(palletQtyStr, 10) || 1;

        await this.checkIn(customer, productId, palletQty, unitsPerPallet, loc, null, "Scan", pal.id);
        this.setView("tracker");
        return;
      }

      // CHECK OUT FLOW (whole entry)
      if (this.scanMode === "checkout") {
        const payload = parsedPallet;
        const id = payload?.id || String(text).trim();
        if (!id) return;

        await this.stopScanner(true);
        const ok = await this.confirm("Check out pallet", `Remove pallet entry ${id} from inventory?`);
        if (!ok) return this.setView("scan");

        await this.checkOut(id);
        this.setView("tracker");
        return;
      }

      // REMOVE UNITS FLOW
      if (this.scanMode === "checkout-units") {
        const payload = parsedPallet;
        const id = payload?.id || String(text).trim();
        if (!id) return;

        await this.stopScanner(true);
        const unitsStr = await this.prompt("Remove Units", `How many units to remove from ${id}?`, "1");
        if (unitsStr === null) return this.setView("scan");

        const unitsToRemove = Number(unitsStr);
        if (!Number.isFinite(unitsToRemove) || unitsToRemove <= 0) {
          this.showToast("Enter a valid unit quantity", "error");
          return this.setView("scan");
        }

        await this.removePartialUnits(id, unitsToRemove, "Scan");
        this.setView("tracker");
        return;
      }

      // MOVE FLOW
      if (this.scanMode === "move-pallet") {
        const payload = parsedPallet;
        const id = payload?.id || String(text).trim();
        if (!id) {
          this.showToastDedup("Invalid pallet QR", "error");
          return;
        }

        this._scannedPallet = { id };
        this.scanMode = "move-location";
        this.showToastDedup(`Pallet scanned: ${id}`, "success", 1200);
        this._syncScannerUi();
        return;
      }

      if (this.scanMode === "move-location") {
        if (looksLikePalletQr) {
          this.showToastDedup("That is a pallet QR. Now scan the destination location label.", "info", 2500);
          return;
        }
        const loc = String(raw || "").trim().replace(/\s+/g, " ").toUpperCase();
        const pal = this._scannedPallet;
        if (!pal?.id) {
          this.showToast("Missing pallet step. Scan pallet first.", "error");
          return;
        }

        const knownLocations = new Set((this.locations || []).map((x) => String(x.id || "").toUpperCase()).filter(Boolean));
        if (knownLocations.size > 0 && !knownLocations.has(loc)) {
          this.showToastDedup(`Unknown location: ${loc}`, "error", 2500);
          return;
        }

        await this.stopScanner(true);
        const ok = await this.confirm("Move pallet", `Move ${pal.id} to ${loc}?`);
        if (!ok) return this.setView("scan");

        await this.movePallet(pal.id, loc, "Scan");
        this.setView("tracker");
        return;
      }
      } finally {
        setTimeout(() => {
          this._scanBusy = false;
        }, 650);
      }
    },

    // --------------------------
    // Server mutations
    // --------------------------

  _makeIdempotencyKey(action, parts = []) {
    const bucket = Math.floor(Date.now() / 3000); // 3s window for duplicate scan suppression
    const sig = [action, ...parts.map((x) => String(x ?? "").trim().toUpperCase()), bucket].join("|");
    return sig;
  },

  async _resolveScannedBy(defaultLabel = "Scan") {
    const sharedNoLogin = this.authDisabled || String(this.currentUser?.username || "").toLowerCase() === "shared";
    if (sharedNoLogin) {
      const existing = String(this.operatorName || "").trim();
      if (existing) return existing;
      const entered = await this.prompt("Operator", "Enter operator name for audit trail:", "");
      if (entered === null) return null;
      const clean = String(entered || "").trim();
      if (!clean) return null;
      this.setOperatorName(clean);
      return clean;
    }

    const mode = this.identityMode === "operator_prompt" ? "operator_prompt" : "account";
    if (mode === "account") {
      return String(this.currentUser?.display_name || this.currentUser?.username || defaultLabel || "Unknown");
    }

    const fallback = String(this.operatorName || this.currentUser?.display_name || "");
    const entered = await this.prompt("Operator", "Who is performing this action?", fallback);
    if (entered === null) return null;
    const clean = String(entered || "").trim();
    if (!clean) return null;
    this.setOperatorName(clean);
    return clean;
  },

  async setOperatorNameFlow() {
    const entered = await this.prompt("Operator", "Operator name:", this.operatorName || "");
    if (entered === null) return;
    const clean = String(entered || "").trim();
    if (!clean) return this.showToast("Operator name is required", "error");
    this.setOperatorName(clean);
    this.showToast(`Operator set: ${clean}`, "success");
    this.render();
  },

  _auditMeta(scannedBy = "Scan", idempotencyKey = "") {
    return {
      scanned_by: scannedBy,
      actor_id: this.actorId || "ops-user",
      client_session_id: this.clientSessionId || "unknown-session",
      idempotency_key: idempotencyKey || "",
    };
  },

  async checkIn(customerName, productId, palletQuantity, productQuantity, location, parts = null, scannedBy = 'Manual entry', palletId = null) {
    try {
      const resolvedScannedBy = await this._resolveScannedBy(scannedBy);
      if (!resolvedScannedBy) return this.showToast("Action cancelled (operator not provided)", "info");
      const idempotencyKey = this._makeIdempotencyKey("CHECK_IN", [palletId || "", customerName, productId, location, palletQuantity, productQuantity]);
      const payload = {
        id: palletId || null, // server can generate if omitted
        customer_name: customerName,
        product_id: productId,
        pallet_quantity: palletQuantity,
        product_quantity: productQuantity,
        location,
        parts,
        ...this._auditMeta(resolvedScannedBy, idempotencyKey),
      };

      const result = await apiFetch('/api/pallets', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      this.showToast('✅ Pallet checked in!', 'success');
      await this.loadPallets();
      this.setView('tracker');
    } catch (error) {
      console.error('Check-in error:', error);
      this.showToast(`Check-in failed: ${error.message}`, 'error');
    }
  },

  async checkOut(palletId, scannedBy = 'Scan') {
    try {
      if (!palletId) throw new Error('Missing pallet id');
      const resolvedScannedBy = await this._resolveScannedBy(scannedBy);
      if (!resolvedScannedBy) return this.showToast("Action cancelled (operator not provided)", "info");
      const idempotencyKey = this._makeIdempotencyKey("CHECK_OUT", [palletId]);

      await apiFetch(`/api/pallets/${encodeURIComponent(palletId)}`, {
        method: 'DELETE',
        body: JSON.stringify(this._auditMeta(resolvedScannedBy, idempotencyKey)),
      });

      this.showToast('✅ Pallet checked out!', 'success');
      await this.loadPallets();
    } catch (error) {
      console.error('Check-out error:', error);
      this.showToast(`Check-out failed: ${error.message}`, 'error');
    }
  },

  async movePallet(palletId, toLocation, scannedBy = 'Scan') {
    try {
      if (!palletId) throw new Error('Missing pallet id');
      const target = String(toLocation || "").trim().toUpperCase();
      if (!target) throw new Error('Missing target location');
      const resolvedScannedBy = await this._resolveScannedBy(scannedBy);
      if (!resolvedScannedBy) return this.showToast("Action cancelled (operator not provided)", "info");
      const idempotencyKey = this._makeIdempotencyKey("MOVE", [palletId, target]);

      await apiFetch(`/api/pallets/${encodeURIComponent(palletId)}/move`, {
        method: 'POST',
        body: JSON.stringify({
          to_location: target,
          ...this._auditMeta(resolvedScannedBy, idempotencyKey),
        }),
      });

      this.showToast(`✅ Pallet moved to ${target}`, 'success');
      await this.loadPallets();
      await this.loadActivity();
      await this.loadStats();
    } catch (error) {
      console.error('Move pallet error:', error);
      this.showToast(`Move failed: ${error.message}`, 'error');
    }
  },

  async removePartialUnits(palletId, unitsToRemove, scannedBy = 'Scan') {
    try {
      if (!palletId) throw new Error('Missing pallet id');

      let finalUnits = Number(unitsToRemove);
      if (!Number.isFinite(finalUnits) || finalUnits <= 0) {
        const unitsStr = await this.prompt("Remove Units", `How many units to remove from ${palletId}?`, "1");
        if (unitsStr === null) return;
        finalUnits = Number(unitsStr);
      }
      if (!Number.isFinite(finalUnits) || finalUnits <= 0) {
        this.showToast("Enter a valid unit quantity", "error");
        return;
      }

      const resolvedScannedBy = await this._resolveScannedBy(scannedBy);
      if (!resolvedScannedBy) return this.showToast("Action cancelled (operator not provided)", "info");
      const payload = {
        units_to_remove: finalUnits,
        ...this._auditMeta(resolvedScannedBy, this._makeIdempotencyKey("UNITS_REMOVE", [palletId, finalUnits])),
      };

      await apiFetch(`/api/pallets/${encodeURIComponent(palletId)}/remove-units`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      this.showToast('✅ Units removed!', 'success');
      await this.loadPallets();
    } catch (error) {
      console.error('Remove units error:', error);
      this.showToast(`Remove units failed: ${error.message}`, 'error');
    }
  },

    async showProductInfo(palletId) {
      const pallet = (this.pallets || []).find((p) => p.id === palletId);
      if (!pallet) return this.showToast("Pallet not found", "error");

      let history = [];
      try {
        const h = await apiFetch(`/api/pallets/${encodeURIComponent(palletId)}/history?_t=${Date.now()}`);
        history = Array.isArray(h) ? h : [];
      } catch {
        history = [];
      }

      const parts = Array.isArray(pallet.parts) ? pallet.parts : [];
      const partsHtml = parts.length
        ? `<div class="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
             <div class="text-sm font-bold text-slate-900 mb-2">Parts list</div>
             ${parts.map((x) => `
               <div class="flex justify-between text-sm text-slate-700">
                 <span>${x.part_number || ""}</span>
                 <span class="font-semibold">×${x.quantity || 1}</span>
               </div>
             `).join("")}
           </div>`
        : `<div class="mt-3 text-sm text-slate-600">No parts list.</div>`;

      const actionLabel = (a) => {
        const v = String(a || "").toUpperCase();
        if (v === "CHECK_IN") return "Checked in";
        if (v === "CHECK_OUT") return "Checked out";
        if (v === "PARTIAL_REMOVE") return "Pallet qty removed";
        if (v === "UNITS_REMOVE") return "Units removed";
        if (v === "MOVE") return "Moved";
        return v || "Event";
      };

      const historyHtml = history.length
        ? `
          <div class="mt-4 rounded-xl border border-slate-200 bg-white p-3">
            <div class="text-sm font-bold text-slate-900 mb-2">Pallet timeline</div>
            <div class="space-y-2 max-h-72 overflow-auto pr-1">
              ${history.map((h) => {
                const ts = h.timestamp ? new Date(h.timestamp).toLocaleString() : "";
                const who = String(h.scanned_by || h.actor_id || "Unknown");
                const qtyBits = [];
                if (h.quantity_changed != null) qtyBits.push(`Δ ${Number(h.quantity_changed)}`);
                if (h.quantity_after != null) qtyBits.push(`After ${Number(h.quantity_after)}`);
                const qtyText = qtyBits.length ? ` • ${qtyBits.join(" • ")}` : "";
                return `
                  <div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <span class="font-semibold text-slate-900">${actionLabel(h.action)}</span>
                      <span class="text-slate-500">${ts}</span>
                    </div>
                    <div class="mt-1">
                      By <span class="font-semibold">${who}</span>
                      ${h.location ? ` • Location ${h.location}` : ""}
                      ${qtyText}
                    </div>
                    ${h.notes ? `<div class="mt-1 text-slate-500">${h.notes}</div>` : ""}
                  </div>
                `;
              }).join("")}
            </div>
          </div>
        `
        : `<div class="mt-4 text-sm text-slate-500">No pallet timeline found yet.</div>`;

      const html = `
        <div class="text-sm text-slate-700">
          <div><span class="font-semibold">Product:</span> ${pallet.product_id || ""}</div>
          <div><span class="font-semibold">Customer:</span> ${pallet.customer_name || ""}</div>
          <div><span class="font-semibold">Location:</span> ${pallet.location || ""}</div>
          <div><span class="font-semibold">Pallets:</span> ${pallet.pallet_quantity || 0}</div>
          <div><span class="font-semibold">Units/pallet:</span> ${pallet.product_quantity || 0}</div>
          ${partsHtml}
          ${historyHtml}
        </div>
      `;

      await this.showModal("Pallet info", html, [
        { label: "Close", value: "close", className: "rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white hover:bg-slate-800" },
      ]);
    },

    async reprintPalletQR(palletId) {
      const pallet = (this.pallets || []).find((p) => p.id === palletId);
      if (!pallet) return this.showToast("Pallet not found", "error");

      const qrText = wtMakePalletQrPayload({
        id: pallet.id,
        customer: pallet.customer_name || "",
        productId: pallet.product_id || "",
        unitsPerPallet: Number(pallet.product_quantity) || 0,
      });

      this.tempPallet = {
        id: pallet.id,
        customer: pallet.customer_name || "",
        product: pallet.product_id || "",
        palletQty: Number(pallet.pallet_quantity) || 1,
        productQty: Number(pallet.product_quantity) || 0,
        _qrText: qrText,
      };

      this.setView("single-qr");
    },

    // --------------------------
    // QR generation helpers
    // --------------------------
    async generateQRCode(text, containerId) {
      return new Promise((resolve) => {
        setTimeout(() => {
          const container = document.getElementById(containerId);
          if (!container) return resolve();

          container.innerHTML = "";
          try {
            if (typeof QRCode === "undefined") {
              console.error("QRCode library missing");
              this.showToast("QRCode library missing", "error");
              return resolve();
            }
            new QRCode(container, {
              text: String(text || ""),
              width: 200,
              height: 200,
              colorDark: "#000000",
              colorLight: "#ffffff",
              correctLevel: QRCode.CorrectLevel.H,
            });
          } catch (e) {
            console.error("QR code generation error:", e);
          }
          resolve();
        }, 50);
      });
    },

    async _renderLocationQrCanvas() {
      const grid = document.getElementById("wt-location-qr-grid");
      if (!grid) return;

      const locs = Array.isArray(this.locations) ? this.locations : [];
      grid.innerHTML = "";

      for (const loc of locs) {
        const id = String(loc.id || loc.location || "").trim();
        if (!id) continue;

        const item = document.createElement("div");
        item.className = "rounded-xl border border-slate-200 bg-white p-3 text-center";

        const holder = document.createElement("div");
        holder.className = "flex justify-center";

        const label = document.createElement("div");
        label.className = "mt-2 text-sm font-bold text-slate-900";
        label.textContent = id;

        item.appendChild(holder);
        item.appendChild(label);
        grid.appendChild(item);

        // render QR
        if (holder) {
          try {
            new QRCode(holder, { text: id, width: 128, height: 128 });
          } catch (e) {
            console.error("Location QR error:", e);
          }
        }
      }
    },

    // --------------------------
    // Websocket status (optional)
    // --------------------------
    connectSocket() {
      const setStatus = (state, text) => {
        this.connState = state;
        this.connText = text;
        this._applyConnectionStatus();
      };

      if (this.socket) {
        if (this.socket.connected) setStatus("is-ok", "Live sync connected");
        else setStatus("is-warn", "Connecting…");
        return;
      }

      setStatus("is-warn", "Connecting…");

      try {
        if (window.io) {
          this.socket = window.io();
          this.socket.on("connect", () => setStatus("is-ok", "Live sync connected"));
          this.socket.on("disconnect", () => setStatus("is-warn", "Live sync disconnected"));
          this.socket.on("connect_error", () => setStatus("is-bad", "Connection error"));

          this.socket.on("inventory_update", () => {
            this.refreshAll().catch(() => {});
          });

          // backward-compat: older server event name
          this.socket.on("db_updated", () => {
            this.refreshAll().catch(() => {});
          });
        } else {
          setStatus("is-warn", "No socket library");
        }
      } catch {
        setStatus("is-bad", "Socket init failed");
      }
    },

    // --------------------------
    // Init
    // --------------------------
    async init() {
      this._detectMobileMode();
      window.addEventListener("wt-auth-required", () => {
        this.currentUser = null;
        this.forcePasswordReset = false;
        try {
          if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
          }
        } catch {}
        this.authLoading = false;
        this.render();
      });
      window.addEventListener("resize", () => {
        const changed = this._detectMobileMode();
        if (changed) this.render();
      });
      try {
        this.ensureInvoiceFormDefaults();
        try {
          const existingSession = localStorage.getItem("wt_client_session_id");
          const existingActor = localStorage.getItem("wt_actor_id");
          const existingRole = localStorage.getItem("wt_user_role");
          const savedIdentityMode = localStorage.getItem("wt_identity_mode");
          const savedOperatorName = localStorage.getItem("wt_operator_name");
          this.clientSessionId = existingSession || (crypto?.randomUUID ? crypto.randomUUID() : `sess-${Date.now()}`);
          this.actorId = existingActor || "ops-user";
          this.identityMode = savedIdentityMode === "operator_prompt" ? "operator_prompt" : "account";
          this.operatorName = String(savedOperatorName || "");
          if (!existingRole) localStorage.setItem("wt_user_role", "ops");
          if (!existingSession) localStorage.setItem("wt_client_session_id", this.clientSessionId);
          if (!existingActor) localStorage.setItem("wt_actor_id", this.actorId);
        } catch {
          this.clientSessionId = `sess-${Date.now()}`;
          this.actorId = "ops-user";
        }
        try {
          const savedDensity = localStorage.getItem("wt_tracker_density");
          if (savedDensity === "compact" || savedDensity === "comfy") {
            this.trackerDensity = savedDensity;
          }
        } catch {
          // ignore
        }

        const hasUser = await this.loadCurrentUser();
        if (hasUser && !this.forcePasswordReset) {
          if (this.mobileMode && this.view === "dashboard") this.view = "scan";
          await this.refreshAll();
          this.connectSocket();
        }
      } catch {
        // ignore
      }
      this.authLoading = false;
      this.render();
      window.__WT_APP_BOOT_OK__ = true;
    },
  };

  // expose for inline onclick
  window.app = app;

  // boot once (works even if script loads after DOMContentLoaded)
  const wtBoot = () => {
    app.init().catch((e) => console.error("Init error:", e));
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wtBoot, { once: true });
  } else {
    wtBoot();
  }
})();
