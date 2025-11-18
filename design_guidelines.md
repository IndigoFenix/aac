# CliniAACian Vertical OS - Design Guidelines

## Design Approach
**System-Based Design**: Professional clinical dashboard following Material Design principles adapted for healthcare/clinical workflows. Focus on clarity, efficiency, and reduced cognitive load for SLP practitioners.

## Typography System
- **Primary Font**: Inter or IBM Plex Sans (Google Fonts)
- **Headings**: 
  - Logo/Title: 24px, semibold (600)
  - Section Headers: 14px, medium (500), uppercase, letter-spacing: 0.5px
  - Tool Labels: 16px, medium (500)
- **Body Text**: 14px, regular (400)
- **UI Elements**: 13px, medium (500)
- **Placeholder Text**: 14px, regular (400), reduced opacity

## Layout & Spacing System
**Tailwind Units**: Primary spacing scale of 2, 4, 6, 8, 12, 16, 24
- Component padding: p-4 to p-6
- Section gaps: gap-6 to gap-8
- Icon spacing from text: gap-3
- Bottom bar padding: p-6
- Sidebar section spacing: space-y-8

**Grid Structure**:
- Left sidebar: Fixed 320px width (not percentage)
- Right column: flex-1 (remaining space)
- Minimum total width: 1280px (desktop optimized)

## Component Design

### Left Sidebar
- Fixed vertical sidebar with sticky positioning
- Section grouping with divider lines (1px, subtle)
- Logo text: 24px, bold, top-aligned with p-6
- Navigation items: Full-width buttons, left-aligned, icon + text
- Icons: 20px, positioned left with mr-3 spacing
- Dark mode toggle: Switch component near bottom, above Settings
- Active state: Subtle background highlight, no border
- Hover states: Slight background lightening

### Active Client Context
- Bordered card component (1px subtle border)
- Icon + Name layout with p-4 padding
- Compact, single-line display
- Person icon: 24px

### Workspace Navigation
- Vertical list of action items
- Each item: Icon (20px) + Label, p-3 padding
- Hover: Background highlight
- Click: Brief scale animation (98%)

### Right Column Header
- Thin top bar (h-16)
- SLP Profile indicator: Right-aligned, icon + label
- Status indicator dot: 8px circle, positioned next to profile

### Main Conversation Canvas
- Full height between header and interaction bar
- Message bubbles: max-width-2xl, rounded-2xl
- User messages: Right-aligned
- System messages: Left-aligned, with small avatar/icon
- Timestamp: 11px, reduced opacity, below messages
- Auto-scroll to latest message
- Empty state: Centered welcome message

### Bottom Interaction Bar
- Fixed to bottom, full-width of right column
- Elevated shadow (subtle)
- Height: auto, min-h-24
- Sections stacked vertically with gap-4

**Tool Selection Dropdown**:
- Full-width select component
- Large touch target (h-12)
- Icon prefix + label + chevron
- Rounded corners (rounded-lg)

**Prompt Input**:
- Large textarea (min-h-20)
- Rounded-xl corners
- Icon inside left (ml-4)
- Placeholder text with reduced opacity
- Auto-resize on input
- Microphone icon button: Absolute positioned right, mr-4

**Quick Action Buttons**:
- Grid layout: grid-cols-3 gap-4
- Each button: p-4, rounded-lg
- Icon (28px) centered above label
- Label: 13px, medium weight, mt-2
- Generous touch targets (min-h-24)
- Hover: Slight elevation shadow + subtle scale (102%)
- Active: Scale down (98%)

## Dark Mode Design (Default)
**Sidebar**: Deep navy/charcoal (#1a1f2e or similar dark tone)
**Main Canvas**: Darker background (#0f1419 or similar)
**Cards/Components**: Slightly lighter than canvas (#1e2530)
**Text**: High contrast white/off-white
**Borders**: Subtle, low-contrast (#2d3748)

**Light Mode**: 
**Sidebar**: Deep blue (#1e3a8a or similar professional blue)
**Main Canvas**: Off-white (#f9fafb)
**Cards**: White (#ffffff)
**Text**: Dark gray (#1f2937)
**Borders**: Light gray (#e5e7eb)

## Interaction Patterns
- No loading spinners for quick actions (<200ms)
- Tool button clicks: Show brief confirmation (toast notification, 2s duration)
- Dropdown menus: Smooth slide-down animation (150ms)
- Message send: Immediate optimistic UI update
- Voice input: Pulsing red recording indicator
- Theme toggle: Smooth color transition (300ms)

## Iconography
**Library**: Heroicons (outline for navigation, solid for actions)
**Sizes**: 20px (sidebar nav), 24px (client context), 28px (quick actions)
**Style**: Consistent stroke-width across all icons

## Accessibility
- Focus indicators: 2px outline with offset
- Keyboard navigation: Full support for all interactive elements
- ARIA labels: All icon-only buttons
- Color contrast: WCAG AA minimum (4.5:1 for text)
- Skip navigation link for keyboard users

## Images
**No hero images required** - This is a utility application focused on functionality. The conversational canvas and tool interface are the visual focus.

---

**Design Principle**: Professional clinical interface prioritizing efficiency, clarity, and minimal distraction. Every element serves the SLP's workflow needs.