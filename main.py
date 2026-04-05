import streamlit as st
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
import os
from datetime import datetime, timedelta
import pandas as pd
from zoneinfo import ZoneInfo
import json
from groq import Groq
import json



if "courses" not in st.session_state:
    st.session_state.courses = []

SCOPES = ['https://www.googleapis.com/auth/calendar']

# ---------- AUTH ----------

creds = None

 # 1️⃣ Agar Streamlit Cloud secrets me token hai
creds = None

if os.path.exists("token.json"):
    creds = Credentials.from_authorized_user_file("token.json", SCOPES)

else:
    flow = InstalledAppFlow.from_client_secrets_file(
        "credentials.json", SCOPES
    )
    creds = flow.run_local_server(port=0)

    with open("token.json", "w") as token:
        token.write(creds.to_json())

# ---------- GOOGLE CALENDAR SERVICE ----------

service = build("calendar", "v3", credentials=creds)
# ---------- INDIAN HOLIDAYS FUNCTION ----------

def get_indian_holidays():

    now = datetime.now().astimezone()
    future = now + timedelta(days=60)

    events_result = service.events().list(
        calendarId='en.indian#holiday@group.v.calendar.google.com',
        timeMin=now.isoformat(),
        timeMax=future.isoformat(),
        singleEvents=True,
        orderBy='startTime'
    ).execute()

    return events_result.get('items', [])
  # api key
api_key = os.getenv("GROQ_API_KEY")

if not api_key:
   # api_key = st.secrets["GROQ_API_KEY"]
    api_key = "GROQ_API_KEY"
client = Groq(api_key=api_key)


def ask_groq(prompt):

    response = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[
            {"role": "system", "content": "You are a calendar assistant. Return ONLY JSON."},
            {"role": "user", "content": prompt}
        ]
    )

    return response.choices[0].message.content

def parse_user_input(user_input):

    today = datetime.now().strftime("%Y-%m-%d")

    prompt = f"""
    Today date is {today}

    Convert the user input into STRICT JSON.

    Rules:
    - date MUST be in YYYY-MM-DD format
    - If user says "24 march", assume current year
    - Convert AM/PM to 24 hour format
    - Do NOT return anything except JSON
    - No explanation, no text

    Example:
    Input: "add meeting on 24 march at 9 am to 11 am"

    Output:
    {{
        "action": "create_event",
        "title": "meeting",
        "date": "2026-03-24",
        "start_time": "09:00",
        "end_time": "11:00"
    }}

    Now convert:

    "{user_input}"
    """

    return ask_groq(prompt)


# ==================================================
# FUNCTION → FIND FREE SLOT
# ==================================================

def suggest_free_slot(date, duration):

    start_day = datetime.combine(date, datetime.min.time()).astimezone()
    end_day = start_day + timedelta(days=1)

    events_result = service.events().list(
        calendarId='primary',
        timeMin=start_day.isoformat(),
        timeMax=end_day.isoformat(),
        singleEvents=True,
        orderBy='startTime'
    ).execute()

    events = events_result.get('items', [])

    suggestions = []
    last_end = start_day

    for event in events:

        start = datetime.fromisoformat(
            event['start'].get('dateTime', event['start'].get('date'))
        )

        end = datetime.fromisoformat(
            event['end'].get('dateTime', event['end'].get('date'))
        )

        gap = start - last_end

        if gap >= duration:
            suggestions.append((last_end, last_end + duration))

        last_end = max(last_end, end)

    gap = end_day - last_end

    if gap >= duration:
        suggestions.append((last_end, last_end + duration))

    return suggestions



st.header("🤖 AI Scheduler")

# chat history
if "messages" not in st.session_state:
    st.session_state.messages = []

for msg in st.session_state.messages:
    with st.chat_message(msg["role"]):
        st.write(msg["content"])

user_input = st.chat_input("Type your request...")

