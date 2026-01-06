# Institute Management System Integration Guide

This package contains a complete institute management system with invite functionality for the CliniAACian application.

## Features

- **Institute CRUD Operations**: Create, read, update, and delete institutes
- **Member Management**: Add, remove, and update member roles
- **Admin Controls**: Grant and revoke admin privileges
- **Invite System**: Token-based invite workflow for new and existing users
- **Pending Invites Dashboard**: View and respond to pending invites
- **Invite Signup Page**: Registration flow for new users via invite links

## File Structure

```
institute-system/
├── server/
│   ├── controllers/
│   │   └── instituteController.ts    # HTTP handlers
│   ├── repositories/
│   │   └── instituteRepository.ts    # Database operations
│   ├── services/
│   │   └── instituteService.ts       # Business logic
│   └── routes-additions.ts           # Route definitions
├── client/
│   ├── features/
│   │   └── InstitutePanel.tsx        # Main management UI
│   ├── hooks/
│   │   └── useInstitute.tsx          # React context & hook
│   ├── pages/
│   │   ├── InviteSignupPage.tsx      # Invite registration page
│   │   └── PendingInvitesPage.tsx    # Pending invites dashboard
│   └── i18n/
│       ├── institute-en.ts           # English translations
│       └── institute-he.ts           # Hebrew translations
└── shared/
    └── schema-additions.ts           # Database schema additions
```

## Integration Steps

### 1. Database Schema

Add the institute invites table to your `shared/schema.ts`:

```typescript
// Add to existing enums section
export const instituteInviteStatusEnum = pgEnum("institute_invite_status", [
  "pending",
  "accepted", 
  "declined",
  "expired",
  "cancelled"
]);

// Add the institute_invites table (copy from schema-additions.ts)
export const instituteInvites = pgTable("institute_invites", {
  // ... (see shared/schema-additions.ts for full definition)
});

// Add relations
export const instituteInvitesRelations = relations(instituteInvites, ({ one }) => ({
  // ... (see shared/schema-additions.ts)
}));

// Add type exports
export type InstituteInvite = typeof instituteInvites.$inferSelect;
export type InsertInstituteInvite = typeof instituteInvites.$inferInsert;
export type UpdateInstituteInvite = Partial<InsertInstituteInvite>;
```

Then run a migration to create the new table.

### 2. Backend Integration

**Add Repository Export** (`server/repositories/index.ts`):
```typescript
export { instituteRepository } from './instituteRepository';
```

**Add Service Export** (`server/services/index.ts`):
```typescript
export { instituteService } from './instituteService';
```

**Add Controller Export** (`server/controllers/index.ts`):
```typescript
export { instituteController } from './instituteController';
```

**Add Routes** (`server/routes.ts`):
```typescript
import { instituteController } from './controllers';

// Institute routes
app.get('/api/institutes', requireAuth, (req, res) => instituteController.getInstitutes(req, res));
app.get('/api/institutes/:id', requireAuth, (req, res) => instituteController.getInstitute(req, res));
app.post('/api/institutes', requireAuth, (req, res) => instituteController.createInstitute(req, res));
app.patch('/api/institutes/:id', requireAuth, (req, res) => instituteController.updateInstitute(req, res));
app.delete('/api/institutes/:id', requireAuth, (req, res) => instituteController.deleteInstitute(req, res));

// Member routes
app.get('/api/institutes/:id/members', requireAuth, (req, res) => instituteController.getMembers(req, res));
app.patch('/api/institutes/:id/members/:userId', requireAuth, (req, res) => instituteController.updateMember(req, res));
app.delete('/api/institutes/:id/members/:userId', requireAuth, (req, res) => instituteController.removeMember(req, res));
app.post('/api/institutes/:id/leave', requireAuth, (req, res) => instituteController.leaveInstitute(req, res));

// Invite management routes (admin)
app.post('/api/institutes/:id/invites', requireAuth, (req, res) => instituteController.sendInvite(req, res));
app.get('/api/institutes/:id/invites', requireAuth, (req, res) => instituteController.getInvites(req, res));
app.delete('/api/institutes/:id/invites/:inviteId', requireAuth, (req, res) => instituteController.cancelInvite(req, res));
app.post('/api/institutes/:id/invites/:inviteId/resend', requireAuth, (req, res) => instituteController.resendInvite(req, res));

// User invite routes
app.get('/api/invites/pending', requireAuth, (req, res) => instituteController.getPendingInvites(req, res));
app.post('/api/invites/:inviteId/accept', requireAuth, (req, res) => instituteController.acceptInvite(req, res));
app.post('/api/invites/:inviteId/decline', requireAuth, (req, res) => instituteController.declineInvite(req, res));

// Public invite routes (no auth)
app.get('/api/invites/token/:token', (req, res) => instituteController.getInviteByToken(req, res));
app.post('/api/invites/token/:token/accept', requireAuth, (req, res) => instituteController.acceptInviteByToken(req, res));
app.post('/api/invites/token/:token/register', (req, res) => instituteController.registerWithInvite(req, res));
```

