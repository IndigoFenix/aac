# Aivota AI — Complete Feature Overview

## CliniAACian/Caretaker Portal

### AI Chat Assistant
- Conversational AI with full platform context
- Voice input/output with customizable TTS
- Manage all data through a manual interface or through the AI

### RAG-based Medical Data Library
- AI has access to a massive information base with details relating to a wide variety of medical conditions, clinical practices, and FDA-approved medications to provide expert advice

### Student Files
- Upload PDF files to automatically extract and store student information
- AI has access to all student data and can use it to develop insights during conversations
- Includes:
- - Medical records (diagnoses, medications, health alerts, equipment)
- - Functional reports (mobility, ADL, sensory profile, safety)
- - Educational reports (communication modes, assistive tech, behavioral strategies)
- Draft/review/finalized workflow with version history
- Print-ready output

### Student Management
- Create and manage student profiles with demographics, diagnosis, and background
- Search and filter by name, ID, school, or status
- Multi-institute assignment
- Active/completed status tracking

### Event Calendar
- Schedule events, meetings, repeating appointments, and classes
- Full integration with the AAC

### AAC Board Builder
- AI-powered board generation from natural language descriptions
- Visual drag-and-drop editor
- Multi-page boards with navigation
- Button customization (labels, symbols, colors, actions)
- AI-generated custom symbols with approval workflow
- Boards can be given context hints describing what situations they should be used in (in class, while eating, at home, etc.). When the student uses the AAC, it will examine its surroundings, check calendar events, and automatically call up these boards when appropriate.
- Boards can also be exported to Grid3 (.gridset) format

### Progress Tracking (IEP / TALA)
- Full IEP (US) and TALA (Israel) program management
- Annual goals with baselines, targets, and success criteria
- Short-term objectives with measurement methods
- Data collection with trend visualization
- Related services tracking (speech, OT, PT, etc.)
- Team management with roles and contact info
- Meeting scheduling and consent form management

### Billing
- Credit-based system with tiered packages

### Platform-Wide
- Role-based access (admin, clinician, caregiver, family)
- Invite-based onboarding with codes
- 11+ languages with full RTL support
- Dark/light themes
- Accessibility statement, privacy policy, terms of service, AI policy pages
- Full HIPAA-compliance with a variety of privacy and data access options

### Premium Feature - Video Analysis
- Upload videos of student to analyze behavior
- Creates a timeline of relevant events and marks areas and objects that the student is focusing on

### Premium Feature - Deep Analysis Mode
- Performs a deep analysis of all data concerning a student and looks for patterns that might have been missed
- Produces a detailed report on insights, student progress and suggests next steps

## AAC Client (Student-Facing)

### Core Communication
- AI-powered dynamic communication boards that adapt in real-time based on context
- Multiple input methods: touch, eye gaze (with configurable dwell selection), cursor, voice, and body gestures
- Context aware switching between "Interactive Mode" and "Assist Mode"
- - Interactive Mode: The AI interacts directly with the student, actively asking questions and guiding progress towards goals
- - Assist Mode: The AI manages the board quietly as the student interacts with others, only speaking when necessary
- Manually-activated "Silent Mode" forces the AI to remain silent
- Quick-access buttons for Yes/No/More/Home/Back
- Pre-built board support alongside AI-generated boards

### Gesture & Body Language Detection
- Facial expression recognition (smile, frown, attention/focus)
- Head gesture detection (nods, shakes, turns)
- Hand gesture recognition (wave, point, raise, pinch)
- Sign language interpretation via camera
- Object detection — identifies items the student is focusing on and adds them to the board
- Multi-person detection — recognizes caregivers and clinicians in frame

### Eye Tracking Support
- Compatible with Tobii, EyeTech, LC Technologies, Gazepoint, WebHID, and browser-based trackers
- Passive fixation-based calibration (no tapping required)
- Configurable dwell timeout for selection sensitivity

### Passive Co-Listening
- Monitors ambient speech from caregivers
- Detects choice offers and yes/no questions directed at the student
- Automatically surfaces relevant response buttons

### Voice & Audio
- Multiple TTS engines: ElevenLabs, Google, browser-based, and Gemini real-time voices
- Separate configurable voices for student output and AI responses
- Adjustable pitch, speed, and volume
- Voice input for sending audio messages to the AI

### Built-In Apps (Togglable and tunable from CliniAACian)
- Drawing canvas (supports eye-gaze drawing)
- Music Maker (virtual piano with color-coded keys)
- YouTube player with large, accessible playback controls (in development)
- Spotify music player with AI-powered song suggestions (in development)
- Farming sim game designed with insight from expert researchers to train cognitive abilities and monitor progress (in development)
- Questions game integrated with school curriculum (in development)

### Accessibility
- 5 levels of icon-to-text ratio adjustment
- Parts-of-speech color coding
- Dark/light themes
- 12 languages including RTL support (Hebrew, Arabic)
- Designed specifically for Rett Syndrome — passive input, low-effort interaction, fixation-based activation

### Visual Feedback
- Animated avatar with emotional states (happy, sad, neutral, sleeping), responds to student attention
- Face mirror display showing the student's detected expressions and hand positions
- Connection, recording, and processing status indicators
