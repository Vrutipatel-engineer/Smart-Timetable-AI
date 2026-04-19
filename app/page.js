"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import AcademicModule, { mockEmailNotify } from "./academic";


// ─── Constants ─────────────────────────────────────────────────────────────────
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const PC = { high: "#ef4444", medium: "#f97316", low: "#22c55e" };
const PAT0 = { totalEvents: 0, avgDur: 60, peakHour: 10, peakDow: 1, hourCounts: Array(24).fill(0), dowCounts: Array(7).fill(0) };
const TABS = [
  { id: "calendar", icon: "📅", label: "Calendar" },
  { id: "tasks", icon: "✅", label: "Tasks" },
  { id: "academic", icon: "🎓", label: "Academic" },
  { id: "insights", icon: "📊", label: "Insights" },
  { id: "settings", icon: "⚙️", label: "Settings" },
];

const BUSY_THRESHOLD = 4;
const G = "#4f46e5"; // Google / default event color
const O = "#f97316"; // Outlook event color
function evColor(ev) { return ev?.source === "outlook" ? O : G; }

// ─── Helpers ───────────────────────────────────────────────────────────────────
function parseDate(s) { if (!s) return new Date(); return new Date(s); }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function isoDate(d) { return d.toISOString().slice(0, 10); }
function fmtTime(s) { if (!s) return ""; return parseDate(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function fmtShort(s) { const d = s instanceof Date ? s : parseDate(s); return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); }
function fmtLong(s) { const d = s instanceof Date ? s : parseDate(s); return d.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" }); }
function addMin(d, m) { return new Date(+d + m * 60_000); }
function dom(y, m) { return new Date(y, m + 1, 0).getDate(); }
function fd(y, m) { return new Date(y, m, 1).getDay(); }
function avgDur(p) { return p.totalEvents > 0 ? Math.round(p.avgDur) : 60; }

// ─── External APIs ─────────────────────────────────────────────────────────────
async function fetchWeather(lat, lon, date) {
  try {
    const d = isoDate(date instanceof Date ? date : new Date(date));
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,temperature_2m_min&start_date=${d}&end_date=${d}&timezone=auto`);
    const j = await r.json();
    const icons = { 0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️", 45: "🌫️", 51: "🌦️", 61: "🌧️", 71: "🌨️", 80: "🌦️", 95: "⛈️" };
    return { icon: icons[j.daily?.weathercode?.[0]] || "🌡️", max: j.daily?.temperature_2m_max?.[0], min: j.daily?.temperature_2m_min?.[0] };
  } catch { return null; }
}
const HOLIDAY_COUNTRIES = [
  { code: "IN", label: "🇮🇳 India" },
  { code: "US", label: "🇺🇸 USA" },
  { code: "GB", label: "🇬🇧 UK" },
];
async function fetchHolidays(year, country = "IN") {
  try {
    const r = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
    if (!r.ok) return [];                    // non-200 → silently skip
    const text = await r.text();             // read as text first — guards empty body
    if (!text || !text.trim()) return [];    // empty body guard (API quirk)
    let data;
    try { data = JSON.parse(text); } catch { return []; }  // invalid JSON guard
    if (!Array.isArray(data)) return [];
    return data.map(h => ({
      date:  h.date,                           // "YYYY-MM-DD" — required by getHol()
      title: h.localName || h.name || "",      // regional/local name preferred
      name:  h.name || "",                     // English name
      type:  "holiday",
    }));
  } catch (e) {
    console.warn("[Holidays] fetch skipped:", e.message);
    return [];
  }
}

// ─── Google public holiday calendar for India ────────────────────────────────
// Uses the official Google Calendar holiday feed (no extra API key needed —
// only requires the user's existing Google Calendar OAuth accessToken).
async function fetchGoogleIndianHolidays(accessToken, year) {
  const CAL_ID = "en.indian%23holiday%40group.v.calendar.google.com";
  const timeMin = encodeURIComponent(`${year}-01-01T00:00:00Z`);
  const timeMax = encodeURIComponent(`${year}-12-31T23:59:59Z`);
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${CAL_ID}/events` +
    `?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=100`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      console.warn("[GoogleHolidays] API error:", r.status, r.statusText);
      return [];
    }
    const text = await r.text();
    if (!text || !text.trim()) return [];
    let data;
    try { data = JSON.parse(text); } catch { return []; }
    return (data.items || []).map(e => ({
      // Normalize to same shape as Nager holidays so getHol() works identically
      date:  (e.start?.date || e.start?.dateTime || "").slice(0, 10), // "YYYY-MM-DD"
      title: e.summary || "Holiday",
      name:  e.summary || "Holiday",
      type:  "holiday",
      source: "google-holiday",
    }));
  } catch (e) {
    console.warn("[GoogleHolidays] fetch failed:", e.message);
    return [];
  }
}


// ─── Pattern learning ───────────────────────────────────────────────────────────
function learnFromEvents(events) {
  const p = { ...PAT0, hourCounts: Array(24).fill(0), dowCounts: Array(7).fill(0) };
  const timed = events.filter(e => !e.allDay);
  p.totalEvents = timed.length;
  let durSum = 0;
  timed.forEach(e => { const s = parseDate(e.start), en = parseDate(e.end); p.hourCounts[s.getHours()]++; p.dowCounts[s.getDay()]++; durSum += (+en - +s) / 60_000; });
  p.avgDur = timed.length ? durSum / timed.length : 60;
  p.peakHour = p.hourCounts.indexOf(Math.max(...p.hourCounts));
  p.peakDow = p.dowCounts.indexOf(Math.max(...p.dowCounts));
  return p;
}
function getPreferredHours(patterns, n = 3) { return [...patterns.hourCounts.map((c, h) => ({ h, c }))].sort((a, b) => b.c - a.c).slice(0, n).map(x => x.h); }
function rankSlots(slots, patterns, prefHour) {
  const labels = ["⭐ Optimal", "✅ Good", "🟡 Okay", "⚪ Available"];
  return slots.map(slot => {
    const h = slot.start.getHours(), dow = slot.start.getDay(); let score = 0;
    score += Math.round((patterns.hourCounts[h] || 0) / Math.max(...patterns.hourCounts, 1) * 50);
    score += Math.round((patterns.dowCounts[dow] || 0) / Math.max(...patterns.dowCounts, 1) * 30);
    if (Math.abs(h - prefHour) <= 1) score += 20; if (h >= 9 && h <= 17) score += 10;
    return { ...slot, score, label: labels[score >= 70 ? 0 : score >= 45 ? 1 : score >= 20 ? 2 : 3] };
  }).sort((a, b) => b.score - a.score);
}

// ─── Intent detection ───────────────────────────────────────────────────────────
function detectIntent(text) {
  const t = text.toLowerCase().trim();
  if (/^(hi+|hello+|hey+|good\s*(morning|afternoon|evening|night)|what'?s\s*up|sup|yo|namaste|hola)[\s!?.]*$/.test(t)) return "greeting";
  if (/^(thanks?|thank\s*you|thx|ty|great|awesome|perfect|got\s*it|sounds?\s*good|cool|ok|okay)[\s!.]*$/.test(t)) return "thanks";
  if (/\b(what can you do|how.*work|help me|show.*command|list.*feature)\b/.test(t)) return "help";
  if (/\b(delete|cancel|remove)\b/i.test(t)) return "delete";
  if (/\b(reschedule|move|postpone|shift|rebook|change.*time)\b/i.test(t)) return "reschedule";
  if (/\b(suggest|best time|predict|optimal.*time|recommend.*time)\b/i.test(t)) return "suggest";
  if (/\b(find.*free|free.*time|free.*slot|any.*free|available|when.*free|open.*slot)\b/i.test(t)) return "query_free";
  if (/\b(what.*(have|happening|on|scheduled?)|show.*event|list.*event|check.*schedule|today'?s?\s*(plan|schedule))\b/i.test(t)) return "query_show";
  if (/\b(schedule|create|add|book|set\s*up|plan|make|block|remind)\b/i.test(t)) return "create";
  const hasTime = /\d{1,2}(?::\d{2})?\s*(am|pm)/i.test(t);
  const hasDate = /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t) || /\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t);
  if ((hasTime || hasDate) && t.split(/\s+/).filter(w => w.length > 2).length >= 2) return "create";
  return "unclear";
}

// ─── NLP Parsing ───────────────────────────────────────────────────────────────
const ML = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11, jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseSpecificDate(text) {
  const t = text.toLowerCase(), now = new Date(); let day, monthIdx;
  let m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/);
  if (m) { day = +m[1]; monthIdx = ML[m[2]]; }
  if (!m) { m = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/); if (m) { monthIdx = ML[m[1]]; day = +m[2]; } }
  if (day === undefined) return null;
  const d = new Date(now.getFullYear(), monthIdx, day);
  if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d.setFullYear(now.getFullYear() + 1);
  return d;
}
function parseTimeStr(text) {
  const t = text.toLowerCase(); let m;
  m = t.match(/(\d{1,2}):(\d{2})\s*(am|pm)/); if (m) { let h = +m[1], min = +m[2]; if (m[3] === "pm" && h !== 12) h += 12; if (m[3] === "am" && h === 12) h = 0; return { h, m: min }; }
  m = t.match(/(\d{1,2})\s*(am|pm)/); if (m) { let h = +m[1]; if (m[2] === "pm" && h !== 12) h += 12; if (m[2] === "am" && h === 12) h = 0; return { h, m: 0 }; }
  m = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/); if (m) return { h: +m[1], m: +m[2] };
  if (t.includes("noon")) return { h: 12, m: 0 }; if (t.includes("midnight")) return { h: 0, m: 0 };
  if (t.includes("morning")) return { h: 9, m: 0 }; if (t.includes("afternoon")) return { h: 14, m: 0 };
  if (t.includes("evening")) return { h: 18, m: 0 }; if (t.includes("night")) return { h: 20, m: 0 };
  return null;
}
function parseTimeRange(text) {
  const m = text.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*(?:to|till|until|[-–])\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
  if (!m) return null; const s = parseTimeStr(m[1]), e = parseTimeStr(m[2]); return (s && e) ? { start: s, end: e } : null;
}
function extractCleanTitle(text) {
  return text
    .replace(/\b(add|create|schedule|book|set up|plan|make|put|block time for|block|remind me (to|about)?|remind me|remind)\b/gi, "")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/gi, "")
    .replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi, "")
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*(?:to|till|until|-)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, "")
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, "")
    .replace(/\bfrom\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, "")
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, "")
    .replace(/\b(tomorrow|today|tonight|next week|this week)\b/gi, "")
    .replace(/\b(on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "")
    .replace(/\bfor\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)\b/gi, "")
    .replace(/\b(on|at|the|a|an|from|by|of)\b/gi, "")
    .replace(/[-–]/g, " ").replace(/\s+/g, " ").trim();
}
function extractDateFromText(text) {
  const t = text.toLowerCase(), now = new Date();
  const sp = parseSpecificDate(text); if (sp) return sp;
  let d = new Date(now);
  if (t.includes("tomorrow")) { d.setDate(now.getDate() + 1); return d; }
  if (t.includes("next week")) { d.setDate(now.getDate() + 7); return d; }
  if (t.includes("today") || t.includes("tonight")) return d;
  const dn = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  for (let i = 0; i < dn.length; i++)if (t.includes(dn[i])) { let diff = i - now.getDay(); if (diff <= 0) diff += 7; d.setDate(now.getDate() + diff); return d; }
  return d;
}
function smartParse(text) {
  const t = text.toLowerCase(), now = new Date();
  let targetDate = null;
  const sp = parseSpecificDate(text);
  if (sp) targetDate = sp;
  else if (t.includes("tomorrow")) { targetDate = new Date(now); targetDate.setDate(now.getDate() + 1); }
  else if (t.includes("next week")) { targetDate = new Date(now); targetDate.setDate(now.getDate() + 7); }
  else if (t.includes("today") || t.includes("tonight")) targetDate = new Date(now);
  else { const dn = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]; for (let i = 0; i < dn.length; i++)if (t.includes(dn[i])) { targetDate = new Date(now); let diff = i - now.getDay(); if (diff <= 0) diff += 7; targetDate.setDate(now.getDate() + diff); break; } }
  const hasDate = !!targetDate;
  const tr = parseTimeRange(text); let startTime = tr ? tr.start : parseTimeStr(text), endTime = tr ? tr.end : null;
  const hasTime = !!startTime;
  const base = targetDate ? new Date(targetDate) : new Date(now);
  let startDate = null, endDate = null;
  if (startTime) { startDate = new Date(base); startDate.setHours(startTime.h, startTime.m, 0, 0); }
  if (endTime && startTime) { endDate = new Date(base); endDate.setHours(endTime.h, endTime.m, 0, 0); if (endDate <= startDate) endDate.setDate(endDate.getDate() + 1); }
  let explicitDur = null;
  const dm = t.match(/\bfor\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h\b|minutes?|mins?|m\b)/);
  if (dm && !endTime) explicitDur = /^h/.test(dm[2]) ? Math.round(+dm[1] * 60) : Math.round(+dm[1]);
  const rawTitle = extractCleanTitle(text);
  const title = rawTitle && rawTitle.length >= 2 ? rawTitle[0].toUpperCase() + rawTitle.slice(1) : null;
  return { targetDate, startDate, endDate, hasDate, hasTime, title, explicitDur, startTime, endTime };
}

