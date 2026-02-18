/**
 * Warehouse Tracker - Google Sheets Integration
 *
 * Paste this entire script into Apps Script as Code.gs (replace all),
 * then Deploy as Web App:
 * - Execute as: Me
 * - Who has access: Anyone
 *
 * This script:
 * - Keeps your existing per-customer tabs (so nothing breaks)
 * - Maintains Activity Log + Removals History
 * - ✅ Adds Daily_Storage (date + customer + pallets in storage) with UPSERT (no duplicates)
 */

const ACTIVITY_SHEET_NAME = "Activity Log";
const REMOVALS_SHEET_NAME = "Removals History";
const DAILY_STORAGE_SHEET_NAME = "Daily_Storage";
const RESERVED_TABS = new Set([ACTIVITY_SHEET_NAME, REMOVALS_SHEET_NAME, DAILY_STORAGE_SHEET_NAME]);

function doGet() {
  return createResponse({ success: true, message: "Warehouse Sheets Web App running" });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createResponse({ success: false, message: "Missing request body" });
    }

    const req = JSON.parse(e.postData.contents);
    const action = req.action;
    const payload = req.data || {};

    Logger.log("Received action: " + action);
    Logger.log("Payload: " + JSON.stringify(payload));

    switch (action) {
      case "test":
        getOrCreateActivitySheet();
        getOrCreateRemovalsSheet();
        getOrCreateDailyStorageSheet();
        return createResponse({ success: true, message: "Connection successful!" });

      case "add_pallet":
        return handleAddPallet(payload);

      case "remove_pallet":
        return handleRemovePallet(payload);

      case "update_quantity":
        return handleUpdateQuantity(payload);

      case "partial_remove":
        return handleUpdateQuantity(payload);

      case "units_remove":
        return handleUnitsRemove(payload);

      case "sync_all":
        return handleSyncAll(payload);

      // ✅ OPTIONAL UPGRADE ACTION
      case "daily_snapshot":
        return handleDailySnapshot(payload);

      default:
        return createResponse({ success: false, message: "Unknown action: " + action });
    }
  } catch (error) {
    Logger.log("Error: " + error.toString());
    return createResponse({ success: false, message: "Error: " + error.toString() });
  }
}

function createResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function safeSheetName_(name) {
  const cleaned = String(name || "Unknown")
    .trim()
    .replace(/[\\/?*[\]:]/g, "-")
    .slice(0, 80);
  return cleaned || "Unknown";
}

function ensureHeaders_(sheet, headers, style) {
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  const existing = headerRange.getValues()[0];
  const isEmpty = existing.every(v => v === "" || v === null);

  if (isEmpty) {
    headerRange.setValues([headers]);

    if (style && style.bg && style.fg) {
      headerRange.setFontWeight("bold");
      headerRange.setBackground(style.bg);
      headerRange.setFontColor(style.fg);
    }

    sheet.setFrozenRows(1);
  }
}

// ========================
// Customer Sheet
// ========================
function getOrCreateCustomerSheet(customerName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabName = safeSheetName_(customerName);

  let sheet = ss.getSheetByName(tabName);
  if (!sheet) sheet = ss.insertSheet(tabName);

  const headers = [
    "Product ID",
    "Location",
    "Pallets",
    "Units/Pallet (Spec)",
    "Current Units",
    "Parts List",
    "Date Added",
    "Scanned In By",
    "Last Removal Date",
    "Last Removal Qty",
    "Last Removal By",
    "Status"
  ];

  ensureHeaders_(sheet, headers, { bg: "#4285f4", fg: "#ffffff" });

  sheet.setColumnWidth(1, 150);
  sheet.setColumnWidth(2, 100);
  sheet.setColumnWidth(3, 80);
  sheet.setColumnWidth(4, 130);
  sheet.setColumnWidth(5, 110);
  sheet.setColumnWidth(6, 260);
  sheet.setColumnWidth(7, 140);
  sheet.setColumnWidth(8, 140);
  sheet.setColumnWidth(9, 150);
  sheet.setColumnWidth(10, 130);
  sheet.setColumnWidth(11, 140);
  sheet.setColumnWidth(12, 100);

  return sheet;
}

