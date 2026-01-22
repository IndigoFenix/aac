# AAC Server Migration Notes

## Objective
Merge `server-aac-to-migrate` functionality into the current `server` system.
- Old "users" = New "students"
- Need to integrate memory system for student information
- Focus on prompt building and memory system integration
- Client: `client-aac` (real-time AAC communication for non-verbal children)

---

## Old System Analysis (server-aac-to-migrate)

### Core Purpose
Real-time AAC communication platform for non-verbal children. Processes:
- Visual context (camera analysis)
- Audio context (microphone transcription)
- Person detection (identifying child vs. others)
- Symbol/button generation for communication
- Voice synthesis for responses

### File Structure Overview

| File | Purpose | Migration Status |
|------|---------|------------------|
| `index.ts` | Express server entry, session setup | **REPLACE** - Use current server's entry |
| `routes.ts` | All HTTP endpoints (~1900 lines) | **MIGRATE** - Extract routes into controllers |
| `db.ts` | Neon PostgreSQL setup | **REPLACE** - Use current server's Drizzle setup |
| `storage.ts` | Database access layer | **REPLACE** - Use current repositories |

### Services Analysis

#### **KEEP & MIGRATE** (Unique AAC Functionality)

| Service | Purpose | Notes |
|---------|---------|-------|
| `conversation.ts` | Greeting & response generation | Core AAC interaction - adapt to use new prompt system |
| `contextualSymbols.ts` | Symbol suggestion engine | Core AAC - keep intact |
| `cabal2AAC.ts` | CABAL² Markov symbol prediction | Advanced AAC - keep intact |
| `bertAAC.ts` | BERT-like symbol prediction | Fallback for cabal2 - keep intact |
| `choiceClassifier.ts` | Detects choice questions in audio | Unique to AAC - keep intact |
| `choiceAACGenerator.ts` | Generates choice response options | Unique to AAC - keep intact |
| `personDetection.ts` | Person/role identification | Unique to AAC - keep intact |
| `userCameraDetection.ts` | User vs environment camera | Unique to AAC - keep intact |
| `signgemma.ts` | Sign language detection | Unique to AAC - keep intact |
| `audioCapture.ts` | Gemini audio transcription | Unique to AAC - keep intact |
| `voiceManager.ts` | Voice synthesis routing | Unique to AAC - keep intact |
| `googleTTS.ts` | Google TTS | Unique to AAC - keep intact |
| `elevenlabs.ts` | ElevenLabs TTS fallback | Unique to AAC - keep intact |
| `hebrewSymbols.ts` | Hebrew symbol mappings | Unique to AAC - keep intact |
| `arasaac.ts` | ARASAAC symbol library API | Unique to AAC - keep intact |
| `multiCameraAnalysis.ts` | Multi-camera support | Unique to AAC - keep intact |

#### **MERGE & ADAPT** (Overlapping with Current Server)

| Service | Purpose | How to Merge |
|---------|---------|--------------|
| `vertexai.ts` | Google Vertex AI | Merge with current AI services, add visual analysis capabilities |
| `openai.ts` | OpenAI GPT-4o | Already exists in current - add AAC-specific functions |
| `anthropic.ts` | Claude integration | Already exists in current - add AAC-specific functions |
| `modelOverride.ts` | Per-user ChatGPT-5 toggle | Adapt to work with Student model instead of User |

#### **REPLACE** (Current Server Has Better Implementation)

| Service | Replace With |
|---------|--------------|
| `emailService.ts` | Current server's email system (if exists) or keep |

---

## Current Server Analysis

### Core Purpose
Clinical/educational platform for special education professionals. Manages:
- Students (AAC users linked to multiple caregivers/clinicians)
- IEP/TALA programs with goals, objectives, data points
- Reports (medical, functional, educational)
- AAC boards (design and export)
- Credit-based AI usage tracking

### Strengths to Preserve
1. **Memory System** - Declarative schemas with DB persistence
2. **Prompt Building** - Modular tool building with `prompt-kit.ts`
3. **Student Management** - Multi-user access with role-based permissions
4. **Credit Tracking** - Token usage monitoring
5. **Repository Pattern** - Clean data access layer

### Key Files for Integration