// ─── Analytics helpers ──────────────────────────────────────────────────────────
function detectConflicts(start, end, events) {
  const s = +parseDate(start), e = +parseDate(end);
  return events.filter(ev => { if (ev.allDay) return false; return s < +parseDate(ev.end) && e > +parseDate(ev.start); });
}
function findFreeSlots(date, events, dur = 60) {
  const evs = events.filter(e => !e.allDay && sameDay(parseDate(e.start), date)).sort((a, b) => +parseDate(a.start) - +parseDate(b.start));
  let cur = new Date(date); cur.setHours(8, 0, 0, 0); const end = new Date(date); end.setHours(20, 0, 0, 0); const slots = [];
  for (const ev of evs) { const s = parseDate(ev.start), e = parseDate(ev.end); if (+s - +cur >= dur * 60_000) slots.push({ start: new Date(cur), end: s }); if (e > cur) cur = e; }
  if (+end - +cur >= dur * 60_000) slots.push({ start: new Date(cur), end }); return slots;
}
function calcStats(events, tasks) {
  const now = new Date();
  const wk = new Date(now); wk.setDate(now.getDate() - now.getDay()); wk.setHours(0, 0, 0, 0);
  const mn = new Date(now.getFullYear(), now.getMonth(), 1);
  const byDow = Array(7).fill(0), byHr = Array(24).fill(0);
  events.forEach(e => { const d = parseDate(e.start); byDow[d.getDay()]++; if (!e.allDay) byHr[d.getHours()]++; });
  return {
    week: events.filter(e => parseDate(e.start) >= wk).length,
    month: events.filter(e => parseDate(e.start) >= mn).length,
    upcoming: events.filter(e => parseDate(e.start) >= now).length,
    todo: tasks.filter(t => !t.done).length, done: tasks.filter(t => t.done).length,
    byDow, byHr,
    peakH: byHr.some(v => v > 0) ? byHr.indexOf(Math.max(...byHr)) : -1,
    busyD: byDow.some(v => v > 0) ? byDow.indexOf(Math.max(...byDow)) : -1,
    maxDow: Math.max(...byDow, 1), maxHr: Math.max(...byHr, 1),
  };
}
function calcProdScore(events, tasks, patterns) {
  if (!events.length && !tasks.length) return 0;
  const tRate = tasks.length > 0 ? tasks.filter(t => t.done).length / tasks.length : 0;
  const eScore = Math.min(events.filter(e => parseDate(e.start) >= new Date()).length / 10, 1);
  const pScore = Math.min(patterns.totalEvents / 20, 1);
  return Math.round(tRate * 35 + eScore * 35 + pScore * 30);
}
function getBusyFree(events, date) {
  const dayEvs = events.filter(e => !e.allDay && sameDay(parseDate(e.start), date));
  let busy = 0; dayEvs.forEach(e => { busy += Math.max(0, (+parseDate(e.end) - +parseDate(e.start)) / 60_000); });
  const total = 720; return { busy: Math.round(Math.min(busy, total)), free: Math.max(0, total - Math.round(busy)), pct: Math.round(Math.min(busy / total * 100, 100)) };
}

// ─── Landing page ──────────────────────────────────────────────────────────────
function LandingPage() {
  const hasOutlook = !!(process.env.NEXT_PUBLIC_HAS_AZURE || "");
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#0f172a 0%,#1e1b4b 50%,#0f172a 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 20px" }}>
      <div style={{ fontSize: 56, marginBottom: 16 }}>📅</div>
      <h1 style={{ fontSize: 44, fontWeight: 900, color: "#fff", margin: "0 0 10px", textAlign: "center", letterSpacing: "-1.5px" }}>
        Smart<span style={{ color: "#818cf8" }}>Scheduler</span>
      </h1>
      <p style={{ fontSize: 18, color: "#94a3b8", margin: "0 0 44px", textAlign: "center", maxWidth: 500, lineHeight: 1.65 }}>
        Your AI-powered calendar assistant. Schedule smarter, detect conflicts, and get predictive insights — all in one beautiful place.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 52, maxWidth: 620, width: "100%" }}>
        {[{ icon: "🤖", title: "AI Assistant", desc: "Natural language scheduling" },
        { icon: "🔮", title: "Predictive", desc: "Learns your patterns" },
        { icon: "⚡", title: "Real-time Sync", desc: "Google & Outlook Calendar" },
        ].map(f => (
          <div key={f.title} style={{ background: "rgba(255,255,255,0.06)", borderRadius: 14, padding: "18px 14px", border: "1px solid rgba(255,255,255,0.1)", textAlign: "center", backdropFilter: "blur(8px)" }}>
            <div style={{ fontSize: 30, marginBottom: 8 }}>{f.icon}</div>
            <div style={{ color: "#e2e8f0", fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{f.title}</div>
            <div style={{ color: "#64748b", fontSize: 12 }}>{f.desc}</div>
          </div>
        ))}
      </div>
      {/* Google sign-in */}
      <button onClick={() => signIn("google")} style={{ display: "flex", alignItems: "center", gap: 12, padding: "15px 36px", borderRadius: 14, border: "none", background: "linear-gradient(135deg,#4f46e5,#7c3aed)", color: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer", boxShadow: "0 8px 32px rgba(79,70,229,.5)", letterSpacing: ".3px", transition: "transform .15s", marginBottom: 12 }}
        onMouseEnter={e => e.currentTarget.style.transform = "scale(1.04)"}
        onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}>
        <GoogleIcon />Continue with Google
      </button>
      {/* Outlook sign-in — only shown when Azure AD is configured */}
      <button onClick={() => signIn("azure-ad", { callbackUrl: "/" })} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 36px", borderRadius: 14, border: "1px solid rgba(255,255,255,.15)", background: "rgba(255,255,255,.06)", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer", backdropFilter: "blur(8px)", transition: "transform .15s", marginBottom: 12 }}
        onMouseEnter={e => e.currentTarget.style.transform = "scale(1.03)"}
        onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}>
        <OutlookIcon />Continue with Outlook
      </button>
      <p style={{ color: "#475569", fontSize: 12, marginTop: 6 }}>Connect Google or Microsoft Outlook Calendar. No data stored on our servers.</p>
    </div>
  );
}
function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20H24v8h11.3C33.7 33.8 29.3 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l5.7-5.7C34.6 5.1 29.6 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21c10.5 0 20-7.8 20-21 0-1.4-.2-2.7-.4-4z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.1 8.1 2.9l5.7-5.7C34.6 5.1 29.6 3 24 3 16.3 3 9.7 7.9 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 45c5.2 0 10.1-1.9 13.8-5.1l-6.4-5.4C29.4 36.4 26.8 37 24 37c-5.2 0-9.6-3.2-11.3-7.8l-6.5 5C9.5 41.1 16.2 45 24 45z" />
      <path fill="#1565C0" d="M43.6 20H24v8h11.3c-.8 2.3-2.3 4.3-4.2 5.7l6.4 5.4C41.6 35.7 44 30.2 44 24c0-1.4-.2-2.7-.4-4z" />
    </svg>
  );
}
function OutlookIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
      <rect width="48" height="48" rx="8" fill="#0078D4" />
      <path d="M28 10v28l-16-4V14l16-4z" fill="#28A8E8" />
      <path d="M28 10h12v8H28V10zm0 10h12v8H28V20zm0 10h12v8H28V30z" fill="white" opacity="0.15" />
      <path d="M28 10h12v28H28V10z" fill="white" opacity="0.1" />
      <ellipse cx="20" cy="24" rx="6" ry="8" fill="white" />
      <ellipse cx="20" cy="24" rx="4" ry="6" fill="#0078D4" />
    </svg>
  );
}

// ─── Loading screen ────────────────────────────────────────────────────────────
function LoadingScreen() {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 44, marginBottom: 14 }}>📅</div>
        <div style={{ color: "var(--muted)", fontSize: 15 }}>Loading SmartScheduler…</div>
      </div>
    </div>
  );
}