// ========================
// Activity Log
// ========================
function getOrCreateActivitySheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ACTIVITY_SHEET_NAME);

  if (!sheet) sheet = ss.insertSheet(ACTIVITY_SHEET_NAME, 0);

  const headers = [
    "Timestamp",
    "Customer",
    "Product ID",
    "Location",
    "Action",
    "Quantity Changed",
    "Before",
    "After",
    "Notes",
    "By"
  ];

  ensureHeaders_(sheet, headers, { bg: "#ea4335", fg: "#ffffff" });

  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidth(2, 140);
  sheet.setColumnWidth(3, 180);
  sheet.setColumnWidth(4, 110);
  sheet.setColumnWidth(5, 150);
  sheet.setColumnWidth(6, 140);
  sheet.setColumnWidth(7, 90);
  sheet.setColumnWidth(8, 90);
  sheet.setColumnWidth(9, 320);
  sheet.setColumnWidth(10, 140);

  return sheet;
}

// ========================
// Removals History
// ========================
function getOrCreateRemovalsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(REMOVALS_SHEET_NAME);

  if (!sheet) sheet = ss.insertSheet(REMOVALS_SHEET_NAME, 1);

  const headers = [
    "Timestamp",
    "Customer",
    "Product ID",
    "Location",
    "Removal Type",
    "Qty Removed",
    "Qty Before",
    "Qty After",
    "Notes",
    "Removed By"
  ];

  ensureHeaders_(sheet, headers, { bg: "#ff9800", fg: "#ffffff" });

  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidth(2, 140);
  sheet.setColumnWidth(3, 180);
  sheet.setColumnWidth(4, 110);
  sheet.setColumnWidth(5, 150);
  sheet.setColumnWidth(6, 120);
  sheet.setColumnWidth(7, 100);
  sheet.setColumnWidth(8, 100);
  sheet.setColumnWidth(9, 320);
  sheet.setColumnWidth(10, 140);

  return sheet;
}

// ========================
// ✅ Daily Storage Snapshot (Invoice-ready)
// ========================
function getOrCreateDailyStorageSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DAILY_STORAGE_SHEET_NAME);

  if (!sheet) sheet = ss.insertSheet(DAILY_STORAGE_SHEET_NAME, 2);

  const headers = ["Date", "Customer", "Pallets in Storage", "Floor Sqm Used", "Site Floor Sqm Total", "Site Floor Sqm Used"];
  ensureHeaders_(sheet, headers, { bg: "#0f9d58", fg: "#ffffff" });

  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  const existing = headerRange.getValues()[0].map((v) => String(v || "").trim());
  const mismatch = headers.some((h, i) => existing[i] !== h);
  if (mismatch) {
    headerRange.setValues([headers]);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#0f9d58");
    headerRange.setFontColor("#ffffff");
    sheet.setFrozenRows(1);
  }

  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(2, 180);
  sheet.setColumnWidth(3, 150);
  sheet.setColumnWidth(4, 140);
  sheet.setColumnWidth(5, 170);
  sheet.setColumnWidth(6, 170);

  return sheet;
}

function logActivity(customer, productId, location, action, quantityChanged, before, after, notes, by) {
  const sheet = getOrCreateActivitySheet();
  sheet.appendRow([
    new Date(),
    customer || "Unknown",
    productId || "",
    location || "",
    action || "",
    quantityChanged || "",
    before || "",
    after || "",
    notes || "",
    by || ""
  ]);

  sortSheetByTimestampDesc_(sheet, 10);
}

