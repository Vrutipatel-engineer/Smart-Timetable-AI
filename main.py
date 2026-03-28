import streamlit as st
import os
from datetime import datetime, timedelta
import pandas as pd
import json

# ---------------- STORAGE ----------------
FILE = "events.json"

def load_events():
    if os.path.exists(FILE):
        with open(FILE, "r") as f:
            return json.load(f)
    return []

def save_events(data):
    with open(FILE, "w") as f:
        json.dump(data, f, indent=4)

# ---------------- SIMPLE PARSER (NO AI) ----------------
def parse_input(user_input):
    try:
        words = user_input.lower().split()

        title = words[0] if words else "event"
        date = datetime.now().strftime("%Y-%m-%d")

        start = "10:00"
        end = "11:00"

        for i, w in enumerate(words):
            if w.isdigit() and i+2 < len(words):
                start = f"{int(w):02}:00"
                end = f"{int(words[i+2]):02}:00"
                break

        return {
            "title": title,
            "date": date,
            "start": start,
            "end": end
        }

    except:
        return None

# ---------------- CONFLICT CHECK ----------------
def check_conflict(events, new_start, new_end):
    for e in events:
        e_start = datetime.fromisoformat(e["start"])
        e_end = datetime.fromisoformat(e["end"])

        if new_start < e_end and new_end > e_start:
            return True
    return False

def suggest_time(events, duration):
    now = datetime.now().replace(hour=9, minute=0)

    for i in range(8):
        start = now + timedelta(hours=i)
        end = start + duration

        if not check_conflict(events, start, end):
            return start, end

    return None, None

# ---------------- UI ----------------
st.title("🤖 Smart Scheduler (No AI Mode)")

events = load_events()

# ---------------- CHAT ----------------
st.subheader("💬 Quick Add (Type like: meeting 10 to 11)")

user_input = st.text_input("Enter request")

if st.button("Add via Text"):

    data = parse_input(user_input)

    if not data:
        st.error("❌ Could not understand input")

    else:
        title = data["title"]
        date = data["date"]

        start_dt = datetime.fromisoformat(f"{date}T{data['start']}")
        end_dt = datetime.fromisoformat(f"{date}T{data['end']}")

        if check_conflict(events, start_dt, end_dt):
            st.warning("⚠ Time conflict!")

            new_start, new_end = suggest_time(events, end_dt - start_dt)

            if new_start:
                st.info(f"👉 Try: {new_start.strftime('%I:%M %p')} - {new_end.strftime('%I:%M %p')}")
            else:
                st.error("No free slot found")

        else:
            events.append({
                "title": title,
                "start": start_dt.isoformat(),
                "end": end_dt.isoformat()
            })

            save_events(events)
            st.success(f"✅ Event '{title}' added!")

# ---------------- MANUAL ADD ----------------
st.subheader("➕ Add Event Manually")

title = st.text_input("Title", key="manual_title")
date = st.date_input("Date")

start = st.time_input("Start Time")
end = st.time_input("End Time")

if st.button("Add Event"):

    start_dt = datetime.combine(date, start)
    end_dt = datetime.combine(date, end)

    if not title:
        st.error("Enter title")

    elif end_dt <= start_dt:
        st.error("End must be after start")

    elif check_conflict(events, start_dt, end_dt):
        st.warning("⚠ Conflict detected")

    else:
        events.append({
            "title": title,
            "start": start_dt.isoformat(),
            "end": end_dt.isoformat()
        })
        save_events(events)
        st.success("Event added")

# ---------------- SHOW EVENTS ----------------
st.subheader("📋 Your Events")

if events:
    df = pd.DataFrame(events)
    df["start"] = pd.to_datetime(df["start"]).dt.strftime("%d %b %I:%M %p")
    df["end"] = pd.to_datetime(df["end"]).dt.strftime("%d %b %I:%M %p")

    st.table(df)

    # DELETE
    st.subheader("❌ Delete Event")
    names = [e["title"] for e in events]

    selected = st.selectbox("Select Event", names)

    if st.button("Delete"):
        events = [e for e in events if e["title"] != selected]
        save_events(events)
        st.success("Deleted")
        st.rerun()

else:
    st.info("No events yet")
    # ==================================================
# 📌 ASSIGNMENT DEADLINE TRACKER
# ==================================================

from datetime import date

st.header("📌 Assignment Deadline Tracker")

# Initialize session state
if "assignments" not in st.session_state:
    st.session_state.assignments = []

# ---------------- ADD ASSIGNMENT ----------------
st.subheader("➕ Add Assignment")