| File | Purpose | Integration Point |
|------|---------|-------------------|
| `services/chat/prompt-kit.ts` | Builds prompts & tools | Add AAC-specific prompts |
| `services/chat/memory-system.ts` | Memory operations | Extend for AAC context |
| `services/chat/memory-db-bridge.ts` | DB sync for memory | Add AAC data persistence |
| `services/studentService.ts` | Student CRUD | Add AAC-specific fields |
| `repositories/studentRepository.ts` | Student data access | Extend for AAC data |

---

## Migration Plan

### Phase 1: Schema & Data Model Updates

**1.1 Extend Student Schema**
Add AAC-specific fields to Student model (currently in `@shared/schema`):
```typescript
// New fields for AAC users
language: 'en' | 'he'           // From old user.language
chatAgentPrompt: string         // Custom prompt override
demoMode: boolean               // Demo scenario enabled
demoScenario: string            // Demo scenario type
usePcsSymbols: boolean          // PCS vs emoji preference
signLanguageReading: boolean    // Sign language enabled
multiCameraMode: boolean        // Multi-camera support
chatgpt5Enabled: boolean        // Model override toggle
voiceType: 'man' | 'woman' | 'boy' | 'girl'  // Voice preference
knownPeople: JSON               // Array of known people for recognition
```

**1.2 Create AAC Session Storage**
For real-time context (not persisted long-term):
- `visualContext` - Current scene analysis
- `personDetection` - Current person detection
- `audioContext` - Current audio transcription
- `cameraVisualContexts` - Per-camera analysis

### Phase 2: Service Migration

**2.1 Copy Services (Keep Intact)**
Copy these to `server/services/aac/`:
```
services/aac/
├── contextualSymbols.ts
├── cabal2AAC.ts
├── bertAAC.ts
├── choiceClassifier.ts
├── choiceAACGenerator.ts
├── personDetection.ts
├── userCameraDetection.ts
├── signgemma.ts
├── audioCapture.ts
├── voiceManager.ts
├── googleTTS.ts
├── elevenlabs.ts
├── hebrewSymbols.ts
├── arasaac.ts
└── multiCameraAnalysis.ts
```

**2.2 Adapt conversation.ts**
- Rename to `aacConversation.ts`
- Replace `userId` with `studentId` throughout
- Integrate with current memory system
- Use current prompt-kit patterns
- Keep fallback chain logic

**2.3 Merge AI Services**
Add to existing services:
- `vertexai.ts` → Add to `server/services/chat/` with visual analysis functions
- Update `gpt.ts` to include AAC-specific functions from old `openai.ts`

**2.4 Adapt modelOverride.ts**
- Change from user-based to student-based
- Integrate with studentService for settings lookup

### Phase 3: Route Migration

**3.1 Create AAC Router**
New file: `server/routes/aacRoutes.ts`

Extract and adapt these routes from old `routes.ts`:
```typescript
// Conversation
POST /api/aac/conversation/start     // Start conversation for student
POST /api/aac/conversation/respond   // Generate response to symbols
GET  /api/aac/conversation/history/:studentId
DELETE /api/aac/conversation/:studentId

// Symbols
POST /api/aac/symbols/suggestions
POST /api/aac/symbols/contextual
POST /api/aac/symbols/choice-options
GET  /api/aac/arasaac/search/:language/:searchText
GET  /api/aac/arasaac/keywords/:language

// Visual Analysis
POST /api/aac/analyze-image
POST /api/aac/detect-person
POST /api/aac/detect-sign-language
POST /api/aac/detect-objects-in-hands

// Audio
POST /api/aac/audio/process
POST /api/aac/audio/classify-choice
GET  /api/aac/audio/context
POST /api/aac/audio/start-monitoring
POST /api/aac/audio/stop-monitoring

// Voice
POST /api/aac/voice/synthesize

// Debug
GET  /api/aac/debug/environment
```

**3.2 Create AAC Controllers**
```
server/controllers/aac/
├── aacConversationController.ts
├── aacSymbolController.ts
├── aacVisualController.ts
├── aacAudioController.ts
└── aacVoiceController.ts
```

**3.3 Update routes.ts**
Add AAC routes to main router with student access verification.

### Phase 4: Memory System Integration

**4.1 Create AAC Memory Schema**
New file: `server/services/memory-schema/aac-memory-schema.ts`

Define memory fields for AAC context:
```typescript
const AAC_CONTEXT_FIELD: AgentMemoryFieldObject = {
  type: 'object',
  id: 'Context_AAC',
  name: 'AAC Session Context',
  fields: {
    student: { /* student info */ },
    visualContext: { /* current scene */ },
    emotionalContext: { /* detected emotions */ },
    audioContext: { /* transcription */ },
    conversationHistory: { /* recent messages */ },
    suggestedSymbols: { /* current suggestions */ },
    knownPeople: { /* recognized people */ }
  }
}
```