function logRemoval(customer, productId, location, removalType, qtyRemoved, qtyBefore, qtyAfter, notes, removedBy) {
  const sheet = getOrCreateRemovalsSheet();
  sheet.appendRow([
    new Date(),
    customer || "Unknown",
    productId || "",
    location || "",
    removalType || "",
    qtyRemoved || "",
    qtyBefore || "",
    qtyAfter || "",
    notes || "",
    removedBy || ""
  ]);

  sortSheetByTimestampDesc_(sheet, 10);
}

function sortSheetByTimestampDesc_(sheet, colCount) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 2) return;
  const range = sheet.getRange(2, 1, lastRow - 1, colCount);
  range.sort({ column: 1, ascending: false });
}

function formatPartsList(parts) {
  if (!parts || !parts.length) return "";
  return parts.map(p => `${p.part_number} (x${p.quantity || 1})`).join(", ");
}

function normalizePartsList_(parts) {
  if (!parts) return "";
  if (Array.isArray(parts)) return formatPartsList(parts);
  if (typeof parts === "string") {
    const t = parts.trim();
    if (!t) return "";
    try {
      const parsed = JSON.parse(t);
      return Array.isArray(parsed) ? formatPartsList(parsed) : t;
    } catch (_) {
      return t;
    }
  }
  return "";
}

function upsertDailyStorageRow_(dateStr, customer, qty, floorSqmUsed, siteFloorSqmTotal, siteFloorSqmUsed) {
  const sheet = getOrCreateDailyStorageSheet();
  const tz = Session.getScriptTimeZone();
  const values = sheet.getDataRange().getValues();

  let foundRow = -1;
  for (let i = 1; i < values.length; i++) {
    const cellDate = values[i][0];
    const cellCustomer = String(values[i][1] || "").trim();
    const normalizedCellDate =
      cellDate instanceof Date
        ? Utilities.formatDate(cellDate, tz, "yyyy-MM-dd")
        : String(cellDate || "").trim();
    if (normalizedCellDate === dateStr && cellCustomer === customer) {
      foundRow = i + 1;
      break;
    }
  }

  const floorUsed = Number(floorSqmUsed || 0);
  const floorTotal = Number(siteFloorSqmTotal || 0);
  const siteUsed = Number(siteFloorSqmUsed || 0);

  if (foundRow > 0) {
    sheet.getRange(foundRow, 3, 1, 4).setValues([[qty, floorUsed, floorTotal, siteUsed]]);
  } else {
    const dateObj = new Date(dateStr + "T00:00:00");
    sheet.appendRow([dateObj, customer, qty, floorUsed, floorTotal, siteUsed]);
  }
}

// ========================
// Handlers
// ========================
function handleAddPallet(data) {
  const customerName = data.customer_name || "Unknown";
  const sheet = getOrCreateCustomerSheet(customerName);

  const productId = data.product_id || "";
  const location = data.location || "";
  const palletQty = Number(data.pallet_quantity || 1);
  const productQty = Number(data.product_quantity || 0);

  const currentUnits = (data.current_units !== undefined && data.current_units !== null)
    ? Number(data.current_units)
    : Number(productQty);

  const parts = data.parts ? formatPartsList(data.parts) : "";
  const dateAdded = data.date_added ? new Date(data.date_added) : new Date();
  const scannedBy = data.scanned_by || "Unknown";

  const values = sheet.getDataRange().getValues();
  let existingRow = -1;

  for (let i = 1; i < values.length; i++) {
    const isMatch = values[i][0] === productId && values[i][1] === location;
    const isActive = values[i][11] === "Active";
    if (isMatch && isActive) {
      existingRow = i + 1;
      break;
    }
  }

  if (existingRow > 0) {
    const currentPallets = Number(values[existingRow - 1][2] || 0);
    const currentUnitsExisting = Number(values[existingRow - 1][4] || 0);

    const newPallets = currentPallets + palletQty;
    const newCurrentUnits = currentUnitsExisting + currentUnits;

    sheet.getRange(existingRow, 3).setValue(newPallets);
    sheet.getRange(existingRow, 5).setValue(newCurrentUnits);

    logActivity(
      customerName,
      productId,
      location,
      "CHECK_IN (Added to existing)",
      palletQty,
      currentPallets,
      newPallets,
      `Added ${palletQty} pallets to existing entry`,
      scannedBy
    );

    return createResponse({ success: true, message: "Pallet added to existing row" });
  }

  sheet.appendRow([
    productId,
    location,
    palletQty,
    productQty,
    currentUnits,
    parts,
    dateAdded,
    scannedBy,
    "",
    "",
    "",
    "Active"
  ]);

  logActivity(
    customerName,
    productId,
    location,
    "CHECK_IN (New)",
    palletQty,
    0,
    palletQty,
    parts ? "Includes parts list" : "",
    scannedBy
  );

  return createResponse({ success: true, message: "Pallet added to sheet" });
}

