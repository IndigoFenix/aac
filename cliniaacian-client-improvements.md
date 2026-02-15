## Plan for Cliniaacian chat improvements

# Automatic panel navigation: [DONE]

- When the user interacts with the chat in a way that directly relates to a specific panel-related feature of the system, it should automatically be able to navigate to the relevant panel or feature. This navigation feature needs to be added to the sessionService prompt setup for all paths except "AAC", which is its own independent system.
- Navigation should happen on the client as soon as the tool is called (use the same websocket system that progress updates use).
- When it does so, we need to make sure that it has the context associated with that panel loaded in its system prompt. This may require a bit of refactoring, especially in the case of the AAC board builder, which has significant information in its custom prompt.

**Implementation**: Added `navigateToFeature` tool to the AI's toolset (prompt-kit.ts). The tool emits a `navigate` SSE event immediately via chatStreamController → useChatStream → useChat → setActiveFeature. Enabled for all non-AAC features. AI is instructed to call it when the user's message relates to a specific panel (boards, students, institute, progress, reports, interpret).

# Default persona fixes [DONE]

- Right now the default persona (general assistant) has no icon or text associated with it. Add one, including its translations.

**Implementation**: `getPersonaInfo()` now returns the DEFAULT_PERSONA (🤖 Assistant) as fallback when persona is undefined or not found. Added default persona as first option in both ChatFeature PersonaSelector buttons and ChatPopup dropdown. Translations already existed (`chat.persona.assistant` / `chat.persona.assistantDesc`).

# Better progress updates when thinking [DONE]

- Right now the progress updates tend to pick one response describing its entire task and then stick with it, even for multi-step processes that take a long time. This can make it look like the system is frozen. We need the system to vary its progress updates more to give better feedback on what it's actually doing.

**Implementation**: Updated `describeActions` tool description to instruct the AI to call it before EACH step in multi-step processes, with varying descriptions. Added end-prompt reinforcement reminding the AI to use unique messages per step to prevent the frozen appearance.

# Check that the panels update when their database objects update [DONE]

- This is working well on the Reports page but it isn't working on the Students and Institutes pages. Coming up with a global solution that can be applied to all panels might be the best approach.

**Implementation**:
- **StudentsPanel**: Removed `isOpen` gate from query's `enabled` condition so React Query invalidation works even when panel isn't visible (matching Reports pattern).
- **InstitutePanel**: Added useEffect watching `isAiRefreshing` that re-fetches sub-entity data (members, invites, classrooms, students) for the current tab + calls `refetchInstitutes()`. This bridges the gap between React Query invalidation (which the AI triggers) and the panel's manual Promise-based data loading.
