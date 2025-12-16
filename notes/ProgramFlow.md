# IEP/TALA Program Management - Frontend Flow Documentation

## Overview

The new StudentProgressPanel provides a comprehensive interface for managing IEP (US) and TALA (Israel) programs. Both frameworks share the same underlying structure and UI, with terminology differences handled through translations.

## User Flow States

### State 1: No Program Exists
When a student has no active program, the user sees:
- A welcome card with framework selection (TALA/IEP)
- Program year input
- "Create Program" button
- Optional: List of previous archived programs

**Action:** Creating a program automatically generates the 6 default profile domains.

### State 2: Draft Program
New programs start in "draft" status:
- All tabs are available for editing
- Clear "Draft" badge shown
- "Activate Program" button in header
- Cannot record data points until activated

**Purpose:** Allow complete setup before the program goes live.

### State 3: Active Program
Once activated:
- Full functionality enabled
- Data point recording available
- Progress reports can be created
- "Archive" option available in menu

### State 4: Archived Program
When a program year ends:
- Read-only view of all data
- Historical reference
- User can create a new program for the next year

## Tab Structure

### 1. Overview Tab
**Purpose:** Dashboard view of program status

**Contents:**
- 4 stat cards: Active Goals, Goals Achieved, Weekly Service Minutes, Team Members
- Progress bar showing overall goal completion
- Goals by domain breakdown
- Timeline with due date and approval date

### 2. Profile Tab
**Purpose:** Functional profile / PLAAFP documentation

**Contents:**
- 6 collapsible domain cards:
  - Cognitive & Academic
  - Communication & Language
  - Social, Emotional & Behavioral
  - Motor & Sensory
  - Life Skills & Transition Preparation
  - Other

**Per Domain Fields:**
- Present Levels of Performance
- Strengths
- Needs
- Educational Impact
- Parent Input

**Auto-save:** Changes are saved automatically on blur.

### 3. Goals Tab
**Purpose:** Annual goals and short-term objectives

**Features:**
- Collapsible goal cards showing:
  - Goal number and title
  - Linked domain badge
  - Status badge
  - Description
  - Baseline and target levels
  - Progress bar
- Actions per goal:
  - Edit
  - Delete
  - Add Objective
  - Record Data Point

**Goal Form Fields:**
- Title (required)
- Profile Domain (dropdown)
- Description
- Baseline Level
- Target Level
- Target Date

### 4. Services Tab
**Purpose:** Related services and accommodations

**Service Card Shows:**
- Service type icon
- Service name
- Type label
- Duration and frequency
- Setting
- Provider name

**Service Form Fields:**
- Service Type (dropdown)
- Service Name (required)
- Frequency (number)
- Period (daily/weekly/monthly)
- Duration in minutes
- Setting
- Provider

**Accommodations Section:**
- Listed below services
- Shows type and description
- Required indicator

### 5. Progress Tab
**Purpose:** Data collection and progress monitoring

**Quick Data Entry:**
- Shows active goals with "Add Data" button
- One-click recording

**Data Point Form:**
- Numeric value
- Text value
- Session notes

**Progress Reports Section:**
- List of periodic reports
- Create new report button
- Shared with parents indicator

### 6. Team Tab
**Purpose:** Team members, meetings, and compliance

**Team Members:**
- Grid of member cards
- Name, role, contact info
- Coordinator badge
- Add/remove members

**Team Member Form:**
- Name (required)
- Role (dropdown with 13 options)
- Email
- Phone
- Is Coordinator checkbox

**Meetings Section:**
- List of scheduled/completed meetings
- Meeting type, date, location
- Schedule meeting button

**Consent Forms Section:**
- List of required consents
- Signed/pending status
- Sign date

## Access Control

Based on user-student link role:
- **owner**: Full CRUD on everything
- **caregiver**: View all, edit goals/data points
- **observer**: Read-only

## Framework Differences

### TALA (Israel)
- Hebrew terminology
- Israeli compliance requirements
- Framework enum: `tala`

### US IEP
- English terminology
- IDEA compliance requirements
- Transition planning required for ages 16+
- Framework enum: `us_iep`

## Component Architecture

```
StudentProgressPanel/
├── Header
│   ├── Back button
│   ├── Student name & badge
│   ├── Framework & year
│   └── Actions (Activate/Archive/Menu)
├── TabsList
│   ├── Overview
│   ├── Profile
│   ├── Goals
│   ├── Services
│   ├── Progress
│   └── Team
├── TabsContent (ScrollArea)
│   └── [Content for active tab]
└── Modals
    ├── GoalModal
    ├── ObjectiveModal
    ├── ServiceModal
    ├── DataPointModal
    └── TeamMemberModal
```

## API Endpoints Used

```
GET  /api/students/:id/programs/current
GET  /api/students/:id/programs
GET  /api/programs/:id/full
POST /api/students/:id/programs
POST /api/programs/:id/activate
POST /api/programs/:id/archive
PATCH /api/domains/:id
POST /api/programs/:id/goals
PATCH /api/goals/:id
DELETE /api/goals/:id
POST /api/goals/:id/objectives
POST /api/programs/:id/services
PATCH /api/services/:id
DELETE /api/services/:id
POST /api/goals/:id/data-points
POST /api/programs/:id/team
DELETE /api/team-members/:id
```

## State Management

- Uses TanStack Query for server state
- Local state for form values and modal visibility
- Memoized statistics calculation
- Collapsible sections track expanded IDs in Sets

## Internationalization

All text uses the `t('key')` function from `useLanguage()`:
- Supports RTL layout with `isRTL`
- All labels, placeholders, and messages are translated
- Enums have translation keys (e.g., `t('goal.status.active')`)

## Next Steps

1. **Add to your project:**
   - Copy `StudentProgressPanel.tsx` to `src/features/`
   - Merge translation keys into `en.ts` and `he.ts`

2. **Wire up routes:**
   - Ensure the backend routes are registered
   - Update navigation to use the new panel

3. **Future enhancements:**
   - AI-assisted goal writing
   - Progress chart visualizations
   - Document export functionality
   - Meeting scheduling integration