**4.2 Update Student Memory**
Extend existing student fields with AAC preferences.

### Phase 5: Authentication & Access

**5.1 Student Access for AAC**
- AAC client authenticates as User
- User selects which Student to interact with
- All AAC endpoints require valid User session + Student access

**5.2 Middleware Updates**
Add `requireStudentAccess` middleware that:
- Validates user session
- Checks UserStudent link exists
- Provides studentId to handlers

---

## Files to Remove After Migration

These become obsolete:
- `server-aac-to-migrate/index.ts` (replaced by current server)
- `server-aac-to-migrate/db.ts` (using current db.ts)
- `server-aac-to-migrate/storage.ts` (using repositories)
- `server-aac-to-migrate/routes.ts` (extracted to controllers)

---

## Environment Variables to Merge

From old `.env` (add to current server):
```
# Google Cloud
GOOGLE_APPLICATION_CREDENTIALS_JSON=...

# ElevenLabs
ELEVENLABS_API_KEY=...

# Gemini (if not already present)
GEMINI_API_KEY=...

# Vertex AI (if not already present)
GOOGLE_CLOUD_PROJECT=...
```

---

## Integration Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      Current Server                              │
├─────────────────────────────────────────────────────────────────┤
│  routes.ts                                                       │
│  ├── /auth/*          (existing)                            │
│  ├── /api/students/*      (existing)                            │
│  ├── /api/programs/*      (existing)                            │
│  ├── /api/chat/*          (existing - clinical chat)            │
│  └── /api/aac/*           (NEW - AAC routes)                    │
│       ├── /conversation/* → aacConversationController           │
│       ├── /symbols/*      → aacSymbolController                 │
│       ├── /visual/*       → aacVisualController                 │
│       ├── /audio/*        → aacAudioController                  │
│       └── /voice/*        → aacVoiceController                  │
├─────────────────────────────────────────────────────────────────┤
│  services/                                                       │
│  ├── chat/                 (existing)                            │
│  │   ├── prompt-kit.ts     (extend for AAC prompts)             │
│  │   ├── memory-system.ts  (extend for AAC context)             │
│  │   └── gpt.ts            (add AAC functions)                  │
│  ├── aac/                  (NEW - migrated services)            │
│  │   ├── contextualSymbols.ts                                   │
│  │   ├── cabal2AAC.ts                                           │
│  │   ├── bertAAC.ts                                             │
│  │   ├── choiceClassifier.ts                                    │
│  │   ├── choiceAACGenerator.ts                                  │
│  │   ├── aacConversation.ts (adapted from conversation.ts)      │
│  │   ├── personDetection.ts                                     │
│  │   ├── userCameraDetection.ts                                 │
│  │   ├── signgemma.ts                                           │
│  │   ├── audioCapture.ts                                        │
│  │   ├── voiceManager.ts                                        │
│  │   ├── googleTTS.ts                                           │
│  │   ├── elevenlabs.ts                                          │
│  │   ├── hebrewSymbols.ts                                       │
│  │   ├── arasaac.ts                                             │
│  │   └── multiCameraAnalysis.ts                                 │
│  └── memory-schema/        (existing + new)                      │
│      └── aac-memory-schema.ts (NEW)                             │
├─────────────────────────────────────────────────────────────────┤
│  Student Model (extended)                                        │
│  + language, chatAgentPrompt, demoMode, voiceType, etc.         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Transformation: User → Student

**Old System Pattern:**
```typescript
// Old: Direct user operations
const user = await storage.getUser(userId);
const context = buildContext(user.age, user.language);
```

**New System Pattern:**
```typescript
// New: User accesses student
const user = req.user; // Authenticated user
const student = await studentService.getStudentById(studentId);
await studentService.verifyStudentAccess(user.id, studentId);
const context = buildContext(student.age, student.language);
```

---

## Clarified Decisions

| Question | Decision |
|----------|----------|
| **Session Storage** | In-memory with database fallback (hybrid approach) |
| **Credit Tracking** | Yes, track credits like current sessionService |
| **Demo Mode** | Keep - useful for testing |
| **Multi-Student** | Yes, multiple simultaneous sessions required (each student on own device) |
| **Existing Functions** | Add new functions only - don't modify existing to avoid breaking changes |

---

## AAC Session Architecture (NEW)

### Problem
Old system uses single in-memory session - won't work for multiple students on different devices.

### Solution: Hybrid In-Memory + Database Pattern

Follow the current `sessionService.ts` pattern with AAC-specific adaptations.

#### Data Model

**New Table: `aacSessions`**
```typescript
// Similar to chatSessions but for AAC real-time context
export const aacSessions = pgTable('aac_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id').references(() => students.id).notNull(),
  userId: uuid('user_id').references(() => users.id),  // Who started this session

  // Real-time context (JSONB - updated frequently)
  context: jsonb('context').$type<AACSessionContext>(),

  // Conversation state
  conversationHistory: jsonb('conversation_history').$type<AACMessage[]>(),

  // Credit tracking
  creditsUsed: integer('credits_used').default(0),

  // Session management
  status: varchar('status', { length: 20 }).default('active'), // active, paused, ended
  started: timestamp('started').defaultNow(),
  lastActivity: timestamp('last_activity').defaultNow(),
  ended: timestamp('ended'),
});

interface AACSessionContext {
  visualContext?: VisualAnalysis;
  personDetection?: PersonDetection;
  audioContext?: AudioContext;
  cameraVisualContexts?: Record<string, VisualAnalysis>;
  emotionalContext?: EmotionalState;
  lastSymbols?: Symbol[];
}

interface AACMessage {
  role: 'agent' | 'user';
  content: string;
  symbols?: Symbol[];       // For user messages
  timestamp: Date;
  audioGenerated?: boolean; // For agent messages
}
```

#### In-Memory Cache Layer

**New Service: `server/services/aac/aacSessionService.ts`**
```typescript
// In-memory cache for active sessions
const sessionCache = new Map<string, {
  session: AACSession;
  context: AACSessionContext;
  lastAccess: number;
  dirty: boolean;  // Needs DB sync
}>();

// Cache TTL: 5 minutes of inactivity → persist to DB and evict
const CACHE_TTL_MS = 5 * 60 * 1000;

export class AACSessionService {

  // Get or create session for student
  async getSession(studentId: string, userId?: string): Promise<AACSession> {
    // 1. Check in-memory cache first
    const cached = sessionCache.get(studentId);
    if (cached && !this.isExpired(cached)) {
      cached.lastAccess = Date.now();
      return cached.session;
    }

    // 2. Check database for existing active session
    let session = await aacSessionRepository.findActiveByStudentId(studentId);

    // 3. Create new session if none exists
    if (!session) {
      session = await aacSessionRepository.create({
        studentId,
        userId,
        context: {},
        conversationHistory: [],
        status: 'active',
      });
    }

    // 4. Cache in memory
    sessionCache.set(studentId, {
      session,
      context: session.context || {},
      lastAccess: Date.now(),
      dirty: false,
    });

    return session;
  }

  // Update context (in-memory, periodic DB sync)
  async updateContext(studentId: string, updates: Partial<AACSessionContext>): Promise<void> {
    const cached = sessionCache.get(studentId);
    if (!cached) {
      throw new Error('Session not found - call getSession first');
    }

    // Merge updates into cached context
    cached.context = { ...cached.context, ...updates };
    cached.dirty = true;
    cached.lastAccess = Date.now();

    // Debounced DB sync (don't write on every update)
    this.schedulePersist(studentId);
  }

  // Add message to conversation
  async addMessage(studentId: string, message: AACMessage): Promise<void> {
    const cached = sessionCache.get(studentId);
    if (!cached) throw new Error('Session not found');

    cached.session.conversationHistory.push(message);
    cached.dirty = true;

    // Messages are important - persist immediately
    await this.persistSession(studentId);
  }

  // Track credit usage
  async addCredits(studentId: string, credits: number): Promise<void> {
    const cached = sessionCache.get(studentId);
    if (!cached) throw new Error('Session not found');

    cached.session.creditsUsed += credits;
    cached.dirty = true;

    // Also update student's total credits (like current sessionService)
    await studentService.addCreditsUsed(studentId, credits);

    this.schedulePersist(studentId);
  }

  // Periodic persistence (debounced)
  private persistTimers = new Map<string, NodeJS.Timeout>();

  private schedulePersist(studentId: string): void {
    // Cancel existing timer
    const existing = this.persistTimers.get(studentId);
    if (existing) clearTimeout(existing);

    // Schedule new persist in 2 seconds
    const timer = setTimeout(() => this.persistSession(studentId), 2000);
    this.persistTimers.set(studentId, timer);
  }

  private async persistSession(studentId: string): Promise<void> {
    const cached = sessionCache.get(studentId);
    if (!cached || !cached.dirty) return;

    await aacSessionRepository.update(cached.session.id, {
      context: cached.context,
      conversationHistory: cached.session.conversationHistory,
      creditsUsed: cached.session.creditsUsed,
      lastActivity: new Date(),
    });

    cached.dirty = false;
  }

  // Cleanup expired sessions periodically
  startCleanupInterval(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [studentId, cached] of sessionCache.entries()) {
        if (now - cached.lastAccess > CACHE_TTL_MS) {
          // Persist before evicting
          this.persistSession(studentId);
          sessionCache.delete(studentId);
        }
      }
    }, 60000); // Check every minute
  }
}
```

#### Benefits of This Approach

1. **Multi-session support**: Each student has their own session keyed by `studentId`
2. **Performance**: Frequent context updates stay in memory
3. **Durability**: Periodic + on-message DB persistence
4. **Recovery**: Can resume session from DB after server restart
5. **Credit tracking**: Consistent with current sessionService pattern
6. **Scalability**: Can migrate to Redis later if needed for multi-server

#### Integration with Existing sessionService

The AAC session is **separate** from the chat session:
- `sessionService` → Clinical chat (text-based, tool calls, memory system)
- `aacSessionService` → Real-time AAC (visual/audio context, symbol generation)

They can coexist - a student might have both active simultaneously.

---

## Migration Approach: Additive Only

**IMPORTANT**: To avoid breaking existing functionality:

1. **New functions only** - Don't modify existing service methods
2. **New files** - Create `services/aac/` directory for AAC-specific code
3. **New routes** - Add `/api/aac/*` routes without touching existing routes
4. **Extend, don't modify** - If adding to existing services (like gpt.ts), add new exported functions

Example - adding to gpt.ts:
```typescript
// DON'T modify existing functions
// DO add new functions

// Existing (don't touch)
export async function generateResponse(...) { ... }

// New AAC-specific functions (add these)
export async function generateAACGreeting(...) { ... }
export async function generateAACResponse(...) { ... }
export async function analyzeVisualForAAC(...) { ... }
```

---

## Next Steps

### Phase 1: Foundation ✅
1. [x] Review and approve migration plan
2. [x] Create `aacSessions` table schema in `@shared/schema`
3. [x] Create `server/repositories/aacSessionRepository.ts`
4. [x] Create `server/services/aac/aacSessionService.ts` (hybrid cache)
5. [x] Update Student schema with AAC-specific fields

### Phase 2: Service Migration (Pure Utilities First)
6. [ ] Create `server/services/aac/` directory
7. [ ] Copy pure utility services (no userId dependencies):
   - `hebrewSymbols.ts`
   - `arasaac.ts`
   - `cabal2AAC.ts`
   - `bertAAC.ts`
8. [ ] Copy AI integration services:
   - `googleTTS.ts`
   - `elevenlabs.ts`
   - `voiceManager.ts`
9. [ ] Copy context analysis services (adapt userId → studentId):
   - `personDetection.ts`
   - `userCameraDetection.ts`
   - `signgemma.ts`
   - `audioCapture.ts`
   - `multiCameraAnalysis.ts`
10. [ ] Copy symbol generation services:
    - `contextualSymbols.ts`
    - `choiceClassifier.ts`
    - `choiceAACGenerator.ts`
11. [ ] Adapt `conversation.ts` → `aacConversation.ts`
12. [ ] Adapt `modelOverride.ts` → `aacModelOverride.ts`

### Phase 3: Routes & Controllers
13. [ ] Create AAC controllers in `server/controllers/aac/`
14. [ ] Create AAC routes (mount at `/api/aac/*`)
15. [ ] Add `requireStudentAccess` middleware

### Phase 4: Integration
16. [ ] Create AAC memory schema
17. [ ] Add AAC-specific functions to `gpt.ts` (additive only)
18. [ ] Merge environment variables

### Phase 5: Client & Cleanup
19. [ ] Update `client-aac` to use new endpoints (`/api/aac/*`)
20. [ ] Test end-to-end AAC flow
21. [ ] Archive/remove `server-aac-to-migrate` directory