if user_input:

    # show user
    st.session_state.messages.append({
        "role": "user",
        "content": user_input
    })

    with st.chat_message("user"):
        st.write(user_input)

    # =========================
    # ✅ YES HANDLE
    # =========================
    if user_input.lower() in ["yes", "ok", "haan"]:

        slot = st.session_state.get("pending_slot")
        title = st.session_state.get("pending_title", "Event")

        if slot:
            start_dt, end_dt = slot

            event = {
                'summary': title,
                'start': {
                    'dateTime': start_dt.isoformat(),
                    'timeZone': 'Asia/Kolkata',
                },
                'end': {
                    'dateTime': end_dt.isoformat(),
                    'timeZone': 'Asia/Kolkata',
                },
            }

            service.events().insert(
                calendarId='primary',
                body=event
            ).execute()

            response = f"✅ Event '{title}' scheduled successfully!"

            st.session_state["pending_slot"] = None
            st.session_state["pending_title"] = None

        else:
            response = "❌ Koi pending slot nahi hai"

        st.session_state.messages.append({
            "role": "assistant",
            "content": response
        })

        with st.chat_message("assistant"):
            st.write(response)

        st.stop()

    # =========================
    # ❌ NO HANDLE
    # =========================
    if user_input.lower() in ["no", "nahi"]:

        st.session_state["pending_slot"] = None
        st.session_state["pending_title"] = None

        response = "👍 Theek hai, koi aur time try karo!"

        st.session_state.messages.append({
            "role": "assistant",
            "content": response
        })

        with st.chat_message("assistant"):
            st.write(response)

        st.stop()

    # =========================
    # 🤖 AI → JSON
    # =========================
    raw = parse_user_input(user_input)

    raw = raw.strip()
    if "```" in raw:
        raw = raw.split("```")[1]

    raw = raw.replace("json", "").replace("\n", "").strip()

    try:
        data = json.loads(raw)
    except:
        st.write("AI raw output:", raw)
        response = "❌ Samajh nahi aaya 😬"

    else:

        if data["action"] == "create_event":

            try:
                title = data["title"] if data["title"] else "Untitled Event"
                date = datetime.strptime(data["date"], "%Y-%m-%d").date()

                start_hour, start_min = map(int, data["start_time"].split(":"))
                end_hour, end_min = map(int, data["end_time"].split(":"))

                start_dt = datetime.combine(date, datetime.min.time()).replace(
                    hour=start_hour,
                    minute=start_min,
                    tzinfo=ZoneInfo("Asia/Kolkata")
                )

                end_dt = datetime.combine(date, datetime.min.time()).replace(
                    hour=end_hour,
                    minute=end_min,
                    tzinfo=ZoneInfo("Asia/Kolkata")
                )

                event = {
                    'summary': title,
                    'start': {
                        'dateTime': start_dt.isoformat(),
                        'timeZone': 'Asia/Kolkata',
                    },
                    'end': {
                        'dateTime': end_dt.isoformat(),
                        'timeZone': 'Asia/Kolkata',
                    },
                    'reminders': {
                        'useDefault': False,
                        'overrides': [
                            {'method': 'email', 'minutes': 30},
                            {'method': 'popup', 'minutes': 10},
                        ],
                    },
                }

                # =========================
                # ⚠️ CONFLICT CHECK
                # =========================
                events_result = service.events().list(
                    calendarId='primary',
                    timeMin=start_dt.isoformat(),
                    timeMax=end_dt.isoformat(),
                    singleEvents=True
                ).execute()

                events = events_result.get('items', [])

                if events:

                    response = "⚠️ Time conflict hai!\n\n"

                    suggestions = suggest_free_slot(date, end_dt - start_dt)

                    if suggestions:
                        st.session_state["pending_slot"] = suggestions[0]
                        st.session_state["pending_title"] = title

                        response += f"👉 {suggestions[0][0].strftime('%I:%M %p')} - {suggestions[0][1].strftime('%I:%M %p')}"
                        response += "\n\n❓ Isko schedule kar du? (yes/no)"
                    else:
                        response += "❌ No free slots available"

                else:
                    service.events().insert(
                        calendarId='primary',
                        body=event
                    ).execute()

                    response = f"✅ Event '{title}' created!"

            except Exception as e:
                response = f"❌ Error: {str(e)}"

        else:
            response = "❌ Unknown action"

    # =========================
    # 🤖 RESPONSE SHOW
    # =========================
    st.session_state.messages.append({
        "role": "assistant",
        "content": response
    })

    with st.chat_message("assistant"):
        st.write(response)


# ==================================================
# CLASS SCHEDULE STORAGE
# ==================================================

def load_schedule():

    if os.path.exists("schedule.json"):
        with open("schedule.json", "r") as f:
            return json.load(f)

    return []


def save_schedule(data):

    with open("schedule.json", "w") as f:
        json.dump(data, f, indent=4)


# ==================================================
# FUNCTION → GET EVENTS
# ==================================================

def get_events():
    now = datetime.now().astimezone().isoformat()

    result = service.events().list(
        calendarId='primary',
        timeMin=now,
        maxResults=20,
        singleEvents=True,
        orderBy='startTime'
    ).execute()

    return result.get('items', [])

# ==================================================
# TIME CONVERSION FUNCTION
# ==================================================

def convert_to_24(hour, minute, ampm):

    if ampm == "PM" and hour != 12:
        hour += 12

    if ampm == "AM" and hour == 12:
        hour = 0

    return hour, minute

# ==================================================
# CREATE EVENT
# ==================================================

st.header("➕ Create Event")

title = st.text_input("Event Title")
date = st.date_input("Select Date")

st.markdown("**Start Time**")

