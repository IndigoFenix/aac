# Plan for Storing Private Data in External Locations

## Problem

We need to store sensitive data in external locations. Multiple storage locations may exist simultaneously — a user may belong to multiple institutions, each with its own preferred storage. The system must handle this without breaking or losing data.

## Core Principles

1. **NoSQL-style external storage**: Sensitive fields are stored as JSON blobs in external services, keyed by table and record ID. This decouples the external storage from our schema — we can add/remove/rename fields without coordinating migrations with external providers.
2. **Repository transparency**: The repository layer handles all external storage reads/writes. The service layer receives complete objects and never needs to know where data lives.
3. **Entity-level storage assignment**: Only three entity types carry an `externalStorage` column — `users`, `students`, and `institutes`. All child tables inherit from their owning entity. No per-row duplication.
4. **Tiered access patterns**: Not all sensitive data has the same fetch frequency or size. Data is split into tiers to avoid unnecessary external calls.

## Storage Assignment

### Who owns `externalStorage`

| Entity | Column | Example Values |
|--------|--------|----------------|
| `institutes` | `externalStorage` | `"metropolinet"`, `"s3-encrypted"`, `null` (local) |
| `students` | `externalStorage` | Inherited from institution by default, overridable |
| `users` | `externalStorage` | Set by user or inherited from their primary institution |

### Inheritance & Resolution

Child tables inherit storage from their owning entity. The repository resolves which backend to use by looking up the owner, not the row.

**Resolution priority for child tables:**
- Tables owned by a student (medical records, goals, reports, etc.) → use the student's storage
- Tables owned by a user (password tokens, MFA tokens) → use the user's storage
- Tables owned by an institution (institute invites) → use the institute's storage

**Join/relationship tables** (e.g., `userStudents`, `instituteStudents`, `studentClassrooms`):
- Structural/permission data (role, flags, dates) stays local in PostgreSQL — not sensitive
- Any sensitive fields on join tables (e.g., `userStudents.chatMemory`) route to the **student's** storage, since the data pertains to that student's care

**Defaults:**
- When a user creates an institution → institution inherits the user's `externalStorage`
- When a user creates a student → student inherits from the active institution if one is loaded, otherwise from the user
- `null` means local storage (data stays in PostgreSQL as today)

### Edge Cases