name = st.text_input("Assignment Name", key="assign_name")
deadline = st.date_input("Select Deadline", key="assign_deadline")
priority = st.selectbox("Priority", ["High", "Medium", "Low"], key="assign_priority")

if st.button("Add Assignment"):
    if name:
        st.session_state.assignments.append({
            "name": name,
            "deadline": deadline,
            "priority": priority
        })
        st.success("Assignment Added ✅")
    else:
        st.error("Enter assignment name")

# ---------------- SHOW ASSIGNMENTS ----------------
st.subheader("📋 Your Assignments")

today = date.today()

if st.session_state.assignments:

    for i, task in enumerate(st.session_state.assignments):

        days_left = (task["deadline"] - today).days

        if days_left < 0:
            status = "❌ Overdue"
        elif days_left == 0:
            status = "⚠ Due Today"
        else:
            status = f"⏳ {days_left} days left"

        col1, col2 = st.columns([4,1])

        with col1:
            st.write(f"**{task['name']}** | {task['priority']} | {status}")

        with col2:
            if st.button("❌ Delete", key=f"del_{i}"):
                st.session_state.assignments.pop(i)
                st.rerun()

else:
    st.info("No assignments yet")

# ---------------- CLEAR ALL ----------------
if st.button("🗑 Clear All Assignments"):
    st.session_state.assignments = []
    st.success("All assignments cleared ✅")


   

# ==================================================
# 🎓 SEMESTER / TERM TEMPLATE
# ==================================================

st.header("🎓 Semester / Term Schedule")

# initialize FIRST (important)
if "courses" not in st.session_state:
    st.session_state.courses = []

semester_templates = {
    "Semester 1": [
        {"subject": "Maths", "type": "Lecture", "day": "Monday", "start": "10:00", "end": "11:00"},
        {"subject": "Physics", "type": "Lecture", "day": "Tuesday", "start": "11:00", "end": "12:00"},
        {"subject": "Chemistry Lab", "type": "Lab", "day": "Wednesday", "start": "13:00", "end": "15:00"},
    ],
    "Semester 2": [
        {"subject": "DBMS", "type": "Lecture", "day": "Monday", "start": "09:00", "end": "10:00"},
        {"subject": "Java", "type": "Lecture", "day": "Tuesday", "start": "10:00", "end": "11:00"},
        {"subject": "OS Lab", "type": "Lab", "day": "Friday", "start": "14:00", "end": "16:00"},
    ],
    "Term 1": [
        {"subject": "English", "type": "Lecture", "day": "Monday", "start": "09:00", "end": "10:00"},
        {"subject": "Economics", "type": "Lecture", "day": "Wednesday", "start": "11:00", "end": "12:00"},
    ]
}

selected_sem = st.selectbox(
    "Select Semester/Term",
    list(semester_templates.keys()),
    key="sem_select"
)

if st.button("Load Template", key="load_template_btn"):

    st.session_state.courses = semester_templates[selected_sem].copy()

    st.success(f"{selected_sem} loaded successfully ✅")


# ==================================================
# 📚 COURSE SCHEDULING + DISPLAY
# ==================================================

st.header("📚 Course Schedule")

# ---------------- ADD COURSE ----------------
st.subheader("➕ Add Course")

subject = st.text_input("Subject Name", key="course_subject")

course_type = st.selectbox(
    "Type",
    ["Lecture", "Lab", "Tutorial"],
    key="course_type"
)

day = st.selectbox(
    "Day",
    ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    key="course_day"
)

col1, col2 = st.columns(2)

start_time = col1.time_input("Start Time", key="course_start")
end_time = col2.time_input("End Time", key="course_end")

if st.button("Add Course", key="add_course_btn"):

    if subject and end_time > start_time:

        st.session_state.courses.append({
            "subject": subject,
            "type": course_type,
            "day": day,
            "start": start_time.strftime("%H:%M"),
            "end": end_time.strftime("%H:%M")
        })

        st.success("Course added ✅")

    else:
        st.error("Invalid input")


# ---------------- SHOW TIMETABLE ----------------
st.subheader("📅 Weekly Timetable")

if st.session_state.courses:

    df = pd.DataFrame(st.session_state.courses)

    day_order = {
        "Monday": 1, "Tuesday": 2, "Wednesday": 3,
        "Thursday": 4, "Friday": 5, "Saturday": 6
    }

    df["order"] = df["day"].map(day_order)

    df = df.sort_values(by=["order", "start"]).drop(columns=["order"])

    st.dataframe(df, use_container_width=True)

else:
    st.warning("⚠ No courses to display")