function handleRemovePallet(data) {
  const customerName = data.customer_name || "Unknown";
  const sheet = getOrCreateCustomerSheet(customerName);

  const productId = data.product_id || "";
  const location = data.location || "";
  const removedBy = data.scanned_by || "Unknown";

  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    const isMatch = values[i][0] === productId && values[i][1] === location;
    const isActive = values[i][11] === "Active";
    if (isMatch && isActive) {
      const row = i + 1;
      const palletsBefore = Number(values[i][2] || 0);
      const unitsBefore = Number(values[i][4] || 0);

      sheet.deleteRow(row);

      logRemoval(
        customerName,
        productId,
        location,
        "CHECK_OUT (Complete)",
        palletsBefore,
        palletsBefore,
        0,
        "Complete removal from inventory - entry deleted",
        removedBy
      );

      logActivity(
        customerName,
        productId,
        location,
        "CHECK_OUT (Complete)",
        palletsBefore,
        palletsBefore,
        0,
        `Removed row (units before: ${unitsBefore})`,
        removedBy
      );

      return createResponse({ success: true, message: "Pallet removed (row deleted)" });
    }
  }

  return createResponse({ success: false, message: "Pallet not found" });
}

function handleUpdateQuantity(data) {
  const customerName = data.customer_name || "Unknown";
  const sheet = getOrCreateCustomerSheet(customerName);

  const productId = data.product_id || "";
  const location = data.location || "";
  const newQuantity = Number(data.new_quantity);
  const scannedBy = data.scanned_by || "Unknown";

  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    const isMatch = values[i][0] === productId && values[i][1] === location;
    const isActive = values[i][11] === "Active";
    if (!isMatch || !isActive) continue;

    const row = i + 1;
    const oldQuantity = Number(values[i][2] || 0);
    const unitsPerPalletSpec = Number(values[i][3] || 0);

    const quantityRemoved = oldQuantity - newQuantity;

    if (isNaN(newQuantity)) {
      return createResponse({ success: false, message: "new_quantity is not a number" });
    }

    if (newQuantity <= 0) {
      sheet.deleteRow(row);

      logRemoval(
        customerName,
        productId,
        location,
        "PARTIAL_REMOVE (All)",
        quantityRemoved,
        oldQuantity,
        0,
        "Removed all pallets - entry deleted",
        scannedBy
      );

      logActivity(
        customerName,
        productId,
        location,
        "PARTIAL_REMOVE (All)",
        quantityRemoved,
        oldQuantity,
        0,
        "Removed all pallets - entry deleted",
        scannedBy
      );

      return createResponse({ success: true, message: "Quantity updated (row deleted)" });
    }

    const newTotalUnits = unitsPerPalletSpec > 0 ? (newQuantity * unitsPerPalletSpec) : values[i][4];

    sheet.getRange(row, 3).setValue(newQuantity);
    sheet.getRange(row, 5).setValue(newTotalUnits);

    sheet.getRange(row, 9).setValue(new Date());
    sheet.getRange(row, 10).setValue(
      unitsPerPalletSpec > 0
        ? `${Math.round(quantityRemoved * unitsPerPalletSpec)} units`
        : `${quantityRemoved} pallets`
    );
    sheet.getRange(row, 11).setValue(scannedBy);

    logRemoval(
      customerName,
      productId,
      location,
      "PARTIAL_REMOVE",
      quantityRemoved,
      oldQuantity,
      newQuantity,
      unitsPerPalletSpec > 0
        ? `${Math.round(quantityRemoved * unitsPerPalletSpec)} units removed`
        : `${quantityRemoved} pallets removed`,
      scannedBy
    );

    logActivity(
      customerName,
      productId,
      location,
      "PARTIAL_REMOVE",
      quantityRemoved,
      oldQuantity,
      newQuantity,
      `Removed ${quantityRemoved} pallets. ${newQuantity} remaining.`,
      scannedBy
    );

    return createResponse({ success: true, message: "Quantity updated" });
  }

  return createResponse({ success: false, message: "Pallet not found" });
}

