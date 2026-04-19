import { getServerSession } from "next-auth";
// Import the single canonical authOptions — never duplicate this config.
// A mismatch in strategy or secret between this file and [...nextauth]/route.js
// is the #1 cause of getServerSession() silently returning null for azure-ad.
import { authOptions } from "../auth/[...nextauth]/route";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;


// ── Helpers ──────────────────────────────────────────────────────────────────
function authErr(status = 401) {
  return Response.json({ error: "Not authenticated" }, { status });
}
function apiErr(data, status, source = "API") {
  const isWrite = status === 403;
  const msg = isWrite
    ? `${source} write access denied. Sign out and sign back in to grant permission.`
    : data?.error?.message || data?.error || `${source} error`;
  return Response.json({ error: msg }, { status });
}

// ── Google helpers ───────────────────────────────────────────────────────────
const GCAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

async function fetchGoogle(token) {
  const now = new Date();
  const timeMin = new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString();
  const timeMax = new Date(now.getFullYear(), now.getMonth() + 4, 0).toISOString();
  const url = `${GCAL_BASE}?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=250&singleEvents=true&orderBy=startTime`;
  const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw { data, status: res.status, source: "Google" };
  return (data.items || []).map(e => ({
    id: `g_${e.id}`,
    rawId: e.id,
    title: e.summary || "(No title)",
    start: e.start?.dateTime ?? e.start?.date,
    end:   e.end?.dateTime   ?? e.end?.date,
    allDay: !e.start?.dateTime,
    description: e.description || "",
    location: e.location || "",
    source: "google",
  }));
}

// ── Outlook / Microsoft Graph helpers ────────────────────────────────────────
const GRAPH_BASE = "https://graph.microsoft.com/v1.0/me/events";

async function fetchOutlook(token) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString();
  const end   = new Date(now.getFullYear(), now.getMonth() + 4, 0).toISOString();
  // Use $filter to get a date range, $top=250, $select only needed fields
  const url = `${GRAPH_BASE}?$top=250&$orderby=start/dateTime&$filter=start/dateTime ge '${start}' and end/dateTime le '${end}'&$select=id,subject,start,end,isAllDay,bodyPreview,location`;
  const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${TZ}"` }, cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw { data, status: res.status, source: "Outlook" };
  return (data.value || []).map(e => ({
    id: `o_${e.id}`,
    rawId: e.id,
    title: e.subject || "(No title)",
    start: e.start?.dateTime ? new Date(e.start.dateTime).toISOString() : e.start?.dateTime,
    end:   e.end?.dateTime   ? new Date(e.end.dateTime).toISOString()   : e.end?.dateTime,
    allDay: e.isAllDay || false,
    description: e.bodyPreview || "",
    location: e.location?.displayName || "",
    source: "outlook",
  }));
}

// ── GET: Fetch events (both providers in one call) ───────────────────────────
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) return authErr();

  try {
    const isOutlook = session.provider === "azure-ad";
    let events = [];

    if (isOutlook) {
      events = await fetchOutlook(session.accessToken);
    } else {
      events = await fetchGoogle(session.accessToken);
    }

    return Response.json({ events, total: events.length });
  } catch (err) {
    if (err.data) return apiErr(err.data, err.status, err.source);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) return authErr();

  const { title, start, end, description = "", recurrence, outlookRecurrence } = await req.json();
  if (!title || !start || !end)
    return Response.json({ error: "title, start, and end are required" }, { status: 400 });

  const isOutlook = session.provider === "azure-ad";

  try {
    if (isOutlook) {
      const body = {
        subject: title,
        body: { contentType: "text", content: description },
        start: { dateTime: start, timeZone: TZ },
        end:   { dateTime: end,   timeZone: TZ },
        ...(outlookRecurrence ? { recurrence: outlookRecurrence } : {}),
      };
      const res  = await fetch(GRAPH_BASE, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return apiErr(data, res.status, "Outlook");
      return Response.json({ event: { id: `o_${data.id}`, rawId: data.id, title: data.subject, start: data.start?.dateTime, end: data.end?.dateTime, source: "outlook" } });
    } else {
      const res = await fetch(GCAL_BASE, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: title, description,
          start: { dateTime: start, timeZone: TZ },
          end:   { dateTime: end,   timeZone: TZ },
          ...(recurrence ? { recurrence } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) return apiErr(data, res.status, "Google");
      return Response.json({ event: { id: `g_${data.id}`, rawId: data.id, title: data.summary, start: data.start?.dateTime, end: data.end?.dateTime, source: "google" } });
    }
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// ── PATCH: Reschedule / update event ─────────────────────────────────────────
export async function PATCH(req) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) return authErr();

  const { eventId, start, end, title } = await req.json();
  if (!eventId) return Response.json({ error: "eventId is required" }, { status: 400 });

  // Strip prefix (g_ / o_) to get the real calendar ID
  const rawId = eventId.replace(/^[go]_/, "");
  const isOutlook = session.provider === "azure-ad";

  try {
    if (isOutlook) {
      const body = {};
      if (title) body.subject = title;
      if (start) body.start = { dateTime: start, timeZone: TZ };
      if (end)   body.end   = { dateTime: end,   timeZone: TZ };
      const res  = await fetch(`${GRAPH_BASE}/${encodeURIComponent(rawId)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return apiErr(data, res.status, "Outlook");
      return Response.json({ event: { id: `o_${data.id}`, title: data.subject, start: data.start?.dateTime, end: data.end?.dateTime } });
    } else {
      const body = {};
      if (title) body.summary = title;
      if (start) body.start = { dateTime: start, timeZone: TZ };
      if (end)   body.end   = { dateTime: end,   timeZone: TZ };
      const res  = await fetch(`${GCAL_BASE}/${rawId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return apiErr(data, res.status, "Google");
      return Response.json({ event: { id: `g_${data.id}`, title: data.summary, start: data.start?.dateTime, end: data.end?.dateTime } });
    }
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// ── DELETE: Remove event ──────────────────────────────────────────────────────
export async function DELETE(req) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) return authErr();

  const { searchParams } = new URL(req.url);
  const eventId = searchParams.get("id");
  if (!eventId) return Response.json({ error: "id query param required" }, { status: 400 });

  const rawId    = eventId.replace(/^[go]_/, "");
  const isOutlook = session.provider === "azure-ad";

  try {
    const url = isOutlook
      ? `${GRAPH_BASE}/${encodeURIComponent(rawId)}`
      : `${GCAL_BASE}/${rawId}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    if (res.status === 204 || res.ok) return Response.json({ success: true });
    const data = await res.json().catch(() => ({}));
    return apiErr(data, res.status, isOutlook ? "Outlook" : "Google");
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