col1, col2, col3 = st.columns(3)

start_hour = col1.selectbox("Hour", list(range(1,13)), key="start_hour")
start_min = col2.selectbox("Minute", [f"{i:02}" for i in range(60)], key="start_min")
start_ampm = col3.selectbox("AM/PM", ["AM","PM"], key="start_ampm")

st.markdown("**End Time**")

col4, col5, col6 = st.columns(3)

end_hour = col4.selectbox("Hour", list(range(1,13)), key="end_hour")
end_min = col5.selectbox("Minute", [f"{i:02}" for i in range(60)], key="end_min")
end_ampm = col6.selectbox("AM/PM", ["AM","PM"], key="end_ampm")

if st.button("Add Event"):

    start_hour24, start_min = convert_to_24(start_hour, int(start_min), start_ampm)
    end_hour24, end_min = convert_to_24(end_hour, int(end_min), end_ampm)

    start_datetime = datetime.combine(
        date,
        datetime.min.time()
    ).replace(
        hour=start_hour24,
        minute=start_min,
        tzinfo=ZoneInfo("Asia/Kolkata")
    )

    end_datetime = datetime.combine(
        date,
        datetime.min.time()
    ).replace(
        hour=end_hour24,
        minute=end_min,
        tzinfo=ZoneInfo("Asia/Kolkata")
    )

    if not title:
        st.error("Enter event title")
        st.stop()

    elif end_datetime <= start_datetime:
        st.error("End time must be after start time")
        st.stop()

    # Check class schedule conflict
    schedule = load_schedule()

    event_day = date.strftime("%A")

    for c in schedule:

        if c["day"] == event_day:

            class_start = datetime.strptime(c["start"], "%H:%M").time()
            class_end = datetime.strptime(c["end"], "%H:%M").time()

            event_start = start_datetime.time()
            event_end = end_datetime.time()

            if event_start < class_end and event_end > class_start:

                st.error(f"❌ Conflict with class: {c['subject']}")
                st.stop()


    # Calendar conflict check
    events_result = service.events().list(
        calendarId='primary',
        timeMin=start_datetime.isoformat(),
        timeMax=end_datetime.isoformat(),
        singleEvents=True
    ).execute()

    events = events_result.get('items', [])

    if events:

        st.warning("⚠ Time conflict detected")

        required_duration = end_datetime - start_datetime
        suggestions = suggest_free_slot(date, required_duration)

        if suggestions:

            st.info("Suggested Free Slots:")

            for slot in suggestions[:3]:

                start = slot[0].strftime("%I:%M %p")
                end = slot[1].strftime("%I:%M %p")

                st.write(f"🟢 {start} - {end}")

    else:

        event = {
            'summary': title,
            'start': {
                'dateTime': start_datetime.isoformat(),
                'timeZone': 'Asia/Kolkata',
            },
            'end': {
                'dateTime': end_datetime.isoformat(),
                'timeZone': 'Asia/Kolkata',
            },
        }

        service.events().insert(
            calendarId='primary',
            body=event
        ).execute()

        st.success("✅ Event Created Successfully!")

        st.rerun()

# ==================================================
# CLASS SCHEDULE MANAGEMENT
# ==================================================

st.header("📚 Class Schedule Management")

schedule = load_schedule()

day = st.selectbox(
    "Day",
    ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]
)

subject = st.text_input("Subject")

colA, colB = st.columns(2)

class_start = colA.time_input("Class Start Time")
class_end = colB.time_input("Class End Time")

if st.button("Add Class"):

    new_class = {
        "day": day,
        "subject": subject,
        "start": class_start.strftime("%H:%M"),
        "end": class_end.strftime("%H:%M")
    }

    schedule.append(new_class)

    save_schedule(schedule)

    st.success("Class added successfully")

if schedule:

    st.subheader("Weekly Classes")

    class_data = []

    for c in schedule:

        class_data.append({
            "Day": c["day"],
            "Subject": c["subject"],
            "Start": c["start"],
            "End": c["end"]
        })

    st.table(pd.DataFrame(class_data))


# ==================================================
# SHOW EVENTS
# ==================================================

st.header("📋 Upcoming Events")

events = get_events()

if not events:
    st.write("No events found")

else:

    data = []

    for event in events:

        start = datetime.fromisoformat(event['start']['dateTime'])
        end = datetime.fromisoformat(event['end']['dateTime'])

        data.append({
            "Event": event['summary'],
            "Date": start.strftime("%d %b %Y"),
            "Start": start.strftime("%I:%M %p"),
            "End": end.strftime("%I:%M %p"),
            "ID": event['id']
        })

    df = pd.DataFrame(data)

    st.table(df[["Event", "Date", "Start", "End"]])

    st.subheader("❌ Delete Event")

    event_to_delete = st.selectbox(
        "Select event",
        df["Event"],
        key="delete_event"
    )

    if st.button("Delete Event"):

        event_id = df[df["Event"] == event_to_delete]["ID"].values[0]

        service.events().delete(
            calendarId='primary',
            eventId=event_id
        ).execute()

        st.success("Event deleted")

        st.rerun()