function handleUnitsRemove(data) {
  const customerName = data.customer_name || "Unknown";
  const sheet = getOrCreateCustomerSheet(customerName);

  const productId = data.product_id || "";
  const location = data.location || "";
  const unitsRemoved = Number(data.units_removed || 0);
  const scannedBy = data.scanned_by || "Unknown";

  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    const isMatch = values[i][0] === productId && values[i][1] === location;
    const isActive = values[i][11] === "Active";
    if (!isMatch || !isActive) continue;

    const row = i + 1;

    const unitsPerPalletSpec = Number(values[i][3] || 0);
    const oldCurrentUnits = Number(values[i][4] || 0);
    const newCurrentUnits = oldCurrentUnits - unitsRemoved;

    if (newCurrentUnits <= 0) {
      sheet.deleteRow(row);

      logRemoval(
        customerName,
        productId,
        location,
        "UNITS_REMOVE (All)",
        unitsRemoved,
        oldCurrentUnits,
        0,
        "All units removed - entry deleted",
        scannedBy
      );

      logActivity(
        customerName,
        productId,
        location,
        "UNITS_REMOVE (All)",
        unitsRemoved,
        oldCurrentUnits,
        0,
        `Removed all units. Spec: ${unitsPerPalletSpec} units/pallet`,
        scannedBy
      );

      return createResponse({ success: true, message: "All units removed (row deleted)" });
    }

    sheet.getRange(row, 5).setValue(newCurrentUnits);

    sheet.getRange(row, 9).setValue(new Date());
    sheet.getRange(row, 10).setValue(`${unitsRemoved} units`);
    sheet.getRange(row, 11).setValue(scannedBy);

    logRemoval(
      customerName,
      productId,
      location,
      "UNITS_REMOVE",
      unitsRemoved,
      oldCurrentUnits,
      newCurrentUnits,
      `Removed ${unitsRemoved} units (${oldCurrentUnits} -> ${newCurrentUnits})`,
      scannedBy
    );

    logActivity(
      customerName,
      productId,
      location,
      "UNITS_REMOVE",
      unitsRemoved,
      oldCurrentUnits,
      newCurrentUnits,
      `Removed ${unitsRemoved} units. Spec: ${unitsPerPalletSpec} units/pallet`,
      scannedBy
    );

    return createResponse({ success: true, message: "Units removed and sheet updated" });
  }

  return createResponse({ success: false, message: "Pallet not found in sheet for customer: " + customerName });
}