// ─── Main App (authenticated) ──────────────────────────────────────────────────
function App() {
  // App() is only rendered by AppRouter when session is authenticated.
  // Do NOT add loading/unauthenticated guards here — they violate Rules of Hooks
  // (useState calls below would come after a conditional return).
  const { data: session, status } = useSession();

  /* ── State ──────────────────────────────────────────────────────────────── */
  const [tab, setTab] = useState("calendar");
  const [events, setEvents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState("");
  const [viewDate, setViewDate] = useState(new Date());
  const [view, setView] = useState("month");
  const [selDay, setSelDay] = useState(null);
  const [selEvent, setSelEvent] = useState(null);
  const [notifs, setNotifs] = useState([]);
  const [notifOff, setNotifOff] = useState(false);
  // Chat
  const [showChat, setShowChat] = useState(false);
  const [chat, setChat] = useState([{ role: "a", text: "👋 Hey! I'm your AI scheduling assistant.\n\nTry:\n• \"Schedule standup tomorrow at 9am\"\n• \"Find free time Wednesday\"\n• \"What do I have today?\"\n• \"Delete team meeting\"\n\nI'll clarify anything unclear 😊" }]);
  const [nlInput, setNlInput] = useState("");
  const [nlBusy, setNlBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const [clarifying, setClarifying] = useState(null);
  // Profile dropdown
  const [showProfile, setShowProfile] = useState(false);
  // Settings modal
  const [showSettings, setShowSettings] = useState(false);
  const [notifEnabled, setNotifEnabled] = useState(true);
  const [notifPerm, setNotifPerm] = useState("default"); // "granted" | "denied" | "default"
  const [reminderMinutes, setReminderMinutes] = useState(10); // 5 | 10 | 30
  const [classNotifsEnabled, setClassNotifsEnabled] = useState(true);
  // Dark mode
  const [darkMode, setDarkMode] = useState(false);
  // Manual event form
  const [showEvForm, setShowEvForm] = useState(false);
  const [evForm, setEvForm] = useState({ title: "", date: "", startTime: "", endTime: "", description: "" });
  const [evFormErr, setEvFormErr] = useState({});
  // Task form
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [newTask, setNewTask] = useState({ title: "", dueDate: "", priority: "medium", notes: "" });
  // Cache / export
  const [cacheTs, setCacheTs] = useState(0);
  const [exporting, setExporting] = useState(false);
  // Predictive
  const [patterns, setPatterns] = useState({ ...PAT0, hourCounts: Array(24).fill(0), dowCounts: Array(7).fill(0) });
  const [prodScore, setProdScore] = useState(0);
  // External
  const [weather, setWeather] = useState(null);
  const [holidays, setHolidays] = useState([]);
  const [userLoc, setUserLoc] = useState({ lat: 20.59, lon: 78.96 });
  // Toasts
  const [toasts, setToasts] = useState([]);
  // Academic / holiday
  const [holidayCountry, setHolidayCountry] = useState("IN");
  const [classes, setClasses] = useState([]); // used for renderin class chips

  const fired = useRef(new Set());
  const chatEnd = useRef(null);
  const profileRef = useRef(null);
  const today = new Date();

  /* ── Toast helper ───────────────────────────────────────────────────────── */
  // ── Notification permission helper (requires user gesture in modern browsers) ──
  async function requestNotifPermission() {
    if (!("Notification" in window)) {
      console.warn("[Notif] Notification API not available (not HTTPS or localhost?)");
      toast("⚠️ Notifications require HTTPS or localhost", "error");
      return;
    }
    try {
      console.log("[Notif] Requesting permission... current:", Notification.permission);
      const perm = await Notification.requestPermission();
      console.log("[Notif] Permission result:", perm);
      setNotifPerm(perm);
      if (perm === "granted") {
        toast("✅ Notifications enabled!");
      } else if (perm === "denied") {
        toast("❌ Notifications blocked by browser. Check browser settings.", "error");
      }
    } catch (e) {
      console.error("[Notif] Permission request error:", e);
      toast("⚠️ Could not request notification permission", "error");
    }
  }

  function sendTestNotification() {
    if (!("Notification" in window)) {
      toast("⚠️ Notification API not available", "error");
      return;
    }
    if (Notification.permission !== "granted") {
      toast("⚠️ Enable notifications first", "error");
      return;
    }
    try {
      const notif = new Notification("🔔 Test Notification", {
        body: "Notifications are working! You'll receive reminders before events and classes.",
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📅</text></svg>",
        tag: "test-" + Date.now(),
      });
      notif.onclick = () => { window.focus(); notif.close(); };
      toast("✅ Test notification sent!");
      console.log("[Notif] Test notification sent successfully");
    } catch (e) {
      console.error("[Notif] Test notification failed:", e);
      toast("❌ Test failed: " + e.message, "error");
    }
  }

  function toast(msg, type = "success") {
    const id = Date.now();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3200);
  }

  /* ── Init effects ───────────────────────────────────────────────────────── */
  useEffect(() => {
    try { const s = localStorage.getItem("ss-tasks"); if (s) setTasks(JSON.parse(s)); } catch { }
    try { if (localStorage.getItem("ss-dark") === "1") setDarkMode(true); } catch { }
    try { const c = localStorage.getItem("ss-classes"); if (c) setClasses(JSON.parse(c)); } catch { }
    try { const hc = localStorage.getItem("ss-holiday-country"); if (hc) setHolidayCountry(hc); } catch { }
    // Notification settings
    try { const rm = localStorage.getItem("ss-reminder-min"); if (rm) setReminderMinutes(+rm); } catch { }
    try { const cn = localStorage.getItem("ss-class-notifs"); if (cn !== null) setClassNotifsEnabled(cn === "1"); } catch { }
    try { const ne = localStorage.getItem("ss-notif-enabled"); if (ne !== null) setNotifEnabled(ne === "1"); } catch { }
    // Restore fired notification IDs (prevents duplicates across refresh)
    try { const firedIds = localStorage.getItem("ss-fired-notifs"); if (firedIds) { const parsed = JSON.parse(firedIds); if (Array.isArray(parsed)) parsed.forEach(id => fired.current.add(id)); } } catch { }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
    try { localStorage.setItem("ss-dark", darkMode ? "1" : "0"); } catch { }
  }, [darkMode]);
  useEffect(() => {
    if ("Notification" in window) {
      const currentPerm = Notification.permission;
      console.log("[Notif] Initial permission state:", currentPerm);
      setNotifPerm(currentPerm);
      // Auto-request on load — may be blocked by Chrome without user gesture.
      // That's OK, we show a manual "Enable" button as fallback.
      if (currentPerm === "default") {
        Notification.requestPermission()
          .then(perm => {
            console.log("[Notif] Auto-request result:", perm);
            setNotifPerm(perm);
          })
          .catch(e => console.warn("[Notif] Auto-request blocked (expected in Chrome):", e.message));
      }
    } else {
      console.warn("[Notif] Notification API not available — check HTTPS/localhost");
    }
  }, []);
  useEffect(() => {
    if ("geolocation" in navigator)
      navigator.geolocation.getCurrentPosition(pos => setUserLoc({ lat: pos.coords.latitude, lon: pos.coords.longitude }), () => { });
  }, []);
  useEffect(() => {
    localStorage.setItem("ss-holiday-country", holidayCountry);
    const year = new Date().getFullYear();
    const isGoogleSession = session?.provider === "google" && !!session?.accessToken;

    if (holidayCountry === "IN" && isGoogleSession) {
      // India: Nager.Date doesn't cover Indian holidays fully.
      // Use the official Google Calendar public holiday feed instead.
      fetchGoogleIndianHolidays(session.accessToken, year).then(setHolidays);
    } else {
      // All other countries: Nager.Date API
      fetchHolidays(year, holidayCountry).then(setHolidays);
    }
  // session?.provider is a stable string — only changes on login/logout, not on re-render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holidayCountry, session?.provider, session?.accessToken]);



  // Close profile menu on outside click
  useEffect(() => {
    const h = e => { if (profileRef.current && !profileRef.current.contains(e.target)) setShowProfile(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);

  /* ── Fetch events (with 5-min cache) ───────────────────────────────────── */
  const fetchEvents = useCallback(async (force = false) => {
    if (!session) return;
    const now = Date.now();
    if (!force && cacheTs && (now - cacheTs) < 5 * 60_000 && events.length > 0) return;
    setLoading(true); setApiError("");
    try {
      const r = await fetch("/api/events");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (d.error) { setApiError(d.error); return; }
      const evs = d.events || [];
      setEvents(evs); setCacheTs(now);
      const h24 = now + 86_400_000;
      setNotifs(evs.filter(e => { const t = +parseDate(e.start); return t >= now && t <= h24; }));
      setNotifOff(false);
    } catch (e) { setApiError(`Failed to load events: ${e.message}`); }
    finally { setLoading(false); }
  }, [session]); // stable — only recreate when session identity changes (login/logout)


  // Trigger once when session becomes authenticated — NOT on every session object re-render.
  // Using 'status' (a string) instead of 'session' (a new object reference each render)
  // prevents the infinite loop: session changes → fetchEvents recreates → effect fires → events update → repeat.
  const didFetch = useRef(false);
  useEffect(() => {
    if (status === "authenticated" && !didFetch.current) {
      didFetch.current = true;
      fetchEvents();
    }
    if (status !== "authenticated") didFetch.current = false; // reset on logout so next login fetches
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]); // ✔ fires only when "loading"/"unauthenticated"/"authenticated" string changes


  /* ── Pattern learning ───────────────────────────────────────────────────── */
  useEffect(() => {
    if (events.length > 0) { const p = learnFromEvents(events); setPatterns(p); setProdScore(calcProdScore(events, tasks, p)); }
  }, [events, tasks]);

  /* ── Weather on day select ──────────────────────────────────────────────── */
  useEffect(() => { if (selDay) { setWeather(null); fetchWeather(userLoc.lat, userLoc.lon, selDay).then(setWeather); } }, [selDay, userLoc]);

  /* ── Reminders (real-time check loop, class-aware, tab-focus aware) ──────── */
  useEffect(() => {
    if (!notifEnabled) {
      console.log("[Notif] Master toggle OFF — skipping reminder setup");
      return;
    }

    // Clean up stale fired IDs older than 24h on mount
    try {
      const now = Date.now();
      const cleaned = [...fired.current].filter(key => {
        // Keys with timestamps embedded: "10_eventId" — can't extract time,
        // so just keep the last 100 to prevent infinite growth
        return true;
      });
      if (cleaned.length > 100) {
        const trimmed = cleaned.slice(-100);
        fired.current = new Set(trimmed);
        localStorage.setItem("ss-fired-notifs", JSON.stringify(trimmed));
        console.log(`[Notif] Cleaned fired cache: ${cleaned.length} → ${trimmed.length}`);
      }
    } catch { }

    function checkReminders() {
      const now = new Date();
      const nowMs = +now;
      const reminderMs = reminderMinutes * 60_000;

      // Build unified item list: events + tasks + classes
      const allItems = [];

      // Calendar events
      events.forEach(e => {
        if (!e.start) return;
        allItems.push({
          id: e.id, title: e.title, start: e.start,
          _type: "event", _source: e.source === "outlook" ? "Outlook" : "Google", _icon: "📝",
        });
      });

      // Tasks with due dates
      tasks.filter(t => !t.done && t.dueDate).forEach(t => {
        allItems.push({
          id: t.id, title: t.title, start: t.dueDate,
          _type: "task", _source: "Task", _icon: "✅",
        });
      });

      // Classes for today (and tomorrow if near midnight)
      if (classNotifsEnabled && classes.length > 0) {
        const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
        // Check today AND tomorrow (handles reminders near midnight)
        [0, 1].forEach(offset => {
          const checkDate = new Date(now);
          checkDate.setDate(now.getDate() + offset);
          const dayName = dayNames[checkDate.getDay()];
          classes.filter(c => c.day === dayName).forEach(c => {
            const [h, m] = (c.startTime || "09:00").split(":").map(Number);
            const classDate = new Date(checkDate);
            classDate.setHours(h, m, 0, 0);
            allItems.push({
              id: `${c.id}_${classDate.toISOString().slice(0,10)}`,
              title: c.subject,
              start: classDate.toISOString(),
              _type: "class", _source: "Class", _icon: "📚",
              _extra: `${c.startTime} – ${c.endTime}`,
            });
          });
        });
      }

      let didFire = false;
      let checkedCount = 0;
      let skippedPast = 0;
      let skippedFired = 0;
      let skippedFar = 0;

      allItems.forEach(item => {
        const eventTime = +parseDate(item.start);
        checkedCount++;

        // Skip past events
        if (eventTime < nowMs) { skippedPast++; return; }

        // Calculate when reminder should fire
        const reminderFireTime = eventTime - reminderMs;
        const key = `${reminderMinutes}_${item.id || item.title}`;

        // Already fired?
        if (fired.current.has(key)) { skippedFired++; return; }

        // Is NOW within the reminder window? (reminderFireTime <= now < eventTime)
        if (nowMs >= reminderFireTime && nowMs < eventTime) {
          fired.current.add(key);
          didFire = true;

          const minsLeft = Math.max(1, Math.round((eventTime - nowMs) / 60_000));
          const bodyText = item._type === "class"
            ? `${item.title} class starts at ${item._extra}`
            : `[${item._source}] Starting in ~${minsLeft} min`;

          console.log("[Notif] 🔔 FIRING:", { title: item.title, type: item._type, minsLeft, key });

          // Browser notification
          if ("Notification" in window && Notification.permission === "granted") {
            try {
              const notif = new Notification(
                `${item._icon} ${item._type === "class" ? "Upcoming Class" : item._type === "task" ? "Task Due" : "Event Reminder"}`,
                {
                  body: bodyText,
                  icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📅</text></svg>",
                  tag: key,
                  requireInteraction: true,
                }
              );
              notif.onclick = () => { window.focus(); notif.close(); };
            } catch (e) { console.warn("[Notif] Browser notification failed:", e.message); }
          }

          // In-app toast
          toast(`${item._icon} In ${minsLeft} min: ${item.title} (${item._source})`, "info");
        } else {
          skippedFar++;
        }
      });

      // Debug log every check cycle
      console.log(`[Notif] Check @ ${now.toLocaleTimeString()} — ${checkedCount} items | ${skippedPast} past | ${skippedFired} already-fired | ${skippedFar} not-yet | ${didFire ? "🔔 FIRED" : "—"}`);

      // Persist fired IDs
      if (didFire) {
        try {
          const allFired = [...fired.current];
          const trimmed = allFired.length > 200 ? allFired.slice(-200) : allFired;
          localStorage.setItem("ss-fired-notifs", JSON.stringify(trimmed));
        } catch { }
      }
    }

    // ── Run IMMEDIATELY on setup (don't wait for interval) ──
    checkReminders();

    // ── Run on interval every 15 seconds ──
    const intervalId = setInterval(checkReminders, 15_000);

    // ── Run on tab focus (user returns to tab) ──
    const onFocus = () => {
      console.log("[Notif] Tab focused — checking reminders");
      checkReminders();
    };
    window.addEventListener("focus", onFocus);

    // ── Run on visibility change (tab becomes visible) ──
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        console.log("[Notif] Tab visible — checking reminders");
        checkReminders();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    console.log(`[Notif] Reminder system active — checking every 15s, reminder=${reminderMinutes}min, events=${events.length}, classes=${classes.length}`);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [events, tasks, classes, notifEnabled, classNotifsEnabled, reminderMinutes]);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [chat]);

  /* ── Task CRUD ──────────────────────────────────────────────────────────── */
  function saveTasks(t) { setTasks(t); localStorage.setItem("ss-tasks", JSON.stringify(t)); }
  function addTask() { if (!newTask.title.trim()) return; saveTasks([...tasks, { id: Date.now().toString(), done: false, ...newTask }]); setNewTask({ title: "", dueDate: "", priority: "medium", notes: "" }); setShowTaskForm(false); toast("✅ Task added!"); }
  const toggleTask = id => saveTasks(tasks.map(t => t.id === id ? { ...t, done: !t.done } : t));
  const deleteTask = id => { saveTasks(tasks.filter(t => t.id !== id)); toast("🗑️ Task deleted"); };

  /* ── Google Calendar API ────────────────────────────────────────────────── */
  async function gcalPost(method, body, qs = "") {
    const r = await fetch(`/api/events${qs}`, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const d = await r.json(); if (d.error) throw new Error(d.error); return d;
  }
  const createEvent = (title, start, dur, end) => gcalPost("POST", { title, start: start.toISOString(), end: (end || addMin(start, dur || 60)).toISOString() });
  const patchEvent = (eventId, start, dur) => gcalPost("PATCH", { eventId, start: start.toISOString(), end: addMin(start, dur).toISOString() });
  const deleteEventApi = id => {
    if (!id) { console.error("[Delete] Missing event id — aborting"); throw new Error("Event has no id — cannot delete"); }
    return gcalPost("DELETE", null, `?id=${encodeURIComponent(id)}`);
  };


  /* ── Manual event form ──────────────────────────────────────────────────── */
  function validateEvForm() {
    const e = {};
    if (!evForm.title.trim()) e.title = "Title is required";
    if (!evForm.date) e.date = "Date is required";
    else if (isNaN(new Date(evForm.date))) e.date = "Invalid date";
    if (!evForm.startTime) e.startTime = "Start time is required";
    if (evForm.startTime && evForm.endTime) {
      const s = new Date(`${evForm.date}T${evForm.startTime}`), en = new Date(`${evForm.date}T${evForm.endTime}`);
      if (!isNaN(s) && !isNaN(en) && en <= s) e.endTime = "End must be after start (or leave blank for overnight auto)";
    }
    return e;
  }
  async function submitManualEvent() {
    const errs = validateEvForm(); if (Object.keys(errs).length > 0) { setEvFormErr(errs); return; }
    setNlBusy(true); setEvFormErr({});
    const start = new Date(`${evForm.date}T${evForm.startTime}`);
    let end = evForm.endTime ? new Date(`${evForm.date}T${evForm.endTime}`) : addMin(start, 60);
    if (evForm.endTime && end <= start) end.setDate(end.getDate() + 1);
    // ─ Conflict check BEFORE creating ─────────────────────────────────────
    const conflicts = detectConflicts(start, end, events);
    if (conflicts.length > 0) {
      const dur = Math.round((+end - +start) / 60_000);
      const ranked = rankSlots(findFreeSlots(start, events, dur), patterns, start.getHours());
      const conEv = conflicts[0];
      // Build conflict slots for the conflicting event itself
      const conDur = Math.round((+parseDate(conEv.end) - +parseDate(conEv.start)) / 60_000);
      const conSlots = rankSlots(findFreeSlots(start, events.filter(e => e.id !== conEv.id), conDur), patterns, parseDate(conEv.start).getHours());
      setChat(c => [...c,
      { role: "a", text: `⚠️ Conflict detected!\n\n"${evForm.title.trim()}" overlaps with "${conEv.title}" (${fmtTime(conEv.start)} – ${fmtTime(conEv.end)}).\n\nOptions below:` }
      ]);
      setPending({
        type: "create", title: evForm.title.trim(), date: start, endDate: end, duration: dur,
        conflicts, slots: ranked,
        conflictEvent: conEv, conflictSlots: conSlots,
        fromForm: true,
      });
      setShowEvForm(false);
      setShowChat(true);
      setNlBusy(false);
      return;
    }
    try {
      await gcalPost("POST", { title: evForm.title.trim(), start: start.toISOString(), end: end.toISOString(), description: evForm.description });
      setEvForm({ title: "", date: "", startTime: "", endTime: "", description: "" });
      setShowEvForm(false);
      await fetchEvents(true);
      toast(`✅ "${evForm.title}" added to Google Calendar!`);
    } catch (e) { setEvFormErr({ submit: `❌ ${e.message}` }); }
    setNlBusy(false);
  }

  /* ── Task → Calendar ────────────────────────────────────────────────────── */
  async function taskToCalendar(task) {
    if (!session) { toast("Sign in first", "error"); return; }
    const base = task.dueDate ? new Date(task.dueDate) : new Date();
    try {
      await gcalPost("POST", { title: task.title, start: base.toISOString(), end: addMin(base, 60).toISOString(), description: task.notes || "" });
      await fetchEvents(true);
      toast(`📅 "${task.title}" added to Google Calendar!`); // ← NO redirect
    } catch (e) { toast(`Failed: ${e.message}`, "error"); }
  }

  /* ── Export ─────────────────────────────────────────────────────────────── */
  function exportJSON() {
    setExporting(true);
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), events: events.map(e => ({ title: e.title, start: e.start, end: e.end, allDay: e.allDay })) }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `schedule-${isoDate(new Date())}.json`; a.click(); URL.revokeObjectURL(url);
    setExporting(false); toast("📥 JSON exported!");
  }
  function exportICS() {
    setExporting(true);
    const esc = s => s.replace(/[\r\n]/g, " ").replace(/,/g, "\\,");
    const dtFmt = iso => iso ? iso.replace(/[-:]/g, "").replace(".000Z", "Z") : "";
    let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SmartScheduler//EN\r\n";
    events.forEach(e => {
      ics += `BEGIN:VEVENT\r\nUID:${e.id || Math.random()}\r\n`;
      ics += e.allDay ? `DTSTART;VALUE=DATE:${e.start?.replace(/-/g, "")}\r\nDTEND;VALUE=DATE:${e.end?.replace(/-/g, "")}\r\n` : `DTSTART:${dtFmt(e.start)}\r\nDTEND:${dtFmt(e.end)}\r\n`;
      ics += `SUMMARY:${esc(e.title)}\r\nEND:VEVENT\r\n`;
    });
    ics += "END:VCALENDAR";
    const blob = new Blob([ics], { type: "text/calendar" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `schedule-${isoDate(new Date())}.ics`; a.click(); URL.revokeObjectURL(url);
    setExporting(false); toast("🗓️ ICS exported!");
  }

  /* ── NLP helpers ────────────────────────────────────────────────────────── */
  const pickRandom = arr => arr[Math.floor(Math.random() * arr.length)];

  function showCreateConfirmation(parsed) {
    const title = parsed.title || "New Event";
    const sd = parsed.startDate;
    const ed = parsed.endDate || addMin(sd, parsed.explicitDur || 60);
    const overnight = !sameDay(sd, ed);
    const dur = Math.round((+ed - +sd) / 60_000);
    const conflicts = detectConflicts(sd, ed, events);
    const ranked = rankSlots(findFreeSlots(sd, events, dur), patterns, sd.getHours());
    let msg = `📋 ${title}\n📅 ${fmtLong(sd)}\n🕐 ${fmtTime(sd)} – ${overnight ? fmtTime(ed) + " (next day)" : fmtTime(ed)}`;
    if (overnight) msg += "\n🌙 Overnight event";
    if (conflicts.length > 0) {
      const conEv = conflicts[0];
      const conDur = Math.round((+parseDate(conEv.end) - +parseDate(conEv.start)) / 60_000);
      const conSlots = rankSlots(findFreeSlots(sd, events.filter(e => e.id !== conEv.id), conDur), patterns, parseDate(conEv.start).getHours());
      msg += `\n\n⚠️ This time conflicts with "${conEv.title}" (${fmtTime(conEv.start)} – ${fmtTime(conEv.end)}).\n\nChoose: use a free slot below, or shift the conflicting event.`;
      setChat(c => [...c, { role: "a", text: msg }]);
      setPending({ type: "create", title, date: sd, endDate: ed, duration: dur, conflicts, slots: ranked, conflictEvent: conEv, conflictSlots: conSlots });
    } else {
      msg += `\n\n✅ No conflicts! Confirm below.`;
      setChat(c => [...c, { role: "a", text: msg }]);
      setPending({ type: "create", title, date: sd, endDate: ed, duration: dur, conflicts: [], slots: ranked });
    }
    setClarifying(null);
  }

  async function handleClarification(answer) {
    const prev = clarifying;
    if (/\b(cancel|nevermind|stop|forget it|no)\b/i.test(answer)) { setClarifying(null); setChat(c => [...c, { role: "a", text: "No problem! Let me know when you're ready 😊" }]); setNlBusy(false); return; }
    const partial = { ...prev.partial }; let reply = "";
    if (prev.needs === "title") {
      const t = answer.trim().replace(/^["']|["']$/g, "");
      partial.title = t.charAt(0).toUpperCase() + t.slice(1);
      if (!partial.hasDate) { reply = `Got "${partial.title}"! On which date? 📅`; setClarifying({ ...prev, partial, needs: "date" }); }
      else if (!partial.hasTime) { reply = `What time? (e.g. "3pm", "9pm to 11pm") ⏰`; setClarifying({ ...prev, partial, needs: "time" }); }
      else { showCreateConfirmation(partial); setNlBusy(false); return; }
    } else if (prev.needs === "date") {
      const np = smartParse(answer);
      if (np.targetDate) {
        partial.targetDate = np.targetDate; partial.hasDate = true;
        if (partial.startDate) { const sd2 = new Date(np.targetDate); sd2.setHours(partial.startDate.getHours(), partial.startDate.getMinutes(), 0, 0); partial.startDate = sd2; }
        if (!partial.hasTime) { reply = `Great, ${fmtShort(np.targetDate)}! What time? ⏰`; setClarifying({ ...prev, partial, needs: "time" }); }
        else { showCreateConfirmation(partial); setNlBusy(false); return; }
      } else { reply = `Could not parse that date. Try: tomorrow, 19th April, or next Monday \uD83D\uDCC5`; }
    } else if (prev.needs === "time") {
      const np = smartParse(answer);
      if (np.startTime) {
        const base = partial.targetDate || new Date();
        partial.startDate = new Date(base); partial.startDate.setHours(np.startTime.h, np.startTime.m, 0, 0); partial.hasTime = true;
        if (np.endTime) { partial.endDate = new Date(base); partial.endDate.setHours(np.endTime.h, np.endTime.m, 0, 0); if (partial.endDate <= partial.startDate) partial.endDate.setDate(partial.endDate.getDate() + 1); }
        else if (np.explicitDur) partial.explicitDur = np.explicitDur;
        showCreateConfirmation(partial); setNlBusy(false); return;
      } else { reply = `Did not catch a time. Try: 3pm, 14:00, or 9pm to 11pm \u23F0`; }
    }
    if (reply) setChat(c => [...c, { role: "a", text: reply }]);
    setNlBusy(false);
  }

  async function handleNL() {
    const txt = nlInput.trim(); if (!txt || nlBusy) return;
    setChat(c => [...c, { role: "u", text: txt }]); setNlInput(""); setNlBusy(true);
    await new Promise(r => setTimeout(r, 300));
    if (clarifying) { await handleClarification(txt); return; }
    const intent = detectIntent(txt); let reply = "";
    if (intent === "greeting") { reply = pickRandom(["Hey! 👋 What can I help you schedule?", "Hi! 😊 Ready to organize your day?", "Hello! 🗓️ What's on the agenda?"]); }
    else if (intent === "thanks") { reply = pickRandom(["You're welcome! 😊", "Happy to help! Anything else?", "Anytime! 👍"]); }
    else if (intent === "help") { reply = "Here's what I can do:\n\n📅 **Create** — \"Schedule meeting 19th April 9pm\"\n🔄 **Reschedule** — \"Reschedule standup to Friday 2pm\"\n🗑️ **Delete** — \"Delete team meeting\"\n🔍 **Free time** — \"Find free time Wednesday\"\n🔮 **Predict** — \"Best time for 1h meeting today\"\n📋 **View** — \"What do I have tomorrow?\""; }
    else if (intent === "unclear") { reply = pickRandom(["Hmm, not sure what you mean 🤔 Try: \"Schedule [event] on [date] at [time]\"", "I didn't get that. Are you adding, changing, or checking something?"]); }
    else if (intent === "query_free") {
      const d = extractDateFromText(txt);
      const dm2 = txt.match(/(\d+)\s*(hour|hr|h\b|minute|min|m\b)/i); const dur = dm2 ? (/^h/i.test(dm2[2]) ? +dm2[1] * 60 : +dm2[1]) : 60;
      const ranked = rankSlots(findFreeSlots(d, events, dur), patterns, d.getHours());
      reply = ranked.length === 0 ? `😔 No free ${dur}-min slots on ${fmtShort(d)} — fully booked!` : `✅ Free slots on ${fmtShort(d)} (${dur}min):\n${ranked.slice(0, 5).map((s, i) => `${i + 1}. ${fmtTime(s.start)}–${fmtTime(s.end)} ${s.label}`).join("\n")}`;
    } else if (intent === "query_show") {
      const d = extractDateFromText(txt); const evs = events.filter(e => sameDay(parseDate(e.start), d));
      reply = evs.length === 0 ? `📅 No events on ${fmtShort(d)} — clear schedule!` : `📅 ${fmtShort(d)}:\n${evs.map(e => `• ${e.allDay ? "All day" : fmtTime(e.start)} — ${e.title}`).join("\n")}`;
    } else if (intent === "suggest") {
      const d = extractDateFromText(txt); const dm2 = txt.match(/(\d+)\s*(hour|hr|h\b|minute|min|m\b)/i); const dur = dm2 ? (/^h/i.test(dm2[2]) ? +dm2[1] * 60 : +dm2[1]) : 60;
      const preferred = getPreferredHours(patterns, 5);
      if (!preferred.length) { reply = "🔮 Not enough data yet — sync your calendar first!\n\nDefault best times:\n1. 10:00 Morning\n2. 14:00 Post-lunch\n3. 16:00 Late afternoon"; }
      else { const sug = preferred.map(h => { const dt = new Date(d); dt.setHours(h, 0, 0, 0); const free = detectConflicts(dt, addMin(dt, dur), events).length === 0; return `${h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening"}: ${fmtTime(dt)} — ${free ? "✅ Free" : "⚠️ Busy"} (used ${patterns.hourCounts[h]}× before)`; }); reply = `🔮 Best times on ${fmtShort(d)}:\n\n${sug.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nAvg event: ${avgDur(patterns)}min`; }
    } else if (intent === "reschedule") {
      const kw = txt.toLowerCase().replace(/\b(reschedule|move|postpone|shift|to .*)\b/g, "").trim();
      const matchEv = events.find(e => e.title.toLowerCase().includes(kw) && kw.length > 1);
      if (!matchEv) { reply = `🔍 No event matching "${kw}".\nUpcoming: ${events.filter(e => parseDate(e.start) >= new Date()).slice(0, 4).map(e => e.title).join(", ") || "None"}`; }
      else {
        const d = extractDateFromText(txt); const st = parseTimeStr(txt); if (st) d.setHours(st.h, st.m, 0, 0);
        const dur = avgDur(patterns); const conflicts = detectConflicts(d, addMin(d, dur), events.filter(e => e.id !== matchEv.id));
        const ranked = rankSlots(findFreeSlots(d, events.filter(e => e.id !== matchEv.id), dur), patterns, d.getHours());
        if (conflicts.length > 0) { reply = `⚠️ Conflict for "${matchEv.title}".\n\n🔮 Alternatives:\n${ranked.slice(0, 4).map((s, i) => `${i + 1}. ${fmtTime(s.start)} — ${s.label}`).join("\n")}`; }
        else { reply = `📅 Reschedule "${matchEv.title}" → ${fmtTime(d)} on ${fmtShort(d)}\n\n✅ No conflicts. Confirm below.`; }
        setPending({ type: "reschedule", event: matchEv, newDate: d, duration: dur, conflicts, slots: ranked });
      }
    } else if (intent === "delete") {
      const kw = txt.toLowerCase().replace(/\b(delete|cancel|remove)\b/g, "").trim();
      const matchEv = events.find(e => e.title.toLowerCase().includes(kw) && kw.length > 1);
      if (!matchEv) { reply = `🔍 No event matching "${kw}".\nUpcoming: ${events.filter(e => parseDate(e.start) >= new Date()).slice(0, 4).map(e => e.title).join(", ") || "None"}`; }
      else { reply = `🗑️ Delete "${matchEv.title}" on ${fmtShort(matchEv.start)}?\nThis cannot be undone. Confirm below.`; setPending({ type: "delete", event: matchEv }); }
    } else if (intent === "create") {
      if (!session) { reply = "✋ Please sign in with Google first to create events!"; }
      else {
        const parsed = smartParse(txt);
        if (!parsed.title) { setClarifying({ partial: parsed, needs: "title" }); reply = "Sure! What should I call this event? 📌"; }
        else if (!parsed.hasDate && !parsed.hasTime) { setClarifying({ partial: parsed, needs: "date" }); reply = `Got "${parsed.title}"! When should it be? (e.g. "tomorrow at 3pm") 📅`; }
        else if (!parsed.hasDate) { setClarifying({ partial: parsed, needs: "date" }); reply = `On which date should "${parsed.title}" be? 📅`; }
        else if (!parsed.hasTime) { setClarifying({ partial: parsed, needs: "time" }); reply = `What time should "${parsed.title}" start? (e.g. "3pm") ⏰`; }
        else { showCreateConfirmation(parsed); setNlBusy(false); return; }
      }
    }
    setChat(c => [...c, { role: "a", text: reply }]); setNlBusy(false);
  }

  /* ── Confirm pending action ──────────────────────────────────────────────── */
  async function confirmPending(useSlot = null) {
    if (!pending || nlBusy) return; setNlBusy(true);
    try {
      if (pending.type === "create") {
        const start = useSlot ? useSlot.start : pending.date;
        const end = useSlot ? addMin(useSlot.start, pending.duration) : (pending.endDate || addMin(pending.date, pending.duration || 60));
        await createEvent(pending.title, start, pending.duration, end);
        toast(`✅ "${pending.title}" added!`);
        setChat(c => [...c, { role: "a", text: `✅ "${pending.title}" added to Google Calendar! 🎉` }]);
        await fetchEvents(true);
      } else if (pending.type === "reschedule") {
        const start = useSlot ? useSlot.start : pending.newDate;
        await patchEvent(pending.event.id, start, pending.duration);
        toast(`✅ "${pending.event.title}" rescheduled!`);
        setChat(c => [...c, { role: "a", text: `✅ "${pending.event.title}" rescheduled to ${fmtTime(start)}!` }]);
        await fetchEvents(true);
      } else if (pending.type === "delete") {
        await deleteEventApi(pending.event.id);
        // ─ FIX: immediately remove from local state — no page reload ─────
        setEvents(prev => prev.filter(e => e.id !== pending.event.id));
        toast(`🗑️ "${pending.event.title}" deleted!`);
        setChat(c => [...c, { role: "a", text: `🗑️ "${pending.event.title}" deleted from Google Calendar.` }]);
        // No fetchEvents() call needed — state already updated
      }
    } catch (e) {
      toast(`❌ ${e.message}`, "error");
      setChat(c => [...c, { role: "a", text: `❌ ${e.message}` }]);
    }
    setPending(null); setNlBusy(false);
  }

  /* ── Calendar rendering ─────────────────────────────────────────────────── */
  // Filter out class events from the main calendar — classes are shown in the Academic timetable view
  const isClassEvent = e => (e.title || "").startsWith("📚") || (e.description || "").includes("Weekly class");
  const calendarEvents = events.filter(e => !isClassEvent(e));
  const evOn = d => calendarEvents.filter(e => sameDay(parseDate(e.start), d));
  const getHol = d => holidays.find(h => h.date === isoDate(d));
  const hasConfl = d => {
    const evs = evOn(d).filter(e => !e.allDay).sort((a, b) => +parseDate(a.start) - +parseDate(b.start));
    for (let i = 0; i < evs.length - 1; i++)if (+parseDate(evs[i].end) > +parseDate(evs[i + 1].start)) return true;
    return false;
  };
  const navP = () => setViewDate(d => { const n = new Date(d); n.setMonth(n.getMonth() - 1); return n; });
  const navN = () => setViewDate(d => { const n = new Date(d); n.setMonth(n.getMonth() + 1); return n; });
  const monthLabel = `${MONTHS[viewDate.getMonth()]} ${viewDate.getFullYear()}`;

  function renderMonth() {
    const y = viewDate.getFullYear(), m = viewDate.getMonth(), cells = [];
    for (let i = 0; i < fd(y, m); i++)cells.push(<div key={`p${i}`} style={{ minHeight: 90, borderRadius: 8, border: "1px solid transparent" }} />);
    for (let day = 1; day <= dom(y, m); day++) {
      const date = new Date(y, m, day), dayEvs = evOn(date);
      const isTdy = sameDay(date, today), isSel = selDay && sameDay(date, selDay);
      const conflict = hasConfl(date), hol = getHol(date), isBusy = dayEvs.length > BUSY_THRESHOLD;
      cells.push(
        <div key={day} onClick={() => setSelDay(date)} style={{ minHeight: 90, borderRadius: 8, padding: "5px 6px", border: conflict ? "2px solid #ef4444" : isSel ? "2px solid #4f46e5" : isTdy ? "2px solid rgba(79,70,229,.4)" : "1px solid var(--border)", background: isSel ? "#4f46e5" : isTdy ? "rgba(79,70,229,.08)" : hol ? "rgba(245,158,11,.07)" : "var(--surface)", color: isSel ? "#fff" : "var(--text)", cursor: "pointer", overflow: "hidden", transition: "background .12s", fontSize: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", fontWeight: isTdy || isSel ? 700 : 400, fontSize: 13, background: isTdy && !isSel ? "#4f46e5" : "transparent", color: isTdy && !isSel ? "#fff" : "inherit" }}>{day}</span>
            <span style={{ fontSize: 10, display: "flex", gap: 2 }}>
              {hol && <span title="Holiday">🎉</span>}
              {conflict && <span title="Schedule conflict">⚠️</span>}
              {isBusy && !conflict && <span style={{ color: isSel ? "#fff" : "#3b82f6", fontWeight: 700 }} title={`Busy day (${dayEvs.length} events)`}>●</span>}
            </span>
          </div>
          {/* Regular event chips */}
          {dayEvs.slice(0, 2).map(ev => (
            <div key={ev.id} onClick={e => { e.stopPropagation(); setSelEvent(ev); }} style={{ fontSize: 10, color: "#fff", borderRadius: 4, padding: "2px 4px", marginTop: 2, overflow: "hidden", whiteSpace: "nowrap", cursor: "pointer", background: isSel ? "rgba(255,255,255,.25)" : evColor(ev) }} title={ev.title}>
              {ev.allDay ? "⬛ " : ev.source === "outlook" ? "📧 " : ""}{ev.title.length > 13 ? ev.title.slice(0, 12) + "…" : ev.title}
            </div>
          ))}
          {dayEvs.length > 2 && <div style={{ fontSize: 9, color: isSel ? "rgba(255,255,255,.7)" : "var(--subtle)", marginTop: 1 }}>+{dayEvs.length - 2} more</div>}
          {/* Holiday chip — always shown below events */}
          {hol && (
            <div style={{ fontSize: 9, color: "#92400e", background: "#fef3c7", border: "1px solid #f59e0b", borderRadius: 4, padding: "2px 4px", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", fontWeight: 600 }} title={hol.name}>
              🎉 {hol.title.length > 12 ? hol.title.slice(0, 11) + "…" : hol.title}
            </div>
          )}
        </div>
      );
    }
    return cells;
  }

  function renderWeek() {
    const weekStart = new Date(viewDate); weekStart.setDate(viewDate.getDate() - viewDate.getDay());
    const hours = Array.from({ length: 13 }, (_, i) => i + 8);
    return (
      <div style={{ overflowX: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "48px repeat(7,1fr)", gap: 0, minWidth: 600 }}>
          <div />
          {Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); const isTdy = sameDay(d, today); return (<div key={i} style={{ textAlign: "center", padding: "6px 2px", borderBottom: "1px solid var(--border)", fontSize: 11, fontWeight: isTdy ? 700 : 400, color: isTdy ? "#4f46e5" : "var(--muted)" }}>{DAYS[d.getDay()]} {d.getDate()}</div>); })}
          {hours.map(h => (
            <React.Fragment key={h}>
              <div style={{ fontSize: 10, color: "var(--subtle)", textAlign: "right", paddingRight: 6, paddingTop: 2, borderTop: "1px solid var(--border)" }}>{h}:00</div>
              {Array.from({ length: 7 }, (_, i) => {
                const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); d.setHours(h, 0, 0, 0);
                const slot = calendarEvents.filter(e => !e.allDay && parseDate(e.start).getHours() === h && sameDay(parseDate(e.start), d));
                return (<div key={i} style={{ borderTop: "1px solid var(--border)", borderLeft: "1px solid var(--border)", minHeight: 44, padding: 2, background: sameDay(d, today) ? "rgba(79,70,229,.03)" : "transparent" }}>
                  {slot.map(ev => (<div key={ev.id} onClick={() => setSelEvent(ev)} style={{ background: evColor(ev), color: "#fff", borderRadius: 4, padding: "2px 4px", fontSize: 10, cursor: "pointer", marginBottom: 2, overflow: "hidden", whiteSpace: "nowrap" }}>{ev.source === "outlook" ? "📧 " : ""}{ev.title}</div>))}
                </div>);
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  }

  /* ── Shift conflicting event ─────────────────────────────────────────────── */
  async function shiftConflictingEvent(slot) {
    if (!pending?.conflictEvent || nlBusy) return;
    setNlBusy(true);
    try {
      await patchEvent(pending.conflictEvent.id, slot.start, pending.conflictEvent.dur || 60);
      // Now create the original event
      await createEvent(pending.title, pending.date, pending.duration, pending.endDate);
      await fetchEvents(true);
      toast(`✅ "${pending.conflictEvent.title}" moved & "${pending.title}" created!`);
      setChat(c => [...c, { role: "a", text: `✅ Done! Shifted "${pending.conflictEvent.title}" to ${fmtTime(slot.start)} and created "${pending.title}".` }]);
      setPending(null);
    } catch (e) {
      toast(`❌ ${e.message}`, "error");
      setChat(c => [...c, { role: "a", text: `❌ ${e.message}` }]);
    }
    setNlBusy(false);
  }

  /* ── Pending card ────────────────────────────────────────────────────────── */
  function renderPending() {
    if (!pending || nlBusy) return null;
    const isDel = pending.type === "delete", isResh = pending.type === "reschedule", hasCon = (pending.conflicts?.length ?? 0) > 0;
    const hasConflictSlots = (pending.conflictSlots || []).length > 0;
    return (
      <div style={{ background: isDel ? "rgba(239,68,68,.1)" : "rgba(79,70,229,.1)", borderRadius: 10, padding: "12px 13px", border: `1px solid ${isDel ? "#fca5a5" : "#a5b4fc"}`, marginTop: 8 }}>
        <p style={{ margin: "0 0 5px", fontWeight: 700, fontSize: 13, color: isDel ? "#ef4444" : "#4f46e5" }}>
          {isDel ? "⚠️ Confirm deletion:" : hasCon ? "⚠️ Time conflict — choose an action:" : isResh ? "📅 Confirm reschedule:" : "✅ Confirm creation:"}
        </p>
        <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--text)" }}>
          {isDel && `"${pending.event.title}" on ${fmtShort(pending.event.start)}`}
          {isResh && `"${pending.event.title}" → ${fmtTime(pending.newDate)} ${fmtShort(pending.newDate)}`}
          {pending.type === "create" && `"${pending.title}" · ${fmtShort(pending.date)}`}
        </p>
        {/* Free slots for the new event */}
        {hasCon && (pending.slots || []).length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <p style={{ margin: "0 0 4px", fontSize: 11, color: "#4f46e5", fontWeight: 600 }}>📅 Free slots for "{pending.title}":</p>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {(pending.slots || []).slice(0, 3).map((s, i) => (
                <button key={i} onClick={() => confirmPending(s)} style={{ ...S.btn, padding: "4px 9px", fontSize: 10, background: s.label.startsWith("⭐") ? "#059669" : "#3b82f6" }}>{s.label} {fmtTime(s.start)}</button>
              ))}
            </div>
          </div>
        )}
        {/* Option to shift the conflicting event out of the way */}
        {hasCon && hasConflictSlots && pending.conflictEvent && (
          <div style={{ marginBottom: 8 }}>
            <p style={{ margin: "0 0 4px", fontSize: 11, color: "#f97316", fontWeight: 600 }}>🔀 Or shift "{pending.conflictEvent.title}" to:</p>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {(pending.conflictSlots || []).slice(0, 3).map((s, i) => (
                <button key={i} onClick={() => shiftConflictingEvent(s)} style={{ ...S.btn, padding: "4px 9px", fontSize: 10, background: "#f97316" }}>{fmtTime(s.start)} {s.label}</button>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {!hasCon && !isDel && <button onClick={() => confirmPending()} style={{ ...S.btn, padding: "5px 12px", fontSize: 11, background: isResh ? "#059669" : "#4f46e5" }}>{isResh ? "✓ Reschedule" : "✓ Create"}</button>}
          {isDel && <button onClick={() => confirmPending()} style={{ ...S.btn, padding: "5px 12px", fontSize: 11, background: "#ef4444" }}>🗑️ Delete Forever</button>}
          {!hasCon && !isDel && (pending.slots || []).slice(0, 2).map((s, i) => (
            <button key={i} onClick={() => confirmPending(s)} style={{ ...S.btn, padding: "5px 10px", fontSize: 10, background: s.label.startsWith("⭐") ? "#059669" : "#3b82f6" }}>{s.label} {fmtTime(s.start)}</button>
          ))}
          <button onClick={() => setPending(null)} style={{ ...S.btn, padding: "5px 10px", fontSize: 11, background: "#64748b" }}>✕ Cancel</button>
        </div>
      </div>
    );
  }

  /* ── Computed ────────────────────────────────────────────────────────────── */
  const st = calcStats(events, tasks), bf = getBusyFree(events, today);

  /* ── JSX ─────────────────────────────────────────────────────────────────── */
  return (
    <div style={S.app}>

      {/* ═══ SIDEBAR ═══ */}
      <aside className="ss-sidebar" style={S.sidebar}>
        <div style={S.sidebarLogo}>
          <span style={{ fontSize: 24 }}>📅</span>
          <span className="ss-sidebar-brand" style={{ fontWeight: 800, fontSize: 16, color: "var(--text)" }}>Scheduler</span>
        </div>
        <nav style={{ flex: 1, paddingTop: 8 }}>
          {TABS.map(t => (
            <button key={t.id} className={`sb-btn${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
          {session?.user?.image && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <img src={session.user.image} alt="" style={{ width: 32, height: 32, borderRadius: "50%", border: "2px solid var(--border)" }} />
              <span className="ss-sidebar-username" style={{ fontSize: 12, color: "var(--muted)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", maxWidth: 120 }}>{session.user.name?.split(" ")[0]}</span>
            </div>
          )}
        </div>
      </aside>

      {/* ═══ MAIN AREA ═══ */}
      <div style={S.mainWrap}>

        {/* ── Top bar ── */}
        <header style={S.topBar}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text)" }}>
            {TABS.find(t => t.id === tab)?.icon}&nbsp;{TABS.find(t => t.id === tab)?.label}
          </h1>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            {loading && <span style={{ fontSize: 12, color: "var(--muted)", animation: "pulse .8s infinite" }}>⟳ Syncing…</span>}

            {/* Profile avatar + dropdown */}
            <div ref={profileRef} style={{ position: "relative" }}>
              <button onClick={() => setShowProfile(v => !v)}
                style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, padding: "4px 8px", borderRadius: 10, transition: "background .15s" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--border)"}
                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                {session?.user?.image
                  ? <img src={session.user.image} alt="" style={{ width: 32, height: 32, borderRadius: "50%", border: "2px solid var(--border)" }} />
                  : <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#4f46e5", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 14, fontWeight: 700 }}>{session?.user?.name?.[0] || "U"}</div>
                }
                <span style={{ fontSize: 13, color: "var(--muted)" }}>{session?.user?.name?.split(" ")[0]}</span>
                <span style={{ fontSize: 10, color: "var(--subtle)" }}>▼</span>
              </button>

              {/* Dropdown */}
              {showProfile && (
                <div style={S.dropdown}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: "var(--bg)" }}>
                    {session?.user?.image && <img src={session.user.image} alt="" style={{ width: 36, height: 36, borderRadius: "50%" }} />}
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>{session?.user?.name}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>{session?.user?.email}</div>
                    </div>
                  </div>
                  <div style={{ height: 1, background: "var(--border)" }} />
                  {/* Hydration fix: span instead of nested button for the toggle pill */}
                  <button className="dd-item" onClick={() => setDarkMode(v => !v)}>
                    <span>{darkMode ? "☀️" : "🌙"}</span><span>{darkMode ? "Light Mode" : "Dark Mode"}</span>
                    <span role="switch" aria-checked={darkMode} className={`dm-toggle ${darkMode ? "on" : "off"}`} style={{ marginLeft: "auto", pointerEvents: "none", display: "inline-block" }} />
                  </button>
                  <div style={{ height: 1, background: "var(--border)" }} />
                  <button className="dd-item" onClick={() => { setShowProfile(false); setShowSettings(true); }}><span>⚙️</span><span>Settings &amp; Profile</span></button>
                  <div style={{ height: 1, background: "var(--border)" }} />
                  <button className="dd-item danger" onClick={() => { signOut(); setShowProfile(false); }}><span>🚪</span><span>Sign Out</span></button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Notification banner */}
        {notifs.length > 0 && !notifOff && (
          <div style={{ background: "#fef3c7", borderBottom: "1px solid #fde68a", padding: "8px 20px", fontSize: 12, color: "#78350f", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexShrink: 0 }}>
            <span>🔔 <strong>{notifs.length}</strong> event{notifs.length > 1 ? "s" : ""} in the next 24h:&nbsp;{notifs.slice(0, 3).map(n => <em key={n.id} style={{ marginRight: 8 }}>{n.title} ({fmtTime(n.start)})</em>)}</span>
            <button onClick={() => setNotifOff(true)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16 }}>✕</button>
          </div>
        )}

        {/* Error banner */}
        {apiError && (
          <div style={{ padding: "8px 20px", background: "#fee2e2", borderBottom: "1px solid #fca5a5", fontSize: 12, color: "#ef4444", display: "flex", justifyContent: "space-between", flexShrink: 0 }}>
            <span>⚠️ {apiError}</span>
            <button onClick={() => setApiError("")} style={{ background: "none", border: "none", cursor: "pointer" }}>✕</button>
          </div>
        )}

        {/* Notification permission banner — shown prominently when permission not yet granted */}
        {notifEnabled && notifPerm === "default" && (
          <div style={{ background: "linear-gradient(135deg,#312e81,#4338ca)", padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexShrink: 0 }}>
            <span style={{ fontSize: 13, color: "#e0e7ff" }}>🔔 Enable browser notifications to get reminders before events and classes</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={requestNotifPermission} style={{ background: "#fff", color: "#4338ca", border: "none", borderRadius: 8, padding: "6px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>Enable Notifications</button>
              <button onClick={() => { setNotifEnabled(false); localStorage.setItem("ss-notif-enabled", "0"); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#a5b4fc" }}>✕</button>
            </div>
          </div>
        )}

        {/* ── Main Content ── */}
        <main style={S.main}>

          {/* ══════════════════════ CALENDAR ══════════════════════════════════ */}
          {tab === "calendar" && (
            <div>
              {/* Toolbar */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                <button onClick={navP} style={S.ib}>◀</button>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text)", minWidth: 180 }}>{monthLabel}</h2>
                <button onClick={navN} style={S.ib}>▶</button>
                <button onClick={() => setViewDate(new Date())} style={S.ib}>Today</button>
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button onClick={() => setView("month")} style={{ ...S.ib, background: view === "month" ? "#4f46e5" : "var(--surface)", color: view === "month" ? "#fff" : "var(--muted)", border: "none", fontWeight: view === "month" ? 600 : 400 }}>Month</button>
                  <button onClick={() => setView("week")} style={{ ...S.ib, background: view === "week" ? "#4f46e5" : "var(--surface)", color: view === "week" ? "#fff" : "var(--muted)", border: "none", fontWeight: view === "week" ? 600 : 400 }}>Week</button>
                  <button onClick={() => setShowEvForm(v => !v)} style={{ ...S.btn, padding: "6px 13px", fontSize: 12, background: showEvForm ? "#64748b" : "#059669" }}>{showEvForm ? "✕ Close" : "+ Add Event"}</button>
                  <button onClick={() => fetchEvents(true)} style={S.ib} title="Force refresh">🔄</button>
                  {/* Holiday country selector */}
                  <select value={holidayCountry} onChange={e => setHolidayCountry(e.target.value)}
                    style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: 12, cursor: "pointer" }}
                    title="Holiday country">
                    {HOLIDAY_COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
                  </select>
                </div>
              </div>

              {/* Manual event form (modal-style card, NO redirect after submit) */}
              {showEvForm && (
                <div className="ss-panel" style={{ marginBottom: 16, padding: 20 }}>
                  <h4 style={{ margin: "0 0 14px", color: "var(--text)", fontSize: 15 }}>📝 Create New Calendar Event</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
                    <div>
                      <label className="ss-lbl">Title *</label>
                      <input value={evForm.title} onChange={e => setEvForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Team Standup" className={`ss-inp${evFormErr.title ? " err" : ""}`} />
                      {evFormErr.title && <span className="ss-err">{evFormErr.title}</span>}
                    </div>
                    <div>
                      <label className="ss-lbl">Date *</label>
                      <input type="date" value={evForm.date} onChange={e => setEvForm(f => ({ ...f, date: e.target.value }))} className={`ss-inp${evFormErr.date ? " err" : ""}`} />
                      {evFormErr.date && <span className="ss-err">{evFormErr.date}</span>}
                    </div>
                    <div>
                      <label className="ss-lbl">Start Time *</label>
                      <input type="time" value={evForm.startTime} onChange={e => setEvForm(f => ({ ...f, startTime: e.target.value }))} className={`ss-inp${evFormErr.startTime ? " err" : ""}`} />
                      {evFormErr.startTime && <span className="ss-err">{evFormErr.startTime}</span>}
                    </div>
                    <div>
                      <label className="ss-lbl">End Time <span style={{ color: "var(--subtle)" }}>(optional, blank = +1h)</span></label>
                      <input type="time" value={evForm.endTime} onChange={e => setEvForm(f => ({ ...f, endTime: e.target.value }))} className={`ss-inp${evFormErr.endTime ? " err" : ""}`} />
                      {evFormErr.endTime && <span className="ss-err">{evFormErr.endTime}</span>}
                    </div>
                    <div style={{ gridColumn: "2/4" }}>
                      <label className="ss-lbl">Description</label>
                      <input value={evForm.description} onChange={e => setEvForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional" className="ss-inp" />
                    </div>
                  </div>
                  {evFormErr.submit && <p style={{ color: "#ef4444", fontSize: 12, margin: "0 0 10px" }}>{evFormErr.submit}</p>}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={submitManualEvent} disabled={nlBusy} style={{ ...S.btn, background: "#4f46e5", padding: "8px 20px", opacity: nlBusy ? .6 : 1 }}>{nlBusy ? "Creating…" : "✅ Create Event"}</button>
                    <button onClick={() => { setShowEvForm(false); setEvFormErr({}); }} style={{ ...S.btn, background: "var(--border)", color: "var(--text)", padding: "8px 14px" }}>Cancel</button>
                  </div>
                </div>
              )}

              {/* Legend */}
              <div style={{ display: "flex", gap: 16, marginBottom: 10, fontSize: 11, color: "var(--muted)", flexWrap: "wrap", alignItems: "center" }}>
                <span><span style={{ width: 8, height: 8, borderRadius: "50%", background: G, display: "inline-block", marginRight: 4 }} />Google</span>
                <span><span style={{ width: 8, height: 8, borderRadius: "50%", background: O, display: "inline-block", marginRight: 4 }} />Outlook</span>
                <span style={{ color: "#ef4444" }}>⚠️ = conflict</span>
                <span style={{ color: "#3b82f6", display: "flex", alignItems: "center", gap: 3 }}><span style={{ fontWeight: 700 }}>●</span> = busy ({`>${BUSY_THRESHOLD}`} events)</span>
                <span>🎉 = holiday</span>
                {/* Calendar legend */}
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 10, fontSize: 11, color: "var(--muted)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: "#4f46e5", display: "inline-block" }} />Google</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: "#f97316", display: "inline-block" }} />Outlook</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: "#059669", display: "inline-block" }} />Study</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>🎉 Holiday</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>⚠️ Conflict</span>
              </div>
              {selDay && <span style={{ color: "#4f46e5", fontWeight: 600 }}>📅 Selected: {fmtShort(selDay)}</span>}
              </div>

              {/* Calendar grid */}
              {view === "month" ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 }}>
                    {DAYS.map(d => <div key={d} style={{ textAlign: "center", fontWeight: 600, fontSize: 11, color: "var(--subtle)", padding: "6px 0", letterSpacing: ".05em" }}>{d}</div>)}
                    {renderMonth()}
                  </div>
                  {/* Selected day detail */}
                  {selDay && (
                    <div className="ss-panel" style={{ marginTop: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                        <h4 style={{ margin: 0, color: "var(--text)", fontSize: 14 }}>📅 {fmtLong(selDay)}</h4>
                        {weather && <span style={{ fontSize: 13 }}>{weather.icon} {weather.max}°/{weather.min}°C</span>}
                      </div>
                      {/* Holiday banner */}
                      {getHol(selDay) && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, background: "#fef3c7", border: "1px solid #f59e0b", marginBottom: 10 }}>
                          <span style={{ fontSize: 16 }}>🎉</span>
                          <div>
                            <div style={{ fontWeight: 700, color: "#92400e", fontSize: 13 }}>{getHol(selDay).title}</div>
                            {getHol(selDay).name !== getHol(selDay).title && <div style={{ fontSize: 11, color: "#b45309" }}>{getHol(selDay).name}</div>}
                          </div>
                          <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, color: "#92400e", background: "#fde68a", padding: "2px 8px", borderRadius: 6 }}>PUBLIC HOLIDAY</span>
                        </div>
                      )}
                      {evOn(selDay).length === 0
                        ? <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>No events. <button onClick={() => setShowEvForm(true)} style={{ background: "none", border: "none", color: "#4f46e5", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>+ Add one</button></p>
                        : evOn(selDay).map(ev => (
                          <div key={ev.id} onClick={() => setSelEvent(ev)} style={{ padding: "9px 12px", borderRadius: 8, marginBottom: 6, background: "var(--bg)", border: "1px solid var(--border)", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "background .12s" }}
                            onMouseEnter={e => e.currentTarget.style.background = "rgba(79,70,229,.06)"}
                            onMouseLeave={e => e.currentTarget.style.background = "var(--bg)"}>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>{ev.title}</div>
                              <div style={{ fontSize: 11, color: "var(--muted)" }}>{ev.allDay ? "All day" : `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`}</div>
                            </div>
                            <span style={{ padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: ev.source === "outlook" ? "#fff7ed" : "#ede9fe", color: ev.source === "outlook" ? "#c2410c" : "#4f46e5" }}>{ev.source === "outlook" ? "📧 Outlook" : "🔵 Google"}</span>
                          </div>
                        ))
                      }
                    </div>
                  )}
                </>
              ) : renderWeek()}
            </div>
          )}

          {/* ══════════════════════ TASKS ══════════════════════════════════════ */}
          {tab === "tasks" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 18, color: "var(--text)" }}>Task Manager</h2>
                <button onClick={() => setShowTaskForm(v => !v)} style={{ ...S.btn, background: showTaskForm ? "#64748b" : "#4f46e5", padding: "7px 14px", fontSize: 13 }}>{showTaskForm ? "✕ Close" : "+ New Task"}</button>
              </div>
              {showTaskForm && (
                <div className="ss-panel" style={{ marginBottom: 16 }}>
                  <h4 style={{ margin: "0 0 12px", color: "var(--text)" }}>📝 New Task</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
                    <div><label className="ss-lbl">Title *</label><input value={newTask.title} onChange={e => setNewTask(n => ({ ...n, title: e.target.value }))} placeholder="Task name" className="ss-inp" /></div>
                    <div><label className="ss-lbl">Due Date</label><input type="datetime-local" value={newTask.dueDate} onChange={e => setNewTask(n => ({ ...n, dueDate: e.target.value }))} className="ss-inp" /></div>
                    <div><label className="ss-lbl">Priority</label><select value={newTask.priority} onChange={e => setNewTask(n => ({ ...n, priority: e.target.value }))} className="ss-inp"><option value="high">🔴 High</option><option value="medium">🟡 Medium</option><option value="low">🟢 Low</option></select></div>
                    <div style={{ gridColumn: "1/4" }}><label className="ss-lbl">Notes</label><input value={newTask.notes} onChange={e => setNewTask(n => ({ ...n, notes: e.target.value }))} placeholder="Optional notes" className="ss-inp" /></div>
                  </div>
                  <button onClick={addTask} style={{ ...S.btn, background: "#4f46e5", padding: "7px 18px" }}>Add Task</button>
                </div>
              )}
              <div style={{ marginBottom: 24 }}>
                <h3 style={{ margin: "0 0 10px", fontSize: 12, color: "var(--subtle)", textTransform: "uppercase", letterSpacing: ".06em" }}>Pending ({tasks.filter(t => !t.done).length})</h3>
                {tasks.filter(t => !t.done).sort((a, b) => a.dueDate && b.dueDate ? new Date(a.dueDate) - new Date(b.dueDate) : 0).map(t => (
                  <div key={t.id} className="ss-panel" style={{ marginBottom: 8, padding: "11px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: PC[t.priority], flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>{t.title}</div>
                        {t.dueDate && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>📅 {new Date(t.dueDate).toLocaleString()}</div>}
                        {t.notes && <div style={{ fontSize: 11, color: "var(--subtle)", marginTop: 1 }}>{t.notes}</div>}
                      </div>
                      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                        <button onClick={() => taskToCalendar(t)} title="Add to Google Calendar" style={{ ...S.ib, background: "#dbeafe", color: "#1d4ed8", border: "none", padding: "4px 8px", fontSize: 11 }}>📅</button>
                        <button onClick={() => toggleTask(t.id)} style={{ ...S.ib, background: "#dcfce7", color: "#059669", border: "none", padding: "4px 8px", fontSize: 11 }}>✓</button>
                        <button onClick={() => deleteTask(t.id)} style={{ ...S.ib, background: "#fee2e2", color: "#ef4444", border: "none", padding: "4px 8px", fontSize: 11 }}>✕</button>
                      </div>
                    </div>
                  </div>
                ))}
                {tasks.filter(t => !t.done).length === 0 && <p style={{ color: "var(--muted)", fontSize: 13 }}>All done! 🎉 Add a new task above.</p>}
              </div>
              {tasks.filter(t => t.done).length > 0 && (
                <div>
                  <h3 style={{ margin: "0 0 10px", fontSize: 12, color: "var(--subtle)", textTransform: "uppercase", letterSpacing: ".06em" }}>Completed ({tasks.filter(t => t.done).length})</h3>
                  {tasks.filter(t => t.done).map(t => (
                    <div key={t.id} style={{ padding: "9px 12px", borderRadius: 8, marginBottom: 6, background: "var(--bg)", border: "1px solid var(--border)", opacity: .55, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 13, color: "var(--muted)", textDecoration: "line-through" }}>{t.title}</span>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button onClick={() => toggleTask(t.id)} style={{ ...S.ib, fontSize: 11, padding: "3px 7px" }}>↩</button>
                        <button onClick={() => deleteTask(t.id)} style={{ ...S.ib, background: "#fee2e2", color: "#ef4444", border: "none", fontSize: 11, padding: "3px 7px" }}>✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ══════════════════════ ACADEMIC ═══════════════════════════════════ */}
          {tab === "academic" && (
            <div>
              <h2 style={{ margin:"0 0 20px", fontSize:18, color:"var(--text)", fontWeight:700 }}>🎓 Academic Planner</h2>
              <AcademicModule
                events={events}
                toast={toast}
                onSendToChat={(msg) => {
                  setNlInput(msg || "Help me build my college timetable.");
                  setShowChat(true);
                }}

                onCreateEvent={async (ev) => {
                  const safeTitle = (ev.title || "").trim() || "Study Session";
                  try {
                    const res = await gcalPost("POST", { title: safeTitle, start: ev.start, end: ev.end, description: ev.description || "" });
                    const newEv = res.event || res;
                    setEvents(prev => [...prev, { ...newEv, source: newEv.source || "google" }]);
                    toast(`✅ Study block booked: ${safeTitle}`);
                  } catch (e) { toast(e.message, "error"); }
                }}

                onCreateClass={async (cls) => {
                  const BYDAY = { Monday:"MO",Tuesday:"TU",Wednesday:"WE",Thursday:"TH",Friday:"FR",Saturday:"SA",Sunday:"SU" };
                  const GDAYS = { Monday:"monday",Tuesday:"tuesday",Wednesday:"wednesday",Thursday:"thursday",Friday:"friday",Saturday:"saturday",Sunday:"sunday" };
                  // Find next occurrence of the selected day
                  const dayIdx = { Sunday:0,Monday:1,Tuesday:2,Wednesday:3,Thursday:4,Friday:5,Saturday:6 };
                  const now = new Date();
                  const diff = ((dayIdx[cls.day]??1) - now.getDay() + 7) % 7 || 7;
                  const base = new Date(now); base.setDate(now.getDate() + diff);
                  const [sh,sm] = (cls.startTime||"09:00").split(":").map(Number);
                  const [eh,em] = (cls.endTime||"10:00").split(":").map(Number);
                  const startDt = new Date(base); startDt.setHours(sh,sm,0,0);
                  const endDt  = new Date(base); endDt.setHours(eh,em,0,0);
                  const isOutlook = session?.provider === "azure-ad";
                  const res = await gcalPost("POST", {
                    title: `📚 ${cls.subject}`,
                    start: startDt.toISOString(),
                    end:   endDt.toISOString(),
                    description: `Weekly class | ${cls.day} ${cls.startTime}–${cls.endTime}`,
                    ...(isOutlook
                      ? { outlookRecurrence: { pattern: { type:"weekly", interval:1, daysOfWeek:[GDAYS[cls.day]] }, range: { type:"noEnd", startDate: base.toISOString().slice(0,10) } } }
                      : { recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[cls.day]}`] }
                    ),
                  });
                  return res.event || res;
                }}

                onDeleteClass={async (calendarId) => {
                  if (!calendarId) return;
                  await deleteEventApi(calendarId);
                  setEvents(prev => prev.filter(e => e.id !== calendarId));
                }}
              />
            </div>
          )}

          {/* ══════════════════════ SETTINGS ═══════════════════════════════════ */}
          {tab === "settings" && (
            <div>
              <h2 style={{ margin:"0 0 20px", fontSize:18, color:"var(--text)", fontWeight:700 }}>⚙️ Settings</h2>
              <AcademicModule
                events={events}
                toast={toast}
                forceTab="apis"
                onSendToChat={() => {}}
                onCreateEvent={async () => {}}
                onCreateClass={async () => {}}
                onDeleteClass={async () => {}}
                settingsProps={{
                  session,
                  darkMode,
                  setDarkMode,
                  notifEnabled,
                  setNotifEnabled,
                  notifPerm,
                  requestNotifPermission,
                  sendTestNotification,
                  reminderMinutes,
                  setReminderMinutes,
                  classNotifsEnabled,
                  setClassNotifsEnabled,
                  events,
                  tasks,
                  prodScore,
                  exporting,
                  exportJSON: () => { exportJSON(); },
                  exportICS: () => { exportICS(); },
                  fetchEvents,
                  signOut,
                  setTasks,
                  setEvents,
                }}
              />
            </div>
          )}

          {/* ══════════════════════ INSIGHTS ═══════════════════════════════════ */}
          {tab === "insights" && (
            <div>
              <h2 style={{ margin: "0 0 16px", fontSize: 18, color: "var(--text)" }}>📊 Analytics Dashboard</h2>
              <div style={{ display: "grid", gridTemplateColumns: "130px 1fr", gap: 14, marginBottom: 14 }}>
                <div className="ss-panel" style={{ textAlign: "center", padding: 14 }}>
                  <h4 style={{ margin: "0 0 8px", fontSize: 10, color: "var(--subtle)", textTransform: "uppercase", letterSpacing: ".06em" }}>Score</h4>
                  <div style={{ position: "relative", width: 80, height: 80, margin: "0 auto 6px" }}>
                    <svg viewBox="0 0 36 36" style={{ width: "100%", height: "100%", transform: "rotate(-90deg)" }}>
                      <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--border)" strokeWidth="3" />
                      <circle cx="18" cy="18" r="15.9" fill="none" stroke={prodScore >= 70 ? "#059669" : prodScore >= 40 ? "#f97316" : "#ef4444"} strokeWidth="3" strokeDasharray={`${prodScore} 100`} strokeLinecap="round" />
                    </svg>
                    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                      <span style={{ fontSize: 18, fontWeight: 800, color: "#4f46e5" }}>{prodScore}</span>
                      <span style={{ fontSize: 9, color: "var(--subtle)" }}>/100</span>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: prodScore >= 70 ? "#059669" : prodScore >= 40 ? "#f97316" : "var(--muted)" }}>{prodScore >= 70 ? "🌟 Excellent" : prodScore >= 40 ? "📈 Good" : prodScore > 0 ? "💪 Building" : "—"}</div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9 }}>
                  {[{ l: "This Week", v: st.week, i: "📅" }, { l: "This Month", v: st.month, i: "📆" }, { l: "Upcoming", v: st.upcoming, i: "⏰" }, { l: "Tasks Pending", v: st.todo, i: "📋" }, { l: "Tasks Done", v: st.done, i: "✅" }, { l: "Completion", v: st.todo + st.done > 0 ? `${Math.round(st.done / (st.todo + st.done) * 100)}%` : "—", i: "🎯" }].map(s => (
                    <div key={s.l} className="ss-panel" style={{ padding: 11, textAlign: "center" }}>
                      <div style={{ fontSize: 18, marginBottom: 2 }}>{s.i}</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: "#4f46e5" }}>{s.v}</div>
                      <div style={{ fontSize: 10, color: "var(--subtle)" }}>{s.l}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="ss-panel" style={{ marginBottom: 14, padding: "14px 16px" }}>
                <h4 style={{ margin: "0 0 8px", color: "var(--text)", fontSize: 13 }}>Today's Busy vs Free (8am–8pm)</h4>
                <div style={{ display: "flex", height: 22, borderRadius: 5, overflow: "hidden", marginBottom: 8 }}>
                  <div style={{ flex: bf.busy, background: "#ef4444", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", minWidth: bf.busy > 0 ? 40 : 0 }}>{bf.busy > 60 ? `${Math.floor(bf.busy / 60)}h` : ""}</div>
                  <div style={{ flex: Math.max(bf.free, 1), background: "#22c55e", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff" }}>{bf.free > 60 ? `${Math.floor(bf.free / 60)}h free` : ""}</div>
                </div>
                <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--muted)" }}>
                  <span>🔴 Busy: {Math.floor(bf.busy / 60)}h {bf.busy % 60}m</span>
                  <span>🟢 Free: {Math.floor(bf.free / 60)}h {bf.free % 60}m</span>
                  <span>📊 {bf.pct}% scheduled</span>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
                <div className="ss-panel" style={{ padding: "14px 16px" }}>
                  <h4 style={{ margin: "0 0 10px", color: "var(--text)", fontSize: 13 }}>Events by Day of Week</h4>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 70 }}>
                    {DAYS.map((d, i) => { const pct = Math.max(4, (st.byDow[i] / st.maxDow) * 65); return (<div key={d} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}><span style={{ fontSize: 9, color: "var(--muted)" }}>{st.byDow[i] || ""}</span><div style={{ width: "100%", height: `${pct}px`, background: i === st.busyD ? "#4f46e5" : "#a5b4fc", borderRadius: "3px 3px 0 0" }} /><span style={{ fontSize: 9, color: "var(--subtle)" }}>{d}</span></div>); })}
                  </div>
                  {st.busyD >= 0 && <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--muted)" }}>Busiest: <strong>{DAYS[st.busyD]}</strong></p>}
                </div>
                <div className="ss-panel" style={{ padding: "14px 16px" }}>
                  <h4 style={{ margin: "0 0 10px", color: "var(--text)", fontSize: 13 }}>🔮 Scheduling Patterns</h4>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 1.5, height: 60 }}>
                    {patterns.hourCounts.map((c, h) => { const pct = st.maxHr > 0 ? Math.max(2, (c / st.maxHr) * 55) : 2; return (<div key={h} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}><div style={{ width: "100%", height: `${pct}px`, borderRadius: "2px 2px 0 0", background: h === st.peakH ? "#4f46e5" : h >= 8 && h <= 19 ? "#a5b4fc" : "var(--border)" }} title={`${h}:00 — ${c} events`} />{h % 6 === 0 && <span style={{ fontSize: 8, color: "var(--subtle)" }}>{h}</span>}</div>); })}
                  </div>
                  {st.peakH >= 0 ? <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--muted)" }}>Peak: <strong>{st.peakH}:00</strong> · Avg: <strong>{avgDur(patterns)}min</strong></p> : <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--subtle)" }}>Sync calendar to see patterns</p>}
                </div>
              </div>
              <div className="ss-panel" style={{ padding: "14px 16px" }}>
                <h4 style={{ margin: "0 0 10px", color: "var(--text)", fontSize: 13 }}>🤖 AI-Powered Insights</h4>
                {[
                  st.peakH >= 0 && `Your peak scheduling hour is ${st.peakH}:00 — block deep-focus time around it.`,
                  st.busyD >= 0 && `${DAYS[st.busyD]}s are your busiest day. Schedule lighter work on other days.`,
                  bf.pct > 70 && "Today is 70%+ booked — consider declining non-critical meetings.",
                  bf.pct < 15 && events.length > 0 && "Very light day — ideal for deep work or batch-processing tasks.",
                  st.todo > 5 && `${st.todo} tasks pending. Time-block 2h daily to reduce the backlog.`,
                  patterns.totalEvents > 10 && `Based on ${patterns.totalEvents} events, your average meeting lasts ${avgDur(patterns)}min.`,
                  st.done > 0 && st.todo + st.done > 0 && Math.round(st.done / (st.todo + st.done) * 100) >= 80 && "🌟 80%+ task completion! Excellent productivity.",
                  events.length === 0 && "Connect Google Calendar to unlock pattern learning and predictive suggestions.",
                ].filter(Boolean).map((s, i) => (
                  <div key={i} style={{ padding: "8px 11px", background: "rgba(14,165,233,.08)", borderRadius: 7, marginBottom: 6, fontSize: 12, color: "var(--text)", borderLeft: "3px solid #0ea5e9" }}>💡 {s}</div>
                ))}
              </div>
            </div>
          )}

          {/* (Profile tab removed — now inside Settings modal) */}

        </main>
      </div>

      {/* ═══ FLOATING AI CHAT BUTTON ═══ */}
      <button onClick={() => setShowChat(v => !v)} className="ss-fab"
        style={{ position: "fixed", bottom: 24, right: 24, width: 54, height: 54, borderRadius: "50%", background: "linear-gradient(135deg,#4f46e5,#7c3aed)", color: "#fff", fontSize: showChat ? 22 : 24, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 400, transition: "transform .2s", boxShadow: "0 4px 20px rgba(79,70,229,.4)" }}
        title="AI Scheduling Assistant">
        {showChat ? "✕" : "💬"}
      </button>

      {/* ═══ AI CHAT PANEL (slide-in from right) ═══ */}
      {showChat && (
        <div className="ss-chat-panel chat-panel" style={{ position: "fixed", right: 0, top: 0, bottom: 0, width: 380, background: "var(--surface)", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", zIndex: 450, boxShadow: "-4px 0 24px rgba(0,0,0,.14)" }}>
          {/* Chat header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid var(--border)", background: "var(--navbg)", flexShrink: 0 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>🤖 AI Scheduling Assistant</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>{nlBusy ? "Thinking…" : clarifying ? "Clarifying…" : "Ready to help"}</div>
            </div>
            <button onClick={() => setShowChat(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "var(--muted)", padding: 4 }}>✕</button>
          </div>
          {/* Messages */}
          <div style={{ flex: 1, overflowY: "auto", padding: "14px 14px 8px" }}>
            {chat.map((m, i) => (
              <div key={i} style={{ display: "flex", justifyContent: m.role === "u" ? "flex-end" : "flex-start", marginBottom: 10 }}>
                {m.role === "a" && <span style={{ fontSize: 20, marginRight: 7, flexShrink: 0, alignSelf: "flex-end" }}>🤖</span>}
                <div style={{ background: m.role === "u" ? "#4f46e5" : "var(--bg)", color: m.role === "u" ? "#fff" : "var(--text)", padding: "9px 12px", borderRadius: m.role === "u" ? "14px 14px 4px 14px" : "4px 14px 14px 14px", maxWidth: "82%", fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", border: m.role === "a" ? "1px solid var(--border)" : "none" }}>
                  {m.text}
                </div>
              </div>
            ))}
            {nlBusy && <div style={{ display: "flex", gap: 5, padding: "6px 0", marginLeft: 34 }}><span className="dot" /><span className="dot" /><span className="dot" /></div>}
            {renderPending()}
            <div ref={chatEnd} />
          </div>
          {/* Input */}
          <div style={{ display: "flex", padding: "10px 12px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
            <input value={nlInput} onChange={e => setNlInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.shiftKey && handleNL()}
              placeholder={clarifying ? "Type your answer…" : "Schedule, delete, find free time…"} className="ss-inp"
              style={{ flex: 1, borderRadius: "10px 0 0 10px", borderRight: "none" }} disabled={nlBusy} autoFocus />
            <button onClick={handleNL} disabled={nlBusy} style={{ ...S.btn, background: "#4f46e5", padding: "8px 14px", borderRadius: "0 10px 10px 0", fontSize: 16 }}>➤</button>
          </div>
        </div>
      )}

      {/* ═══ SETTINGS MODAL ═══ */}
      {showSettings && (
        <div style={{ position: "fixed", inset: 0, background: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }} onClick={() => setShowSettings(false)}>
          <div style={{ background: "var(--surface)", borderRadius: 16, padding: 0, maxWidth: 520, width: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 24px 80px rgba(0,0,0,.3)", border: "1px solid var(--border)" }} onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 22px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontWeight: 800, fontSize: 17, color: "var(--text)" }}>⚙️ Settings</div>
              <button onClick={() => setShowSettings(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--subtle)" }}>✕</button>
            </div>
            <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 18 }}>
              {/* A: Profile */}
              <div className="ss-panel" style={{ padding: 16 }}>
                <h4 style={{ margin: "0 0 12px", fontSize: 10, color: "var(--subtle)", textTransform: "uppercase", letterSpacing: ".06em" }}>Profile</h4>
                <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                  {session?.user?.image && <img src={session.user.image} alt="" style={{ width: 54, height: 54, borderRadius: "50%", border: "3px solid #4f46e5" }} />}
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>{session?.user?.name}</div>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>{session?.user?.email}</div>
                    <div style={{ fontSize: 11, color: "#059669", marginTop: 4 }}>
                      {session?.provider === "azure-ad" ? "📧 Connected: Outlook Calendar" : "🔵 Connected: Google Calendar"}
                    </div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 14 }}>
                  {[{ l: "Events", v: events.length, c: "#4f46e5" }, { l: "Tasks", v: tasks.length, c: "#059669" }, { l: "Score", v: `${prodScore}/100`, c: "#f97316" }].map(s => (
                    <div key={s.l} style={{ textAlign: "center", padding: 9, background: "var(--bg)", borderRadius: 8 }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: s.c }}>{s.v}</div>
                      <div style={{ fontSize: 10, color: "var(--subtle)" }}>{s.l}</div>
                    </div>
                  ))}
                </div>
              </div>
              {/* B: Preferences */}
              <div className="ss-panel" style={{ padding: 16 }}>
                <h4 style={{ margin: "0 0 12px", fontSize: 10, color: "var(--subtle)", textTransform: "uppercase", letterSpacing: ".06em" }}>Preferences</h4>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <span style={{ fontSize: 13, color: "var(--text)" }}>{darkMode ? "🌙 Dark Mode" : "☀️ Light Mode"}</span>
                  <span role="switch" aria-checked={darkMode} className={`dm-toggle ${darkMode ? "on" : "off"}`} onClick={() => setDarkMode(v => !v)} style={{ cursor: "pointer", display: "inline-block" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <span style={{ fontSize: 13, color: "var(--text)" }}>🔔 Notifications</span>
                  <span role="switch" aria-checked={notifEnabled} className={`dm-toggle ${notifEnabled ? "on" : "off"}`} onClick={() => { setNotifEnabled(v => { const nv = !v; localStorage.setItem("ss-notif-enabled", nv ? "1" : "0"); return nv; }); }} style={{ cursor: "pointer", display: "inline-block" }} />
                </div>
                {notifEnabled && (
                  <>
                    {/* Permission denied warning */}
                    {notifPerm === "denied" && (
                      <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 12, color: "#991b1b" }}>
                        ⚠️ Browser notifications are blocked. Enable them in your browser settings to receive reminders.
                      </div>
                    )}
                    {notifPerm === "default" && (
                      <div style={{ marginBottom: 12 }}>
                        <button onClick={requestNotifPermission} style={{ background: "linear-gradient(135deg,#4f46e5,#7c3aed)", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 12px rgba(79,70,229,.3)", width: "100%" }}>🔔 Enable Browser Notifications</button>
                        <p style={{ margin: "6px 0 0", fontSize: 10, color: "var(--subtle)" }}>Click to allow — your browser will show a permission popup</p>
                      </div>
                    )}
                    {notifPerm === "granted" && (
                      <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, padding: "6px 12px", marginBottom: 12, fontSize: 12, color: "#166534", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span>✅ Notifications enabled</span>
                        <button onClick={sendTestNotification} style={{ background: "#059669", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>🔔 Test</button>
                      </div>
                    )}
                    {/* Reminder timing */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                      <span style={{ fontSize: 13, color: "var(--text)" }}>⏰ Remind me before</span>
                      <select value={reminderMinutes} onChange={e => { const v = +e.target.value; setReminderMinutes(v); localStorage.setItem("ss-reminder-min", String(v)); }} style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12, fontWeight: 600 }}>
                        <option value={5}>5 minutes</option>
                        <option value={10}>10 minutes</option>
                        <option value={15}>15 minutes</option>
                        <option value={30}>30 minutes</option>
                        <option value={60}>1 hour</option>
                      </select>
                    </div>
                    {/* Class notification toggle */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 13, color: "var(--text)" }}>📚 Class Reminders</span>
                      <span role="switch" aria-checked={classNotifsEnabled} className={`dm-toggle ${classNotifsEnabled ? "on" : "off"}`} onClick={() => { setClassNotifsEnabled(v => { const nv = !v; localStorage.setItem("ss-class-notifs", nv ? "1" : "0"); return nv; }); }} style={{ cursor: "pointer", display: "inline-block" }} />
                    </div>
                  </>
                )}
              </div>
              {/* C: Data */}
              <div className="ss-panel" style={{ padding: 16 }}>
                <h4 style={{ margin: "0 0 10px", fontSize: 10, color: "var(--subtle)", textTransform: "uppercase", letterSpacing: ".06em" }}>Export Data</h4>
                <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                  <button onClick={() => { exportJSON(); }} className="ss-export-btn" disabled={exporting || !events.length}>📤 JSON ({events.length} events)</button>
                  <button onClick={() => { exportICS(); }} className="ss-export-btn" disabled={exporting || !events.length}>🗓️ ICS file</button>
                </div>
                <p style={{ margin: 0, fontSize: 10, color: "var(--subtle)" }}>JSON = structured data · ICS = import into any calendar app</p>
              </div>
              {/* D: Account / Danger zone */}
              <div className="ss-panel" style={{ padding: 16, border: "1px solid #fca5a5" }}>
                <h4 style={{ margin: "0 0 12px", fontSize: 10, color: "#ef4444", textTransform: "uppercase", letterSpacing: ".06em" }}>⚠️ Danger Zone</h4>
                <button onClick={() => { fetchEvents(true); toast("🔄 Calendar synced!"); }} style={{ ...S.btn, background: "#059669", padding: "8px 14px", marginRight: 8, marginBottom: 8, fontSize: 12 }}>🔄 Sync Calendar</button>
                <button onClick={() => {
                  if (!confirm("Delete ALL data? This cannot be undone.")) return;
                  localStorage.clear();
                  setTasks([]); setEvents([]);
                  toast("🗑️ All local data cleared. Signing out…", "info");
                  setTimeout(() => signOut(), 1500);
                }} style={{ ...S.btn, background: "#dc2626", padding: "8px 14px", marginRight: 8, marginBottom: 8, fontSize: 12 }}>🗑️ Delete Account Data</button>
                <button onClick={() => { signOut(); }} style={{ ...S.btn, background: "#ef4444", padding: "8px 14px", fontSize: 12 }}>🚪 Sign Out</button>
                <p style={{ margin: "8px 0 0", fontSize: 11, color: "#94a3b8" }}>Delete Account Data clears all tasks, cache and local storage, then signs you out. Google Calendar events remain in your Google account.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ EVENT DETAIL MODAL ═══ */}
      {selEvent && (
        <div style={{ position: "fixed", inset: 0, background: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setSelEvent(null)}>
          <div style={{ background: "var(--surface)", borderRadius: 14, padding: "22px 22px 18px", maxWidth: 420, width: "90%", position: "relative", boxShadow: "0 20px 60px rgba(0,0,0,.28)", border: "1px solid var(--border)" }} onClick={e => e.stopPropagation()}>
            <button style={{ position: "absolute", top: 12, right: 12, background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--subtle)" }} onClick={() => setSelEvent(null)}>✕</button>
            <span style={{ padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: selEvent.source === "outlook" ? "#fff3e0" : "#dbeafe", color: selEvent.source === "outlook" ? "#e65100" : "#1d4ed8", marginBottom: 10, display: "inline-block" }}>
              {selEvent.source === "outlook" ? "📧 Outlook Calendar" : "🔵 Google Calendar"}{selEvent.allDay ? " · All-day" : ""}
            </span>
            <h3 style={{ margin: "8px 0 8px", color: "var(--text)" }}>{selEvent.title}</h3>
            <p style={{ color: "var(--muted)", fontSize: 13, margin: "3px 0" }}>🕐 {selEvent.allDay ? "All day" : `${fmtTime(selEvent.start)} – ${fmtTime(selEvent.end)}`}</p>
            <p style={{ color: "var(--muted)", fontSize: 13, margin: "3px 0" }}>📅 {fmtLong(selEvent.start)}</p>
            {selEvent.location && <p style={{ color: "var(--muted)", fontSize: 13, margin: "3px 0" }}>📍 {selEvent.location}</p>}
            {selEvent.description && <p style={{ fontSize: 12, color: "var(--text)", marginTop: 8, padding: 9, background: "var(--bg)", borderRadius: 7, border: "1px solid var(--border)" }}>{selEvent.description}</p>}
            <div style={{ display: "flex", gap: 7, marginTop: 12 }}>
              {/* Reschedule → pre-fill chat */}
              <button onClick={() => { setNlInput(`Reschedule ${selEvent.title} to tomorrow at 10am`); setSelEvent(null); setShowChat(true); }} style={{ ...S.btn, padding: "6px 12px", fontSize: 12, background: "#3b82f6" }}>📅 Reschedule</button>
              {/* Direct delete — NO chat, NO AI */}
              <button onClick={async () => {
                if (!confirm(`Delete "${selEvent.title}"?`)) return;
                const ev = selEvent;
                setSelEvent(null);
                try {
                  await deleteEventApi(ev.id);
                  setEvents(prev => prev.filter(e => e.id !== ev.id));
                  toast(`🗑️ "${ev.title}" deleted!`);
                } catch (e) { toast(`❌ ${e.message}`, "error"); }
              }} style={{ ...S.btn, padding: "6px 12px", fontSize: 12, background: "#ef4444" }}>🗑️ Delete</button>
            </div>
            {(() => { const c = detectConflicts(selEvent.start, selEvent.end, events.filter(e => e.id !== selEvent.id)); return c.length > 0 ? (<div style={{ marginTop: 9, padding: "7px 10px", background: "#fee2e2", borderRadius: 7 }}><p style={{ margin: 0, fontSize: 11, color: "#ef4444", fontWeight: 600 }}>⚠️ Conflicts with:</p>{c.map(x => <p key={x.id} style={{ margin: "2px 0 0", fontSize: 11, color: "#7f1d1d" }}>• {x.title} · {fmtTime(x.start)}</p>)}</div>) : null; })()}
          </div>
        </div>
      )}

      {/* ═══ TOAST NOTIFICATIONS ═══ */}
      <div style={{ position: "fixed", bottom: 90, right: 24, display: "flex", flexDirection: "column", gap: 8, zIndex: 600 }}>
        {toasts.map(t => (
          <div key={t.id} className="ss-toast" style={{ padding: "10px 16px", borderRadius: 10, color: "#fff", fontSize: 13, fontWeight: 500, boxShadow: "0 4px 14px rgba(0,0,0,.18)", minWidth: 220, maxWidth: 320, background: t.type === "error" ? "#ef4444" : t.type === "info" ? "#3b82f6" : "#059669" }}>
            {t.msg}
          </div>
        ))}
      </div>

    </div>
  );
}

// ─── Styles object (CSS-var-aware for dark mode) ────────────────────────────────
const S = {
  app: { fontFamily: "inherit", minHeight: "100vh", display: "flex", background: "var(--bg)", color: "var(--text)", transition: "background .2s, color .2s" },
  sidebar: { width: 220, flexShrink: 0, background: "var(--navbg)", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh", overflow: "hidden" },
  sidebarLogo: { padding: "18px 18px 14px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--border)" },
  mainWrap: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" },
  topBar: { height: 56, display: "flex", alignItems: "center", padding: "0 20px", borderBottom: "1px solid var(--border)", background: "var(--navbg)", gap: 12, flexShrink: 0 },
  main: { flex: 1, padding: "20px 24px", overflowY: "auto" },
  btn: { display: "inline-block", padding: "9px 18px", borderRadius: 10, border: "none", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600, transition: "opacity .15s" },
  ib: { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer", fontSize: 12, color: "var(--muted)", transition: "background .15s" },
  center: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", paddingTop: 48 },
  badge: { padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600 },
  dropdown: { position: "absolute", top: "calc(100% + 8px)", right: 0, width: 248, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 8px 30px rgba(0,0,0,.16)", zIndex: 500, overflow: "hidden" },
};

// ─── App Router ────────────────────────────────────────────────────────────────
function AppRouter() {
  const { data: session, status } = useSession();

  // ━━ DEBUG: Remove these logs after confirming Outlook login works ━━
  useEffect(() => {
    console.log("[SS] status:", status);
    console.log("[SS] provider:", session?.provider);
    console.log("[SS] user:", session?.user?.email);
    console.log("[SS] accessToken:", session?.accessToken ? "✓ present" : "✗ missing");
  }, [status, session]);

  // Show spinner while NextAuth resolves the session cookie (including after OAuth redirect)
  if (status === "loading") return <LoadingScreen />;

  // Only show landing if definitively unauthenticated — NOT if just loading
  if (status === "unauthenticated") return <LandingPage />;

  // status === "authenticated" for BOTH Google and Azure AD
  return <App />;
}

// ─── Root export ───────────────────────────────────────────────────────────────
// SessionProvider is provided globally by app/providers.js via layout.js.
// Do NOT wrap in a second SessionProvider — it creates an isolated context
// that breaks session detection for azure-ad after OAuth redirect.
export default function Page() {
  return <AppRouter />;
}
