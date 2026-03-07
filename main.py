import streamlit as st
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
import os
from datetime import datetime, timedelta
import pandas as pd
from zoneinfo import ZoneInfo
import json


SCOPES = ['https://www.googleapis.com/auth/calendar']

# ---------- AUTH ----------

creds = None

# 1️⃣ Agar Streamlit Cloud secrets me token hai
if "google_token" in st.secrets:

    creds = Credentials(
        token=st.secrets["google_token"]["token"],
        refresh_token=st.secrets["google_token"]["refresh_token"],
        token_uri=st.secrets["google_token"]["token_uri"],
        client_id=st.secrets["google_token"]["client_id"],
        client_secret=st.secrets["google_token"]["client_secret"],
        scopes=SCOPES,
    )

# 2️⃣ Agar local machine me token.json hai
elif os.path.exists("token.json"):

    creds = Credentials.from_authorized_user_file("token.json", SCOPES)

# 3️⃣ Agar login first time ho raha hai
else:

    flow = InstalledAppFlow.from_client_config(
        st.secrets["credentials"], SCOPES
    )

    creds = flow.run_local_server(port=0)

    with open("token.json", "w") as token:
        token.write(creds.to_json())


# ---------- GOOGLE CALENDAR SERVICE ----------

service = build("calendar", "v3", credentials=creds)


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