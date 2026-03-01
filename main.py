import streamlit as st
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
import os
from datetime import datetime, timezone

SCOPES = ['https://www.googleapis.com/auth/calendar']

# ---------- AUTH ----------
creds = None

if os.path.exists('token.json'):
    creds = Credentials.from_authorized_user_file('token.json', SCOPES)

if not creds or not creds.valid:
    flow = InstalledAppFlow.from_client_secrets_file(
        'credentials.json', SCOPES)
    creds = flow.run_local_server(port=0)

    with open('token.json', 'w') as token:
        token.write(creds.to_json())

service = build('calendar', 'v3', credentials=creds)

# ---------- UI ----------
st.title("📅 Smart Timetable AI Agent")

# =========================
# CREATE EVENT SECTION
# =========================
st.header("➕ Create Event")

title = st.text_input("Event Title")
date = st.date_input("Select Date")
start_time = st.time_input("Start Time")
end_time = st.time_input("End Time")

if st.button("Add Event"):

    if not title:
        st.error("Please enter event title")

    elif end_time <= start_time:
        st.error("End time must be greater than Start time")

    else:
        start_datetime = datetime.combine(date, start_time).isoformat()
        end_datetime = datetime.combine(date, end_time).isoformat()

        event = {
            'summary': title,
            'start': {
                'dateTime': start_datetime,
                'timeZone': 'Asia/Kolkata',
            },
            'end': {
                'dateTime': end_datetime,
                'timeZone': 'Asia/Kolkata',
            },
        }

        try:
            event = service.events().insert(
                calendarId='primary',
                body=event
            ).execute()

            st.success("✅ Event Created Successfully!")
            st.write("Event Link:", event.get('htmlLink'))

        except Exception as e:
            st.error("❌ Error creating event")
            st.write(e)

# =========================
# VIEW EVENTS SECTION
# =========================
st.header("📋 Upcoming Events")

if st.button("Show Events"):

    try:
        now = datetime.utcnow().isoformat() + "Z"

        result = service.events().list(
            calendarId='primary',
            timeMin=now,
            maxResults=10,
            singleEvents=True,
            orderBy='startTime'
        ).execute()

        events = result.get('items', [])

        if not events:
            st.write("No upcoming events found.")
        else:
            for event in events:
                start = event['start'].get('dateTime', event['start'].get('date'))
                st.write(f"📌 {start} - {event['summary']}")

    except Exception as e:
        st.error("❌ Error fetching events")
        st.write(e)