function handleSyncAll(data) {
  const pallets = Array.isArray(data.pallets) ? data.pallets : [];
  const tz = Session.getScriptTimeZone();
  const syncDate = data.synced_at ? new Date(data.synced_at) : new Date();
  const dateStr = Utilities.formatDate(syncDate, tz, "yyyy-MM-dd");

  const byCustomer = {};
  pallets.forEach((p) => {
    const customerName = String(p.customer_name || "Unknown").trim() || "Unknown";
    if (!byCustomer[customerName]) byCustomer[customerName] = [];

    const productQty = Number(p.product_quantity || 0);
    const currentUnits = (p.current_units !== undefined && p.current_units !== null)
      ? Number(p.current_units)
      : Number(p.pallet_quantity || 0) * productQty;

    byCustomer[customerName].push([
      p.product_id || "",
      p.location || "",
      Number(p.pallet_quantity || 0),
      productQty,
      currentUnits,
      normalizePartsList_(p.parts),
      p.date_added ? new Date(p.date_added) : new Date(),
      p.scanned_by || "Unknown",
      "",
      "",
      "",
      "Active",
    ]);
  });

  const customerNames = Object.keys(byCustomer);

  // Rebuild each active customer tab from full snapshot
  customerNames.forEach((customerName) => {
    const sheet = getOrCreateCustomerSheet(customerName);
    const rows = byCustomer[customerName];
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, 12).clearContent();
    }
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, 12).setValues(rows);
    }
  });

  // Clear stale customer tabs (tabs that no longer have active stock)
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.getSheets().forEach((sheet) => {
    const name = sheet.getName();
    if (RESERVED_TABS.has(name)) return;
    if (customerNames.indexOf(name) >= 0) return;
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, Math.max(12, sheet.getMaxColumns())).clearContent();
    }
  });

  // Upsert Daily_Storage rows for this sync date (with floor-space metrics)
  const floorMetrics = data.floor_metrics || {};
  const byCustomerFloorSqm = floorMetrics.by_customer_sqm_used || {};
  const siteFloorSqmTotal = Number(floorMetrics.site_floor_total_sqm || 0);
  const siteFloorSqmUsed = Number(floorMetrics.site_floor_used_sqm || 0);

  customerNames.forEach((customerName) => {
    const rows = byCustomer[customerName] || [];
    const palletsInStorage = rows.reduce((sum, row) => sum + Number(row[2] || 0), 0);
    const floorSqmUsed = Number(byCustomerFloorSqm[customerName] || 0);
    upsertDailyStorageRow_(dateStr, customerName, palletsInStorage, floorSqmUsed, siteFloorSqmTotal, siteFloorSqmUsed);
  });

  logActivity(
    "SYSTEM",
    "SYNC_ALL",
    "-",
    "SYNC",
    pallets.length,
    0,
    pallets.length,
    `Customer tabs rebuilt from snapshot. Customers: ${customerNames.length}, rows: ${pallets.length}, daily_storage date: ${dateStr}`,
    "SYSTEM"
  );

  return createResponse({
    success: true,
    message: `Snapshot sync complete. Customers: ${customerNames.length}, rows: ${pallets.length}, daily_storage updated (${dateStr}).`
  });
}

// ✅ New handler: daily snapshot UPSERT (no duplicate rows for same date+customer)
function handleDailySnapshot(data) {
  const dateStr = String(data.date || "").trim(); // YYYY-MM-DD
  const customer = String(data.customer_name || "Unknown").trim();
  const qty = Number(data.pallets_in_storage || 0);

  if (!dateStr) {
    return createResponse({ success: false, message: "daily_snapshot missing date" });
  }
  upsertDailyStorageRow_(dateStr, customer, qty, Number(data.floor_sqm_used || 0), Number(data.site_floor_sqm_total || 0), Number(data.site_floor_sqm_used || 0));

  logActivity(
    customer,
    "DAILY_SNAPSHOT",
    "-",
    "DAILY_SNAPSHOT",
    qty,
    "",
    qty,
    `Snapshot recorded for ${dateStr}`,
    "SYSTEM"
  );

  return createResponse({ success: true, message: "Daily snapshot recorded", date: dateStr, customer, qty });
}
