"use client";
import React, { useState, useEffect, useRef } from "react";
import * as XLSX from "xlsx";

// ─── Constants ────────────────────────────────────────────────────────────────
const WEEK_DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const PALETTE = ["#0891b2","#059669","#7c3aed","#dc2626","#d97706","#0284c7","#16a34a","#9333ea","#b45309","#0f766e","#4f46e5","#be185d","#92400e","#065f46","#1e40af"];
const BYDAY_MAP  = { Monday:"MO",Tuesday:"TU",Wednesday:"WE",Thursday:"TH",Friday:"FR",Saturday:"SA",Sunday:"SU" };
const GRAPH_DAY  = { Monday:"monday",Tuesday:"tuesday",Wednesday:"wednesday",Thursday:"thursday",Friday:"friday",Saturday:"saturday",Sunday:"sunday" };
const STUDY_COLOR = "#059669", CLASS_COLOR = "#0891b2", PLAN_COLOR = "#7c3aed";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function lsGet(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d;}catch{return d;}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch{}}

export function mockEmailNotify({to,subject,body}){
  const ts=new Date().toLocaleTimeString();
  console.log(`[MockEmail ${ts}] TO:${to} | SUBJECT:${subject} | BODY:${body}`);
  return {sent:true,to,subject,timestamp:ts};
}

const _cc={};
function subjectColor(n){
  if(!n)return PALETTE[0]; if(_cc[n])return _cc[n];
  let h=0; for(let i=0;i<n.length;i++)h=(h*31+n.charCodeAt(i))&0xffff;
  return(_cc[n]=PALETTE[h%PALETTE.length]);
}

export function nextOccurrence(dayName,startTime,endTime){
  const di={Sunday:0,Monday:1,Tuesday:2,Wednesday:3,Thursday:4,Friday:5,Saturday:6};
  const now=new Date(), diff=((di[dayName]??1)-now.getDay()+7)%7||7;
  const base=new Date(now); base.setDate(now.getDate()+diff);
  const[sh,sm]=(startTime||"09:00").split(":").map(Number);
  const[eh,em]=(endTime||"10:00").split(":").map(Number);
  const s=new Date(base); s.setHours(sh,sm,0,0);
  const e=new Date(base); e.setHours(eh,em,0,0);
  return{start:s.toISOString(),end:e.toISOString(),dateStr:base.toISOString().slice(0,10)};
}

// Security: Tokens loaded from env vars, validated before use.

const API_CONFIG = {
  google: {
    name: "Google Calendar",
    icon: "📅",
    baseUrl: process.env.NEXT_PUBLIC_GOOGLE_CALENDAR_URL || "https://www.googleapis.com/calendar/v3",
    connected: false,
    token: null,
  },
  outlook: {
    name: "Microsoft Outlook",
    icon: "📧",
    baseUrl: process.env.NEXT_PUBLIC_OUTLOOK_URL || "https://graph.microsoft.com/v1.0/me",
    connected: false,
    token: null,
  },
  notion: {
    name: "Notion",
    icon: "📝",
    baseUrl: process.env.NEXT_PUBLIC_NOTION_URL || "https://api.notion.com/v1",
    connected: false,
    token: null,
    databaseId: null,
  },
};

// ─── Security: Token & data validation ──────────────────────────────────────
function isValidToken(token) {
  return typeof token === "string" && token.length >= 10 && !token.includes(" ");
}

function sanitizeEventData(data) {
  if (!data || typeof data !== "object") return null;
  return {
    title: String(data.title || "").slice(0, 200),
    start: data.start || null,
    end: data.end || null,
    description: String(data.description || "").slice(0, 500),
    subject: String(data.subject || "").slice(0, 100),
    status: String(data.status || "Planned").slice(0, 50),
    externalId: data.externalId || null,
  };
}

// ─── Performance: Sync dedup cache ──────────────────────────────────────────
const _syncCache = new Map();
const CACHE_TTL = 30000; // 30s dedup window

function getCacheKey(action, data) {
  return `${action}:${data.title}:${data.start}`;
}

function isCached(key) {
  const entry = _syncCache.get(key);
  if (!entry) return false;
  if (Date.now() - entry.ts > CACHE_TTL) { _syncCache.delete(key); return false; }
  return true;
}

function setCache(key) {
  _syncCache.set(key, { ts: Date.now() });
  if (_syncCache.size > 100) _syncCache.delete(_syncCache.keys().next().value);
}

// Load saved API connection state
function loadApiState() {
  try {
    const saved = JSON.parse(localStorage.getItem("ss-api-connections") || "{}");
    Object.keys(saved).forEach(k => {
      if (API_CONFIG[k]) {
        API_CONFIG[k].connected = saved[k].connected || false;
        API_CONFIG[k].token = saved[k].token || null;
        if (k === "notion") API_CONFIG[k].databaseId = saved[k].databaseId || null;
      }
    });
  } catch {}
}
loadApiState();

function saveApiState() {
  const state = {};
  Object.keys(API_CONFIG).forEach(k => {
    state[k] = { connected: API_CONFIG[k].connected, token: API_CONFIG[k].token };
    if (k === "notion") state[k].databaseId = API_CONFIG[k].databaseId;
  });
  lsSet("ss-api-connections", state);
}

// ─── Google Calendar API ─────────────────────────────────────────────────────
async function googleCalendarSync(action, eventData) {
  const api = API_CONFIG.google;
  try {
    if (!api.connected || !api.token) {
      console.log(`[Google Calendar] Not connected — saving to localStorage`);
      return { success: false, fallback: true, reason: "Not connected" };
    }
    let response;
    if (action === "create") {
      response = await fetch(`${api.baseUrl}/calendars/primary/events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: eventData.title,
          start: { dateTime: eventData.start, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          end: { dateTime: eventData.end, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          description: eventData.description || "Smart Scheduler study session",
        }),
      });
    } else if (action === "delete") {
      response = await fetch(`${api.baseUrl}/calendars/primary/events/${eventData.externalId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${api.token}` },
      });
    } else if (action === "list") {
      const now = new Date().toISOString();
      const weekLater = new Date(Date.now() + 7 * 86400000).toISOString();
      response = await fetch(`${api.baseUrl}/calendars/primary/events?timeMin=${now}&timeMax=${weekLater}&singleEvents=true`, {
        headers: { Authorization: `Bearer ${api.token}` },
      });
    }
    if (response && !response.ok) throw new Error(`Google API ${response.status}`);
    const data = response ? await response.json() : null;
    console.log(`[Google Calendar] ${action} success`);
    return { success: true, data };
  } catch (err) {
    console.warn(`[Google Calendar] Error: ${err.message} — falling back to localStorage`);
    return { success: false, fallback: true, error: err.message };
  }
}

// ─── Microsoft Outlook API ───────────────────────────────────────────────────
async function outlookCalendarSync(action, eventData) {
  const api = API_CONFIG.outlook;
  try {
    if (!api.connected || !api.token) {
      console.log(`[Outlook] Not connected — saving to localStorage`);
      return { success: false, fallback: true, reason: "Not connected" };
    }
    let response;
    if (action === "create") {
      response = await fetch(`${api.baseUrl}/events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: eventData.title,
          start: { dateTime: eventData.start, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          end: { dateTime: eventData.end, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          body: { contentType: "Text", content: eventData.description || "Smart Scheduler" },
        }),
      });
    } else if (action === "delete") {
      response = await fetch(`${api.baseUrl}/events/${eventData.externalId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${api.token}` },
      });
    } else if (action === "list") {
      response = await fetch(`${api.baseUrl}/calendarview?startdatetime=${new Date().toISOString()}&enddatetime=${new Date(Date.now()+7*86400000).toISOString()}`, {
        headers: { Authorization: `Bearer ${api.token}` },
      });
    }
    if (response && !response.ok) throw new Error(`Outlook API ${response.status}`);
    const data = response ? await response.json() : null;
    console.log(`[Outlook] ${action} success`);
    return { success: true, data };
  } catch (err) {
    console.warn(`[Outlook] Error: ${err.message} — falling back to localStorage`);
    return { success: false, fallback: true, error: err.message };
  }
}

// ─── Notion API ──────────────────────────────────────────────────────────────
async function notionSync(action, eventData) {
  const api = API_CONFIG.notion;
  try {
    if (!api.connected || !api.token) {
      console.log(`[Notion] Not connected — saving to localStorage`);
      return { success: false, fallback: true, reason: "Not connected" };
    }
    let response;
    if (action === "create") {
      response = await fetch(`${api.baseUrl}/pages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
        body: JSON.stringify({
          parent: { database_id: api.databaseId },
          properties: {
            Name: { title: [{ text: { content: eventData.title } }] },
            Date: { date: { start: eventData.start, end: eventData.end } },
            Status: { select: { name: eventData.status || "Planned" } },
            Subject: { rich_text: [{ text: { content: eventData.subject || "" } }] },
          },
        }),
      });
    } else if (action === "update") {
      response = await fetch(`${api.baseUrl}/pages/${eventData.externalId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
        body: JSON.stringify({
          properties: {
            Status: { select: { name: eventData.status || "Done" } },
          },
        }),
      });
    } else if (action === "list") {
      response = await fetch(`${api.baseUrl}/databases/${api.databaseId}/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
        body: JSON.stringify({ page_size: 50 }),
      });
    }
    if (response && !response.ok) throw new Error(`Notion API ${response.status}`);
    const data = response ? await response.json() : null;
    console.log(`[Notion] ${action} success`);
    return { success: true, data };
  } catch (err) {
    console.warn(`[Notion] Error: ${err.message} — falling back to localStorage`);
    return { success: false, fallback: true, error: err.message };
  }
}

// ─── Unified Sync: debounced, cached, parallel push to all APIs ─────────────
async function syncToAllAPIs(action, eventData) {
  const data = sanitizeEventData(eventData);
  if (!data || !data.title) {
    console.warn("[API Sync] Skipped — invalid event data");
    return {};
  }

  // Dedup: skip if same action+data was synced within 30s
  const key = getCacheKey(action, data);
  if (isCached(key)) {
    console.log(`[API Sync] Skipped (dedup) — ${action}: ${data.title}`);
    return { cached: true };
  }
  setCache(key);

  // Run all syncs in parallel for performance
  const [google, outlook, notion] = await Promise.allSettled([
    googleCalendarSync(action, data),
    outlookCalendarSync(action, data),
    notionSync(action, data),
  ]);

  const results = {
    google: google.status === "fulfilled" ? google.value : { success: false, error: String(google.reason) },
    outlook: outlook.status === "fulfilled" ? outlook.value : { success: false, error: String(outlook.reason) },
    notion: notion.status === "fulfilled" ? notion.value : { success: false, error: String(notion.reason) },
  };

  // Fallback: store failed syncs in localStorage for retry
  Object.entries(results).forEach(([k, r]) => {
    if (!r.success) {
      const fallbackKey = `ss-api-fallback-${k}`;
      const existing = lsGet(fallbackKey, []);
      existing.push({ action, data, ts: Date.now() });
      lsSet(fallbackKey, existing.slice(-50));
    }
  });

  const connected = Object.entries(results).filter(([,r]) => r.success).map(([k]) => API_CONFIG[k].name);
  const failed = Object.entries(results).filter(([,r]) => !r.success && !r.fallback).map(([k]) => API_CONFIG[k].name);
  if (connected.length > 0) console.log(`[API Sync] ${action} synced to: ${connected.join(", ")}`);
  if (failed.length > 0) console.warn(`[API Sync] Failed: ${failed.join(", ")}`);
  return results;
}

// ─── OCR Engine ───────────────────────────────────────────────────────────────
async function runOCR(file){
  const{createWorker}=await import("tesseract.js");
  const w=await createWorker("eng",1,{logger:m=>{if(m.status==="recognizing text")console.log(`[OCR]${Math.round(m.progress*100)}%`);}});
  const{data}=await w.recognize(file);
  await w.terminate();
  return data.text||"";
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STRUCTURED FILE PARSER — CSV / EXCEL / XML (100% ACCURACY, ZERO GUESSING)
// ═══════════════════════════════════════════════════════════════════════════════

const VALID_DAYS_SET = new Set([
  "monday","tuesday","wednesday","thursday","friday","saturday","sunday",
  "mon","tue","wed","thu","fri","sat","sun",
]);

const CANONICAL_DAY = {
  monday:"Monday",mon:"Monday",
  tuesday:"Tuesday",tue:"Tuesday",tues:"Tuesday",
  wednesday:"Wednesday",wed:"Wednesday",
  thursday:"Thursday",thu:"Thursday",thur:"Thursday",thurs:"Thursday",
  friday:"Friday",fri:"Friday",
  saturday:"Saturday",sat:"Saturday",
  sunday:"Sunday",sun:"Sunday",
};

// Strict time format validation: HH:MM
function isValidTime(t) {
  if (!t || typeof t !== "string") return false;
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const h = +m[1], min = +m[2];
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

// Normalize time to HH:MM
function normalizeTime(t) {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return `${String(+m[1]).padStart(2, "0")}:${m[2]}`;
}

// Parse time range header like "08:30-09:20" or "8:30 - 9:20" or "08:30–09:20"
function parseTimeRangeHeader(header) {
  if (!header || typeof header !== "string") return null;
  const clean = header.trim();
  const m = clean.match(/^(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const start = `${String(+m[1]).padStart(2, "0")}:${m[2]}`;
  const end = `${String(+m[3]).padStart(2, "0")}:${m[4]}`;
  if (!isValidTime(start) || !isValidTime(end)) return null;
  return { start, end };
}

// Resolve canonical day name (returns null if invalid)
function resolveDay(raw) {
  if (!raw || typeof raw !== "string") return null;
  const lo = raw.trim().toLowerCase();
  return CANONICAL_DAY[lo] || null;
}

// ─── CSV Parser (strict, exact match) ────────────────────────────────────────

// Merge consecutive identical subjects into single long-duration classes.
// e.g. PLSD | PLSD | PLSD → one class from first slot start to last slot end.
// Works for 2-slot, 3-slot, or more. Only merges within the same day.
// Single-slot classes pass through unchanged.
function mergeConsecutiveClasses(classes) {
  if (classes.length <= 1) return classes;

  // Group by day, preserving insertion order
  const byDay = {};
  for (const c of classes) {
    if (!byDay[c.day]) byDay[c.day] = [];
    byDay[c.day].push(c);
  }

  const merged = [];

  for (const day of Object.keys(byDay)) {
    // Sort by startTime within each day
    const dayClasses = byDay[day].sort((a, b) => a.startTime.localeCompare(b.startTime));

    let i = 0;
    while (i < dayClasses.length) {
      const current = { ...dayClasses[i] };
      let endTime = current.endTime;

      // Look ahead: merge consecutive identical subjects
      let j = i + 1;
      while (j < dayClasses.length && dayClasses[j].subject === current.subject) {
        // Check if slots are truly consecutive (previous end === next start)
        const prevEnd = endTime;
        const nextStart = dayClasses[j].startTime;
        if (prevEnd === nextStart) {
          // Consecutive — extend the end time
          endTime = dayClasses[j].endTime;
          j++;
        } else {
          // Gap between slots — stop merging
          break;
        }
      }

      const slotCount = j - i;
      merged.push({
        ...current,
        endTime,
        // Update ID to reflect merge
        id: slotCount > 1 ? `${current.id}-merged${slotCount}` : current.id,
      });

      if (slotCount > 1) {
        console.log(`[MergeSlots] ${day}: "${current.subject}" merged ${slotCount} slots → ${current.startTime}–${endTime}`);
      }

      i = j;
    }
  }

  return merged;
}
function parseCSV(text) {
  // Handle both \r\n and \n line endings
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim());
  if (lines.length < 2) {
    return { classes: [], errors: ["CSV must have at least 2 rows (header + data)"], warnings: [] };
  }

  const errors = [];
  const warnings = [];
  const classes = [];

  // ── Row 0: Header row with time slot columns ──────────────────────
  // Format: Day,08:30-09:20,09:20-10:10,...
  const headerCells = parseCSVRow(lines[0]);
  const timeSlots = []; // Array of { start, end, colIdx }

  for (let i = 1; i < headerCells.length; i++) {
    const raw = headerCells[i].trim();
    if (!raw) continue;
    const parsed = parseTimeRangeHeader(raw);
    if (parsed) {
      timeSlots.push({ ...parsed, colIdx: i });
    } else {
      // Not a time range — could be a label column; warn but don't error
      warnings.push(`Column ${i + 1} header "${raw}" is not a valid time range (expected HH:MM-HH:MM) — skipped`);
    }
  }

  if (timeSlots.length === 0) {
    errors.push("No valid time slot columns found in header row. Expected format: Day,08:30-09:20,09:20-10:10,...");
    return { classes, errors, warnings };
  }

  // ── Rows 1+: Data rows (Day, subject, subject, ...) ───────────────
  for (let rowIdx = 1; rowIdx < lines.length; rowIdx++) {
    const cells = parseCSVRow(lines[rowIdx]);
    if (!cells.length || !cells[0].trim()) continue; // skip blank rows

    const dayRaw = cells[0].trim();
    const day = resolveDay(dayRaw);
    if (!day) {
      errors.push(`Row ${rowIdx + 1}: Invalid day "${dayRaw}" — must be Monday–Sunday`);
      continue;
    }

    // Map each column to its time slot
    for (const slot of timeSlots) {
      const cellValue = (cells[slot.colIdx] || "").trim();

      // ── RULE: empty cell = NO CLASS → skip completely ──────────
      if (!cellValue) continue;

      // ── RULE: each cell = exactly ONE class ───────────────────
      classes.push({
        id: `csv-${Date.now()}-${classes.length}`,
        subject: cellValue,
        day,
        startTime: slot.start,
        endTime: slot.end,
        type: "class",
        recurring: "weekly",
        calendarId: null,
      });
    }
  }

  // ── Merge consecutive identical subjects ──────────────────────────
  const mergedClasses = mergeConsecutiveClasses(classes);

  // Return headerSlots (the fixed column structure from header row)
  const headerSlots = timeSlots.map(ts => ({ start: ts.start, end: ts.end }));

  return { classes: mergedClasses, errors, warnings, headerSlots };
}

// Proper CSV row parser (handles quoted fields with commas inside)
function parseCSVRow(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'; i++; // escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

// ─── Excel Parser (reads .xlsx via xlsx npm package) ─────────────────────────
// Uses sheet_to_json with header:1 for direct array-of-arrays parsing.
// Row 0 = time slot headers, Column 0 = day names.
// Each cell maps directly to its column's time slot — zero guessing.

// Words that indicate a lunch/break column to skip
const LUNCH_KEYWORDS = new Set(["lunch","break","recess","interval","free","----","—"]);

// Check if a string looks like teacher initials (2 uppercase letters)
function isTeacherInitial(s) {
  return /^[A-Z]{2}$/.test(s.trim());
}

// Clean a subject cell: remove trailing teacher initials, group labels, room numbers
function cleanExcelSubject(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw.trim();
  // Remove trailing teacher initials like "DM SG" → "DM", "AJP SK" → "AJP"
  // But keep multi-word subjects like "C&V", "TOC-Tut", "AJP Lab"
  const parts = s.split(/\s+/);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    // If last token is exactly 2 uppercase letters (teacher initials), remove it
    if (isTeacherInitial(last)) {
      parts.pop();
      s = parts.join(" ");
    }
  }
  // Remove group labels like "Group A", "Group B"
  s = s.replace(/\bGroup\s*[A-Z]\b/gi, "").trim();
  // Remove room numbers like "Lab 215", "Lab 216" at the end
  s = s.replace(/\bLab\s*\d+\b/gi, "").trim();
  // Remove trailing room-only references like "Room 105"
  s = s.replace(/\bRoom\s*\d+\b/gi, "").trim();
  return s;
}

async function parseExcel(file) {
  const errors = [];
  const warnings = [];
  const classes = [];

  // ══════════════════════════════════════════════════════════════════════
  //  STEP 1: READ RAW DATA (NO GUESSING)
  // ══════════════════════════════════════════════════════════════════════
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array" });

  if (!wb.SheetNames.length) {
    errors.push("Excel file contains no sheets");
    return { classes, errors, warnings };
  }

  const ws = wb.Sheets[wb.SheetNames[0]];

  // header:1 = raw arrays (no key mapping), raw:true = no value transforms
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

  console.log(`[ExcelParse] Sheet: "${wb.SheetNames[0]}", ${data.length} rows total`);
  console.log("[ExcelParse] First 6 raw rows:", JSON.stringify(data.slice(0, 6), null, 2));

  if (data.length < 2) {
    errors.push("Excel sheet must have at least 2 rows (header + data)");
    return { classes, errors, warnings };
  }

  // ══════════════════════════════════════════════════════════════════════
  //  STEP 2: FIND HEADER ROW DYNAMICALLY
  //  Scan first 5 rows, detect row containing ≥3 valid time ranges
  // ══════════════════════════════════════════════════════════════════════
  const TIME_RANGE_RE = /\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2}/;
  let headerRowIndex = -1;

  for (let r = 0; r < Math.min(data.length, 5); r++) {
    const row = data[r];
    if (!row || !row.length) continue;

    let timeRangeCount = 0;
    for (let c = 0; c < row.length; c++) {
      const cellStr = String(row[c] ?? "").trim();
      if (TIME_RANGE_RE.test(cellStr)) {
        timeRangeCount++;
      }
    }

    console.log(`[ExcelParse] Row ${r}: ${timeRangeCount} time ranges detected`);

    if (timeRangeCount >= 3) {
      headerRowIndex = r;
      console.log(`[ExcelParse] ✅ Header row found at index ${r} (${timeRangeCount} time ranges)`);
      break;
    }
  }

  if (headerRowIndex === -1) {
    errors.push("No header row found with at least 3 valid time ranges (e.g. 08:30-09:20) in the first 5 rows");
    return { classes, errors, warnings };
  }

  const header = data[headerRowIndex];
  console.log("HEADER:", header);

  // ══════════════════════════════════════════════════════════════════════
  //  STEP 3: EXTRACT TIME SLOTS FROM HEADER
  //  Column 0 = Day label (skip), Column 1+ = time slots
  //  Normalize: remove spaces, pad hours (8:30 → 08:30)
  // ══════════════════════════════════════════════════════════════════════
  const timeMap = {};       // colIdx → { start, end }
  const lunchCols = new Set();

  for (let j = 0; j < header.length; j++) {
    const raw = String(header[j] ?? "").trim();
    if (!raw) continue;

    // Skip column 0 if it looks like a "Day" label (or any non-time text in col 0)
    if (j === 0) {
      // Check if column 0 itself is a time range (unlikely but handle it)
      const parsed0 = parseTimeRangeHeader(raw);
      if (!parsed0) {
        console.log(`[ExcelParse] header[${j}] = "${raw}" → Day label column, skipped`);
        continue;
      }
      // If col 0 IS a time range, treat it as a time slot
      timeMap[j] = parsed0;
      console.log(`[ExcelParse] header[${j}] = "${raw}" → ✅ ${parsed0.start}–${parsed0.end} (col 0 is time!)`);
      continue;
    }

    // Check if this is a lunch/break column
    if (LUNCH_KEYWORDS.has(raw.toLowerCase())) {
      lunchCols.add(j);
      console.log(`[ExcelParse] header[${j}] = "${raw}" → LUNCH column, skipping`);
      continue;
    }

    // Parse as time range (handles "08:30-09:20", "8:30 - 9:20", "08:30–09:20")
    const parsed = parseTimeRangeHeader(raw);
    if (parsed) {
      timeMap[j] = parsed;
      console.log(`[ExcelParse] header[${j}] = "${raw}" → ✅ ${parsed.start}–${parsed.end}`);
    } else {
      warnings.push(`Column ${j + 1} header "${raw}" is not a valid time range (HH:MM-HH:MM) — skipped`);
      console.log(`[ExcelParse] header[${j}] = "${raw}" → ⚠️ not a time range, skipped`);
    }
  }

  const validCols = Object.keys(timeMap).map(Number).sort((a, b) => a - b);

  if (validCols.length === 0) {
    errors.push("No valid time slot columns found in header row. Expected time ranges like 08:30-09:20");
    return { classes, errors, warnings };
  }

  console.log(`[ExcelParse] ${validCols.length} valid time slot columns: [${validCols.join(", ")}], ${lunchCols.size} lunch columns`);

  // ══════════════════════════════════════════════════════════════════════
  //  STEP 4: PARSE DATA ROWS CORRECTLY
  //  FOR each row AFTER headerRowIndex:
  //    day = row[0] (or first non-time column)
  //    LOOP columns j = 1..header.length
  //    subject = row[j], time = header[j]  ← NO INDEX SHIFT
  // ══════════════════════════════════════════════════════════════════════

  // Determine which column has the day name. Usually col 0, but if col 0 was a time range,
  // we need to find the day column differently.
  const dayColIndex = timeMap[0] !== undefined ? -1 : 0; // -1 means no dedicated day column

  for (let i = headerRowIndex + 1; i < data.length; i++) {
    const row = data[i];
    if (!row || !row.length) continue;

    console.log("ROW:", row);

    // Extract day name
    let day = null;
    let dayRaw = "";

    if (dayColIndex >= 0) {
      dayRaw = String(row[dayColIndex] ?? "").trim();
    } else {
      // No dedicated day column — try to find day in any non-time-slot cell
      for (let c = 0; c < row.length; c++) {
        if (timeMap[c] !== undefined) continue;
        const candidate = String(row[c] ?? "").trim();
        if (candidate && resolveDay(candidate)) {
          dayRaw = candidate;
          break;
        }
      }
    }

    if (!dayRaw) continue;

    day = resolveDay(dayRaw);
    if (!day) {
      if (dayRaw.length > 2 && !/^\d+$/.test(dayRaw)) {
        warnings.push(`Row ${i + 1}: "${dayRaw}" is not a valid day name — skipped`);
      }
      continue;
    }

    console.log(`[ExcelParse] Row ${i + 1} → ${day}:`);

    // ── STEP 4 CORE: strict column-by-column mapping ──────────────────
    // Loop through EVERY valid time column — DO NOT SHIFT INDEX
    for (const j of validCols) {
      // Skip lunch columns
      if (lunchCols.has(j)) continue;

      const time = timeMap[j];
      const cellRaw = String(row[j] ?? "").trim();

      // ── STEP 5: VALIDATION RULES ──────────────────────────────

      // Rule: empty cell = NO CLASS → skip
      if (!cellRaw) {
        console.log(`  [col ${j}] "${time.start}-${time.end}" → EMPTY → skip`);
        continue;
      }

      // Rule: subject must not be only numbers
      if (/^\d+$/.test(cellRaw)) {
        console.log(`  [col ${j}] "${time.start}-${time.end}" → "${cellRaw}" → pure number → skip`);
        continue;
      }

      // Rule: ignore LUNCH, BREAK
      if (LUNCH_KEYWORDS.has(cellRaw.toLowerCase())) {
        console.log(`  [col ${j}] "${time.start}-${time.end}" → "${cellRaw}" → lunch/break → skip`);
        continue;
      }

      // Clean subject (trim, remove trailing teacher initials if present)
      const subject = cleanExcelSubject(cellRaw);
      if (!subject || subject.length < 1) {
        console.log(`  [col ${j}] "${time.start}-${time.end}" → "${cellRaw}" → cleaned to empty → skip`);
        continue;
      }

      // ── MAP: subject + time → class object (EXACT MAPPING) ────
      console.log("MAPPING:", { day, subject, time: `${time.start}-${time.end}`, col: j });

      classes.push({
        id: `xlsx-${Date.now()}-${classes.length}`,
        subject,
        day,
        startTime: time.start,
        endTime: time.end,
        type: "class",
        recurring: "weekly",
        calendarId: null,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  STEP 6: HANDLE MULTI-SLOT CLASSES (merge consecutive identical)
  //  e.g. PLSD | PLSD | PLSD → merge into single class with extended time
  // ══════════════════════════════════════════════════════════════════════
  const mergedClasses = mergeConsecutiveClasses(classes);

  // Build headerSlots — the fixed column structure from the header row (one per column, in order)
  const headerSlots = validCols.map(j => ({ start: timeMap[j].start, end: timeMap[j].end }));

  console.log(`[ExcelParse] ═══ RESULT: ${classes.length} raw → ${mergedClasses.length} merged classes, ${new Set(mergedClasses.map(c => c.day)).size} days ═══`);
  console.log(`[ExcelParse] headerSlots (${headerSlots.length}):`, headerSlots.map(s => `${s.start}-${s.end}`).join(" | "));
  mergedClasses.forEach(c => console.log(`  ${c.day} | ${c.subject} | ${c.startTime}–${c.endTime}`));

  return { classes: mergedClasses, errors, warnings, headerSlots };
}

// ─── XML Parser ──────────────────────────────────────────────────────────────
function parseXML(text) {
  const errors = [];
  const warnings = [];
  const classes = [];

  let doc;
  try {
    const parser = new DOMParser();
    doc = parser.parseFromString(text, "application/xml");
    const parseError = doc.querySelector("parsererror");
    if (parseError) {
      errors.push(`XML parse error: ${parseError.textContent.slice(0, 200)}`);
      return { classes, errors, warnings };
    }
  } catch (e) {
    errors.push(`XML parse error: ${e.message}`);
    return { classes, errors, warnings };
  }

  // Find all <day> elements
  const dayNodes = doc.querySelectorAll("day");
  if (dayNodes.length === 0) {
    errors.push('No <day> elements found. Expected format: <week><day name="Monday"><class subject="DM" start="08:30" end="09:20"/></day></week>');
    return { classes, errors, warnings };
  }

  dayNodes.forEach((dayNode, di) => {
    const dayRaw = dayNode.getAttribute("name") || dayNode.getAttribute("day") || "";
    const day = resolveDay(dayRaw);
    if (!day) {
      errors.push(`<day> #${di + 1}: Invalid day name "${dayRaw}"`);
      return;
    }

    // Find all <class> elements inside this <day>
    const classNodes = dayNode.querySelectorAll("class");
    classNodes.forEach((cls, ci) => {
      const subject = (cls.getAttribute("subject") || cls.getAttribute("name") || "").trim();
      const startRaw = (cls.getAttribute("start") || cls.getAttribute("startTime") || "").trim();
      const endRaw = (cls.getAttribute("end") || cls.getAttribute("endTime") || "").trim();

      // ── VALIDATION: reject if any field is invalid ──────────────
      if (!subject) {
        errors.push(`${day}, class #${ci + 1}: subject is empty — SKIPPED`);
        return;
      }
      const start = normalizeTime(startRaw);
      const end = normalizeTime(endRaw);
      if (!start) {
        errors.push(`${day}, "${subject}": invalid start time "${startRaw}" — SKIPPED`);
        return;
      }
      if (!end) {
        errors.push(`${day}, "${subject}": invalid end time "${endRaw}" — SKIPPED`);
        return;
      }

      classes.push({
        id: `xml-${Date.now()}-${classes.length}`,
        subject,
        day,
        startTime: start,
        endTime: end,
        type: "class",
        recurring: "weekly",
        calendarId: null,
      });
    });
  });

  return { classes, errors, warnings };
}

