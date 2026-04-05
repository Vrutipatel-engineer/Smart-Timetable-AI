# 📅 Smart Timetable AI Agent

An AI-powered smart scheduling assistant built using Streamlit and Google Calendar API.

---

## 🚀 Features

✔ Create Google Calendar Events (Manual + AI)
✔ View Upcoming Events
✔ Delete Events
✔ Conflict Detection
✔ Free Slot Suggestions
✔ Confirmation System (Yes/No)
✔ Email & Popup Reminders
✔ Class Schedule Management
✔ Assignment Deadline Tracker
✔ Course Scheduling
✔ Semester/Term Schedule
✔ Exam Planner
✔ Indian holidays

---

## 🛠️ Tech Stack

* Python
* Streamlit
* Google Calendar API
* OAuth 2.0
* Groq API

---

## 📂 Project Structure

Smart-Timetable-AI/
│
├── .devcontainer/
├── .streamlit/
├── .gitignore
├── main.py
├── README.md
├── requirements.txt\

---

## 🔐 Security Information

The following files contain sensitive data and should NOT be shared publicly:

* credentials.json
* token.json
* .env
* secret.toml

Make sure these files are added to `.gitignore` before pushing to GitHub.

---

## ⚙️ Setup Guide

### 1️⃣ Clone the Repository

git clone https://github.com/Vrutipatel-engineer/Smart-Timetable-AI.git
cd Smart-Timetable-AI

---

### 2️⃣ Install Dependencies

pip install -r requirements.txt

---

### 3️⃣ Setup Environment Variable

Create a `.env` file:

GROQ_API_KEY=your_api_key_here

---

### 4️⃣ Google Cloud Setup

1. Enable Google Calendar API
2. Create OAuth credentials
3. Download `credentials.json`
4. Place it in project root

---

### 5️⃣ Run the App

streamlit run main.py