# ===============================
# 🎓 WEEK 5-6 FEATURES
# ===============================
# 📌 1. Semester/term  Template
st.header("🎓 Semester / Term Templates")

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
    ]
}

selected_sem = st.selectbox("Select Semester", list(semester_templates.keys()))

if st.button("Load Template"):
    st.session_state.courses = semester_templates[selected_sem].copy()
    st.success("Template Loaded ✅")

# load template
    st.subheader("📅 Weekly Timetable")

if st.session_state.courses:

    df = pd.DataFrame(st.session_state.courses)

    order = {
        "Monday":1,"Tuesday":2,"Wednesday":3,
        "Thursday":4,"Friday":5,"Saturday":6
    }

    df["order"] = df["day"].map(order)

    df = df.sort_values(by=["order","start"]).drop(columns=["order"])

    st.dataframe(df, use_container_width=True)

else:
    st.warning("⚠ No courses to display")



    # ✅ 2. 📚 Course Scheduling (Lecture / Lab / Tutorial)
    st.header("📚 Course Scheduling")

subject = st.text_input("Subject Name")
course_type = st.selectbox("Type", ["Lecture", "Lab", "Tutorial"])
day = st.selectbox("Day", ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"])

col1, col2 = st.columns(2)
start_time = col1.time_input("Start Time")
end_time = col2.time_input("End Time")

if st.button("Add Course"):
    if subject and end_time > start_time:
        st.session_state.courses.append({
            "subject": subject,
            "type": course_type,
            "day": day,
            "start": start_time.strftime("%H:%M"),
            "end": end_time.strftime("%H:%M")
        })
        st.success("Course Added ✅")
    else:
        st.error("Invalid Input")


    # display course Timetable  
    st.subheader("📅 Weekly Timetable")

if "courses" in st.session_state and st.session_state.courses:

    df = pd.DataFrame(st.session_state.courses)

    # Day order fix
    order = {
        "Monday":1,"Tuesday":2,"Wednesday":3,
        "Thursday":4,"Friday":5,"Saturday":6
    }

    df["order"] = df["day"].map(order)

    df = df.sort_values(by=["order","start"]).drop(columns=["order"])

    st.dataframe(df, use_container_width=True)

else:
    st.warning("⚠ No courses added")    

    # ✅ 4. 📝 Exam Schedule + Study Plan
    st.header("📝 Exam Planner")

exam_name = st.text_input("Exam Name")
exam_date = st.date_input("Exam Date")

if st.button("Generate Study Plan"):
    if exam_name:
        st.subheader("📚 Study Plan (7 Days Before Exam)")

        for i in range(7, 0, -1):
            day = exam_date - timedelta(days=i)
            st.write(f"📅 {day} → Study {exam_name} (Day {8-i})")
    else:
        st.error("Enter exam name")


  # ✅ 5. 📌 Assignment Tracker (with Priority + Save)
 #   st.header("📌 Assignment Tracker") 

FILE = "assignments.json"

def load_data():
    if os.path.exists(FILE):
        with open(FILE, "r") as f:
            return json.load(f)
    return []

def save_data(data):
    with open(FILE, "w") as f:
        json.dump(data, f, indent=4)

assignments = load_data()

name = st.text_input("Assignment Name")
deadline = st.date_input("Deadline")
priority = st.selectbox("Priority", ["High","Medium","Low"])

if st.button("Add Assignment"):
    assignments.append({
        "name": name,
        "deadline": str(deadline),
        "priority": priority
    })
    save_data(assignments)
    st.success("Added ✅")

for i, a in enumerate(assignments):
    st.write(f"{a['name']} | {a['deadline']} | {a['priority']}")

    if st.button("Delete", key=f"del{i}"):
        assignments.pop(i)
        save_data(assignments)
        st.rerun()

        #✅ 6.  Indian Academic Calendar (Festivals + Breaks)
       # st.header("🇮🇳 Academic Calendar (India)")

#calendar_data = [
   # {"event": "Diwali Break", "date": "2026-11-01"},
   # {"event": "Holi Holiday", "date": "2026-03-14"},
    #{"event": "Independence Day", "date": "2026-08-15"},
    #{"event": "Winter Break", "date": "2026-12-20"}
#]

#for c in calendar_data:
    #st.write(f"🎉 {c['event']} → {c['date']}")
    st.header(" Indian Holidays")

holidays = get_indian_holidays()

for h in holidays:
    st.write(f"{h['summary']} → {h['start'].get('date')}")