### 3. Frontend Integration

**Add Provider to App.tsx**:
```typescript
import { InstituteProvider } from '@/hooks/useInstitute';

// Wrap your app with InstituteProvider (inside AuthProvider)
<AuthProvider>
  <InstituteProvider>
    {/* ... rest of app */}
  </InstituteProvider>
</AuthProvider>
```

**Add Routes to App.tsx**:
```typescript
import InviteSignupPage from '@/pages/InviteSignupPage';
import PendingInvitesPage from '@/pages/PendingInvitesPage';

// Add public route for invite signup
<Route path="/invite/:token" component={InviteSignupPage} />

// Add protected route for pending invites
<Route path="/invites">
  <ProtectedRoute>
    <PendingInvitesPage />
  </ProtectedRoute>
</Route>
```

**Add to Navigation (Sidebar.tsx)**:
```typescript
import { Building2 } from 'lucide-react';

// Add to navigation items
{
  icon: Building2,
  labelKey: 'nav.institutes',
  feature: 'institutes' as FeatureType,
  testId: 'nav-institutes',
}
```

**Add to MainLayout.tsx**:
```typescript
import { InstitutePanel } from '@/features/InstitutePanel';

// Add to renderFeaturePanel switch
case 'institutes':
  return <InstitutePanel isOpen={isPanelOpen} />;
```

**Add to FeaturePanelContext.tsx**:
```typescript
// Add to FeatureType
type FeatureType = 'chat' | 'interpret' | 'boards' | 'docuslp' | 'overview' | 'students' | 'progress' | 'institutes' | 'settings';

// Add to FEATURE_CONFIG
institutes: {
  hasPanel: true,
  panelMode: 'popup',
  isFullScreen: true,
},
```

### 4. Translations

Merge the translation files into your existing `en.ts` and `he.ts`:

```typescript
// In en.ts
import { instituteTranslationsEN } from './institute-en';
// Merge with existing translations

// In he.ts
import { instituteTranslationsHE } from './institute-he';
// Merge with existing translations
```

## Usage

### Creating an Institute

1. Navigate to the Institutes panel
2. Click "Create Institute"
3. Fill in the details (name, type, etc.)
4. Submit - you become the admin automatically

### Inviting Members

1. Go to the "Invites" tab in the Institute panel
2. Click "Send Invite"
3. Enter the email address
4. Select role and admin status
5. Send the invite

The invitee will receive a link like `/invite/{token}`. If they:
- Already have an account: They can accept the invite directly
- Don't have an account: They can register and join in one step

### Managing Members

- Toggle admin status with the crown icon
- Remove members with the trash icon
- Last admin cannot be removed

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/institutes | List user's institutes |
| POST | /api/institutes | Create new institute |
| GET | /api/institutes/:id | Get institute details |
| PATCH | /api/institutes/:id | Update institute |
| DELETE | /api/institutes/:id | Delete institute |
| GET | /api/institutes/:id/members | List members |
| PATCH | /api/institutes/:id/members/:userId | Update member |
| DELETE | /api/institutes/:id/members/:userId | Remove member |
| POST | /api/institutes/:id/leave | Leave institute |
| POST | /api/institutes/:id/invites | Send invite |
| GET | /api/institutes/:id/invites | List invites |
| DELETE | /api/institutes/:id/invites/:inviteId | Cancel invite |
| POST | /api/institutes/:id/invites/:inviteId/resend | Resend invite |
| GET | /api/invites/pending | Get user's pending invites |
| POST | /api/invites/:inviteId/accept | Accept invite |
| POST | /api/invites/:inviteId/decline | Decline invite |
| GET | /api/invites/token/:token | Validate invite token (public) |
| POST | /api/invites/token/:token/accept | Accept via token |
| POST | /api/invites/token/:token/register | Register & accept |

## Future Enhancements

- [ ] Email notifications when email system is ready
- [ ] Institute logo upload
- [ ] Bulk invite sending
- [ ] Invite analytics
- [ ] Institute-scoped student management
- [ ] License/subscription management per institute