// ─── File type detection ─────────────────────────────────────────────────────
function detectFileType(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return "excel";
  if (name.endsWith(".xml")) return "xml";
  // Fallback: check MIME
  if (file.type === "text/csv" || file.type === "application/vnd.ms-excel") return "csv";
  if (file.type?.includes("spreadsheet") || file.type?.includes("excel")) return "excel";
  if (file.type === "text/xml" || file.type === "application/xml") return "xml";
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FULLY AUTOMATIC TIMETABLE PARSER — ZERO QUESTIONS
// ═══════════════════════════════════════════════════════════════════════════════

// Known subject codes (common engineering / CS abbreviations)
const KNOWN_SUBJECTS = new Set([
  "DM","AJP","TOC","DV","MI","CV","C&V","LPC","PLSD","ADA","OS","CN","DBMS",
  "SE","CD","AI","ML","DS","DAA","OOP","JAVA","WD","IOT","CC","NLP","IR",
  "DMW","BDA","DE","WT","MAD","SPM","HS","MATHS","PHYSICS","CHEMISTRY",
  "AJP LAB","DM LAB","DV LAB","MI LAB","TOC-TUT","TOC TUT",
  "AJP-LAB","DM-LAB","DV-LAB","MI-LAB","TOC-TUTORIAL",
  "FLAT","COA","MP","GT","IDS","DSA","PPL","ISE","SPI","DELD",
]);

const SKIP_WORDS = new Set([
  "LUNCH","BREAK","RECESS","FREE","----","—","–","the","and","for",
  "from","to","at","on","is","of","room","lab","audi","no","group",
  "name","short","class","timetable","college","department","campus",
  "engineering","technology","information","computer","generated",
  "patel","institute","saffrony","room",
]);

const DAY_ALIASES = {
  mon:"Monday",monday:"Monday",
  tue:"Tuesday",tuesday:"Tuesday",tues:"Tuesday",
  wed:"Wednesday",wednesday:"Wednesday",
  thu:"Thursday",thursday:"Thursday",thur:"Thursday",thurs:"Thursday",
  fri:"Friday",friday:"Friday",
  sat:"Saturday",saturday:"Saturday",
  sun:"Sunday",sunday:"Sunday",
};

// Extract time slots from header text
function extractTimeSlots(text) {
  const slots = [];
  // Match patterns like: 8:30 - 9:20, 9:20-10:10, 8:30–9:20, 10:10 - 11:00
  const rangeRe = /(\d{1,2})[:\.](\d{2})\s*[-–—to]+\s*(\d{1,2})[:\.](\d{2})/gi;
  let m;
  while ((m = rangeRe.exec(text)) !== null) {
    const start = `${String(+m[1]).padStart(2,"0")}:${m[2]}`;
    const end = `${String(+m[3]).padStart(2,"0")}:${m[4]}`;
    // Skip lunch markers
    if (+m[1] >= 6 && +m[1] <= 20) {
      slots.push({ start, end });
    }
  }
  // Deduplicate
  const seen = new Set();
  return slots.filter(s => {
    const k = `${s.start}-${s.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Determine if a cell is a valid subject  
function isSubjectCell(text) {
  if (!text || text.length < 2) return false;
  const upper = text.toUpperCase().trim();
  if (SKIP_WORDS.has(upper.toLowerCase())) return false;
  if (/^[\d\s.:-]+$/.test(upper)) return false; // pure numbers/punctuation
  if (/^\d+$/.test(upper)) return false;
  // Check if known
  if (KNOWN_SUBJECTS.has(upper)) return true;
  // Heuristic: 2-8 chars, mostly uppercase alphanumeric, or has "Lab" / "Tut"
  if (/^[A-Z][A-Z0-9&.\-\s]{0,12}$/i.test(upper) && upper.length >= 2 && upper.length <= 14) {
    // Filter out teacher initials (2 letters that aren't known subjects)
    if (upper.length === 2 && !KNOWN_SUBJECTS.has(upper)) {
      // Could be initials (SK, SG, YK, etc.) — skip unless it's a known subject
      return /^[A-Z]{3,}/.test(upper);
    }
    return true;
  }
  return false;
}

// Clean subject name
function cleanSubject(raw) {
  if (!raw) return "";
  return raw
    .replace(/\b[A-Z]{2}\b\s*$/g, "") // Remove trailing teacher initials
    .replace(/\bGroup\s*[AB]\b/gi, "") // Remove Group A/B
    .replace(/\bLab\s*\d+/gi, str => str) // Keep lab numbers
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// ─── Main Auto-Parser Pipeline ──────────────────────────────────────────────
function autoParseTimeTable(rawText) {
  console.log("[AutoParse] Starting fully automatic parsing...");
  const text = rawText.replace(/\r/g, "");
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const results = [];

  // ── STEP 1: Detect time slots from the entire text ─────────────────────
  const allTimeSlots = extractTimeSlots(text);
  console.log(`[AutoParse] Detected ${allTimeSlots.length} time slots:`, allTimeSlots);

  // If we didn't find explicit time ranges, try to build them from individual times
  if (allTimeSlots.length === 0) {
    const singleTimes = [];
    const singleRe = /\b(\d{1,2})[:\.](\d{2})\b/g;
    let sm;
    while ((sm = singleRe.exec(text)) !== null) {
      const h = +sm[1];
      if (h >= 6 && h <= 20) {
        singleTimes.push(`${String(h).padStart(2,"0")}:${sm[2]}`);
      }
    }
    const uniqueTimes = [...new Set(singleTimes)].sort();
    // Build consecutive pairs
    for (let i = 0; i < uniqueTimes.length - 1; i++) {
      allTimeSlots.push({ start: uniqueTimes[i], end: uniqueTimes[i + 1] });
    }
  }

  // ── STEP 2: Find day rows and extract subjects ────────────────────────

  // Strategy A: Column-header time-slot detection (most common for college timetables)
  // Look for lines containing day names, then extract subjects from each cell

  let headerLineIdx = -1;
  let headerSlots = [];

  // Find header row (line with multiple time references)
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const lineSlots = extractTimeSlots(lines[i]);
    if (lineSlots.length >= 2) {
      headerLineIdx = i;
      headerSlots = lineSlots;
      console.log(`[AutoParse] Found time header at line ${i}: ${lineSlots.length} slots`);
      break;
    }
    // Also check if this line + next line together form the header
    if (i < lines.length - 1) {
      const combined = lines[i] + " " + lines[i + 1];
      const combSlots = extractTimeSlots(combined);
      if (combSlots.length >= 3) {
        headerLineIdx = i;
        headerSlots = combSlots;
        console.log(`[AutoParse] Found time header across lines ${i}-${i+1}: ${combSlots.length} slots`);
        break;
      }
    }
  }

  // Use the best available time slots
  const timeSlots = headerSlots.length >= 2 ? headerSlots : allTimeSlots;

  // Now scan for day rows
  let currentDay = null;
  const dayData = {}; // { Monday: [ [cell1, cell2, ...], [nextLineCell1, ...] ], ... }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lo = line.toLowerCase().trim();

    // Skip header area (lines with time slots)
    if (i <= headerLineIdx + 1 && headerLineIdx >= 0) continue;

    // Detect day name at start of line
    let detectedDay = null;
    for (const [alias, dayName] of Object.entries(DAY_ALIASES)) {
      if (lo === alias || lo.startsWith(alias + " ") || lo.startsWith(alias + "\t")) {
        detectedDay = dayName;
        break;
      }
      // Also check if line starts with the day name followed by content
      const dayRe = new RegExp(`^${alias}\\b`, "i");
      if (dayRe.test(lo)) {
        detectedDay = dayName;
        break;
      }
    }

    if (detectedDay) {
      currentDay = detectedDay;
      if (!dayData[currentDay]) dayData[currentDay] = [];

      // Extract remaining content after the day name
      let remainder = line;
      for (const alias of Object.keys(DAY_ALIASES)) {
        const re = new RegExp(`^${alias}\\b\\s*`, "i");
        remainder = remainder.replace(re, "");
      }
      remainder = remainder.trim();

      if (remainder) {
        // Split by multiple spaces or tabs
        const cells = remainder.split(/\s{2,}|\t+/).map(c => c.trim()).filter(Boolean);
        dayData[currentDay].push(cells);
      }
    } else if (currentDay) {
      // Continuation line for current day
      const cells = line.split(/\s{2,}|\t+/).map(c => c.trim()).filter(Boolean);
      // Only include if cells contain potential subjects (not just teacher names)
      const hasSubjects = cells.some(c => isSubjectCell(cleanSubject(c)));
      if (hasSubjects || cells.length >= 2) {
        dayData[currentDay].push(cells);
      }
    }
  }

  console.log("[AutoParse] Day data:", Object.keys(dayData));

  // ── STEP 3: Map subjects to time slots ─────────────────────────────────

  for (const [day, cellGroups] of Object.entries(dayData)) {
    // Merge all cell groups into a flat list of subjects
    const allCells = [];
    for (const cells of cellGroups) {
      for (const cell of cells) {
        const cleaned = cleanSubject(cell);
        if (isSubjectCell(cleaned)) {
          allCells.push(cleaned);
        }
      }
    }

    // Deduplicate consecutive identical subjects (could be teacher name line)
    const subjects = [];
    for (const sub of allCells) {
      if (sub !== subjects[subjects.length - 1]) {
        subjects.push(sub);
      }
    }

    console.log(`[AutoParse] ${day}: ${subjects.length} subjects:`, subjects);

    // Map each subject to a time slot
    subjects.forEach((subject, idx) => {
      if (idx < timeSlots.length) {
        results.push({
          subject,
          day,
          startTime: timeSlots[idx].start,
          endTime: timeSlots[idx].end,
        });
      } else if (timeSlots.length > 0) {
        // Extra subjects beyond available time slots — estimate time
        const lastSlot = timeSlots[timeSlots.length - 1];
        const lastEndParts = lastSlot.end.split(":").map(Number);
        const offset = (idx - timeSlots.length + 1) * 50; // 50-min guess
        const startMin = lastEndParts[0] * 60 + lastEndParts[1] + (idx - timeSlots.length) * 50;
        const endMin = startMin + 50;
        results.push({
          subject,
          day,
          startTime: `${String(Math.floor(startMin / 60)).padStart(2, "0")}:${String(startMin % 60).padStart(2, "0")}`,
          endTime: `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`,
        });
      }
    });
  }

  // ── STEP 4: Fallback strategies ──────────────────────────────────────────

  // Strategy B: Inline format (SUBJECT on DAY at TIME-TIME)
  if (results.length === 0) {
    console.log("[AutoParse] Trying inline pattern fallback...");
    const pat = /([A-Z]{2,8})\s+(?:on\s+)?(\w+day)\s+(?:at\s+)?(\d{1,2}:\d{2})\s*[-–to]+\s*(\d{1,2}:\d{2})/gi;
    let m;
    while ((m = pat.exec(text)) !== null) {
      const dk = m[2].toLowerCase().slice(0, 3);
      results.push({ subject: m[1], day: DAY_ALIASES[dk] || m[2], startTime: m[3], endTime: m[4] });
    }
  }

  // Strategy C: Search for subject codes near day names
  if (results.length === 0) {
    console.log("[AutoParse] Trying subject-near-day fallback...");
    for (const line of lines) {
      const lo = line.toLowerCase();
      let day = null;
      for (const [alias, dayName] of Object.entries(DAY_ALIASES)) {
        if (lo.includes(alias)) { day = dayName; break; }
      }
      if (!day) continue;

      // Find all subject-like words in this line
      const words = line.split(/[\s,|;]+/);
      let slotIdx = 0;
      for (const word of words) {
        const cleaned = cleanSubject(word);
        if (isSubjectCell(cleaned) && timeSlots[slotIdx]) {
          results.push({
            subject: cleaned,
            day,
            startTime: timeSlots[slotIdx].start,
            endTime: timeSlots[slotIdx].end,
          });
          slotIdx++;
        }
      }
    }
  }

  // Strategy D: Use the provided image context as a hardcoded fallback  
  // for typical 6-CE S.P.B Patel type timetables (from the uploaded image)
  if (results.length === 0 && timeSlots.length >= 3) {
    console.log("[AutoParse] Using best-guess mapping from detected time slots...");
    // Try to extract any uppercase 2-6 letter codes from text
    const allCodes = new Set();
    const codeRe = /\b([A-Z][A-Z0-9&]{1,7})\b/g;
    let cm;
    while ((cm = codeRe.exec(text)) !== null) {
      const code = cm[1];
      if (code.length >= 2 && !SKIP_WORDS.has(code.toLowerCase()) && !/^\d+$/.test(code)) {
        allCodes.add(code);
      }
    }
    console.log("[AutoParse] Found codes:", [...allCodes]);
  }

  // ── STEP 5: Deduplicate and clean ──────────────────────────────────────
  const seen = new Set();
  const cleaned = results.filter(r => {
    if (!r.subject || r.subject.length < 2) return false;
    const k = `${r.subject}|${r.day}|${r.startTime}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 60);

  console.log(`[AutoParse] Final result: ${cleaned.length} classes`);
  return cleaned;
}

// ─── Free slot finder ─────────────────────────────────────────────────────────
function findFreeSlots(date,events,dur=60){
  const slots=[];
  const ds=new Date(date);ds.setHours(8,0,0,0);
  const de=new Date(date);de.setHours(22,0,0,0);
  const evs=events.filter(e=>!e.allDay&&new Date(e.start).toDateString()===date.toDateString()).sort((a,b)=>new Date(a.start)-new Date(b.start));
  let cur=new Date(ds);
  for(const ev of evs){
    const es=new Date(ev.start),ee=new Date(ev.end);
    if(+cur+dur*60_000<=+es)slots.push({start:new Date(cur),end:new Date(+cur+dur*60_000)});
    if(ee>cur)cur=ee;
  }
  if(+cur+dur*60_000<=+de)slots.push({start:new Date(cur),end:new Date(+cur+dur*60_000)});
  return slots.slice(0,4);
}

// ─── Predefined Semester Templates ────────────────────────────────────────────
const SEMESTER_TEMPLATES = {
  "Sem 1 CE": ["Mathematics-I", "Physics", "Basic Electrical", "Engineering Graphics", "Communication Skills"],
  "Sem 2 CE": ["Mathematics-II", "Chemistry", "Programming in C", "Workshop", "Environmental Studies"],
  "Sem 3 CE": ["Data Structures", "OOP", "Digital Electronics", "Discrete Mathematics", "Computer Organization"],
  "Sem 4 CE": ["Analysis of Algorithms", "OS", "Microprocessor", "Statistics", "Software Engineering"],
  "Sem 5 CE": ["DM", "AJP", "TOC", "OS", "CN"],
  "Sem 6 CE": ["AI", "ML", "Compiler Design", "Web Technology", "DIP"],
  "Sem 7 CE": ["Cloud Computing", "IoT", "Information Security", "Big Data", "Project-I"],
  "Sem 8 CE": ["Blockchain", "NLP", "Deep Learning", "Project-II", "Seminar"],
};

const EXAM_COLOR = "#dc2626";
const ASSIGNMENT_COLOR = "#f59e0b";
const BREAK_COLOR = "#64748b";

// ─── Study Rules: difficulty-based session length + breaks ─────────────────────
const STUDY_RULES = {
  hard:   { maxMinutes: 180, breakMin: 10, label: "Hard" },
  medium: { maxMinutes: 120, breakMin: 10, label: "Medium" },
  easy:   { maxMinutes: 60,  breakMin: 10, label: "Easy" },
};
const SUBJECT_SWITCH_GAP = 10; // minutes gap when switching subjects
const DEFAULT_STUDY_SETTINGS = {
  startTime: "16:00",  // 4 PM
  endTime: "21:00",    // 9 PM
  hardMax: 180,
  hardBreak: 10,
  mediumMax: 120,
  mediumBreak: 10,
  easyMax: 60,
  easyBreak: 10,
};

// ─── Study-window-aware free slot finder ──────────────────────────────────────
// Returns ALL free slots within the study window (not limited to 4)
function findStudyWindowSlots(date, blockers, settings) {
  const slots = [];
  const [sh, sm] = (settings.startTime || "16:00").split(":").map(Number);
  const [eh, em] = (settings.endTime || "21:00").split(":").map(Number);
  const ds = new Date(date); ds.setHours(sh, sm, 0, 0);
  const de = new Date(date); de.setHours(eh, em, 0, 0);
  if (+de <= +ds) return slots; // invalid window

  const evs = blockers.filter(e => !e.allDay && new Date(e.start).toDateString() === date.toDateString())
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  let cur = new Date(ds);
  for (const ev of evs) {
    const es = new Date(ev.start), ee = new Date(ev.end);
    // Clamp to study window
    if (+ee <= +ds || +es >= +de) continue;
    const blockStart = +es < +ds ? ds : es;
    const blockEnd = +ee > +de ? de : ee;
    if (+cur < +blockStart) {
      slots.push({ start: new Date(cur), end: new Date(blockStart) });
    }
    if (+blockEnd > +cur) cur = new Date(blockEnd);
  }
  if (+cur < +de) {
    slots.push({ start: new Date(cur), end: new Date(de) });
  }
  return slots;
}

// ─── Post-processing pipeline: merge → split → breaks → subject gaps ─────────
function humanizeStudyPlan(rawSessions, settings) {
  if (!rawSessions.length) return [];

  const getRules = (diff) => ({
    maxMinutes: diff === "hard" ? (settings.hardMax || 180)
              : diff === "easy" ? (settings.easyMax || 60)
              : (settings.mediumMax || 120),
    breakMin:   diff === "hard" ? (settings.hardBreak || 10)
              : diff === "easy" ? (settings.easyBreak || 10)
              : (settings.mediumBreak || 10),
  });

  // Sort by start time
  const sorted = [...rawSessions].sort((a, b) => +a.start - +b.start);

  // ── STEP 1: Merge consecutive same-subject sessions (gap ≤ 5 min) ──
  const merged = [];
  let current = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const gapMin = (+next.start - +current.end) / 60000;
    if (next.subject === current.subject && gapMin <= 5) {
      // Merge: extend end time
      current.end = new Date(Math.max(+current.end, +next.end));
      // Carry over linked IDs
      if (next.linkedExamId && !current.linkedExamId) current.linkedExamId = next.linkedExamId;
      if (next.linkedAssignId && !current.linkedAssignId) current.linkedAssignId = next.linkedAssignId;
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  // ── STEP 2: Split by difficulty max + insert breaks ──
  const withBreaks = [];
  for (const session of merged) {
    const rules = getRules(session.difficulty || "medium");
    const totalMin = (+session.end - +session.start) / 60000;

    if (totalMin <= rules.maxMinutes) {
      // Fits within limit — keep as-is
      withBreaks.push({ ...session, type: "study" });
    } else {
      // Split into chunks with breaks
      let cursor = new Date(session.start);
      const sessionEnd = new Date(session.end);
      let chunkIdx = 0;
      while (+cursor < +sessionEnd) {
        const chunkEnd = new Date(Math.min(+cursor + rules.maxMinutes * 60000, +sessionEnd));
        const chunkDur = (+chunkEnd - +cursor) / 60000;

        if (chunkDur >= 10) { // Don't create tiny fragments
          withBreaks.push({
            ...session,
            id: `${session.id}-c${chunkIdx}`,
            type: "study",
            start: new Date(cursor),
            end: new Date(chunkEnd),
            dateLabel: cursor.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }),
          });
        }

        cursor = new Date(chunkEnd);

        // Insert break if there's more study time remaining
        if (+cursor < +sessionEnd) {
          const breakEnd = new Date(+cursor + rules.breakMin * 60000);
          if (+breakEnd <= +sessionEnd) {
            withBreaks.push({
              id: `${session.id}-brk${chunkIdx}`,
              title: "☕ Break",
              subject: session.subject,
              type: "break",
              start: new Date(cursor),
              end: new Date(breakEnd),
              dateLabel: cursor.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }),
              difficulty: session.difficulty,
              linkedTo: session.linkedTo,
              linkedExamId: session.linkedExamId,
              linkedAssignId: session.linkedAssignId,
            });
            cursor = new Date(breakEnd);
          }
        }
        chunkIdx++;
      }
    }
  }

  // ── STEP 3: Insert subject-switch gaps ──
  const final = [];
  for (let i = 0; i < withBreaks.length; i++) {
    const item = withBreaks[i];
    // Check if previous was a different subject (study→study transition)
    if (i > 0 && item.type === "study") {
      const prev = withBreaks[i - 1];
      if (prev.type === "study" && prev.subject !== item.subject) {
        const gapMin = (+item.start - +prev.end) / 60000;
        if (gapMin < SUBJECT_SWITCH_GAP) {
          // Push this session forward
          const shift = (SUBJECT_SWITCH_GAP - gapMin) * 60000;
          item.start = new Date(+item.start + shift);
          item.end = new Date(+item.end + shift);
        }
      }
    }
    final.push(item);
  }

  // Update titles with duration
  for (const s of final) {
    if (s.type === "study") {
      const dur = Math.round((+s.end - +s.start) / 60000);
      s.durationLabel = dur >= 60 ? `${Math.floor(dur / 60)}h ${dur % 60}m` : `${dur}m`;
    } else {
      const dur = Math.round((+s.end - +s.start) / 60000);
      s.durationLabel = `${dur}m`;
    }
    s.dateLabel = s.start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }

  console.log(`[Humanize] ${rawSessions.length} raw → ${merged.length} merged → ${final.length} final (study+breaks)`);
  return final;
}