- **Student transfers between institutions**: Student keeps their storage location. If the new institution requires their own storage, this is an explicit migration action (move data from old backend to new, update the student's `externalStorage`).
- **`teamMembers` table**: Stores external providers' contact info (name, email, phone) for people who may not be system users. These belong to the student's program, so they use the student's storage.
- **`studentContacts` table**: Belongs to the student → uses student's storage.

## Tiered Storage Model

External data is organized into three tiers based on access pattern and size.

### Tier 1 — Core PII (always hydrated)

Small, frequently-accessed sensitive fields. Fetched every time the record is read. Stored as a single JSON blob per record.

**Examples:**
- `students`: firstName, lastName, birthDate
- `users`: email, firstName, lastName
- `medicalRecords`: primaryDiagnosis, medications, allergies, seizure alerts
- `goals`: goalStatement, targetBehavior, criteria
- `teamMembers`: name, contactEmail, contactPhone
- `studentContacts`: name, relationship, description

**Storage key**: `{table}/{recordId}/core`

**Behavior**: Repository automatically hydrates on read, persists on write. The service layer sees complete objects.

### Tier 2 — Large/append-only data (lazy-loaded)

Large fields that are only needed for specific operations (historical review, exports). Not fetched by default.

**Examples:**
- `chatSessions.log` — full conversation log, unbounded growth
- `chatSessions.state` — full session state JSON (if large)
- `meetings.notes` / `meetings.decisions` — detailed meeting minutes
- `progressReports.overallSummary` + `recommendedChanges` — lengthy narrative text

**Storage key**: `{table}/{recordId}/log` (or `/notes`, `/detail` as appropriate)

**Behavior**: Repository returns `null` for these fields by default. Dedicated methods (e.g., `getSessionLog(id)`, `getMeetingNotes(id)`) hydrate on demand. Write operations persist to external storage immediately (or buffer for append-only patterns).

### Tier 3 — Biometric data (session-cached)

Face and voice embeddings used for real-time recognition. These require low-latency access during active sessions but are highly sensitive at rest.

**Examples:**
- `students.faceEmbedding`, `students.voiceEmbedding`
- `users.faceEmbedding`, `users.voiceEmbedding`
- `studentContacts.faceEmbedding`, `studentContacts.voiceEmbedding`

**Storage key**: `{table}/{recordId}/biometric`

**Behavior**: Loaded into server memory when a student session starts. The recognition service works against the in-memory cache (no per-frame external calls). Discarded when the session ends. Writes go directly to external storage.

This matches the existing access pattern — the recognition service already operates in-memory. The only change is where cold storage lives.

## Architecture

### Storage Key Structure

```
{table}/{recordId}/core       → Tier 1: always hydrated on read
{table}/{recordId}/log        → Tier 2: lazy, explicit fetch only
{table}/{recordId}/biometric  → Tier 3: loaded into session cache on start
```

### Backend Interface

```typescript
interface StorageBackend {
  getBatch(keys: string[]): Promise<Map<string, Record<string, any>>>;
  get(key: string): Promise<Record<string, any> | null>;
  put(key: string, data: Record<string, any>): Promise<void>;
  putBatch(entries: Map<string, Record<string, any>>): Promise<void>;
  delete(key: string): Promise<void>;
  deleteBatch(keys: string[]): Promise<void>;
}
```

All three tiers use the same interface. The difference is when and how the repository calls it.

### Backend Implementations

Each external storage provider implements `StorageBackend`:
- `MetropolinetBackend` — CRUD via Metropolinet's API
- `S3EncryptedBackend` — AWS S3 with per-institution encryption keys
- `LocalBackend` — no-op passthrough (data stays in PostgreSQL, current behavior)

### Storage Resolver Service

```typescript
class ExternalStorageResolver {
  // Determine which backend to use for an entity
  resolveBackend(entityType: 'user' | 'student' | 'institute', entityId: string): Promise<StorageBackend>;

  // Tier 1: Hydrate sensitive fields onto records after DB fetch
  hydrateRecords<T>(table: string, records: T[], entityResolver: (r: T) => { type: string; id: string }): Promise<T[]>;

  // Tier 1: Extract and persist sensitive fields before/after DB write
  persistSensitiveFields(table: string, recordId: string, fields: Record<string, any>, entityType: string, entityId: string): Promise<void>;

  // Tier 2: Fetch a specific large field on demand
  fetchLargeField(table: string, recordId: string, fieldKey: string, entityType: string, entityId: string): Promise<any>;

  // Tier 3: Load all biometric data for a student session
  loadBiometrics(studentId: string): Promise<Map<string, { face?: number[]; voice?: number[] }>>;
}
```

### Repository Integration

Repositories call the resolver after DB queries and before/during DB writes. Example pattern:

```typescript
// Read — Tier 1 hydration
async getStudent(id: string): Promise<Student | undefined> {
  const [row] = await db.select().from(students).where(eq(students.id, id));
  if (!row) return undefined;
  const [hydrated] = await storageResolver.hydrateRecords('students', [row], r => ({ type: 'student', id: r.id }));
  return hydrated;
}

// List — batch hydration (one external call, not N)
async getStudentsByInstitute(instituteId: string): Promise<Student[]> {
  const rows = await db.select().from(students).where(...);
  return storageResolver.hydrateRecords('students', rows, r => ({ type: 'student', id: r.id }));
}

// Read — Tier 2 lazy load
async getSessionLog(sessionId: string): Promise<any> {
  return storageResolver.fetchLargeField('chatSessions', sessionId, 'log', 'student', studentId);
}
```

### Sensitive Field Registry

A configuration mapping defines which fields are sensitive and which tier they belong to, per table. This is the single source of truth for what gets externalized.

```typescript
const SENSITIVE_FIELDS: Record<string, { core: string[]; log?: string[]; biometric?: string[] }> = {
  students: {
    core: ['firstName', 'lastName', 'name', 'birthDate'],
    biometric: ['faceEmbedding', 'voiceEmbedding'],
  },
  users: {
    core: ['email', 'firstName', 'lastName', 'password', 'googleId', 'mfaSecret'],
    biometric: ['faceEmbedding', 'voiceEmbedding'],
  },
  medicalRecords: {
    core: ['primaryDiagnosis', 'coMorbidities', 'secondaryDiagnoses', 'alertsAllergies',
           'alertsSeizures', 'alertsCardiac', 'medications', 'medicalEquipment'],
  },
  chatSessions: {
    log: ['log', 'state'],
  },
  studentContacts: {
    core: ['name', 'relationship', 'description', 'contextNotes', 'hairColor', 'estimatedAge'],
    biometric: ['faceEmbedding', 'voiceEmbedding'],
  },
  // ... etc for all private tables
};
```

## Caching

### Tier 1 Cache
Short-lived in-memory or Redis cache (5-minute TTL) for hydrated core PII. Keyed by `{table}/{recordId}/core`. Invalidated on write.

### Tier 3 Cache
Session-scoped. Biometric embeddings loaded when a student's AAC session starts, held in server memory for the session duration, discarded on session end. No TTL — explicitly managed by session lifecycle.

### Tier 2
No caching by default. These are large, infrequently accessed. Could add caching per use case if needed.

## Failure Handling

- **External API unavailable on read**: Return structural data with sensitive fields as `null`. UI shows "[data unavailable]" for affected fields. Log the failure.
- **External API unavailable on write**: Buffer writes locally (e.g., a `pending_external_writes` table or in-memory queue). Retry with backoff. Alert if the queue grows beyond a threshold.
- **Biometric load failure on session start**: Session can still start but face/voice recognition is disabled. Log a warning.

## Database Changes

Minimal schema changes required:
- Add `externalStorage varchar` column to `users`, `students`, and `institutes` (3 columns total)
- No other schema changes — sensitive columns remain as-is with their current types and constraints
- When `externalStorage` is `null`, behavior is identical to today (data lives in PostgreSQL)
- When `externalStorage` is set, the repository writes placeholder/empty values to the DB columns and stores real data externally

## Migration Path

1. Add `externalStorage` column to the three entity tables
2. Implement `StorageBackend` interface + `LocalBackend` (no-op) + `ExternalStorageResolver`
3. Define `SENSITIVE_FIELDS` registry
4. Update repositories to call resolver on read/write (with `LocalBackend`, behavior is unchanged)
5. Implement first real backend (e.g., `MetropolinetBackend`)
6. Enable per-institution by setting `institutes.externalStorage`
7. Build admin UI for storage configuration + data migration between backends
