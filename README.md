# Smart-Timetable-AI
Smart Timetable assistant AI
# 📅 Smart Timetable AI Agent

A Streamlit-based AI assistant that integrates with Google Calendar to create and manage timetable events.

---

## 🚀 Week 1 Completion

✔ Google Calendar API Integrated  
✔ OAuth Authentication Implemented  
✔ Streamlit UI Developed  
✔ Event Creation Working  
✔ Upcoming Events Display Working  
✔ Time Validation Added  
✔ Secure Repository (No Secret Files Uploaded)

---

## 🛠️ Tech Stack

- Python  
- Streamlit  
- Google Calendar API  
- OAuth 2.0  

---

## 📂 Project Structure

Smart-Timetable-AI/
│
├── main.py    
├── .gitignore  
└── README.md  

---

## 🔐 Security Information

The following files are NOT included in this repository:

- credentials.json  
- token.json  

Reason:
These files contain sensitive Google OAuth credentials and tokens.
Uploading them to GitHub can expose security risks.
They are excluded using `.gitignore`.

Each user must generate their own credentials to run the project.

---

## ⚙️ Complete Setup Guide

### 1️⃣ Clone the Repository

git clone https://github.com/Vrutipatel-engineer/Smart-Timetable-AI.git  
cd Smart-Timetable-AI  

---

### 2️⃣ Install Required Packages

pip install -r requirements.txt  

If requirements.txt is not available:

pip install streamlit google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client  

---

### 3️⃣ Google Cloud Setup

1. Open Google Cloud Console  
2. Create a New Project  
3. Enable Google Calendar API  
4. Configure OAuth Consent Screen  
5. Create OAuth Client ID (Desktop App)  
6. Download credentials.json  
7. Place credentials.json inside project root folder  

---

### 4️⃣ Run the Application

streamlit run main.py  

- First time login will open browser for Google authentication  
- After login, token.json will be generated locally  
- token.json is not uploaded to GitHub  

---

## 📌 Current Features

- Create Google Calendar Events  
- Validate Event Time  
- View Upcoming Events  
- Secure OAuth Login  

---

## 🎯 Future Improvements

- Smart Conflict Detection  
- AI-based Slot Suggestions  
- Timetable Optimization  
- Cloud Deployment  

---

## 👩‍💻 Project Status

Smart Timetable AI Agent – Week 1 Completed Successfully
