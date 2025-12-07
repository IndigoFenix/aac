# Refactored API Architecture

This refactoring separates the original monolithic `routes.ts` and `storage.ts` files into a proper layered architecture with Controllers, Services, and Repositories.

## Directory Structure

```
├── controllers/           # HTTP request/response handling
│   ├── index.ts
│   ├── authController.ts         # Auth: register, login, logout, password reset, Google OAuth
│   ├── profileController.ts      # Profile: upload image, update profile
│   ├── aacUserController.ts      # AAC Users + Schedules
│   ├── inviteCodeController.ts   # Invite codes CRUD + redemption
│   ├── savedLocationController.ts# Saved GPS locations
│   ├── onboardingController.ts   # Onboarding flow steps
│   ├── interpretationController.ts # Main interpret endpoint + history
│   ├── boardController.ts        # Board generation + export
│   ├── slpClinicalController.ts  # SLP clinical data + metrics
│   ├── adminController.ts        # Admin dashboard + user management
│   └── creditPackageController.ts# Stripe payments + credit packages
│
├── services/              # Business logic
│   ├── index.ts
│   ├── userService.ts            # User registration, validation, profile
│   ├── aacUserService.ts         # AAC user + schedule management
│   ├── creditService.ts          # Credit validation, deduction, packages
│   ├── inviteCodeService.ts      # Invite code logic
│   ├── passwordResetService.ts   # Password reset flow
│   └── adminService.ts           # Admin operations
│
├── repositories/          # Data access layer
│   ├── index.ts
│   ├── baseRepository.ts         # Base class with db reference
│   ├── userRepository.ts         # User CRUD + stats
│   ├── aacUserRepository.ts      # AAC users + schedules
│   ├── interpretationRepository.ts # Interpretations + clinical data
│   ├── creditRepository.ts       # Credits + transactions + packages
│   ├── inviteCodeRepository.ts   # Invite codes + redemptions
│   ├── apiProviderRepository.ts  # API providers + calls + pricing
│   ├── savedLocationRepository.ts# GPS locations
│   ├── boardRepository.ts        # Boards + prompts + analytics
│   └── settingsRepository.ts     # System settings + password tokens
│
├── middleware/            # Express middleware
│   ├── index.ts
│   └── auth.ts                   # requireAuth, optionalAuth, requireAdmin, etc.
│
├── routes.ts              # Route definitions (uses controllers)
└── storage.ts             # Backwards-compatible facade (delegates to repositories)
```

## API Endpoints Coverage

### Auth Routes
- `POST /auth/register` - Register new user
- `POST /auth/login` - Login
- `POST /auth/logout` - Logout
- `POST /auth/forgot-password` - Request password reset
- `POST /auth/reset-password` - Reset password with token
- `GET /auth/user` - Get current user
- `GET /auth/google` - Google OAuth initiation
- `GET /auth/google/callback` - Google OAuth callback

### Profile Routes
- `POST /api/profile/upload-image` - Upload profile image
- `PATCH /api/profile/update` - Update profile info

### AAC User Routes
- `GET /api/aac-users` - Get user's AAC users
- `POST /api/aac-users` - Create AAC user
- `PATCH /api/aac-users/:id` - Update AAC user
- `DELETE /api/aac-users/:id` - Delete AAC user

### Schedule Routes
- `GET /api/schedules/:aacUserId` - Get schedules
- `POST /api/schedules` - Create schedule
- `PATCH /api/schedules/:id` - Update schedule
- `DELETE /api/schedules/:id` - Delete schedule
- `GET /api/schedules/:aacUserId/context` - Get current schedule context

### Saved Location Routes
- `GET /api/saved-locations` - Get saved locations
- `POST /api/saved-locations` - Create saved location
- `DELETE /api/saved-locations/:id` - Delete saved location

### Invite Code Routes
- `POST /api/invite-codes` - Create invite code
- `GET /api/invite-codes` - Get user's invite codes
- `POST /api/invite-codes/redeem` - Redeem invite code
- `GET /api/invite-codes/redemptions` - Get redemptions
- `PATCH /api/invite-codes/:id/deactivate` - Deactivate code

### Onboarding Routes
- `GET /api/onboarding/status` - Get onboarding status
- `POST /api/onboarding/complete-step-1` - Complete step 1 (create AAC user)
- `POST /api/onboarding/complete-step-2` - Complete step 2 (create schedule)
- `POST /api/onboarding/redeem-code` - Redeem invite code during onboarding

