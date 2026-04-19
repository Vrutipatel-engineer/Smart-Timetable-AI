# 🎓 Smart Timetable & Study Planner

An AI-powered academic scheduling system built with **Next.js** that intelligently manages class timetables, exam preparation, assignment tracking, and study sessions with external calendar API integration.

---

## ✨ Features

### 📚 Class Schedule Management
- Add, edit, and delete weekly class entries
- Import timetables from **CSV**, **Excel (.xlsx)**, or **XML**
- Import from **photos** using OCR (Tesseract.js)
- Overlap detection and time validation
- Grid and list view options

### 📘 Smart Exam Study Planner
- Add exams with subject, date, and difficulty
- **AI auto-generates** optimized study sessions
- Crash Plan Mode for urgent exams (≤1 day)
- Adaptive AI adjusts load based on completion rate
- Difficulty-aware session splitting with breaks

### 📝 Assignment Tracker
- Track assignments with deadlines, priority, and progress
- Auto-generated study sessions for assignment prep
- **Deadline highlighting** — urgent deadlines pulse red
- Deadline notifications (today, tomorrow, 2 days)

### ⏰ Intelligent Rescheduling
- Mark sessions as **Done**, **Reschedule**, or **Skip**
- Rescheduling generates **3–5 alternative time slots**
- Slots scored: ⭐ Best / 👍 Good / ✓ OK
- User picks preferred slot from modal
- Conflict-free — checks all existing sessions

### 🔗 External API Integration (3 APIs)
| API | Purpose | Error Handling |
|-----|---------|---------------|
| Google Calendar | Sync study sessions | try-catch + localStorage fallback |
| Microsoft Outlook | Sync events | try-catch + localStorage fallback |
| Notion | Track tasks/sessions | try-catch + localStorage fallback |

- Connect/disconnect from **🔗 APIs** tab
- Auto-syncs on create, complete, skip, reschedule
- Mock mode for demo (no real API keys needed)

### 📈 Analytics Dashboard
- Completion rate tracking with percentage badges
- Subject-wise time distribution
- Weekly study plan visualization
- Predictive recommendations (neglected subjects, urgency)
- Adaptive AI status display

### 📊 Subject Tracking
- Track study time per subject
- Visual progress bars
- Manual study logging

### 📅 Export
- **Export .ics** — import into any calendar app
- **Export JSON** — full report with stats, sessions, analytics

### 🔒 Security
- API tokens loaded from environment variables
- Input validation and sanitization on all forms
- Token validation before API requests
- Request timeout protection (10s)

### ⚡ Performance
- API sync dedup cache (30s window)
- Parallel API calls via `Promise.allSettled`
- Failed syncs stored in localStorage for retry
- Max 100-entry cache with auto-pruning

---

## 🚀 Setup

### Prerequisites
- Node.js 18+
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/smart-scheduler.git
cd smart-scheduler

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local

# Start development server
npm run dev
```

### Environment Variables

Copy `.env.example` to `.env.local` and fill in your API keys:

```env
NEXT_PUBLIC_GOOGLE_CALENDAR_URL=https://www.googleapis.com/calendar/v3
NEXT_PUBLIC_OUTLOOK_URL=https://graph.microsoft.com/v1.0/me
NEXT_PUBLIC_NOTION_URL=https://api.notion.com/v1
```

> **Note:** The app works fully without real API keys — it uses mock mode with localStorage fallback.

---

## 📖 User Guide

### Adding Classes
1. Go to **📚 Classes** tab
2. Click **+ Add Class**
3. Enter subject, day, start time, end time
4. System validates for overlaps automatically
5. Or use **📄 Import CSV/Excel** or **📸 Import from Image**

### Managing Exams
1. Go to **📘 Exams** tab (via **⏱ Study** tab)
2. Click **+ Add Exam** → enter subject, date, difficulty
3. AI auto-generates study plan with breaks
4. Study sessions appear below with action buttons

### Using Reschedule
1. On any study session, click **⏰ Resched**
2. A modal shows 3–5 alternative time slots
3. Each option shows date, time, duration, and score
4. Click your preferred slot → session moves instantly

### Tracking Assignments
1. Go to **📝 Assignments** tab
2. Click **+ Add Assignment** → fill title, subject, deadline, priority
3. Adjust progress with the slider
4. Urgent deadlines auto-highlight in red

### Connecting APIs
1. Go to **🔗 APIs** tab
2. Click **✓ Connect** on any service
3. Sessions auto-sync when you create/complete/skip
4. Click **✕ Disconnect** to stop syncing

### Exporting Data
1. On Exams or Assignments tab, click **📅 Export .ics**
2. Import the file into Google Calendar, Apple Calendar, Outlook
3. Click **📊 Export JSON** for a full report

---

## 🏗️ Tech Stack

| Technology | Purpose |
|-----------|---------|
| Next.js 14 | React framework |
| React 18 | UI components |
| Tesseract.js | OCR for image import |
| xlsx | Excel file parsing |
| localStorage | Offline data persistence |
| Google Calendar API | External sync |
| Microsoft Graph API | Outlook sync |
| Notion API | Task tracking sync |

---

## 📁 Project Structure

```
smart-scheduler/
├── app/
│   ├── page.js          # Main calendar & dashboard
│   ├── academic.js      # Academic module (classes, exams, study)
│   ├── globals.css       # Global styles
│   └── layout.js        # App layout
├── .env.example          # Environment variable template
├── package.json          # Dependencies
└── README.md            # This file
```

---

## 📸 Screenshots

> Add screenshots of:
> 1. Class Schedule (grid view)
> 2. Smart Study Plan with sessions
> 3. Reschedule Modal (3–5 options)
> 4. Analytics Dashboard
> 5. API Connections panel
> 6. Export buttons

---

## 📄 License

MIT License — free to use and modify.