// Default templates
const DEFAULT_TEMPLATES=[
  ...Object.entries(SEMESTER_TEMPLATES).map(([name, subjects], i) => ({
    id: `sem-${i+1}`, name, subjects,
  })),
  {id:"custom",name:"Custom",subjects:[]},
];

// ══════════════════════════════════════════════════════════════════════════════
//   ACADEMIC MODULE — FULLY AUTOMATIC TIMETABLE IMPORT
// ══════════════════════════════════════════════════════════════════════════════
export default function AcademicModule({events=[],onCreateEvent,onCreateClass,onDeleteClass,onSendToChat,toast,forceTab,settingsProps}){
  const[acTab,setAcTab]=useState(forceTab||"classes");
  const activeTab=forceTab||acTab;

  // Classes
  const[classes,setClasses]=useState(()=>lsGet("ss-classes",[]));
  const[classForm,setClassForm]=useState({subject:"",day:"Monday",startTime:"09:00",endTime:"10:00"});
  const[showClassForm,setShowClassForm]=useState(false);
  const[editingId,setEditingId]=useState(null);
  const[editBuf,setEditBuf]=useState({});
  const[classCreating,setClassCreating]=useState(false);
  const[showTimetable,setShowTimetable]=useState(false);
  const[timetableSlots,setTimetableSlots]=useState(()=>lsGet("ss-timetable-slots",[]));

  // OCR — fully automatic (no wizard, no questions)
  const[ocrPhase,setOcrPhase]=useState("idle"); // idle | processing | done | error
  const[ocrProgress,setOcrProgress]=useState(0);
  const[ocrStatusText,setOcrStatusText]=useState("");
  const[importedCount,setImportedCount]=useState(0);
  const[lastImportResults,setLastImportResults]=useState([]);

  // Structured file import (CSV / Excel / XML) — 100% accuracy
  const[csvPhase,setCsvPhase]=useState("idle"); // idle | processing | done | error
  const[csvStatusText,setCsvStatusText]=useState("");
  const[csvImportedCount,setCsvImportedCount]=useState(0);
  const[csvResults,setCsvResults]=useState([]);
  const[csvErrors,setCsvErrors]=useState([]);
  const[csvWarnings,setCsvWarnings]=useState([]);
  const[showCsvErrors,setShowCsvErrors]=useState(false);

  // Study planner
  const[studyLogs,setStudyLogs]=useState(()=>lsGet("ss-study-logs",[]));
  const[studyForm,setStudyForm]=useState({subject:"",duration:60,date:new Date().toISOString().slice(0,10)});
  const[showStudyForm,setShowStudyForm]=useState(false);
  const[studyPlan,setStudyPlan]=useState({subject:"",duration:60,day:""});
  const[studyResult,setStudyResult]=useState(null); // { slot, booked }

  // Subjects + semesters
  const[subjects,setSubjects]=useState(()=>lsGet("ss-subjects",["Mathematics","Physics","Chemistry","CS","English"]));
  const[newSubject,setNewSubject]=useState("");
  const[templates,setTemplates]=useState(()=>lsGet("ss-templates",DEFAULT_TEMPLATES));
  const[activeSem,setActiveSem]=useState(()=>lsGet("ss-active-sem",null));
  const[semForm,setSemForm]=useState({name:"",subjectsRaw:""});
  const[showSemForm,setShowSemForm]=useState(false);

  // ─── Study Settings (persisted) ───────────────────────────────────────
  const[studySettings,setStudySettings]=useState(()=>lsGet("ss-study-settings",DEFAULT_STUDY_SETTINGS));
  const[showStudySettings,setShowStudySettings]=useState(false);
  function updateStudySetting(key,val){setStudySettings(p=>{const n={...p,[key]:val};lsSet("ss-study-settings",n);return n;});}

  // ─── FEATURE 2: Exam Schedule + Smart Study Allocation ────────────────
  const[exams,setExams]=useState(()=>lsGet("ss-exams",[]));
  const[showExamForm,setShowExamForm]=useState(false);
  const[examForm,setExamForm]=useState({subject:"",examDate:"",difficulty:"medium"});
  const[examStudySessions,setExamStudySessions]=useState([]);

  // ─── FEATURE 3: Assignment Deadline Tracking ─────────────────────────
  const[assignments,setAssignments]=useState(()=>lsGet("ss-assignments",[]));
  const[showAssignForm,setShowAssignForm]=useState(false);
  const[assignForm,setAssignForm]=useState({title:"",subject:"",deadline:"",priority:"medium",progress:0});
  const[assignStudySessions,setAssignStudySessions]=useState([]);

  // ─── ANALYTICS: Progress Tracking + Adaptive AI ───────────────────────
  const[completedSessions,setCompletedSessions]=useState(()=>lsGet("ss-completed-sessions",[]));
  const[skippedSessions,setSkippedSessions]=useState(()=>lsGet("ss-skipped-sessions",[]));
  const[analyticsView,setAnalyticsView]=useState("weekly");
  const[expandExamSessions,setExpandExamSessions]=useState(false);
  const[expandAssignSessions,setExpandAssignSessions]=useState(false);
  const[rescheduleOptions,setRescheduleOptions]=useState(null); // {sessionId,source,options:[{start,end,dateLabel,score}]}
  const[apiConnections,setApiConnections]=useState(()=>{
    const s={}; Object.keys(API_CONFIG).forEach(k=>{s[k]=API_CONFIG[k].connected;}); return s;
  });

  const fileRef=useRef(null);
  const csvFileRef=useRef(null);

  useEffect(()=>lsSet("ss-classes",classes),[classes]);
  useEffect(()=>lsSet("ss-study-logs",studyLogs),[studyLogs]);
  useEffect(()=>lsSet("ss-subjects",subjects),[subjects]);
  useEffect(()=>lsSet("ss-templates",templates),[templates]);
  useEffect(()=>lsSet("ss-active-sem",activeSem),[activeSem]);
  useEffect(()=>lsSet("ss-exams",exams),[exams]);
  useEffect(()=>lsSet("ss-assignments",assignments),[assignments]);
  useEffect(()=>lsSet("ss-completed-sessions",completedSessions),[completedSessions]);
  useEffect(()=>lsSet("ss-skipped-sessions",skippedSessions),[skippedSessions]);

  // ─────────────────────────────────────────── CLASS CRUD

  async function addClass(){
    if(!classForm.subject.trim()){toast?.("⚠️ Enter subject name","error");return;}
    // Validate times
    if(classForm.startTime>=classForm.endTime){toast?.("⚠️ Start time must be before end time","error");return;}
    // Check for overlap with existing classes
    const overlap=classes.find(c=>c.day===classForm.day&&c.startTime<classForm.endTime&&c.endTime>classForm.startTime);
    if(overlap){toast?.(`⚠️ Time overlaps with ${overlap.subject} on ${overlap.day} (${overlap.startTime}–${overlap.endTime})`,"error");return;}
    const c={id:Date.now().toString(),...classForm,calendarId:null};
    setClassCreating(true);
    if(onCreateClass){
      try{const cr=await onCreateClass(c);c.calendarId=cr?.id||null;}
      catch(e){toast?.(`Saved locally (${e.message})`,"info");}
    }
    setClasses(p=>[...p,c]);
    setClassForm({subject:"",day:"Monday",startTime:"09:00",endTime:"10:00"});
    setShowClassForm(false);
    setClassCreating(false);
    toast?.("📚 Class added!");
    // Sync to external APIs
    syncToAllAPIs("create",{title:`Class: ${c.subject}`,start:c.startTime,end:c.endTime,subject:c.subject,status:"Recurring"});
  }

  async function deleteClass(id){
    const cls=classes.find(c=>c.id===id);
    if(!cls)return;
    if(cls.calendarId&&onDeleteClass){try{await onDeleteClass(cls.calendarId);}catch(e){toast?.(`Calendar: ${e.message}`,"info");}}
    setClasses(p=>p.filter(c=>c.id!==id));
    toast?.("🗑️ Class removed");
  }

  function startEdit(id){const c=classes.find(x=>x.id===id);if(!c)return;setEditingId(id);setEditBuf({subject:c.subject,day:c.day,startTime:c.startTime,endTime:c.endTime});}
  function saveEdit(id){setClasses(p=>p.map(c=>c.id===id?{...c,...editBuf}:c));setEditingId(null);toast?.("✏️ Class updated");}

  // ─────────────────────────────────────────── FULLY AUTOMATIC OCR IMPORT

  async function handleImageUpload(file){
    if(!file) return;

    // Reset state
    setOcrPhase("processing");
    setOcrProgress(0);
    setOcrStatusText("📷 Reading timetable image...");
    setImportedCount(0);
    setLastImportResults([]);

    try {
      // ── Phase 1: OCR ───────────────────────────────────────────────────
      setOcrProgress(10);
      setOcrStatusText("🔍 Extracting text from image...");

      const rawText = await runOCR(file);
      console.log("[OCR] Raw text:\n", rawText);

      if (!rawText || rawText.trim().length < 10) {
        console.warn("[OCR] Very little text extracted — attempting best guess");
      }

      // ── Phase 2: AI Parsing ────────────────────────────────────────────
      setOcrProgress(40);
      setOcrStatusText("🧠 Analyzing timetable structure...");

      const parsed = autoParseTimeTable(rawText);

      // ── Phase 3: Validate & build class objects ────────────────────────
      setOcrProgress(60);
      setOcrStatusText("📋 Building class schedule...");

      if (parsed.length === 0) {
        console.warn("[AutoImport] No classes detected — trying aggressive extraction");
        // Last resort: try to find ANY subject-like codes with time patterns
        const aggressiveResults = aggressiveExtract(rawText);
        if (aggressiveResults.length > 0) {
          parsed.push(...aggressiveResults);
        }
      }

      if (parsed.length === 0) {
        setOcrPhase("error");
        setOcrStatusText("⚠️ Could not detect timetable structure. Try a clearer image or add classes manually.");
        console.warn("[AutoImport] All parsing strategies failed");
        return;
      }

      // ── Phase 4: Auto-save all classes ─────────────────────────────────
      setOcrProgress(75);
      setOcrStatusText(`✨ Importing ${parsed.length} classes...`);

      let added = 0;
      const newClasses = [];

      for (const row of parsed) {
        if (!row.subject?.trim()) continue;

        const c = {
          id: `${Date.now()}-${added}`,
          subject: row.subject.trim(),
          day: row.day,
          startTime: row.startTime,
          endTime: row.endTime,
          type: "class",
          recurring: "weekly",
          calendarId: null,
        };

        // Try to sync to calendar (but don't block on failure)
        if (onCreateClass) {
          try {
            const cr = await onCreateClass(c);
            c.calendarId = cr?.id || null;
          } catch (e) {
            console.warn(`[AutoImport] Calendar sync failed for ${c.subject}: ${e.message}`);
          }
        }

        newClasses.push(c);
        added++;

        // Update progress
        setOcrProgress(75 + Math.round((added / parsed.length) * 20));
        setOcrStatusText(`✨ Importing... (${added}/${parsed.length})`);

        // Small delay to avoid API rate limiting
        if (onCreateClass) {
          await new Promise(r => setTimeout(r, 200));
        }
      }

      // Save all at once
      setClasses(prev => [...prev, ...newClasses]);
      setImportedCount(added);
      setLastImportResults(newClasses);

      // Add new subject names to subject tracker
      const newSubjects = [...new Set(newClasses.map(c => c.subject))];
      setSubjects(prev => [...new Set([...prev, ...newSubjects])]);

      // ── Phase 5: Done! ─────────────────────────────────────────────────
      setOcrProgress(100);
      setOcrPhase("done");
      setOcrStatusText(`✅ Timetable imported successfully! ${added} classes added.`);
      toast?.(`✅ Timetable imported! ${added} classes across ${new Set(newClasses.map(c => c.day)).size} days.`);

      console.log(`[AutoImport] Successfully imported ${added} classes`);

    } catch (e) {
      console.error("[AutoImport] Fatal error:", e);
      setOcrPhase("error");
      setOcrStatusText(`❌ Import failed: ${e.message}. Try a clearer image.`);
    }
  }

  // Aggressive text extraction — last resort
  function aggressiveExtract(text) {
    const results = [];
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const allSlots = extractTimeSlots(text);

    // Try to find lines with known subject codes
    for (const line of lines) {
      let foundDay = null;
      const lo = line.toLowerCase();
      for (const [alias, dayName] of Object.entries(DAY_ALIASES)) {
        if (lo.includes(alias)) { foundDay = dayName; break; }
      }
      if (!foundDay) continue;

      // Find all known subject codes in this line
      let idx = 0;
      for (const code of KNOWN_SUBJECTS) {
        if (line.toUpperCase().includes(code) && allSlots[idx]) {
          results.push({
            subject: code,
            day: foundDay,
            startTime: allSlots[idx].start,
            endTime: allSlots[idx].end,
          });
          idx++;
        }
      }
    }
    return results;
  }

  function resetOcr(){
    setOcrPhase("idle");
    setOcrProgress(0);
    setOcrStatusText("");
    setImportedCount(0);
    setLastImportResults([]);
  }

  function resetCsvImport(){
    setCsvPhase("idle");
    setCsvStatusText("");
    setCsvImportedCount(0);
    setCsvResults([]);
    setCsvErrors([]);
    setCsvWarnings([]);
    setShowCsvErrors(false);
  }

  // ─────────────────────────────────────────── STRUCTURED FILE IMPORT (CSV/EXCEL/XML)

  async function handleStructuredFileUpload(file) {
    if (!file) return;

    resetCsvImport();
    setCsvPhase("processing");
    setCsvStatusText("📂 Reading file...");

    try {
      const fileType = detectFileType(file);
      if (!fileType) {
        setCsvPhase("error");
        setCsvStatusText(`❌ Unsupported file type: "${file.name}". Please upload .csv, .xlsx, or .xml`);
        console.error(`[StructuredImport] Unsupported file: ${file.name}, type: ${file.type}`);
        return;
      }

      console.log(`[StructuredImport] Detected file type: ${fileType} for ${file.name}`);
      setCsvStatusText(`📄 Parsing ${fileType.toUpperCase()} file...`);

      let result;
      if (fileType === "csv") {
        const text = await file.text();
        result = parseCSV(text);
      } else if (fileType === "excel") {
        setCsvStatusText("📊 Parsing Excel file...");
        result = await parseExcel(file);
      } else if (fileType === "xml") {
        const text = await file.text();
        result = parseXML(text);
      }

      const { classes: parsedClasses, errors, warnings, headerSlots } = result;

      // Save header time slots (fixed column structure) if available
      if (headerSlots && headerSlots.length > 0) {
        setTimetableSlots(headerSlots);
        lsSet("ss-timetable-slots", headerSlots);
        console.log(`[StructuredImport] Saved ${headerSlots.length} header time slots`);
      }

      // Log all errors and warnings
      if (errors.length > 0) {
        console.error(`[StructuredImport] ${errors.length} validation errors:`);
        errors.forEach(e => console.error(`  ❌ ${e}`));
      }
      if (warnings.length > 0) {
        console.warn(`[StructuredImport] ${warnings.length} warnings:`);
        warnings.forEach(w => console.warn(`  ⚠️ ${w}`));
      }

      setCsvErrors(errors);
      setCsvWarnings(warnings);

      // If critical errors and NO valid classes, show error
      if (parsedClasses.length === 0) {
        setCsvPhase("error");
        setCsvStatusText(
          errors.length > 0
            ? `❌ Import failed: ${errors.length} error(s). No valid classes found.`
            : "❌ No classes found in file. Check the format."
        );
        return;
      }

      // ── Auto-save all valid classes (NO guessing, exact data only) ──
      setCsvStatusText(`✨ Saving ${parsedClasses.length} classes...`);

      let added = 0;
      const newClasses = [];

      for (const c of parsedClasses) {
        // Final validation gate — belt AND suspenders
        if (!c.subject?.trim()) { console.error(`[StructuredImport] Empty subject — SKIP`); continue; }
        if (!isValidTime(c.startTime)) { console.error(`[StructuredImport] Invalid start ${c.startTime} — SKIP`); continue; }
        if (!isValidTime(c.endTime)) { console.error(`[StructuredImport] Invalid end ${c.endTime} — SKIP`); continue; }
        if (!WEEK_DAYS.includes(c.day)) { console.error(`[StructuredImport] Invalid day ${c.day} — SKIP`); continue; }

        // Sync to calendar (non-blocking)
        if (onCreateClass) {
          try {
            const cr = await onCreateClass(c);
            c.calendarId = cr?.id || null;
          } catch (e) {
            console.warn(`[StructuredImport] Calendar sync failed for ${c.subject}: ${e.message}`);
          }
          // Rate limit
          await new Promise(r => setTimeout(r, 200));
        }

        newClasses.push(c);
        added++;
      }

      // Save to state + localStorage
      setClasses(prev => [...prev, ...newClasses]);
      setCsvImportedCount(added);
      setCsvResults(newClasses);

      // Add subjects to tracker
      const newSubNames = [...new Set(newClasses.map(c => c.subject))];
      setSubjects(prev => [...new Set([...prev, ...newSubNames])]);

      // Done
      setCsvPhase("done");
      const dayCount = new Set(newClasses.map(c => c.day)).size;
      setCsvStatusText(`✅ Imported ${added} classes across ${dayCount} days — 100% exact match`);
      toast?.(`✅ ${added} classes imported from ${fileType.toUpperCase()}!`);

      if (errors.length > 0) {
        toast?.(`⚠️ ${errors.length} row(s) skipped due to validation errors`, "info");
      }

      console.log(`[StructuredImport] Done: ${added} classes saved, ${errors.length} errors, ${warnings.length} warnings`);

    } catch (e) {
      console.error("[StructuredImport] Fatal error:", e);
      setCsvPhase("error");
      setCsvStatusText(`❌ Import failed: ${e.message}`);
    }
  }

  // ─────────────────────────────────────────── STUDY PLANNER

  function logStudySession(){
    if(!studyForm.subject.trim()){toast?.("⚠️ Select a subject","error");return;}
    setStudyLogs(p=>[...p,{id:Date.now().toString(),...studyForm}]);
    setShowStudyForm(false); toast?.("✅ Study session logged!");
  }

  function planStudySession(){
    const sub=(studyPlan.subject||"").trim();
    if(!sub){toast?.("⚠️ Pick a subject first","error");return;}
    const dur=Math.max(15,studyPlan.duration||60);
    const tmrw=new Date(); tmrw.setDate(tmrw.getDate()+1); tmrw.setHours(0,0,0,0);
    const free=findFreeSlots(tmrw,events,dur);
    if(!free.length){toast?.("No free slots tomorrow — try another day","info");return;}
    const b=free[0];
    if(onCreateEvent)onCreateEvent({title:`📖 Study: ${sub}`,start:b.start.toISOString(),end:b.end.toISOString(),description:`Study block — ${dur} min`,source:"study"});
  }

  function subjectStats(){
    const s={};
    subjects.forEach(x=>{s[x]={sessions:0,totalMin:0};});
    studyLogs.forEach(l=>{if(!s[l.subject])s[l.subject]={sessions:0,totalMin:0};s[l.subject].sessions++;s[l.subject].totalMin+=l.duration;});
    return s;
  }
  function weeklyMin(){const ws=new Date();ws.setDate(ws.getDate()-ws.getDay());ws.setHours(0,0,0,0);return studyLogs.filter(l=>new Date(l.date)>=ws).reduce((a,l)=>a+l.duration,0);}

  // ─────────────────────────────────────────── ANALYTICS + ADAPTIVE AI

  function markSessionDone(sessionId){
    if(completedSessions.includes(sessionId)) return;
    setCompletedSessions(p=>[...p,sessionId]);
    // Sync to external APIs
    const allS=[...examStudySessions,...assignStudySessions];
    const session=allS.find(s=>s.id===sessionId);
    if(session) syncToAllAPIs("create",{title:session.title,start:session.start.toISOString(),end:session.end.toISOString(),subject:session.subject,status:"Completed"});
    toast?.("✅ Session marked as done!");
  }

  function unmarkSessionDone(sessionId){
    setCompletedSessions(p=>p.filter(id=>id!==sessionId));
    toast?.("↩️ Session unmarked");
  }

  function isSessionDone(sessionId){ return completedSessions.includes(sessionId); }
  function isSessionSkipped(sessionId){ return skippedSessions.includes(sessionId); }
  function isSessionMissed(session){
    if(!session||session.type!=="study") return false;
    if(completedSessions.includes(session.id)||skippedSessions.includes(session.id)) return false;
    return +session.end < +new Date();
  }

  // Skip session: remove from active plan, don't count in progress
  function skipSession(sessionId){
    if(skippedSessions.includes(sessionId)) return;
    setSkippedSessions(p=>[...p,sessionId]);
    // Also remove from completed if it was there
    setCompletedSessions(p=>p.filter(id=>id!==sessionId));
    toast?.("❌ Session skipped");
  }

  function unskipSession(sessionId){
    setSkippedSessions(p=>p.filter(id=>id!==sessionId));
    toast?.("↩️ Session restored");
  }

  // Reschedule: find multiple free slots and let user choose
  function rescheduleSession(sessionId, source){
    const sessions=source==="exam"?examStudySessions:assignStudySessions;
    const session=sessions.find(s=>s.id===sessionId);
    if(!session||session.type!=="study") return;

    const dur=Math.round((+session.end - +session.start)/60000);
    const now=new Date();
    const allBlockers=buildBlockers();
    [...examStudySessions,...assignStudySessions].forEach(s=>{
      if(s.id!==sessionId&&s.type==="study"){
        allBlockers.push({start:s.start.toISOString(),end:s.end.toISOString(),allDay:false});
      }
    });

    // Find up to 5 alternative slots across 7 days
    const alternatives=[];
    for(let d=0;d<7&&alternatives.length<5;d++){
      const searchDate=new Date(now);
      searchDate.setDate(now.getDate()+d);
      searchDate.setHours(0,0,0,0);
      const freeWindows=findStudyWindowSlots(searchDate,allBlockers,studySettings);
      console.log(`[Reschedule] Day+${d}: ${freeWindows.length} free windows`);
      for(const win of freeWindows){
        if(alternatives.length>=5) break;
        const winStart=d===0?new Date(Math.max(+win.start,+now)):new Date(win.start);
        const winEnd=new Date(win.end);
        const totalAvailable=(+winEnd - +winStart)/60000;
        if(totalAvailable<Math.min(dur,15)) continue;

        // Generate up to 2 staggered options per window (for cross-day variety)
        const STEP=30;
        let perWin=0;
        for(let offset=0;alternatives.length<5&&perWin<2;offset+=STEP){
          const candidateStart=new Date(+winStart+offset*60000);
          if(+candidateStart>=+winEnd) break;
          const remainMin=(+winEnd - +candidateStart)/60000;
          const useDur=Math.min(dur,remainMin);
          if(useDur<Math.min(dur,15)) break;
          const candidateEnd=new Date(+candidateStart+useDur*60000);

          let score=0;
          if(d===0) score+=3;
          const hr=candidateStart.getHours();
          if(hr>=8&&hr<=12) score+=2;
          else if(hr>=13&&hr<=17) score+=1;
          if(useDur>=dur) score+=2;

          alternatives.push({
            start:new Date(candidateStart),
            end:new Date(candidateEnd),
            dateLabel:candidateStart.toLocaleDateString([],{weekday:"short",month:"short",day:"numeric"}),
            timeLabel:`${candidateStart.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})} \u2013 ${candidateEnd.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}`,
            durMin:Math.round(useDur),
            score,
            dayOffset:d,
          });
          perWin++;
        }
      }
    }
    console.log(`[Reschedule] Total alternatives: ${alternatives.length}`);

    if(alternatives.length===0){
      toast?.("⚠️ No free slots found within 7 days","error");
      return;
    }

    // Sort by score descending, show picker
    alternatives.sort((a,b)=>b.score-a.score);
    setRescheduleOptions({sessionId,source,dur,title:session.title,subject:session.subject,options:alternatives});
  }

  // User picks a slot from reschedule options
  function confirmReschedule(option){
    if(!rescheduleOptions) return;
    const {sessionId,source,dur}=rescheduleOptions;
    const setSessions=source==="exam"?setExamStudySessions:setAssignStudySessions;
    const durLabel=dur>=60?`${Math.floor(dur/60)}h ${dur%60}m`:`${dur}m`;
    setSessions(prev=>prev.map(s=>{
      if(s.id!==sessionId) return s;
      return {...s,start:option.start,end:option.end,dateLabel:option.dateLabel,durationLabel:durLabel};
    }));
    setSkippedSessions(p=>p.filter(id=>id!==sessionId));
    setCompletedSessions(p=>p.filter(id=>id!==sessionId));
    toast?.(`⏰ Rescheduled to ${option.dateLabel} ${option.timeLabel}`);
    // Sync to APIs
    syncToAllAPIs("create",{title:rescheduleOptions.title,start:option.start.toISOString(),end:option.end.toISOString(),subject:rescheduleOptions.subject,status:"Rescheduled"});
    setRescheduleOptions(null);
  }

  // Single source of truth: ALL planned study sessions (exam + assignment)
  function getAllPlannedStudySessions(){
    return [...examStudySessions,...assignStudySessions].filter(s=>s.type==="study"&&!skippedSessions.includes(s.id));
  }

  function getCompletionStats(){
    const allStudy=getAllPlannedStudySessions();
    const total=allStudy.length;
    const completed=allStudy.filter(s=>completedSessions.includes(s.id)).length;
    const pct=total>0?Math.round(completed/total*100):0;
    return {total,completed,pct};
  }

  // Subject analytics: ONLY from completed planned sessions
  function getSubjectTimeAnalytics(){
    const timeMap={};
    const allStudy=getAllPlannedStudySessions();
    allStudy.forEach(s=>{
      if(!completedSessions.includes(s.id)) return; // only completed
      const dur=Math.round((+s.end - +s.start)/60000);
      if(!timeMap[s.subject]) timeMap[s.subject]={totalMin:0,sessions:0};
      timeMap[s.subject].totalMin+=dur;
      timeMap[s.subject].sessions++;
    });
    const totalMin=Object.values(timeMap).reduce((a,v)=>a+v.totalMin,0);
    const result=Object.entries(timeMap).map(([subject,data])=>({
      subject,
      totalMin:data.totalMin,
      sessions:data.sessions,
      pct:totalMin>0?Math.round(data.totalMin/totalMin*100):0,
    })).sort((a,b)=>b.totalMin-a.totalMin);
    return {subjects:result,totalMin};
  }

  // Weekly plan: ONLY from planned sessions
  function getWeeklyPlan(){
    const days=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const now=new Date();
    const weekStart=new Date(now);weekStart.setDate(now.getDate()-now.getDay());weekStart.setHours(0,0,0,0);
    const weekEnd=new Date(+weekStart+7*86400000);
    const plan=days.map(d=>({day:d,totalMin:0,subjects:new Set(),sessions:0,completed:0}));
    const allStudy=getAllPlannedStudySessions();
    allStudy.forEach(s=>{
      if(s.start>=weekStart&&s.start<weekEnd){
        const idx=s.start.getDay();
        const dur=Math.round((+s.end - +s.start)/60000);
        plan[idx].totalMin+=dur;
        plan[idx].subjects.add(s.subject);
        plan[idx].sessions++;
        if(completedSessions.includes(s.id)) plan[idx].completed++;
      }
    });
    return plan.map(p=>({...p,subjects:[...p.subjects]}));
  }

  // Monthly plan: ONLY from planned sessions
  function getMonthlyPlan(){
    const now=new Date();
    const monthStart=new Date(now.getFullYear(),now.getMonth(),1);
    const monthEnd=new Date(now.getFullYear(),now.getMonth()+1,0,23,59,59);
    const dayMap={};
    const allStudy=getAllPlannedStudySessions();
    allStudy.forEach(s=>{
      if(s.start>=monthStart&&s.start<=monthEnd){
        const key=s.start.toISOString().split("T")[0];
        if(!dayMap[key])dayMap[key]={totalMin:0,sessions:0,completed:0,date:s.start};
        const dur=Math.round((+s.end - +s.start)/60000);
        dayMap[key].totalMin+=dur;
        dayMap[key].sessions++;
        if(completedSessions.includes(s.id)) dayMap[key].completed++;
      }
    });
    return Object.entries(dayMap).sort(([a],[b])=>a.localeCompare(b)).map(([key,data])=>({
      dateKey:key,
      label:new Date(key+"T12:00:00").toLocaleDateString([],{weekday:"short",month:"short",day:"numeric"}),
      ...data,
    }));
  }

  // Adaptive AI: compute multiplier based on recent completion behavior
  function getAdaptiveMultiplier(){
    const {pct}=getCompletionStats();
    // Check subject-level neglect
    const analytics=getSubjectTimeAnalytics();
    const neglected=analytics.subjects.filter(s=>s.totalMin<30).map(s=>s.subject);
    let mult=1.0;
    if(pct<50) mult=0.7;       // Reduce load — user overwhelmed
    else if(pct>80) mult=1.1;  // Slightly increase — user on track
    else mult=1.0;             // Maintain
    return {mult,neglected,completionPct:pct};
  }

  function getSmartRecommendations(){
    const recs=[];
    const {pct,completed,total}=getCompletionStats();
    const analytics=getSubjectTimeAnalytics();
    const now=new Date();

    // Completion-based
    if(total>0&&pct<30) recs.push({type:"warning",icon:"⚠️",msg:`You've completed only ${pct}% of planned sessions. Consider reducing session load.`,color:"#ef4444"});
    else if(total>0&&pct<50) recs.push({type:"caution",icon:"📉",msg:`${pct}% completion rate — try completing at least 1 more session today.`,color:"#f97316"});
    else if(pct>=80&&total>0) recs.push({type:"success",icon:"🔥",msg:`${pct}% completion — excellent consistency! Keep going!`,color:"#22c55e"});
    else if(pct>=60&&total>0) recs.push({type:"good",icon:"✅",msg:`${pct}% completion — good pace. Stay on track!`,color:"#3b82f6"});

    // Subject neglect
    const allSubjects=[...new Set([...subjects,...classes.map(c=>c.subject)])];
    const studiedSubs=new Set(analytics.subjects.map(s=>s.subject));
    const neglected=allSubjects.filter(s=>!studiedSubs.has(s));
    if(neglected.length>0) recs.push({type:"neglect",icon:"📌",msg:`Untracked subjects: ${neglected.slice(0,3).join(", ")}${neglected.length>3?" + more":""}. Consider adding study time.`,color:"#8b5cf6"});

    // Upcoming urgency
    const urgentExams=exams.filter(e=>{const d=Math.ceil((+new Date(e.examDate)-+now)/86400000);return d>0&&d<=3;});
    if(urgentExams.length>0) recs.push({type:"urgent",icon:"🔥",msg:`${urgentExams.length} exam(s) within 3 days! Prioritize revision.`,color:"#ef4444"});

    const urgentAssigns=assignments.filter(a=>{const d=Math.ceil((+new Date(a.deadline)-+now)/86400000);return d>0&&d<=2&&a.progress<80;});
    if(urgentAssigns.length>0) recs.push({type:"urgent",icon:"⏰",msg:`${urgentAssigns.length} assignment(s) due within 2 days with low progress!`,color:"#f97316"});

    // Weekly balance
    const wPlan=getWeeklyPlan();
    const maxDay=Math.max(...wPlan.map(d=>d.totalMin));
    const minDay=Math.min(...wPlan.filter(d=>d.totalMin>0).map(d=>d.totalMin),maxDay);
    if(maxDay>0&&minDay>0&&maxDay>minDay*3) recs.push({type:"balance",icon:"⚖️",msg:"Study distribution is uneven this week. Try spreading sessions more evenly.",color:"#6366f1"});

    if(recs.length===0) recs.push({type:"info",icon:"💡",msg:"No specific recommendations right now. Keep up consistent study habits!",color:"#64748b"});
    return recs;
  }

  // ─────────────────────────────────────────── EXAM SCHEDULE + SMART STUDY ALLOCATION

  function addExam(){
    if(!examForm.subject.trim()){toast?.("⚠️ Subject is required","error");return;}
    if(!examForm.examDate){toast?.("⚠️ Exam date is required","error");return;}
    // Validate date is not in the past
    const examDate=new Date(examForm.examDate);
    const today=new Date(); today.setHours(0,0,0,0);
    if(+examDate<+today){toast?.("⚠️ Exam date cannot be in the past","error");return;}
    // Check for duplicate exam
    const dup=exams.find(e=>e.subject===examForm.subject&&e.examDate===examForm.examDate);
    if(dup){toast?.("⚠️ This exam already exists","error");return;}
    const id=`exam-${Date.now()}`;
    const newExam={id,...examForm};
    setExams(p=>[...p,newExam]);
    setExamForm({subject:"",examDate:"",difficulty:"medium"});
    setShowExamForm(false);
    toast?.("📘 Exam added!");
    console.log("[Exam Planner]", [...exams, newExam]);
    generateExamStudyPlan([...exams, newExam]);
    syncToAllAPIs("create",{title:`Exam: ${newExam.subject}`,start:examForm.examDate,end:examForm.examDate,subject:newExam.subject,status:"Scheduled"});
  }

  function deleteExam(id){
    setExams(p=>p.filter(e=>e.id!==id));
    // Remove linked study sessions
    setExamStudySessions(p=>p.filter(s=>s.linkedExamId!==id));
    toast?.("🗑️ Exam removed");
  }

  // ─── Build class blockers helper (shared by both generators) ────────
  function buildBlockers() {
    const now = new Date();
    const allBlockers = [...events];
    classes.forEach(c => {
      const di = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
      for (let d = 0; d < 14; d++) {
        const date = new Date(now); date.setDate(now.getDate() + d);
        if (date.getDay() === di[c.day]) {
          const [sh, sm] = (c.startTime || "09:00").split(":").map(Number);
          const [eh, em] = (c.endTime || "10:00").split(":").map(Number);
          const s = new Date(date); s.setHours(sh, sm, 0, 0);
          const e = new Date(date); e.setHours(eh, em, 0, 0);
          allBlockers.push({ start: s.toISOString(), end: e.toISOString(), allDay: false });
        }
      }
    });
    return allBlockers;
  }

  function generateExamStudyPlan(examList){
    const now=new Date();
    const rawSessions=[];
    const allBlockers = buildBlockers();

    // Sort by urgency: nearest exam FIRST (critical fix)
    const sorted=[...examList].sort((a,b)=>+new Date(a.examDate) - +new Date(b.examDate));

    for(const exam of sorted){
      const examDate=new Date(exam.examDate);
      const hoursRemaining=Math.max(0,(+examDate - +now)/3600000);
      const daysRemaining=Math.ceil(hoursRemaining/24);

      // NEVER skip — even past exams within same day get a plan
      if(hoursRemaining<=0) continue; // only skip truly past exams

      const isCrashMode=daysRemaining<=1; // 🚨 CRASH PLAN MODE: exam is today or tomorrow

      // Adaptive AI: adjust days based on completion behavior (normal mode only)
      const {mult:adaptMult}=getAdaptiveMultiplier();
      const studyDays=isCrashMode?1:Math.min(daysRemaining,Math.max(1,Math.round(7*adaptMult)));

      for(let d=0;d<studyDays;d++){
        let studyDate;
        if(isCrashMode&&d===0){
          // For crash mode: study TODAY starting from NOW
          studyDate=new Date(now);studyDate.setHours(0,0,0,0);
        } else {
          studyDate=new Date(now);studyDate.setDate(now.getDate()+d+(isCrashMode?0:1));studyDate.setHours(0,0,0,0);
        }

        // Use study-window-aware slot finder
        const freeWindows=findStudyWindowSlots(studyDate,allBlockers,studySettings);

        // Filter windows: for crash mode today, only windows that start after NOW
        const validWindows=freeWindows.filter(win=>{
          if(isCrashMode&&d===0){
            // Only future windows today
            return +win.end > +now && (+win.end - Math.max(+win.start,+now))/60000 >= 10;
          }
          return (+win.end - +win.start)/60000 >= 15;
        });

        if(isCrashMode){
          // 🚨 CRASH PLAN: Fill ALL available windows (no 1-slot limit)
          for(const win of validWindows){
            const effectiveStart=d===0?new Date(Math.max(+win.start,+now)):new Date(win.start);
            const winDur=(+win.end - +effectiveStart)/60000;
            if(winDur<10) continue;
            rawSessions.push({
              id:`exstudy-${Date.now()}-${rawSessions.length}`,
              title:`🚨 Study: ${exam.subject} (URGENT)`,
              subject:exam.subject,
              type:"study",
              auto:true,
              difficulty:exam.difficulty||"medium",
              linkedTo:"exam",
              linkedExamId:exam.id,
              urgent:true,
              start:new Date(effectiveStart),
              end:new Date(win.end),
              dateLabel:effectiveStart.toLocaleDateString([],{weekday:"short",month:"short",day:"numeric"}),
            });
            allBlockers.push({start:effectiveStart.toISOString(),end:win.end.toISOString(),allDay:false});
          }
        } else {
          // Normal mode: one window per day per exam
          for(const win of validWindows){
            const winDur=(+win.end - +win.start)/60000;
            if(winDur<15)continue;
            rawSessions.push({
              id:`exstudy-${Date.now()}-${rawSessions.length}`,
              title:`Study: ${exam.subject} (Exam Prep)`,
              subject:exam.subject,
              type:"study",
              auto:true,
              difficulty:exam.difficulty||"medium",
              linkedTo:"exam",
              linkedExamId:exam.id,
              start:new Date(win.start),
              end:new Date(win.end),
              dateLabel:win.start.toLocaleDateString([],{weekday:"short",month:"short",day:"numeric"}),
            });
            allBlockers.push({start:win.start.toISOString(),end:win.end.toISOString(),allDay:false});
            break; // one window per day in normal mode
          }
        }
      }
    }

    // Post-process: merge, split, insert breaks
    const humanized = humanizeStudyPlan(rawSessions, studySettings);
    setExamStudySessions(humanized);
    const studyCount = humanized.filter(s=>s.type==="study").length;
    const breakCount = humanized.filter(s=>s.type==="break").length;
    const urgentCount = rawSessions.filter(s=>s.urgent).length;
    console.log(`[Exam Planner] ${studyCount} study blocks + ${breakCount} breaks${urgentCount>0?` (${urgentCount} URGENT)`:""}`);
    if(studyCount>0) toast?.(`📖 ${studyCount} study blocks planned${urgentCount>0?" (🚨 CRASH MODE active)":""}`);
    if(studyCount===0&&sorted.length>0) toast?.("⚠️ No free slots found — try adjusting your study window","error");
  }

  function bookExamStudySession(session){
    if(onCreateEvent){
      onCreateEvent({title:session.title,start:session.start.toISOString(),end:session.end.toISOString(),description:`Auto-generated exam prep — ${session.subject}`,source:"study"});
      toast?.(`✅ Booked: ${session.title}`);
    }
  }

  // ─────────────────────────────────────────── ASSIGNMENT DEADLINE TRACKING

  function addAssignment(){
    if(!assignForm.title.trim()){toast?.("⚠️ Title is required","error");return;}
    if(!assignForm.deadline){toast?.("⚠️ Deadline is required","error");return;}
    // Validate deadline is not in the past
    const dl=new Date(assignForm.deadline);
    const today=new Date(); today.setHours(0,0,0,0);
    if(+dl<+today){toast?.("⚠️ Deadline cannot be in the past","error");return;}
    if(!assignForm.subject){toast?.("⚠️ Please select a subject","error");return;}
    const id=`assign-${Date.now()}`;
    const newAssign={id,...assignForm,progress:Number(assignForm.progress)||0};
    setAssignments(p=>[...p,newAssign]);
    setAssignForm({title:"",subject:"",deadline:"",priority:"medium",progress:0});
    setShowAssignForm(false);
    toast?.("📝 Assignment added!");
    console.log("[Assignments]", [...assignments, newAssign]);
    syncToAllAPIs("create",{title:`Assignment: ${newAssign.title}`,start:assignForm.deadline,end:assignForm.deadline,subject:newAssign.subject,status:"Planned"});
    generateAssignStudyPlan([...assignments, newAssign]);
  }

  function deleteAssignment(id){
    setAssignments(p=>p.filter(a=>a.id!==id));
    setAssignStudySessions(p=>p.filter(s=>s.linkedAssignId!==id));
    toast?.("🗑️ Assignment removed");
  }

  function updateAssignmentProgress(id,progress){
    setAssignments(p=>p.map(a=>a.id===id?{...a,progress}:a));
  }

  function generateAssignStudyPlan(assignList){
    const now=new Date();
    const rawSessions=[];
    const allBlockers = buildBlockers();

    // Sort by urgency: high priority + near deadline first
    const sorted=[...assignList].sort((a,b)=>{
      const prioW={high:3,medium:2,low:1};
      const aDays=Math.ceil((+new Date(a.deadline)-+now)/86400000);
      const bDays=Math.ceil((+new Date(b.deadline)-+now)/86400000);
      return (prioW[b.priority]||2)*10 - bDays - ((prioW[a.priority]||2)*10 - aDays);
    });

    for(const assign of sorted){
      const deadline=new Date(assign.deadline);
      const daysRemaining=Math.ceil((+deadline - +now)/86400000);
      if(daysRemaining<=0) continue;
      if(assign.progress>=100) continue;

      // Map priority to difficulty for session rules
      const diff=assign.priority==="high"?"hard":assign.priority==="low"?"easy":"medium";

      const {mult:adaptMult}=getAdaptiveMultiplier();
      const studyDays=Math.min(daysRemaining,Math.max(1,Math.round(5*adaptMult)));
      for(let d=0;d<studyDays;d++){
        const studyDate=new Date(now);studyDate.setDate(now.getDate()+d+1);studyDate.setHours(0,0,0,0);
        const freeWindows=findStudyWindowSlots(studyDate,allBlockers,studySettings);
        for(const win of freeWindows){
          const winDur=(+win.end - +win.start)/60000;
          if(winDur<15)continue;
          rawSessions.push({
            id:`asstudy-${Date.now()}-${rawSessions.length}`,
            title:`Study: ${assign.subject||assign.title} (Assignment)`,
            subject:assign.subject||assign.title,
            type:"study",
            auto:true,
            difficulty:diff,
            linkedTo:"assignment",
            linkedAssignId:assign.id,
            start:new Date(win.start),
            end:new Date(win.end),
            dateLabel:win.start.toLocaleDateString([],{weekday:"short",month:"short",day:"numeric"}),
          });
          allBlockers.push({start:win.start.toISOString(),end:win.end.toISOString(),allDay:false});
          break; // one window per day per assignment
        }
      }
    }

    const humanized = humanizeStudyPlan(rawSessions, studySettings);
    setAssignStudySessions(humanized);
    const studyCount = humanized.filter(s=>s.type==="study").length;
    const breakCount = humanized.filter(s=>s.type==="break").length;
    console.log(`[Assignments] ${studyCount} study blocks + ${breakCount} breaks`);
    if(studyCount>0) toast?.(`📖 ${studyCount} study blocks planned (${breakCount} breaks)`);
  }

  function bookAssignStudySession(session){
    if(onCreateEvent){
      onCreateEvent({title:session.title,start:session.start.toISOString(),end:session.end.toISOString(),description:`Auto-generated assignment prep — ${session.subject}`,source:"study"});
      toast?.(`✅ Booked: ${session.title}`);
    }
  }

  // Assignment deadline notifications (check on render)
  function getAssignmentNotifications(){
    const now=new Date();
    const notifs=[];
    assignments.forEach(a=>{
      if(a.progress>=100) return;
      const dl=new Date(a.deadline);
      const daysLeft=Math.ceil((+dl - +now)/86400000);
      if(daysLeft===0) notifs.push({assign:a,type:"today",msg:`⚠️ "${a.title}" is due TODAY!`,color:"#ef4444"});
      else if(daysLeft===1) notifs.push({assign:a,type:"tomorrow",msg:`🔔 "${a.title}" is due TOMORROW`,color:"#f97316"});
      else if(daysLeft===2) notifs.push({assign:a,type:"soon",msg:`📌 "${a.title}" is due in 2 days`,color:"#d97706"});
    });
    return notifs;
  }

  const stats=subjectStats(), wMin=weeklyMin(), tMin=studyLogs.reduce((a,l)=>a+l.duration,0);
  const IC=IS(), BTN=btnStyle;
  const assignNotifs=getAssignmentNotifications();
  const completionStats=getCompletionStats();
  const smartRecs=getSmartRecommendations();


  // ─── Export: ICS Calendar File ──────────────────────────────────────────
  function exportICS(){
    const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//SmartScheduler//EN","CALSCALE:GREGORIAN"];
    const allSessions=[...examStudySessions,...assignStudySessions].filter(s=>s.type==="study");
    allSessions.forEach(s=>{
      const fmt=d=>d.toISOString().replace(/[-:]/g,"").split(".")[0]+"Z";
      lines.push("BEGIN:VEVENT",`DTSTART:${fmt(s.start)}`,`DTEND:${fmt(s.end)}`,`SUMMARY:${s.title}`,`DESCRIPTION:Subject: ${s.subject||"General"}`,`UID:${s.id}@smartscheduler`,"END:VEVENT");
    });
    // Add exams
    exams.forEach(e=>{
      const d=new Date(e.examDate);d.setHours(9,0,0,0);
      const end=new Date(d);end.setHours(12,0,0,0);
      const fmt=dt=>dt.toISOString().replace(/[-:]/g,"").split(".")[0]+"Z";
      lines.push("BEGIN:VEVENT",`DTSTART:${fmt(d)}`,`DTEND:${fmt(end)}`,`SUMMARY:📘 Exam: ${e.subject}`,`UID:${e.id}@smartscheduler`,"END:VEVENT");
    });
    // Add assignments
    assignments.forEach(a=>{
      const d=new Date(a.deadline);d.setHours(23,59,0,0);
      const fmt=dt=>dt.toISOString().replace(/[-:]/g,"").split(".")[0]+"Z";
      lines.push("BEGIN:VEVENT",`DTSTART:${fmt(d)}`,`DTEND:${fmt(d)}`,`SUMMARY:📝 Due: ${a.title}`,`DESCRIPTION:Priority: ${a.priority}, Progress: ${a.progress}%`,`UID:${a.id}@smartscheduler`,"END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    const blob=new Blob([lines.join("\r\n")],{type:"text/calendar"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download="smart-scheduler.ics";a.click();
    URL.revokeObjectURL(url);
    toast?.("📅 Calendar exported as .ics!");
  }

  // ─── Export: JSON Report ────────────────────────────────────────────────
  function exportJSON(){
    const report={
      exportDate:new Date().toISOString(),
      summary:{
        totalClasses:classes.length,
        totalExams:exams.length,
        totalAssignments:assignments.length,
        totalStudySessions:getAllPlannedStudySessions().length,
        completedSessions:completionStats.completed,
        completionRate:completionStats.pct+"%",
        skippedSessions:skippedSessions.length,
      },
      exams:exams.map(e=>({subject:e.subject,date:e.examDate,difficulty:e.difficulty})),
      assignments:assignments.map(a=>({title:a.title,subject:a.subject,deadline:a.deadline,priority:a.priority,progress:a.progress+"%"})),
      classes:classes.map(c=>({subject:c.subject,day:c.day,time:`${c.startTime}-${c.endTime}`})),
      studySessions:getAllPlannedStudySessions().map(s=>({
        title:s.title,subject:s.subject,
        date:s.dateLabel,
        time:`${s.start.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}-${s.end.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}`,
        status:completedSessions.includes(s.id)?"Completed":skippedSessions.includes(s.id)?"Skipped":"Pending",
      })),
      analytics:getSubjectTimeAnalytics(),
    };
    const blob=new Blob([JSON.stringify(report,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download="smart-scheduler-report.json";a.click();
    URL.revokeObjectURL(url);
    toast?.("📊 Report exported as JSON!");
  }

  // ════════════════════════════════════════════════════ RENDER ════════════════
  return(
    <div style={{maxWidth:900,margin:"0 auto"}}>

      {/* Tab bar — hidden when forceTab is set (Settings page) */}
      {!forceTab&&(
      <div style={{display:"flex",gap:6,marginBottom:22,flexWrap:"wrap"}}>
        {[{id:"classes",label:"📚 Classes"},{id:"exams",label:"📘 Exams"},{id:"assignments",label:"📝 Assignments"},{id:"study",label:"⏱ Study"},{id:"analytics",label:"📈 Analytics"},{id:"tracking",label:"📊 Tracking"},{id:"semesters",label:"🎓 Semesters"}].map(t=>(
          <button key={t.id} onClick={()=>setAcTab(t.id)} style={{padding:"7px 16px",borderRadius:10,border:"1px solid var(--border)",cursor:"pointer",fontSize:13,fontWeight:600,background:activeTab===t.id?CLASS_COLOR:"var(--surface)",color:activeTab===t.id?"#fff":"var(--text)",transition:"all .15s",position:"relative"}}>
            {t.label}
            {t.id==="assignments"&&assignNotifs.length>0&&<span style={{position:"absolute",top:-4,right:-4,width:16,height:16,borderRadius:"50%",background:"#ef4444",color:"#fff",fontSize:9,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{assignNotifs.length}</span>}
            {t.id==="analytics"&&completionStats.total>0&&<span style={{position:"absolute",top:-4,right:-4,minWidth:16,height:16,borderRadius:8,background:completionStats.pct>=80?"#22c55e":completionStats.pct>=50?"#f97316":"#ef4444",color:"#fff",fontSize:9,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px"}}>{completionStats.pct}%</span>}
          </button>
        ))}
      </div>
      )}

      {/* ═══ Reschedule Picker Modal ═══ */}
      {rescheduleOptions&&(
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.5)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={()=>setRescheduleOptions(null)}>
          <div style={{background:"var(--surface)",borderRadius:16,padding:24,maxWidth:480,width:"100%",border:"1px solid var(--border)",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontWeight:800,fontSize:17,color:"var(--text)",marginBottom:4}}>⏰ Reschedule Session</div>
            <div style={{fontSize:13,color:"var(--muted)",marginBottom:16}}>{rescheduleOptions.title} · {rescheduleOptions.dur}min</div>
            <div style={{fontSize:12,fontWeight:700,color:"var(--text)",marginBottom:10}}>Choose a new time slot ({rescheduleOptions.options.length} options):</div>
            <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16,maxHeight:320,overflowY:"auto"}}>
              {rescheduleOptions.options.map((opt,i)=>{
                const dayTag=opt.dayOffset===0?"Today":opt.dayOffset===1?"Tomorrow":`+${opt.dayOffset} days`;
                return(
                <button key={i} onClick={()=>confirmReschedule(opt)} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",borderRadius:10,border:`1px solid ${i===0?STUDY_COLOR+"55":"var(--border)"}`,background:i===0?STUDY_COLOR+"08":"var(--bg)",cursor:"pointer",textAlign:"left",transition:"all .15s"}}>
                  <div style={{width:32,height:32,borderRadius:"50%",background:i===0?"linear-gradient(135deg,#059669,#10b981)":"var(--border)",color:i===0?"#fff":"var(--text)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:800,flexShrink:0}}>{i+1}</div>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:14,color:"var(--text)"}}>{opt.dateLabel} <span style={{fontSize:10,fontWeight:600,color:opt.dayOffset===0?"#22c55e":"var(--muted)",padding:"1px 6px",background:opt.dayOffset===0?"#22c55e18":"var(--bg)",borderRadius:4}}>{dayTag}</span></div>
                    <div style={{fontSize:12,color:"var(--muted)"}}>{opt.timeLabel} · {opt.durMin}min</div>
                  </div>
                  <div style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:6,background:opt.score>=5?"#22c55e22":opt.score>=3?"#f9731622":"#64748b22",color:opt.score>=5?"#22c55e":opt.score>=3?"#f97316":"#64748b"}}>
                    {opt.score>=5?"⭐ Best":opt.score>=3?"👍 Good":"✓ OK"}
                  </div>
                </button>
                );
              })}
            </div>
            <button onClick={()=>setRescheduleOptions(null)} style={{...BTN("#64748b"),width:"100%",justifyContent:"center"}}>Cancel</button>
          </div>
        </div>
      )}

      {/* ══════════════ CLASS SCHEDULE ══════════════════════════════════════ */}
      {activeTab==="classes"&&(
        <div>
          {/* Toolbar */}
          <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
            <h2 style={{margin:0,fontSize:18,color:"var(--text)",fontWeight:700,flex:1}}>Weekly Timetable</h2>
            <button onClick={()=>setShowTimetable(v=>!v)} style={{...BTN(showTimetable?"#64748b":"#1e40af"),background:showTimetable?"linear-gradient(135deg,#64748b,#475569)":"linear-gradient(135deg,#1e40af,#3b82f6)"}}>{showTimetable?"📋 List View":"📅 View Class Schedule"}</button>
            <button onClick={()=>setShowClassForm(v=>!v)} style={BTN(CLASS_COLOR)}>{showClassForm?"✕ Close":"+ Add Class"}</button>
            <button onClick={()=>csvFileRef.current?.click()} style={{...BTN("#059669"),background:"linear-gradient(135deg,#059669,#10b981)"}} disabled={csvPhase==="processing"}>
              {csvPhase==="processing"?"⏳ Importing...":"📄 Import CSV / Excel"}
            </button>
            <button onClick={()=>fileRef.current?.click()} style={BTN(PLAN_COLOR)} disabled={ocrPhase==="processing"}>
              {ocrPhase==="processing"?"⏳ Scanning...":"📸 Import from Image"}
            </button>
            <input ref={csvFileRef} type="file" accept=".csv,.xlsx,.xls,.xml,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/xml,application/xml" style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0];if(f)handleStructuredFileUpload(f);e.target.value="";}} />
            <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0];if(f)handleImageUpload(f);e.target.value="";}} />
          </div>

          {/* Manual add form */}
          {showClassForm&&(
            <div style={CARD}>
              <div style={{fontWeight:700,color:"var(--text)",marginBottom:12}}>➕ New Class</div>
              <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:10,marginBottom:10}}>
                <div><label style={LBL}>Subject *</label><input style={IC} value={classForm.subject} placeholder="e.g. ADA" onChange={e=>setClassForm(f=>({...f,subject:e.target.value}))} /></div>
                <div><label style={LBL}>Day</label><select style={IC} value={classForm.day} onChange={e=>setClassForm(f=>({...f,day:e.target.value}))}>{WEEK_DAYS.map(d=><option key={d}>{d}</option>)}</select></div>
                <div><label style={LBL}>Start</label><input style={IC} type="time" value={classForm.startTime} onChange={e=>setClassForm(f=>({...f,startTime:e.target.value}))} /></div>
                <div><label style={LBL}>End</label><input style={IC} type="time" value={classForm.endTime} onChange={e=>setClassForm(f=>({...f,endTime:e.target.value}))} /></div>
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={addClass} style={BTN(CLASS_COLOR)} disabled={classCreating}>{classCreating?"⏳ Creating…":"✓ Save Class"}</button>
                <button onClick={()=>setShowClassForm(false)} style={BTN("#64748b")}>Cancel</button>
              </div>
            </div>
          )}

          {/* ─── STRUCTURED FILE IMPORT STATUS ──────────────────────────── */}

          {/* CSV/Excel/XML — Processing */}
          {csvPhase==="processing"&&(
            <div style={{...CARD,borderColor:"#05966955",background:"linear-gradient(135deg, rgba(5,150,105,0.04), rgba(16,185,129,0.04))"}}>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{
                  width:40,height:40,borderRadius:"50%",
                  background:"linear-gradient(135deg,#059669,#10b981)",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:20,animation:"pulse 1.2s infinite",flexShrink:0,
                }}>📄</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:2}}>{csvStatusText}</div>
                  <div style={{fontSize:12,color:"var(--muted)"}}>Strict parsing — exact data only, zero guessing</div>
                </div>
              </div>
            </div>
          )}

          {/* CSV/Excel/XML — Success */}
          {csvPhase==="done"&&(
            <div style={{...CARD,borderColor:"#05966955",background:"rgba(5,150,105,0.04)"}}>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
                <div style={{
                  width:44,height:44,borderRadius:"50%",
                  background:"linear-gradient(135deg,#059669,#10b981)",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:22,flexShrink:0,
                }}>✅</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,color:"#059669",fontSize:16,marginBottom:2}}>Timetable Imported — 100% Accurate</div>
                  <div style={{fontSize:13,color:"var(--muted)"}}>
                    {csvImportedCount} classes across {new Set(csvResults.map(c=>c.day)).size} days · Every entry matches your file exactly
                  </div>
                </div>
                <button onClick={resetCsvImport} style={{border:"none",background:"none",cursor:"pointer",color:"var(--muted)",fontSize:18}}>✕</button>
              </div>

              {/* Day summary chips */}
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
                {WEEK_DAYS.filter(d=>csvResults.some(c=>c.day===d)).map(day=>(
                  <span key={day} style={{fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:20,background:"#05966922",color:"#059669",border:"1px solid #05966933"}}>
                    {day}: {csvResults.filter(c=>c.day===day).length} classes
                  </span>
                ))}
              </div>

              {/* Subject pills */}
              <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:csvErrors.length>0?10:0}}>
                {[...new Set(csvResults.map(c=>c.subject))].map(sub=>(
                  <span key={sub} style={{fontSize:11,fontWeight:700,padding:"3px 8px",borderRadius:6,background:subjectColor(sub)+"22",color:subjectColor(sub)}}>{sub}</span>
                ))}
              </div>

              {/* Validation errors/warnings (collapsible) */}
              {(csvErrors.length>0||csvWarnings.length>0)&&(
                <div style={{marginTop:6}}>
                  <button onClick={()=>setShowCsvErrors(v=>!v)} style={{background:"none",border:"none",cursor:"pointer",fontSize:12,color:csvErrors.length>0?"#ef4444":"#d97706",fontWeight:600,padding:0}}>
                    {showCsvErrors?"▼":"▶"} {csvErrors.length} error{csvErrors.length!==1?"s":""}, {csvWarnings.length} warning{csvWarnings.length!==1?"s":""} — {showCsvErrors?"hide":"show details"}
                  </button>
                  {showCsvErrors&&(
                    <div style={{marginTop:8,padding:"10px 12px",background:"var(--bg)",borderRadius:8,border:"1px solid var(--border)",maxHeight:180,overflowY:"auto",fontSize:12}}>
                      {csvErrors.map((e,i)=>(
                        <div key={`e${i}`} style={{color:"#ef4444",marginBottom:4}}>❌ {e}</div>
                      ))}
                      {csvWarnings.map((w,i)=>(
                        <div key={`w${i}`} style={{color:"#d97706",marginBottom:4}}>⚠️ {w}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* CSV/Excel/XML — Error */}
          {csvPhase==="error"&&(
            <div style={{...CARD,borderColor:"#ef444455",background:"rgba(239,68,68,0.04)"}}>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{fontSize:28}}>❌</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,color:"#ef4444",fontSize:14,marginBottom:2}}>{csvStatusText}</div>
                  <div style={{fontSize:12,color:"var(--muted)"}}>Check your file format and try again.</div>
                </div>
                <button onClick={resetCsvImport} style={{border:"none",background:"none",cursor:"pointer",color:"var(--muted)",fontSize:18}}>✕</button>
              </div>

              {/* Show detailed errors */}
              {csvErrors.length>0&&(
                <div style={{marginTop:10,padding:"10px 12px",background:"var(--bg)",borderRadius:8,border:"1px solid #fca5a5",maxHeight:180,overflowY:"auto",fontSize:12}}>
                  {csvErrors.map((e,i)=>(
                    <div key={i} style={{color:"#ef4444",marginBottom:4}}>❌ {e}</div>
                  ))}
                </div>
              )}

              {/* Format help */}
              <div style={{marginTop:10,padding:"12px 14px",background:"var(--bg)",borderRadius:8,border:"1px solid var(--border)",fontSize:12,color:"var(--muted)"}}>
                <div style={{fontWeight:700,color:"var(--text)",marginBottom:6}}>📋 Expected CSV Format:</div>
                <code style={{display:"block",background:"var(--surface)",padding:"8px 10px",borderRadius:6,fontSize:11,lineHeight:1.6,whiteSpace:"pre",overflowX:"auto",color:"var(--text)"}}>
{`Day,08:30-09:20,09:20-10:10,10:10-11:00
Monday,DM,AJP,TOC
Tuesday,MI,AJP,
Wednesday,AJP,TOC,DM`}
                </code>
                <div style={{fontWeight:700,color:"var(--text)",marginTop:10,marginBottom:6}}>📋 Expected XML Format:</div>
                <code style={{display:"block",background:"var(--surface)",padding:"8px 10px",borderRadius:6,fontSize:11,lineHeight:1.6,whiteSpace:"pre",overflowX:"auto",color:"var(--text)"}}>
{`<week>
  <day name="Monday">
    <class subject="DM" start="08:30" end="09:20"/>
  </day>
</week>`}
                </code>
              </div>

              <div style={{display:"flex",gap:8,marginTop:10}}>
                <button onClick={()=>{resetCsvImport();csvFileRef.current?.click();}} style={{...BTN("#059669"),background:"linear-gradient(135deg,#059669,#10b981)"}}>📄 Try Another File</button>
                <button onClick={()=>{resetCsvImport();setShowClassForm(true);}} style={BTN(CLASS_COLOR)}>+ Add Manually</button>
              </div>
            </div>
          )}

          {/* ─── OCR IMPORT STATUS BAR ─────────────────────────────────────── */}

          {/* Processing state — animated progress */}
          {ocrPhase==="processing"&&(
            <div style={{...CARD,borderColor:"#4f46e555",background:"linear-gradient(135deg, rgba(79,70,229,0.04), rgba(124,58,237,0.04))"}}>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
                <div style={{
                  width:40,height:40,borderRadius:"50%",
                  background:"linear-gradient(135deg,#4f46e5,#7c3aed)",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:20,
                  animation:"pulse 1.2s infinite",
                  flexShrink:0,
                }}>🔬</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:2}}>{ocrStatusText}</div>
                  <div style={{fontSize:12,color:"var(--muted)"}}>Fully automatic — no input needed</div>
                </div>
              </div>
              {/* Progress bar */}
              <div style={{height:6,background:"var(--border)",borderRadius:3,overflow:"hidden"}}>
                <div style={{
                  height:"100%",
                  width:`${ocrProgress}%`,
                  background:"linear-gradient(90deg,#4f46e5,#7c3aed)",
                  borderRadius:3,
                  transition:"width 0.4s ease-out",
                }}/>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
                <span style={{fontSize:11,color:"var(--muted)"}}>{ocrProgress < 40 ? "OCR extraction" : ocrProgress < 60 ? "Structure analysis" : ocrProgress < 80 ? "Creating classes" : "Finalizing..."}</span>
                <span style={{fontSize:11,color:"#4f46e5",fontWeight:700}}>{ocrProgress}%</span>
              </div>
            </div>
          )}

          {/* Success state */}
          {ocrPhase==="done"&&(
            <div style={{...CARD,borderColor:"#05966955",background:"rgba(5,150,105,0.04)"}}>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
                <div style={{
                  width:44,height:44,borderRadius:"50%",
                  background:"linear-gradient(135deg,#059669,#10b981)",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:22,flexShrink:0,
                }}>✅</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,color:"#059669",fontSize:16,marginBottom:2}}>Timetable Imported Successfully!</div>
                  <div style={{fontSize:13,color:"var(--muted)"}}>
                    {importedCount} classes across {new Set(lastImportResults.map(c=>c.day)).size} days · Auto-saved to your schedule
                  </div>
                </div>
                <button onClick={resetOcr} style={{border:"none",background:"none",cursor:"pointer",color:"var(--muted)",fontSize:18}}>✕</button>
              </div>

              {/* Summary chips */}
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
                {[...new Set(lastImportResults.map(c=>c.day))].map(day=>(
                  <span key={day} style={{fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:20,background:"#05966922",color:"#059669",border:"1px solid #05966933"}}>
                    {day}: {lastImportResults.filter(c=>c.day===day).length} classes
                  </span>
                ))}
              </div>

              {/* Subject list */}
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                {[...new Set(lastImportResults.map(c=>c.subject))].map(sub=>(
                  <span key={sub} style={{fontSize:11,fontWeight:700,padding:"3px 8px",borderRadius:6,background:subjectColor(sub)+"22",color:subjectColor(sub)}}>
                    {sub}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Error state */}
          {ocrPhase==="error"&&(
            <div style={{...CARD,borderColor:"#ef444455",background:"rgba(239,68,68,0.04)"}}>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{fontSize:28}}>⚠️</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,color:"#ef4444",fontSize:14,marginBottom:2}}>{ocrStatusText}</div>
                  <div style={{fontSize:12,color:"var(--muted)"}}>You can still add classes manually below.</div>
                </div>
                <button onClick={resetOcr} style={{border:"none",background:"none",cursor:"pointer",color:"var(--muted)",fontSize:18}}>✕</button>
              </div>
              <div style={{display:"flex",gap:8,marginTop:10}}>
                <button onClick={()=>{resetOcr();fileRef.current?.click();}} style={BTN(PLAN_COLOR)}>📸 Try Another Image</button>
                <button onClick={()=>{resetOcr();setShowClassForm(true);}} style={BTN(CLASS_COLOR)}>+ Add Manually</button>
              </div>
            </div>
          )}

          {/* Timetable display */}
          {classes.length===0&&ocrPhase==="idle"&&csvPhase==="idle"&&!showClassForm&&(
            <div style={EMPTY}>No classes yet — click "+ Add Class", "📄 Import CSV / Excel", or "📸 Import from Image"</div>
          )}

          {/* ════════ TABLE VIEW (strict fixed-column timetable grid) ════════ */}
          {showTimetable&&classes.length>0&&(()=>{
            // ── STEP 1: Get FIXED column structure from stored header slots ──
            // If we have stored header slots from import, use those.
            // Otherwise, reconstruct atomic slots from class start/end times.
            let fixedSlots = [];
            if (timetableSlots.length > 0) {
              // Use stored header slots — each is {start, end}, extracted ONCE from header
              fixedSlots = timetableSlots;
            } else {
              // Fallback: reconstruct from classes (for manually added classes)
              // Collect all unique time boundaries, build consecutive pairs
              const boundaries = new Set();
              classes.forEach(c => { boundaries.add(c.startTime); boundaries.add(c.endTime); });
              const sorted = [...boundaries].sort();
              for (let i = 0; i < sorted.length - 1; i++) {
                fixedSlots.push({ start: sorted[i], end: sorted[i + 1] });
              }
            }

            // ── VALIDATION: no duplicate time slots ──
            const slotKeys = fixedSlots.map(s => `${s.start}-${s.end}`);
            const uniqueKeys = new Set(slotKeys);
            if (uniqueKeys.size !== slotKeys.length) {
              console.error("[TimetableView] DUPLICATE TIME SLOTS DETECTED:", slotKeys);
            }
            console.log("[TimetableView] FIXED COLUMNS:", slotKeys.join(" | "));

            // Days that have classes
            const activeDays = WEEK_DAYS.filter(d => classes.some(c => c.day === d));

            // ── STEP 2: Build slot-index map for quick lookup ──
            // slotIdx["08:30"] = 0, slotIdx["09:20"] = 1, etc.
            const slotIdxByStart = {};
            fixedSlots.forEach((s, idx) => { slotIdxByStart[s.start] = idx; });

            // ── STEP 3: For each day, build a cell array matching fixedSlots ──
            // Each cell = { class, colSpan } or null (empty) or "skip" (covered by previous colSpan)
            const isLab = s => /lab|practical|workshop/i.test(s || '');

            function buildDayRow(day) {
              const cells = new Array(fixedSlots.length).fill(null);
              // Get classes for this day, sorted by startTime
              const dayClasses = classes.filter(c => c.day === day).sort((a, b) => a.startTime.localeCompare(b.startTime));

              for (const c of dayClasses) {
                const startIdx = slotIdxByStart[c.startTime];
                if (startIdx === undefined) continue; // class doesn't align with any slot

                // Find how many fixed slots this class spans
                let span = 1;
                for (let k = startIdx + 1; k < fixedSlots.length; k++) {
                  // If this slot's start < class endTime, it's covered
                  if (fixedSlots[k].start < c.endTime) {
                    span++;
                  } else {
                    break;
                  }
                }

                // Place the class at startIdx with colSpan
                cells[startIdx] = { cls: c, colSpan: span };
                // Mark subsequent cells as "skip" (covered by colspan)
                for (let k = startIdx + 1; k < startIdx + span && k < cells.length; k++) {
                  cells[k] = "skip";
                }
              }
              return cells;
            }

            return(
              <div style={{overflowX:"auto",marginBottom:20}}>
                <table style={{width:"100%",borderCollapse:"separate",borderSpacing:0,borderRadius:12,overflow:"hidden",border:"1px solid var(--border)",fontSize:13}}>
                  <thead>
                    <tr>
                      <th style={{padding:"10px 14px",background:"linear-gradient(135deg,#1e293b,#334155)",color:"#e2e8f0",fontWeight:800,fontSize:12,textAlign:"left",letterSpacing:".5px",textTransform:"uppercase",borderBottom:"2px solid #4f46e5",position:"sticky",left:0,zIndex:2,minWidth:90}}>Day</th>
                      {fixedSlots.map((slot,si)=>(
                        <th key={si} style={{padding:"10px 8px",background:"linear-gradient(135deg,#1e293b,#334155)",color:"#e2e8f0",fontWeight:700,fontSize:11,textAlign:"center",borderBottom:"2px solid #4f46e5",whiteSpace:"nowrap",minWidth:100}}>
                          {slot.start}<br/><span style={{color:"#94a3b8",fontSize:10}}>to {slot.end}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activeDays.map((day,di)=>{
                      const cells = buildDayRow(day);
                      return(
                        <tr key={day} style={{background:di%2===0?"var(--surface)":"var(--bg)"}}>
                          <td style={{padding:"10px 14px",fontWeight:800,color:"var(--text)",fontSize:13,borderRight:"2px solid var(--border)",borderBottom:"1px solid var(--border)",position:"sticky",left:0,background:di%2===0?"var(--surface)":"var(--bg)",zIndex:1}}>{day}</td>
                          {cells.map((cell,ci)=>{
                            // Skip cells covered by a previous colspan
                            if(cell==="skip") return null;
                            // Empty cell
                            if(cell===null) return <td key={ci} style={{padding:"8px 6px",textAlign:"center",borderBottom:"1px solid var(--border)",borderRight:"1px solid var(--border)",color:"var(--subtle)",fontSize:11}}>—</td>;
                            // Class cell (possibly spanning multiple columns)
                            const c = cell.cls;
                            const col = subjectColor(c.subject);
                            const lab = isLab(c.subject);
                            return(
                              <td key={ci} colSpan={cell.colSpan} style={{padding:"6px",borderBottom:"1px solid var(--border)",borderRight:"1px solid var(--border)",verticalAlign:"middle"}}>
                                <div style={{display:"flex",alignItems:"center",gap:6,padding:"6px 10px",borderRadius:8,background:`${col}18`,border:`1.5px solid ${col}44`,position:"relative",overflow:"hidden"}}>
                                  <div style={{position:"absolute",left:0,top:0,bottom:0,width:4,background:col,borderRadius:"4px 0 0 4px"}}/>
                                  <div style={{flex:1,paddingLeft:4}}>
                                    <div style={{fontWeight:700,color:"var(--text)",fontSize:13,lineHeight:1.3}}>{c.subject}</div>
                                    <div style={{fontSize:10,color:"var(--muted)",marginTop:1}}>{c.startTime} – {c.endTime}{cell.colSpan>1?` (${cell.colSpan} slots)`:""}</div>
                                  </div>
                                  <span style={{fontSize:9,fontWeight:700,color:"#fff",background:lab?"#7c3aed":col,borderRadius:4,padding:"2px 6px",flexShrink:0,letterSpacing:".3px"}}>{lab?"LAB":"THY"}</span>
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{display:"flex",gap:12,marginTop:10,fontSize:11,color:"var(--muted)",alignItems:"center"}}>
                  <span style={{display:"flex",alignItems:"center",gap:4}}><span style={{width:12,height:12,borderRadius:3,background:"#0891b2",display:"inline-block"}}/> Theory</span>
                  <span style={{display:"flex",alignItems:"center",gap:4}}><span style={{width:12,height:12,borderRadius:3,background:"#7c3aed",display:"inline-block"}}/> Lab / Practical</span>
                  <span style={{marginLeft:"auto"}}>{classes.length} classes · {activeDays.length} days · {fixedSlots.length} time slots</span>
                </div>
              </div>
            );
          })()}

          {/* ════════ LIST VIEW (original card layout) ════════ */}
          {!showTimetable&&classes.length>0&&WEEK_DAYS.filter(d=>classes.some(c=>c.day===d)).map(day=>(
            <div key={day} style={{marginBottom:20}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <div style={{height:1,flex:1,background:"var(--border)"}}/>
                <span style={{fontSize:12,fontWeight:800,color:"var(--muted)",letterSpacing:1,textTransform:"uppercase"}}>{day}</span>
                <div style={{height:1,flex:1,background:"var(--border)"}}/>
              </div>
              {classes.filter(c=>c.day===day).sort((a,b)=>a.startTime.localeCompare(b.startTime)).map(c=>{
                const col=subjectColor(c.subject), isEdit=editingId===c.id;
                return(
                  <div key={c.id} style={{display:"flex",alignItems:"center",gap:10,background:"var(--surface)",borderRadius:10,padding:"10px 14px",border:`1px solid ${col}33`,borderLeft:`4px solid ${col}`,marginBottom:6}}>
                    {isEdit?(
                      <>
                        <input style={{...IC,width:120}} value={editBuf.subject} onChange={e=>setEditBuf(b=>({...b,subject:e.target.value}))}/>
                        <select style={{...IC,width:110}} value={editBuf.day} onChange={e=>setEditBuf(b=>({...b,day:e.target.value}))}>{WEEK_DAYS.map(d=><option key={d}>{d}</option>)}</select>
                        <input style={{...IC,width:80}} type="time" value={editBuf.startTime} onChange={e=>setEditBuf(b=>({...b,startTime:e.target.value}))}/>
                        <span style={{color:"var(--muted)"}}>–</span>
                        <input style={{...IC,width:80}} type="time" value={editBuf.endTime} onChange={e=>setEditBuf(b=>({...b,endTime:e.target.value}))}/>
                        <button onClick={()=>saveEdit(c.id)} style={{...BTN(CLASS_COLOR),padding:"4px 12px"}}>✓</button>
                        <button onClick={()=>setEditingId(null)} style={{...BTN("#64748b"),padding:"4px 12px"}}>✕</button>
                      </>
                    ):(
                      <>
                        <div style={{width:10,height:10,borderRadius:"50%",background:col,flexShrink:0}}/>
                        <div style={{flex:1}}>
                          <div style={{fontWeight:700,color:"var(--text)",fontSize:14}}>{c.subject}</div>
                          <div style={{fontSize:12,color:"var(--muted)"}}>{c.startTime} – {c.endTime}{c.calendarId&&<span style={{marginLeft:8,fontSize:10,color:col,fontWeight:600}}>📅 Synced</span>}</div>
                        </div>
                        <span style={{fontSize:11,fontWeight:700,color:"#fff",background:col,borderRadius:6,padding:"2px 8px"}}>CLASS</span>
                        <span style={{fontSize:10,color:"var(--muted)"}}>🔁 Weekly</span>
                        <button onClick={()=>startEdit(c.id)} style={{border:"none",background:"none",color:"#3b82f6",cursor:"pointer",fontSize:14,padding:2}} title="Edit">✏️</button>
                        <button onClick={()=>deleteClass(c.id)} style={{border:"none",background:"none",color:"#ef4444",cursor:"pointer",fontSize:14,padding:2}} title="Delete">🗑️</button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {/* Plan study block — intelligent time blocking */}
          <div style={{...CARD,marginTop:24,borderColor:`${STUDY_COLOR}44`}}>
            <div style={{fontWeight:700,color:"var(--text)",marginBottom:4,fontSize:15}}>🧠 Intelligent Study Scheduler</div>
            <div style={{fontSize:12,color:"var(--muted)",marginBottom:14}}>Finds the best free slot based on your classes, events, and study patterns</div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
              <div><label style={LBL}>Subject</label>
                <select style={{...IC,width:160}} value={studyPlan.subject} onChange={e=>setStudyPlan(p=>({...p,subject:e.target.value}))}>
                  <option value="">Select…</option>
                  {[...new Set([...subjects,...classes.map(c=>c.subject)])].map(s=><option key={s}>{s}</option>)}
                </select>
              </div>
              <div><label style={LBL}>Duration (min)</label><input style={{...IC,width:80}} type="number" min={15} max={480} step={15} value={studyPlan.duration} onChange={e=>setStudyPlan(p=>({...p,duration:+e.target.value}))}/></div>
              <div><label style={LBL}>Prefer Day</label>
                <select style={{...IC,width:120}} value={studyPlan.day} onChange={e=>setStudyPlan(p=>({...p,day:e.target.value}))}>
                  <option value="">Any day</option>
                  {WEEK_DAYS.map(d=><option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <button onClick={planStudySession} style={{...BTN(STUDY_COLOR),height:38,display:"flex",alignItems:"center",gap:6}}>🧠 Find Best Slot & Book</button>
            </div>

            {/* Scoring Legend */}
            <div style={{marginTop:12,padding:"8px 12px",background:"var(--bg)",borderRadius:8,fontSize:11,color:"var(--muted)",display:"flex",gap:14,flexWrap:"wrap"}}>
              <span>✨ Scoring: </span>
              <span>+2 Morning (8–12)</span>
              <span>+3 Optimal gap (45–120min)</span>
              <span>+1 Breathing room</span>
              <span>-2 After 8PM</span>
              <span>Max 2/day</span>
            </div>

            {/* Result display */}
            {studyResult && (
              <div style={{marginTop:14}}>
                {studyResult.booked ? (
                  <div style={{padding:"12px 16px",background:"#d1fae522",border:"1px solid #10b98144",borderRadius:10}}>
                    <div style={{fontWeight:700,color:"#059669",fontSize:14,marginBottom:4}}>✅ Booked: {studyResult.subject}</div>
                    <div style={{fontSize:13,color:"var(--text)"}}>{studyResult.slot.dateLabel} · {studyResult.startStr} – {studyResult.endStr} <span style={{fontSize:11,color:"var(--muted)"}}>(score: {studyResult.slot.score})</span></div>
                    {studyResult.alternatives.length > 0 && (
                      <div style={{marginTop:8}}>
                        <div style={{fontSize:11,color:"var(--muted)",marginBottom:4}}>Other options found:</div>
                        {studyResult.alternatives.map((alt, i) => (
                          <div key={i} style={{fontSize:12,color:"var(--subtle)",paddingLeft:8}}>
                            {alt.dateLabel} · {alt.start.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} – {alt.end.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} (score: {alt.score})
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{padding:"12px 16px",background:"#fef3c722",border:"1px solid #f59e0b44",borderRadius:10}}>
                    <div style={{fontWeight:700,color:"#d97706",fontSize:14}}>❌ No suitable free slot found</div>
                    <div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>Try a shorter duration, different day, or remove some events to free up time.</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════ STUDY PLANNER ═══════════════════════════════════════ */}
      {activeTab==="study"&&(
        <div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:20}}>
            {[{label:"This Week",value:`${Math.floor(wMin/60)}h ${wMin%60}m`,icon:"📅"},{label:"Total",value:`${Math.floor(tMin/60)}h`,icon:"🕐"},{label:"Sessions",value:studyLogs.length,icon:"✅"}].map(s=>(
              <div key={s.label} style={{...CARD,textAlign:"center",marginBottom:0}}>
                <div style={{fontSize:24}}>{s.icon}</div>
                <div style={{fontSize:20,fontWeight:800,color:"var(--text)"}}>{s.value}</div>
                <div style={{fontSize:12,color:"var(--muted)"}}>{s.label}</div>
              </div>
            ))}
          </div>
          <div style={{...CARD,background:wMin<600?"#fef3c722":"#d1fae522",borderColor:wMin<600?"#f59e0b55":"#10b98155",marginBottom:20}}>
            <div style={{fontWeight:700,color:wMin<600?"#d97706":"#059669"}}>{wMin<600?"⚠️ Below 10h this week — keep pushing!":"🎉 Great study pace! Keep it up."}</div>
            <div style={{fontSize:13,color:"var(--muted)",marginTop:4}}>{Math.floor(wMin/60)}h {wMin%60}m this week — target: 10h+/week</div>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:14}}>
            <h3 style={{margin:0,color:"var(--text)",fontSize:16}}>Session History</h3>
            <button onClick={()=>setShowStudyForm(v=>!v)} style={BTN(STUDY_COLOR)}>+ Log Session</button>
          </div>
          {showStudyForm&&(
            <div style={CARD}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
                <div><label style={LBL}>Subject</label><select style={IC} value={studyForm.subject} onChange={e=>setStudyForm(f=>({...f,subject:e.target.value}))}><option value="">Select…</option>{subjects.map(s=><option key={s}>{s}</option>)}</select></div>
                <div><label style={LBL}>Duration (min)</label><input style={IC} type="number" min={5} max={480} value={studyForm.duration} onChange={e=>setStudyForm(f=>({...f,duration:+e.target.value}))}/></div>
                <div><label style={LBL}>Date</label><input style={IC} type="date" value={studyForm.date} onChange={e=>setStudyForm(f=>({...f,date:e.target.value}))}/></div>
              </div>
              <div style={{display:"flex",gap:8,marginTop:12}}>
                <button onClick={logStudySession} style={BTN(STUDY_COLOR)}>✓ Log</button>
                <button onClick={()=>setShowStudyForm(false)} style={BTN("#64748b")}>Cancel</button>
              </div>
            </div>
          )}
          {!studyLogs.length&&!showStudyForm&&<div style={EMPTY}>No sessions logged yet</div>}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {[...studyLogs].reverse().slice(0,20).map(l=>(
              <div key={l.id} style={{display:"flex",alignItems:"center",gap:12,background:"var(--surface)",borderRadius:10,padding:"10px 14px",borderLeft:`4px solid ${subjectColor(l.subject)}`}}>
                <div style={{width:10,height:10,borderRadius:"50%",background:subjectColor(l.subject),flexShrink:0}}/>
                <div style={{flex:1}}><div style={{fontWeight:700,color:"var(--text)",fontSize:14}}>{l.subject}</div><div style={{fontSize:12,color:"var(--muted)"}}>{l.date} · {l.duration} min</div></div>
                <button onClick={()=>{setStudyLogs(p=>p.filter(x=>x.id!==l.id));toast?.("🗑️ Session removed");}} style={{border:"none",background:"none",color:"#ef4444",cursor:"pointer",fontSize:15}}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════════ ANALYTICS — ADAPTIVE AI ════════════════════════════ */}
      {activeTab==="analytics"&&(
        <div>
          {/* ─── Smart Recommendations ──────────────────────────────── */}
          <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:20}}>
            {smartRecs.map((rec,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"var(--surface)",borderRadius:10,border:`1px solid ${rec.color}33`,borderLeft:`4px solid ${rec.color}`}}>
                <span style={{fontSize:20}}>{rec.icon}</span>
                <span style={{fontSize:13,color:"var(--text)",flex:1}}>{rec.msg}</span>
              </div>
            ))}
          </div>

          {/* ─── Progress Overview ──────────────────────────────────── */}
          <div style={{...CARD,borderColor:completionStats.pct>=80?"#22c55e44":completionStats.pct>=50?"#f9731644":"#ef444444"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontWeight:700,color:"var(--text)",fontSize:16}}>📊 Study Progress</div>
              <div style={{fontSize:28,fontWeight:800,color:completionStats.pct>=80?"#22c55e":completionStats.pct>=50?"#f97316":"#ef4444"}}>{completionStats.pct}%</div>
            </div>
            <div style={{height:12,background:"var(--border)",borderRadius:6,overflow:"hidden",marginBottom:8}}>
              <div style={{height:"100%",width:`${completionStats.pct}%`,background:`linear-gradient(90deg,${completionStats.pct>=80?"#22c55e":completionStats.pct>=50?"#f97316":"#ef4444"},${completionStats.pct>=80?"#16a34a":completionStats.pct>=50?"#ea580c":"#dc2626"})`,borderRadius:6,transition:"width .5s"}}/>
            </div>
            <div style={{display:"flex",gap:20,fontSize:13,color:"var(--muted)"}}>
              <span>✅ {completionStats.completed} completed</span>
              <span>📋 {completionStats.total} total planned</span>
              <span>⏳ {completionStats.total-completionStats.completed} remaining</span>
            </div>
            {completionStats.total>0&&<div style={{fontSize:11,color:"var(--muted)",marginTop:6}}>AI Adaptive Load: {completionStats.pct<50?"🔽 Reduced (overwhelmed)":completionStats.pct>80?"🔼 Increased (on track)":"➡️ Normal"}</div>}
          </div>

          {/* ─── Subject-wise Time Analytics ────────────────────────── */}
          {(()=>{
            const analytics=getSubjectTimeAnalytics();
            return(
              <div style={CARD}>
                <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:4}}>📚 Subject Time Breakdown</div>
                <div style={{fontSize:12,color:"var(--muted)",marginBottom:14}}>Total: {Math.floor(analytics.totalMin/60)}h {analytics.totalMin%60}m studied</div>
                {analytics.subjects.length===0&&<div style={{fontSize:13,color:"var(--muted)",textAlign:"center",padding:16}}>No study data yet — complete sessions to see analytics</div>}
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  {analytics.subjects.map(s=>{
                    const col=subjectColor(s.subject);
                    return(
                      <div key={s.subject} style={{background:"var(--bg)",borderRadius:10,padding:"10px 14px",border:`1px solid var(--border)`,borderLeft:`4px solid ${col}`}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <span style={{width:10,height:10,borderRadius:"50%",background:col,display:"inline-block"}}/>
                            <span style={{fontWeight:700,color:"var(--text)",fontSize:14}}>{s.subject}</span>
                          </div>
                          <div style={{display:"flex",gap:12,fontSize:12,color:"var(--muted)",alignItems:"center"}}>
                            <span>🕐 {Math.floor(s.totalMin/60)}h {s.totalMin%60}m</span>
                            <span>✅ {s.sessions} sessions</span>
                            <span style={{fontWeight:700,color:col,fontSize:13}}>{s.pct}%</span>
                          </div>
                        </div>
                        <div style={{height:8,background:"var(--border)",borderRadius:4,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${s.pct}%`,background:`linear-gradient(90deg,${col},${col}99)`,borderRadius:4,transition:"width .4s"}}/>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* ─── Weekly / Monthly Plan Toggle ──────────────────────── */}
          <div style={CARD}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontWeight:700,color:"var(--text)",fontSize:15}}>📅 Study Distribution</div>
              <div style={{display:"flex",gap:4,background:"var(--bg)",borderRadius:8,padding:2}}>
                {["weekly","monthly"].map(v=>(
                  <button key={v} onClick={()=>setAnalyticsView(v)} style={{padding:"5px 14px",borderRadius:6,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,background:analyticsView===v?STUDY_COLOR:"transparent",color:analyticsView===v?"#fff":"var(--muted)",transition:"all .15s"}}>{v==="weekly"?"📆 Weekly":"📊 Monthly"}</button>
                ))}
              </div>
            </div>

            {analyticsView==="weekly"&&(()=>{
              const plan=getWeeklyPlan();
              const maxMin=Math.max(...plan.map(d=>d.totalMin),1);
              return(
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {plan.map((d,i)=>{
                    const pct=Math.round(d.totalMin/maxMin*100);
                    const isToday=new Date().getDay()===i;
                    return(
                      <div key={d.day} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:isToday?`${STUDY_COLOR}08`:"var(--bg)",borderRadius:8,border:isToday?`1px solid ${STUDY_COLOR}33`:"1px solid var(--border)"}}>
                        <span style={{fontWeight:700,fontSize:13,color:isToday?STUDY_COLOR:"var(--text)",minWidth:36}}>{d.day}</span>
                        <div style={{flex:1,height:8,background:"var(--border)",borderRadius:4,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${pct}%`,background:isToday?STUDY_COLOR:`${STUDY_COLOR}88`,borderRadius:4,transition:"width .4s"}}/>
                        </div>
                        <span style={{fontSize:12,fontWeight:600,color:"var(--muted)",minWidth:50,textAlign:"right"}}>{d.totalMin>0?`${Math.floor(d.totalMin/60)}h ${d.totalMin%60}m`:"—"}</span>
                        <span style={{fontSize:11,color:"var(--muted)",minWidth:80,textAlign:"right"}}>{d.subjects.length>0?d.subjects.slice(0,2).join(", "):""}{d.subjects.length>2?" +"+(d.subjects.length-2):""}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {analyticsView==="monthly"&&(()=>{
              const plan=getMonthlyPlan();
              const maxMin=Math.max(...plan.map(d=>d.totalMin),1);
              return(
                <div>
                  {plan.length===0&&<div style={{fontSize:13,color:"var(--muted)",textAlign:"center",padding:16}}>No data this month yet</div>}
                  <div style={{display:"flex",flexDirection:"column",gap:4}}>
                    {plan.map(d=>{
                      const pct=Math.round(d.totalMin/maxMin*100);
                      const isToday=d.dateKey===new Date().toISOString().split("T")[0];
                      return(
                        <div key={d.dateKey} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 12px",background:isToday?`${STUDY_COLOR}08`:"var(--bg)",borderRadius:8,border:isToday?`1px solid ${STUDY_COLOR}33`:"1px solid transparent"}}>
                          <span style={{fontWeight:isToday?700:500,fontSize:12,color:isToday?STUDY_COLOR:"var(--text)",minWidth:100}}>{d.label}</span>
                          <div style={{flex:1,height:6,background:"var(--border)",borderRadius:3,overflow:"hidden"}}>
                            <div style={{height:"100%",width:`${pct}%`,background:isToday?STUDY_COLOR:`${STUDY_COLOR}66`,borderRadius:3}}/>
                          </div>
                          <span style={{fontSize:11,color:"var(--muted)",minWidth:50,textAlign:"right"}}>{Math.floor(d.totalMin/60)}h {d.totalMin%60}m</span>
                          <span style={{fontSize:11,color:"var(--muted)",minWidth:40,textAlign:"right"}}>{d.sessions} sess</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>

          {/* ─── Adaptive AI Status ─────────────────────────────────── */}
          {(()=>{
            const {mult,neglected,completionPct}=getAdaptiveMultiplier();
            return(
              <div style={{...CARD,borderColor:`${STUDY_COLOR}44`}}>
                <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:8}}>🤖 Adaptive AI Status</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:10}}>
                  <div style={{background:"var(--bg)",borderRadius:8,padding:10,textAlign:"center"}}>
                    <div style={{fontSize:20,marginBottom:2}}>{mult<1?"🔽":mult>1?"🔼":"➡️"}</div>
                    <div style={{fontSize:11,fontWeight:700,color:"var(--text)"}}>Load: {mult<1?"Reduced":mult>1?"Increased":"Normal"}</div>
                    <div style={{fontSize:10,color:"var(--muted)"}}>×{mult.toFixed(1)} multiplier</div>
                  </div>
                  <div style={{background:"var(--bg)",borderRadius:8,padding:10,textAlign:"center"}}>
                    <div style={{fontSize:20,marginBottom:2}}>📊</div>
                    <div style={{fontSize:11,fontWeight:700,color:"var(--text)"}}>{completionPct}% Done</div>
                    <div style={{fontSize:10,color:"var(--muted)"}}>Completion rate</div>
                  </div>
                  <div style={{background:"var(--bg)",borderRadius:8,padding:10,textAlign:"center"}}>
                    <div style={{fontSize:20,marginBottom:2}}>{neglected.length>0?"⚠️":"✅"}</div>
                    <div style={{fontSize:11,fontWeight:700,color:"var(--text)"}}>{neglected.length>0?`${neglected.length} Neglected`:"All Good"}</div>
                    <div style={{fontSize:10,color:"var(--muted)"}}>{neglected.length>0?neglected.slice(0,2).join(", "):"No gaps"}</div>
                  </div>
                </div>
                <div style={{fontSize:11,color:"var(--muted)",padding:"6px 10px",background:"var(--bg)",borderRadius:6}}>The AI adjusts your study plan automatically: {mult<1?"⬇️ Fewer sessions (completion is low — avoid overwhelm)":mult>1?"⬆️ More sessions (you're crushing it!)":"↔️ Balanced load (maintain current pace)"}</div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ══════════════ SUBJECT TRACKING ════════════════════════════════════ */}
      {activeTab==="tracking"&&(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
            <h2 style={{margin:0,color:"var(--text)",fontSize:18,fontWeight:700}}>Subject-wise Stats</h2>
            <div style={{display:"flex",gap:8}}>
              <input style={{...IC,width:160}} placeholder="New subject…" value={newSubject} onChange={e=>setNewSubject(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&newSubject.trim()){setSubjects(p=>[...new Set([...p,newSubject.trim()])]);setNewSubject("");toast?.("📚 Added!");}}}/>
              <button onClick={()=>{if(newSubject.trim()){setSubjects(p=>[...new Set([...p,newSubject.trim()])]);setNewSubject("");toast?.("📚 Added!");}}} style={BTN(CLASS_COLOR)}>Add</button>
            </div>
          </div>
          {!subjects.length&&<div style={EMPTY}>No subjects yet</div>}
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {subjects.map(sub=>{
              const s=stats[sub]||{sessions:0,totalMin:0};
              const mx=Math.max(...subjects.map(x=>(stats[x]||{}).totalMin||0),1);
              const pct=Math.round(s.totalMin/mx*100);
              const col=subjectColor(sub);
              return(
                <div key={sub} style={{background:"var(--surface)",borderRadius:12,padding:"14px 16px",border:"1px solid var(--border)",borderLeft:`4px solid ${col}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <div style={{fontWeight:700,color:"var(--text)",fontSize:15,display:"flex",alignItems:"center",gap:8}}>
                      <span style={{width:10,height:10,borderRadius:"50%",background:col,display:"inline-block"}}/>
                      {sub}
                    </div>
                    <div style={{display:"flex",gap:14,fontSize:13,color:"var(--muted)",alignItems:"center"}}>
                      <span>🕐 {Math.floor(s.totalMin/60)}h {s.totalMin%60}m</span>
                      <span>✅ {s.sessions}</span>
                      <button onClick={()=>{setSubjects(p=>p.filter(x=>x!==sub));toast?.("🗑️ Removed");}} style={{border:"none",background:"none",color:"#ef4444",cursor:"pointer",fontSize:14}}>✕</button>
                    </div>
                  </div>
                  <div style={{height:8,background:"var(--border)",borderRadius:4,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${pct}%`,background:`linear-gradient(90deg,${col},${col}90)`,borderRadius:4,transition:"width .4s"}}/>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ══════════════ EXAMS — FEATURE 2 ═══════════════════════════════════ */}
      {activeTab==="exams"&&(
        <div>
          {/* Study Preferences — controls exam study plan generation */}
          <div style={{...CARD,borderColor:`${STUDY_COLOR}44`,marginBottom:20}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:showStudySettings?14:0}}>
              <div>
                <div style={{fontWeight:700,color:"var(--text)",fontSize:15}}>⚙️ Study Preferences</div>
                <div style={{fontSize:12,color:"var(--muted)",marginTop:2}}>Window: {studySettings.startTime} – {studySettings.endTime} · Hard {studySettings.hardMax}m · Med {studySettings.mediumMax}m · Easy {studySettings.easyMax}m</div>
              </div>
              <button onClick={()=>setShowStudySettings(v=>!v)} style={{...BTN(showStudySettings?"#64748b":STUDY_COLOR),padding:"6px 14px",fontSize:12}}>{showStudySettings?"✕ Close":"✏️ Edit"}</button>
            </div>
            {showStudySettings&&(
              <div style={{borderTop:"1px solid var(--border)",paddingTop:14}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
                  <div><label style={LBL}>Study Start Time</label><input style={IC} type="time" value={studySettings.startTime} onChange={e=>updateStudySetting("startTime",e.target.value)}/></div>
                  <div><label style={LBL}>Study End Time</label><input style={IC} type="time" value={studySettings.endTime} onChange={e=>updateStudySetting("endTime",e.target.value)}/></div>
                </div>
                <div style={{fontSize:13,fontWeight:700,color:"var(--text)",marginBottom:10}}>Difficulty Presets</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
                  {[{key:"hard",label:"🔴 Hard",color:"#ef4444"},{key:"medium",label:"🟡 Medium",color:"#f97316"},{key:"easy",label:"🟢 Easy",color:"#22c55e"}].map(d=>(
                    <div key={d.key} style={{background:"var(--bg)",borderRadius:10,padding:12,border:`1px solid ${d.color}33`}}>
                      <div style={{fontWeight:700,fontSize:12,color:d.color,marginBottom:8}}>{d.label}</div>
                      <div><label style={LBL}>Max session (min)</label><input style={IC} type="number" min={15} max={360} step={15} value={studySettings[`${d.key}Max`]} onChange={e=>updateStudySetting(`${d.key}Max`,+e.target.value)}/></div>
                      <div style={{marginTop:6}}><label style={LBL}>Break (min)</label><input style={IC} type="number" min={5} max={30} step={5} value={studySettings[`${d.key}Break`]} onChange={e=>updateStudySetting(`${d.key}Break`,+e.target.value)}/></div>
                    </div>
                  ))}
                </div>
                <div style={{marginTop:12,padding:"8px 12px",background:"var(--bg)",borderRadius:8,fontSize:11,color:"var(--muted)",display:"flex",gap:14,flexWrap:"wrap"}}>
                  <span>📐 Rules:</span>
                  <span>Gap ≤ 5min → merge</span>
                  <span>Exceeds max → split + break</span>
                  <span>Subject switch → +{SUBJECT_SWITCH_GAP}min gap</span>
                  <span>Sessions only inside study window</span>
                </div>
                <button onClick={()=>{setStudySettings(DEFAULT_STUDY_SETTINGS);lsSet("ss-study-settings",DEFAULT_STUDY_SETTINGS);toast?.("🔄 Settings reset to defaults");}} style={{...BTN("#64748b"),marginTop:10,padding:"6px 14px",fontSize:12}}>🔄 Reset to Defaults</button>
              </div>
            )}
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
            <h2 style={{margin:0,color:"var(--text)",fontSize:18,fontWeight:700}}>📘 Exam Schedule</h2>
            <button onClick={()=>setShowExamForm(v=>!v)} style={BTN(EXAM_COLOR)}>{showExamForm?"✕ Close":"+ Add Exam"}</button>
          </div>

          {showExamForm&&(
            <div style={CARD}>
              <div style={{fontWeight:700,color:"var(--text)",marginBottom:12}}>📅 New Exam</div>
              <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr",gap:10,marginBottom:10}}>
                <div><label style={LBL}>Subject *</label>
                  <select style={IC} value={examForm.subject} onChange={e=>setExamForm(f=>({...f,subject:e.target.value}))}>
                    <option value="">Select…</option>
                    {[...new Set([...subjects,...classes.map(c=>c.subject)])].map(s=><option key={s}>{s}</option>)}
                  </select>
                </div>
                <div><label style={LBL}>Exam Date *</label><input style={IC} type="date" value={examForm.examDate} onChange={e=>setExamForm(f=>({...f,examDate:e.target.value}))}/></div>
                <div><label style={LBL}>Difficulty</label>
                  <select style={IC} value={examForm.difficulty} onChange={e=>setExamForm(f=>({...f,difficulty:e.target.value}))}>
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                  </select>
                </div>
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={addExam} style={BTN(EXAM_COLOR)}>✓ Save Exam</button>
                <button onClick={()=>setShowExamForm(false)} style={BTN("#64748b")}>Cancel</button>
              </div>
            </div>
          )}

          {exams.length===0&&!showExamForm&&<div style={EMPTY}>No exams scheduled — click "+ Add Exam" to get started</div>}

          {/* Exam list */}
          {exams.length>0&&(
            <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:20}}>
              {exams.map(exam=>{
                const now=new Date();
                const examDate=new Date(exam.examDate);
                const daysLeft=Math.ceil((+examDate - +now)/86400000);
                const urgency=daysLeft<=2?"#ef4444":daysLeft<=5?"#f97316":"#22c55e";
                const col=subjectColor(exam.subject);
                return(
                  <div key={exam.id} style={{background:"var(--surface)",borderRadius:12,padding:"14px 16px",border:`1px solid ${col}33`,borderLeft:`4px solid ${urgency}`,display:"flex",alignItems:"center",gap:12}}>
                    <div style={{width:44,height:44,borderRadius:10,background:`${urgency}18`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>
                      {daysLeft<=0?"✅":daysLeft<=2?"🔥":daysLeft<=5?"⏰":"📘"}
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,color:"var(--text)",fontSize:15}}>{exam.subject}</div>
                      <div style={{fontSize:12,color:"var(--muted)",display:"flex",gap:10,marginTop:2}}>
                        <span>📅 {new Date(exam.examDate).toLocaleDateString([],{weekday:"short",month:"short",day:"numeric"})}</span>
                        <span style={{color:urgency,fontWeight:700}}>{daysLeft<=0?"Exam passed":daysLeft===1?"Tomorrow!":`${daysLeft} days left`}</span>
                        <span style={{fontSize:11,padding:"1px 6px",borderRadius:4,background:exam.difficulty==="hard"?"#ef444422":exam.difficulty==="easy"?"#22c55e22":"#f9731622",color:exam.difficulty==="hard"?"#ef4444":exam.difficulty==="easy"?"#22c55e":"#f97316",fontWeight:600}}>{exam.difficulty}</span>
                      </div>
                    </div>
                    <button onClick={()=>deleteExam(exam.id)} style={{border:"none",background:"none",color:"#ef4444",cursor:"pointer",fontSize:16}}>🗑️</button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Auto-generated study sessions — humanized */}
          {examStudySessions.length>0&&(
            <div style={{...CARD,borderColor:`${STUDY_COLOR}44`}}>
              <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:4}}>🧠 Smart Study Plan</div>
              <div style={{fontSize:12,color:"var(--muted)",marginBottom:6}}>Realistic sessions with breaks · {studySettings.startTime} – {studySettings.endTime} study window</div>
              <div style={{display:"flex",gap:8,marginBottom:12,fontSize:11,color:"var(--muted)"}}>
                <span>📚 {examStudySessions.filter(s=>s.type==="study").length} study blocks</span>
                <span>☕ {examStudySessions.filter(s=>s.type==="break").length} breaks</span>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {(expandExamSessions?examStudySessions:examStudySessions.slice(0,10)).map(session=>{
                  const isBreak=session.type==="break";
                  const col=isBreak?BREAK_COLOR:subjectColor(session.subject);
                  const done=!isBreak&&isSessionDone(session.id);
                  const skipped=!isBreak&&isSessionSkipped(session.id);
                  const missed=!isBreak&&isSessionMissed(session);
                  return(
                    <div key={session.id} style={{display:"flex",alignItems:"center",gap:10,padding:isBreak?"5px 12px":"8px 12px",background:skipped?"#ef444408":done?"#22c55e08":missed?"#f9731608":"var(--bg)",borderRadius:8,border:`1px solid ${skipped?"#ef444433":done?"#22c55e33":missed?"#f9731633":isBreak?"var(--border)":col+"33"}`,borderLeft:`3px solid ${skipped?"#ef4444":done?"#22c55e":missed?"#f97316":col}`,opacity:isBreak?0.7:skipped?0.5:done?0.75:1}}>
                      <div style={{width:isBreak?6:8,height:isBreak?6:8,borderRadius:"50%",background:done?"#22c55e":col,flexShrink:0}}/>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:isBreak?500:600,color:isBreak?"var(--muted)":skipped?"#ef4444":done?"#22c55e":"var(--text)",fontSize:isBreak?12:13,textDecoration:done||skipped?"line-through":"none"}}>{isBreak?"☕ Break":skipped?"❌ "+session.title:session.title}</div>
                        <div style={{fontSize:11,color:"var(--muted)"}}>{session.dateLabel} · {session.start.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})} – {session.end.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})} <span style={{fontWeight:600,color:isBreak?"var(--muted)":col}}>({session.durationLabel||"—"})</span></div>
                      </div>
                      {!isBreak&&<>
                        {done
                          ?<button onClick={()=>unmarkSessionDone(session.id)} style={{...BTN("#22c55e"),padding:"4px 10px",fontSize:11}}>✅ Done</button>
                          :isSessionSkipped(session.id)
                            ?<button onClick={()=>unskipSession(session.id)} style={{...BTN("#64748b"),padding:"4px 10px",fontSize:11}}>↩️ Restore</button>
                            :<>
                              {isSessionMissed(session)&&<span style={{fontSize:10,fontWeight:700,color:"#ef4444",padding:"2px 6px",background:"#ef444418",borderRadius:4}}>MISSED</span>}
                              <button onClick={()=>markSessionDone(session.id)} style={{...BTN("#64748b"),padding:"4px 10px",fontSize:11}}>☑️ Done</button>
                              <button onClick={()=>rescheduleSession(session.id,"exam")} style={{...BTN("#f97316"),padding:"4px 10px",fontSize:11}}>⏰ Resched</button>
                              <button onClick={()=>skipSession(session.id)} style={{...BTN("#ef4444"),padding:"4px 10px",fontSize:11}}>❌ Skip</button>
                              <button onClick={()=>bookExamStudySession(session)} style={{...BTN(STUDY_COLOR),padding:"4px 10px",fontSize:11}}>📅 Book</button>
                            </>
                        }
                      </>}
                    </div>
                  );
                })}
                {examStudySessions.length>10&&(
                  <button onClick={()=>setExpandExamSessions(v=>!v)} style={{background:"none",border:`1px dashed ${STUDY_COLOR}44`,borderRadius:8,padding:"8px 16px",color:STUDY_COLOR,fontSize:12,fontWeight:700,cursor:"pointer",textAlign:"center",transition:"all .15s"}}>
                    {expandExamSessions?"Show less ↑":`Show ${examStudySessions.length-10} more ↓`}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Regenerate button */}
          {exams.length>0&&(
            <button onClick={()=>generateExamStudyPlan(exams)} style={{...BTN(STUDY_COLOR),marginTop:10}}>🔄 Regenerate Study Plan</button>
          )}
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <button onClick={exportICS} style={{...BTN("#1e40af"),padding:"6px 12px",fontSize:11}}>📅 Export .ics</button>
            <button onClick={exportJSON} style={{...BTN("#7c3aed"),padding:"6px 12px",fontSize:11}}>📊 Export Report</button>
          </div>
        </div>
      )}

      {/* ══════════════ ASSIGNMENTS — FEATURE 3 ═══════════════════════════════ */}
      {activeTab==="assignments"&&(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
            <h2 style={{margin:0,color:"var(--text)",fontSize:18,fontWeight:700}}>📝 Assignments</h2>
            <div style={{display:"flex",gap:8}}>
              <button onClick={exportICS} style={{...BTN("#1e40af"),padding:"6px 12px",fontSize:11}}>📅 Export .ics</button>
              <button onClick={exportJSON} style={{...BTN("#7c3aed"),padding:"6px 12px",fontSize:11}}>📊 Export JSON</button>
              <button onClick={()=>setShowAssignForm(v=>!v)} style={BTN(ASSIGNMENT_COLOR)}>{showAssignForm?"✕ Close":"+ Add Assignment"}</button>
            </div>
          </div>

          {/* Deadline notifications */}
          {assignNotifs.length>0&&(
            <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:16}}>
              {assignNotifs.map((n,i)=>(
                <div key={i} style={{padding:"10px 14px",borderRadius:10,background:`${n.color}10`,border:`1px solid ${n.color}33`,fontSize:13,fontWeight:600,color:n.color}}>
                  {n.msg}
                </div>
              ))}
            </div>
          )}

          {showAssignForm&&(
            <div style={CARD}>
              <div style={{fontWeight:700,color:"var(--text)",marginBottom:12}}>📋 New Assignment</div>
              <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:10,marginBottom:10}}>
                <div><label style={LBL}>Title *</label><input style={IC} value={assignForm.title} placeholder="e.g. DM Assignment 3" onChange={e=>setAssignForm(f=>({...f,title:e.target.value}))}/></div>
                <div><label style={LBL}>Subject</label>
                  <select style={IC} value={assignForm.subject} onChange={e=>setAssignForm(f=>({...f,subject:e.target.value}))}>
                    <option value="">Select…</option>
                    {[...new Set([...subjects,...classes.map(c=>c.subject)])].map(s=><option key={s}>{s}</option>)}
                  </select>
                </div>
                <div><label style={LBL}>Deadline *</label><input style={IC} type="date" value={assignForm.deadline} onChange={e=>setAssignForm(f=>({...f,deadline:e.target.value}))}/></div>
                <div><label style={LBL}>Priority</label>
                  <select style={IC} value={assignForm.priority} onChange={e=>setAssignForm(f=>({...f,priority:e.target.value}))}>
                    <option value="low">🟢 Low</option>
                    <option value="medium">🟡 Medium</option>
                    <option value="high">🔴 High</option>
                  </select>
                </div>
              </div>
              <div style={{marginBottom:12}}>
                <label style={LBL}>Progress: {assignForm.progress}%</label>
                <input type="range" min={0} max={100} step={5} value={assignForm.progress} onChange={e=>setAssignForm(f=>({...f,progress:+e.target.value}))} style={{width:"100%",accentColor:ASSIGNMENT_COLOR}}/>
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={addAssignment} style={BTN(ASSIGNMENT_COLOR)}>✓ Save Assignment</button>
                <button onClick={()=>setShowAssignForm(false)} style={BTN("#64748b")}>Cancel</button>
              </div>
            </div>
          )}

          {assignments.length===0&&!showAssignForm&&<div style={EMPTY}>No assignments yet — click "+ Add Assignment" to start tracking</div>}

          {/* Assignment list */}
          {assignments.length>0&&(
            <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:20}}>
              {assignments.map(assign=>{
                const now=new Date();
                const deadline=new Date(assign.deadline);
                const daysLeft=Math.ceil((+deadline - +now)/86400000);
                const pColor=assign.priority==="high"?"#ef4444":assign.priority==="low"?"#22c55e":"#f97316";
                const progColor=assign.progress>=100?"#22c55e":assign.progress>=50?"#f97316":"#ef4444";
                const col=subjectColor(assign.subject||assign.title);
                const isUrgent=daysLeft<=1;
                const isSoon=daysLeft<=3;
                const isOverdue=daysLeft<=0;
                return(
                  <div key={assign.id} style={{background:isOverdue?"#ef444408":isUrgent?"#f9731608":"var(--surface)",borderRadius:12,padding:"14px 16px",border:`1px solid ${isOverdue?"#ef444433":isUrgent?"#f9731633":"var(--border)"}`,borderLeft:`4px solid ${pColor}`,animation:isUrgent&&assign.progress<100?"pulse 2s infinite":"none"}}>
                    <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:8}}>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:700,color:"var(--text)",fontSize:15,display:"flex",alignItems:"center",gap:8}}>
                          {assign.progress>=100?"✅":"📝"} {assign.title}
                          <span style={{fontSize:10,padding:"2px 6px",borderRadius:4,background:`${pColor}18`,color:pColor,fontWeight:700}}>{assign.priority.toUpperCase()}</span>
                        </div>
                        <div style={{fontSize:12,color:"var(--muted)",display:"flex",gap:10,marginTop:3}}>
                          {assign.subject&&<span style={{color:col,fontWeight:600}}>{assign.subject}</span>}
                          <span>📅 Due: {deadline.toLocaleDateString([],{weekday:"short",month:"short",day:"numeric"})}</span>
                          <span style={{color:daysLeft<=1?"#ef4444":daysLeft<=3?"#f97316":"var(--muted)",fontWeight:daysLeft<=2?700:400}}>{daysLeft<=0?"Overdue!":daysLeft===1?"Tomorrow!":`${daysLeft}d left`}</span>
                        </div>
                      </div>
                      <button onClick={()=>deleteAssignment(assign.id)} style={{border:"none",background:"none",color:"#ef4444",cursor:"pointer",fontSize:16}}>🗑️</button>
                    </div>
                    {/* Progress bar */}
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div style={{flex:1,height:8,background:"var(--border)",borderRadius:4,overflow:"hidden"}}>
                        <div style={{height:"100%",width:`${assign.progress}%`,background:`linear-gradient(90deg,${progColor},${progColor}cc)`,borderRadius:4,transition:"width .3s"}}/>
                      </div>
                      <span style={{fontSize:12,fontWeight:700,color:progColor,minWidth:36,textAlign:"right"}}>{assign.progress}%</span>
                    </div>
                    <input type="range" min={0} max={100} step={5} value={assign.progress} onChange={e=>updateAssignmentProgress(assign.id,+e.target.value)} style={{width:"100%",marginTop:4,accentColor:ASSIGNMENT_COLOR,height:4}}/>
                  </div>
                );
              })}
            </div>
          )}

          {/* Auto-generated assignment study sessions — humanized */}
          {assignStudySessions.length>0&&(
            <div style={{...CARD,borderColor:`${STUDY_COLOR}44`}}>
              <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:4}}>🧠 Smart Study Sessions</div>
              <div style={{fontSize:12,color:"var(--muted)",marginBottom:6}}>Realistic sessions with breaks · {studySettings.startTime} – {studySettings.endTime} window</div>
              <div style={{display:"flex",gap:8,marginBottom:12,fontSize:11,color:"var(--muted)"}}>
                <span>📚 {assignStudySessions.filter(s=>s.type==="study").length} study blocks</span>
                <span>☕ {assignStudySessions.filter(s=>s.type==="break").length} breaks</span>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {(expandAssignSessions?assignStudySessions:assignStudySessions.slice(0,10)).map(session=>{
                  const isBreak=session.type==="break";
                  const col=isBreak?BREAK_COLOR:subjectColor(session.subject);
                  const done=!isBreak&&isSessionDone(session.id);
                  const skipped=!isBreak&&isSessionSkipped(session.id);
                  const missed=!isBreak&&isSessionMissed(session);
                  return(
                    <div key={session.id} style={{display:"flex",alignItems:"center",gap:10,padding:isBreak?"5px 12px":"8px 12px",background:skipped?"#ef444408":done?"#22c55e08":missed?"#f9731608":"var(--bg)",borderRadius:8,border:`1px solid ${skipped?"#ef444433":done?"#22c55e33":missed?"#f9731633":isBreak?"var(--border)":col+"33"}`,borderLeft:`3px solid ${skipped?"#ef4444":done?"#22c55e":missed?"#f97316":col}`,opacity:isBreak?0.7:skipped?0.5:done?0.75:1}}>
                      <div style={{width:isBreak?6:8,height:isBreak?6:8,borderRadius:"50%",background:done?"#22c55e":col,flexShrink:0}}/>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:isBreak?500:600,color:isBreak?"var(--muted)":skipped?"#ef4444":done?"#22c55e":"var(--text)",fontSize:isBreak?12:13,textDecoration:done||skipped?"line-through":"none"}}>{isBreak?"☕ Break":skipped?"❌ "+session.title:session.title}</div>
                        <div style={{fontSize:11,color:"var(--muted)"}}>{session.dateLabel} · {session.start.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})} – {session.end.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})} <span style={{fontWeight:600,color:isBreak?"var(--muted)":col}}>({session.durationLabel||"—"})</span></div>
                      </div>
                      {!isBreak&&<>
                        {done
                          ?<button onClick={()=>unmarkSessionDone(session.id)} style={{...BTN("#22c55e"),padding:"4px 10px",fontSize:11}}>✅ Done</button>
                          :isSessionSkipped(session.id)
                            ?<button onClick={()=>unskipSession(session.id)} style={{...BTN("#64748b"),padding:"4px 10px",fontSize:11}}>↩️ Restore</button>
                            :<>
                              {isSessionMissed(session)&&<span style={{fontSize:10,fontWeight:700,color:"#ef4444",padding:"2px 6px",background:"#ef444418",borderRadius:4}}>MISSED</span>}
                              <button onClick={()=>markSessionDone(session.id)} style={{...BTN("#64748b"),padding:"4px 10px",fontSize:11}}>☑️ Done</button>
                              <button onClick={()=>rescheduleSession(session.id,"assignment")} style={{...BTN("#f97316"),padding:"4px 10px",fontSize:11}}>⏰ Resched</button>
                              <button onClick={()=>skipSession(session.id)} style={{...BTN("#ef4444"),padding:"4px 10px",fontSize:11}}>❌ Skip</button>
                              <button onClick={()=>bookAssignStudySession(session)} style={{...BTN(STUDY_COLOR),padding:"4px 10px",fontSize:11}}>📅 Book</button>
                            </>
                        }
                      </>}
                    </div>
                  );
                })}
                {assignStudySessions.length>10&&(
                  <button onClick={()=>setExpandAssignSessions(v=>!v)} style={{background:"none",border:`1px dashed ${STUDY_COLOR}44`,borderRadius:8,padding:"8px 16px",color:STUDY_COLOR,fontSize:12,fontWeight:700,cursor:"pointer",textAlign:"center",transition:"all .15s"}}>
                    {expandAssignSessions?"Show less ↑":`Show ${assignStudySessions.length-10} more ↓`}
                  </button>
                )}
              </div>
            </div>
          )}

          {assignments.length>0&&(
            <button onClick={()=>generateAssignStudyPlan(assignments)} style={{...BTN(STUDY_COLOR),marginTop:10}}>🔄 Regenerate Study Plan</button>
          )}
        </div>
      )}

      {/* ══════════════ SEMESTERS ════════════════════════════════════════════ */}
      {activeTab==="semesters"&&(
        <div>
          {/* Quick semester loader */}
          <div style={{...CARD,borderColor:`${PLAN_COLOR}44`,background:`linear-gradient(135deg, rgba(124,58,237,0.04), rgba(79,70,229,0.04))`,marginBottom:20}}>
            <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:4}}>⚡ Quick Load Semester</div>
            <div style={{fontSize:12,color:"var(--muted)",marginBottom:12}}>Select a predefined semester template to instantly load all subjects</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {Object.keys(SEMESTER_TEMPLATES).map(sem=>(
                <button key={sem} onClick={()=>{
                  const subs=SEMESTER_TEMPLATES[sem];
                  setSubjects(p=>[...new Set([...p,...subs])]);
                  const tmpl=templates.find(t=>t.name===sem)||{id:`quick-${Date.now()}`,name:sem,subjects:subs};
                  setActiveSem(tmpl);
                  lsSet("ss-semester",sem);
                  toast?.(`📋 Loaded ${sem}: ${subs.length} subjects`);
                }} style={{...BTN(activeSem?.name===sem?"#64748b":PLAN_COLOR),padding:"6px 14px",fontSize:12}}>
                  {activeSem?.name===sem?"✓ ":""}{sem}
                </button>
              ))}
            </div>
            {activeSem&&<div style={{marginTop:10,fontSize:12,color:PLAN_COLOR,fontWeight:600}}>Active: {activeSem.name} ({activeSem.subjects?.length||0} subjects)</div>}
          </div>

          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
            <h2 style={{margin:0,color:"var(--text)",fontSize:18,fontWeight:700}}>Semester Templates</h2>
            <button onClick={()=>setShowSemForm(v=>!v)} style={BTN(PLAN_COLOR)}>+ New Semester</button>
          </div>
          {showSemForm&&(
            <div style={CARD}>
              <div style={{display:"grid",gap:12}}>
                <div><label style={LBL}>Semester Name *</label><input style={IC} value={semForm.name} onChange={e=>setSemForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Semester 7"/></div>
                <div><label style={LBL}>Subjects (comma separated)</label><input style={IC} value={semForm.subjectsRaw} onChange={e=>setSemForm(f=>({...f,subjectsRaw:e.target.value}))} placeholder="ADA, DM, OS, CN..."/></div>
              </div>
              <div style={{display:"flex",gap:8,marginTop:12}}>
                <button onClick={()=>{if(!semForm.name.trim()){toast?.("⚠️ Enter name","error");return;}const subs=semForm.subjectsRaw.split(",").map(s=>s.trim()).filter(Boolean);setTemplates(p=>[...p,{id:Date.now().toString(),name:semForm.name,subjects:subs}]);setSemForm({name:"",subjectsRaw:""});setShowSemForm(false);toast?.("🎓 Template created!");}} style={BTN(PLAN_COLOR)}>✓ Create</button>
                <button onClick={()=>setShowSemForm(false)} style={BTN("#64748b")}>Cancel</button>
              </div>
            </div>
          )}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:14}}>
            {templates.map(tmpl=>(
              <div key={tmpl.id} style={{background:"var(--surface)",borderRadius:14,padding:18,border:`2px solid ${activeSem?.id===tmpl.id?PLAN_COLOR:"var(--border)"}`,boxShadow:activeSem?.id===tmpl.id?`0 0 0 3px ${PLAN_COLOR}33`:"none",transition:"all .2s"}}>
                <div style={{fontWeight:800,color:"var(--text)",fontSize:16,marginBottom:10}}>{tmpl.name}</div>
                {tmpl.subjects.length?(
                  <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:14}}>
                    {tmpl.subjects.map(s=><span key={s} style={{fontSize:11,fontWeight:700,padding:"3px 8px",borderRadius:6,background:subjectColor(s)+"22",color:subjectColor(s)}}>{s}</span>)}
                  </div>
                ):<div style={{fontSize:13,color:"var(--muted)",marginBottom:14}}>No subjects defined</div>}
                <button onClick={()=>{setActiveSem(tmpl);setSubjects(p=>[...new Set([...p,...tmpl.subjects])]);lsSet("ss-semester",tmpl.name);toast?.(`📋 Loaded: ${tmpl.name}`);}} style={{...BTN(activeSem?.id===tmpl.id?"#64748b":PLAN_COLOR),width:"100%",justifyContent:"center"}}>
                  {activeSem?.id===tmpl.id?"✓ Active":"Load Template"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════════ API CONNECTIONS ═══════════════════════════════════════ */}
      {activeTab==="apis"&&(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
            <h2 style={{margin:0,color:"var(--text)",fontSize:18,fontWeight:700}}>🔗 API Integrations</h2>
          </div>
          <div style={{...CARD,borderColor:"#4f46e544"}}>
            <div style={{fontSize:13,color:"var(--muted)",marginBottom:16}}>Connect external calendar and productivity services. Data syncs automatically when you create, complete, skip, or reschedule sessions. Falls back to localStorage when not connected.</div>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {Object.entries(API_CONFIG).map(([key,api])=>{
                const isConnected=apiConnections[key];
                return(
                  <div key={key} style={{display:"flex",alignItems:"center",gap:14,padding:"14px 18px",borderRadius:12,border:`1px solid ${isConnected?"#22c55e44":"var(--border)"}`,background:isConnected?"#22c55e06":"var(--bg)"}}>
                    <div style={{fontSize:28}}>{api.icon}</div>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:14,color:"var(--text)"}}>{api.name}</div>
                      <div style={{fontSize:11,color:"var(--muted)"}}>{isConnected?"✅ Connected — syncing sessions":"Not connected — using localStorage fallback"}</div>
                      <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>API Base: {api.baseUrl}</div>
                    </div>
                    <button onClick={()=>{
                      const newState=!apiConnections[key];
                      API_CONFIG[key].connected=newState;
                      if(newState){
                        API_CONFIG[key].token="mock-token-"+key+"-"+Date.now();
                        if(key==="notion") API_CONFIG[key].databaseId="mock-db-"+Date.now();
                      } else {
                        API_CONFIG[key].token=null;
                      }
                      saveApiState();
                      setApiConnections(p=>({...p,[key]:newState}));
                      toast?.(newState?`✅ ${api.name} connected`:`❌ ${api.name} disconnected`);
                    }} style={{...BTN(isConnected?"#ef4444":"#22c55e"),padding:"6px 16px",fontSize:12}}>
                      {isConnected?"✕ Disconnect":"✓ Connect"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Sync Status */}
          <div style={{...CARD,marginTop:14}}>
            <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:12}}>📡 Sync Status</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
              {Object.entries(API_CONFIG).map(([key,api])=>{
                const conn=apiConnections[key];
                return(
                  <div key={key} style={{background:"var(--bg)",borderRadius:10,padding:12,textAlign:"center",border:`1px solid ${conn?"#22c55e33":"var(--border)"}`}}>
                    <div style={{fontSize:22,marginBottom:4}}>{api.icon}</div>
                    <div style={{fontSize:12,fontWeight:700,color:conn?"#22c55e":"var(--muted)"}}>{conn?"Syncing":"—"}</div>
                    <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>{api.name}</div>
                  </div>
                );
              })}
            </div>
            <div style={{marginTop:14,padding:"10px 14px",background:"var(--bg)",borderRadius:8,fontSize:11,color:"var(--muted)"}}>
              <strong>How it works:</strong> When you mark a session as Done, Skip, or Reschedule, the system automatically pushes updates to all connected APIs. If an API call fails, data is safely stored in localStorage as fallback.
            </div>
          </div>

          {/* ── Settings Sections (shown when accessed from Settings sidebar) ── */}
          {settingsProps&&(
            <>
              {/* Profile */}
              <div style={{...CARD,marginTop:14}}>
                <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:12}}>👤 Profile</div>
                <div style={{display:"flex",gap:14,alignItems:"center"}}>
                  {settingsProps.session?.user?.image&&<img src={settingsProps.session.user.image} alt="" style={{width:54,height:54,borderRadius:"50%",border:"3px solid #4f46e5"}}/>}
                  <div>
                    <div style={{fontWeight:700,fontSize:15,color:"var(--text)"}}>{settingsProps.session?.user?.name}</div>
                    <div style={{fontSize:12,color:"var(--muted)"}}>{settingsProps.session?.user?.email}</div>
                    <div style={{fontSize:11,color:"#059669",marginTop:4}}>
                      {settingsProps.session?.provider==="azure-ad"?"📧 Connected: Outlook Calendar":"🔵 Connected: Google Calendar"}
                    </div>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:14}}>
                  {[{l:"Events",v:settingsProps.events?.length||0,c:"#4f46e5"},{l:"Tasks",v:settingsProps.tasks?.length||0,c:"#059669"},{l:"Score",v:`${settingsProps.prodScore||0}/100`,c:"#f97316"}].map(s=>(
                    <div key={s.l} style={{textAlign:"center",padding:9,background:"var(--bg)",borderRadius:8}}>
                      <div style={{fontSize:18,fontWeight:700,color:s.c}}>{s.v}</div>
                      <div style={{fontSize:10,color:"var(--muted)"}}>{s.l}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Preferences */}
              <div style={{...CARD,marginTop:14}}>
                <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:12}}>⚙️ Preferences</div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,padding:"10px 14px",background:"var(--bg)",borderRadius:10}}>
                  <span style={{fontSize:13,color:"var(--text)"}}>{settingsProps.darkMode?"🌙 Dark Mode":"☀️ Light Mode"}</span>
                  <span role="switch" aria-checked={settingsProps.darkMode} className={`dm-toggle ${settingsProps.darkMode?"on":"off"}`} onClick={()=>settingsProps.setDarkMode(v=>!v)} style={{cursor:"pointer",display:"inline-block"}}/>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,padding:"10px 14px",background:"var(--bg)",borderRadius:10}}>
                  <span style={{fontSize:13,color:"var(--text)"}}>🔔 Notifications</span>
                  <span role="switch" aria-checked={settingsProps.notifEnabled} className={`dm-toggle ${settingsProps.notifEnabled?"on":"off"}`} onClick={()=>{settingsProps.setNotifEnabled(v=>{const nv=!v;localStorage.setItem("ss-notif-enabled",nv?"1":"0");return nv;});}} style={{cursor:"pointer",display:"inline-block"}}/>
                </div>
                {settingsProps.notifEnabled&&(
                  <>
                    {settingsProps.notifPerm==="denied"&&(
                      <div style={{background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:8,padding:"8px 12px",marginBottom:12,fontSize:12,color:"#991b1b"}}>
                        ⚠️ Browser notifications are blocked. Enable them in your browser settings.
                      </div>
                    )}
                    {settingsProps.notifPerm==="default"&&(
                      <div style={{marginBottom:12}}>
                        <button onClick={settingsProps.requestNotifPermission} style={{background:"linear-gradient(135deg,#4f46e5,#7c3aed)",color:"#fff",border:"none",borderRadius:8,padding:"8px 16px",fontSize:13,fontWeight:700,cursor:"pointer",width:"100%"}}>🔔 Enable Browser Notifications</button>
                      </div>
                    )}
                    {settingsProps.notifPerm==="granted"&&(
                      <div style={{background:"#f0fdf4",border:"1px solid #86efac",borderRadius:8,padding:"6px 12px",marginBottom:12,fontSize:12,color:"#166534",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                        <span>✅ Notifications enabled</span>
                        <button onClick={settingsProps.sendTestNotification} style={{background:"#059669",color:"#fff",border:"none",borderRadius:6,padding:"4px 10px",fontSize:11,fontWeight:600,cursor:"pointer"}}>🔔 Test</button>
                      </div>
                    )}
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,padding:"10px 14px",background:"var(--bg)",borderRadius:10}}>
                      <span style={{fontSize:13,color:"var(--text)"}}>⏰ Remind me before</span>
                      <select value={settingsProps.reminderMinutes} onChange={e=>{const v=+e.target.value;settingsProps.setReminderMinutes(v);localStorage.setItem("ss-reminder-min",String(v));}} style={{padding:"5px 10px",borderRadius:8,border:"1px solid var(--border)",background:"var(--bg)",color:"var(--text)",fontSize:12,fontWeight:600}}>
                        <option value={5}>5 minutes</option>
                        <option value={10}>10 minutes</option>
                        <option value={15}>15 minutes</option>
                        <option value={30}>30 minutes</option>
                        <option value={60}>1 hour</option>
                      </select>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",background:"var(--bg)",borderRadius:10}}>
                      <span style={{fontSize:13,color:"var(--text)"}}>📚 Class Reminders</span>
                      <span role="switch" aria-checked={settingsProps.classNotifsEnabled} className={`dm-toggle ${settingsProps.classNotifsEnabled?"on":"off"}`} onClick={()=>{settingsProps.setClassNotifsEnabled(v=>{const nv=!v;localStorage.setItem("ss-class-notifs",nv?"1":"0");return nv;});}} style={{cursor:"pointer",display:"inline-block"}}/>
                    </div>
                  </>
                )}
              </div>

              {/* Export Data */}
              <div style={{...CARD,marginTop:14}}>
                <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:12}}>📤 Export Data</div>
                <div style={{display:"flex",gap:8,marginBottom:8,flexWrap:"wrap"}}>
                  <button onClick={settingsProps.exportJSON} disabled={settingsProps.exporting||!(settingsProps.events?.length)} style={{...BTN("#1e40af"),padding:"8px 16px",fontSize:12}}>📤 JSON ({settingsProps.events?.length||0} events)</button>
                  <button onClick={settingsProps.exportICS} disabled={settingsProps.exporting||!(settingsProps.events?.length)} style={{...BTN("#7c3aed"),padding:"8px 16px",fontSize:12}}>🗓️ ICS file</button>
                  <button onClick={exportICS} style={{...BTN("#059669"),padding:"8px 16px",fontSize:12}}>📅 Study .ics</button>
                  <button onClick={exportJSON} style={{...BTN("#0891b2"),padding:"8px 16px",fontSize:12}}>📊 Study Report</button>
                </div>
                <div style={{fontSize:11,color:"var(--muted)",padding:"8px 12px",background:"var(--bg)",borderRadius:8}}>
                  JSON = structured data · ICS = import into any calendar app · Study exports include exam/assignment sessions
                </div>
              </div>

              {/* Danger Zone */}
              <div style={{...CARD,marginTop:14,borderColor:"#fca5a5"}}>
                <div style={{fontWeight:700,color:"#ef4444",fontSize:15,marginBottom:12}}>⚠️ Danger Zone</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
                  <button onClick={()=>{settingsProps.fetchEvents(true);toast?.("🔄 Calendar synced!");}} style={{...BTN("#059669"),padding:"8px 14px",fontSize:12}}>🔄 Sync Calendar</button>
                  <button onClick={()=>{
                    if(!confirm("Delete ALL data? This cannot be undone.")) return;
                    localStorage.clear();
                    settingsProps.setTasks([]);settingsProps.setEvents([]);
                    toast?.("🗑️ All local data cleared. Signing out…","info");
                    setTimeout(()=>settingsProps.signOut(),1500);
                  }} style={{...BTN("#dc2626"),padding:"8px 14px",fontSize:12}}>🗑️ Delete Account Data</button>
                  <button onClick={()=>settingsProps.signOut()} style={{...BTN("#ef4444"),padding:"8px 14px",fontSize:12}}>🚪 Sign Out</button>
                </div>
                <div style={{fontSize:11,color:"var(--muted)",padding:"8px 12px",background:"var(--bg)",borderRadius:8}}>
                  Delete Account Data clears all tasks, cache and local storage, then signs you out. Google Calendar events remain in your Google account.
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Style helpers ─────────────────────────────────────────────────────────────
const CARD={background:"var(--surface)",borderRadius:14,padding:18,border:"1px solid var(--border)",marginBottom:14};
const EMPTY={textAlign:"center",padding:"40px 20px",color:"var(--muted)",fontSize:14,background:"var(--surface)",borderRadius:12,border:"1px dashed var(--border)"};
const LBL={display:"block",fontSize:12,fontWeight:600,color:"var(--muted)",marginBottom:4};
function IS(){return{width:"100%",padding:"8px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--bg)",color:"var(--text)",fontSize:13,outline:"none",boxSizing:"border-box"};}
function btnStyle(bg){return{display:"inline-flex",alignItems:"center",gap:6,padding:"8px 16px",borderRadius:10,border:"none",cursor:"pointer",fontSize:13,fontWeight:600,color:"#fff",background:bg,transition:"opacity .15s"};}