### Interpretation Routes (Main Application)
- `POST /api/interpret` - Interpret AAC communication (text/image)
- `GET /api/interpretations` - Get interpretation history
- `GET /api/interpretations/:id` - Get specific interpretation
- `DELETE /api/interpretations/:id` - Delete interpretation
- `POST /api/historical-suggestions` - Get historical pattern suggestions

### Board Generation Routes
- `POST /api/board/generate` - Generate board with AI
- `POST /api/board/save` - Save board
- `GET /api/boards` - Get user's boards
- `GET /api/board/:id` - Get specific board
- `POST /api/export/gridset` - Export as gridset
- `POST /api/export/snappkg` - Export as snap package

### SLP Clinical Routes
- `GET /api/slp/clinical-log` - Get clinical data log
- `GET /api/slp/clinical-metrics` - Get aggregated metrics
- `GET /api/slp/export-csv` - Export clinical data as CSV

### Credit/Payment Routes
- `GET /api/stripe-config` - Get Stripe public key
- `GET /api/credit-packages` - Get available packages
- `POST /api/create-payment-intent` - Create Stripe payment intent
- `POST /api/confirm-payment` - Confirm payment and add credits

### Admin Routes
- `GET /api/admin/auth/user` - Get current admin
- `GET /api/admin/stats` - Dashboard stats
- `GET /api/admin/users` - Get all users
- `GET /api/admin/users/:id` - Get specific user
- `PATCH /api/admin/users/:id` - Update user
- `DELETE /api/admin/users/:id` - Delete user
- `POST /api/admin/users/:id/credits` - Update user credits
- `GET /api/admin/users/:id/transactions` - Get credit transactions
- `GET /api/admin/smtp-check` - Check SMTP config
- `POST /api/admin/test-email` - Send test email
- `GET /api/admin/prompt` - Get system prompt
- `PUT /api/admin/prompt` - Update system prompt
- `GET /api/admin/settings/:key` - Get setting
- `PUT /api/admin/settings/:key` - Update setting
- `GET /api/admin/subscription-plans` - Get plans
- `GET /api/admin/interpretations` - Get all interpretations
- `GET /api/admin/interpretations/:id` - Get specific interpretation
- `GET /api/admin/interpretations/export` - Export as CSV
- `GET /api/admin/usage-stats` - API usage statistics
- `GET /api/admin/api-calls` - Get API calls
- `GET /api/admin/api-calls/export` - Export API calls as CSV
- `GET /api/admin/api-providers` - Get API providers
- `POST /api/admin/api-providers` - Create API provider
- `PATCH /api/admin/api-providers/:id` - Update API provider
- `GET /api/admin/credit-packages` - Get credit packages
- `POST /api/admin/credit-packages` - Create credit package
- `PATCH /api/admin/credit-packages/:id` - Update credit package
- `DELETE /api/admin/credit-packages/:id` - Delete credit package

## Notes on Potential Redundancies

### 1. Invite Code Redemption
- `POST /api/invite-codes/redeem` (inviteCodeController)
- `POST /api/onboarding/redeem-code` (onboardingController)

Both handle invite code redemption. The onboarding version also updates the onboarding step to complete. Consider consolidating by having the regular redemption endpoint accept an optional `completeOnboarding` parameter.

### 2. Credit Packages Endpoints
- `GET /api/credit-packages` (public)
- `GET /api/admin/credit-packages` (admin)

Both return credit packages. The public one filters by `isActive=true`. Could potentially be a single endpoint with role-based filtering.

### 3. Interpretations Endpoints
- `GET /api/interpretations` (user's own)
- `GET /api/admin/interpretations` (all with user info)

These serve different purposes but share similar logic. The admin version joins user data.

## Migration Guide

### Using the Facade (Backwards Compatible)
The `storage.ts` file provides a backwards-compatible facade. Existing code can continue using:
```typescript
import { storage } from "./storage";
storage.getUser(id);
```

### Using Repositories Directly (Recommended for New Code)
New code should import repositories directly:
```typescript
import { userRepository } from "./repositories";
userRepository.getUser(id);
```

### Using Services
For business logic with validation:
```typescript
import { userService } from "./services";
const { user, referralApplied } = await userService.registerUser(data, referralCode);
```

## External Dependencies

The following external services/modules are referenced but not included in this refactoring:
- `./userAuth` - Passport.js setup (setupUserAuth function)
- `./services/emailService` - Email sending functionality
- `./services/interpretationService` - AI interpretation (interpretAACText, interpretAACImage)
- `./services/analyticsService` - Analytics tracking
- `./services/boardGenerationService` - AI board generation
- `./services/dropboxService` - Dropbox backup integration
- `./db` - Database connection (Drizzle ORM)
- `@shared/schema` - Database schemas and types
