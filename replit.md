# CliniAACian

A professional conversational interface prototype for SLP (Speech-Language Pathologist) practitioners.

## Project Overview

CliniAACian Vertical OS provides a modern, clinical dashboard interface for managing AAC (Augmentative and Alternative Communication) workflows. The system features a conversational AI interface with quick access to specialized tool agents.

## Features

### Core Functionality
- **Conversational Interface**: Clean chat-based interaction with AI assistants
- **Tool Agents**: Three specialized AI agents accessible via dropdown and quick actions
  - SyntAACx: AAC Board Generator
  - CommuniACCte: AAC Intent Interpreter
  - DocuSLP: IEP/TLA Document Generator
- **Client Context**: Active client information displayed in sidebar
- **Dark/Light Mode**: Theme toggle with preference persistence
- **Collapsible Sidebar**: Responsive navigation that can collapse to icon-only view

### User Interface
- Fixed left sidebar (320px expanded, 80px collapsed)
- Time-based greetings (Good morning/afternoon/evening)
- Real-time message interaction with typing indicators
- Quick action buttons for common tasks
- Voice input button (UI prototype)
- Tool selection dropdown

## Technology Stack

### Frontend
- React 18 with TypeScript
- Tailwind CSS for styling
- Shadcn UI components
- Wouter for routing
- TanStack Query for state management

### Backend
- Express.js server
- In-memory storage (MemStorage)
- Vite for development and bundling

## Project Structure

```
client/src/
├── components/
│   ├── ui/              # Shadcn UI components
│   ├── LeftSidebar.tsx  # Collapsible navigation sidebar
│   ├── TopHeader.tsx    # Header with sidebar toggle and user profile
│   ├── MainCanvas.tsx   # Conversation interface and input bar
│   └── ThemeProvider.tsx # Dark/light mode management
├── pages/
│   └── Dashboard.tsx    # Main application page
└── App.tsx             # Root application component

server/
├── index.ts            # Express server setup
├── routes.ts           # API route definitions
└── storage.ts          # Storage interface

shared/
└── schema.ts           # Type definitions and schemas
```

## Current State

This is a **UI prototype** demonstrating the conversational workflow interface. Key characteristics:

- **Simulated AI responses**: Messages return prototype responses after 1.5s delay
- **Client-side state**: Messages stored in component state (no persistence)
- **No authentication**: Focuses on UI/UX demonstration
- **Mock data**: Active client "Sarah J." is hardcoded

## Design Guidelines

Follows professional clinical dashboard design principles:
- IBM Plex Sans / Inter typography
- Dark mode by default (deep navy/charcoal sidebar)
- Subtle elevation and hover interactions
- WCAG AA color contrast compliance
- Consistent spacing system (Tailwind scale)

## Running the Project

The "Start application" workflow runs `npm run dev`:
- Express server on port 5000
- Vite dev server with HMR
- Single port serving (no proxy needed)

## Future Development

To build the full application:
1. Add backend API integration for AI tool agents
2. Implement real authentication and user management
3. Add database persistence for conversations and reports
4. Connect to actual AAC generation services
5. Implement voice recording functionality
6. Add client profile management
7. Create saved reports repository
8. Build board library management

## User Preferences

- **Theme**: Dark mode by default, toggleable to light mode
- **Layout**: Fixed sidebar layout optimized for desktop/tablet
- **Active Client**: Sarah J. (prototype data)
