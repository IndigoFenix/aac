# License Plan

For now, system admins will sign up users. We need to set up an interface for this.
Create a section in the admin for license management.

There should be a page to view all licenses.

## License Options

Licenses can be granted to individual users or to institutes. We don't have a payment system set up yet, but keep it open for that.
Each license object has a list of permissions in a JSON field.
    Permissions: (JSON)
        All (if true, gives max level for all permissions and can remove them from the JSON)
        Max Students - 0, a value, or unlimited (-1)
        AAC Enabled
        Board Maker Enabled
        Unrestricted AI
        Dashboard Level (0, 1, 2, -1) (Described as None, Basic Stats, Advanced Analytics, and Full Analysis)
        Expert Agents Count  (0, 1, 2, -1) (-1 is unlimited)

- If Max Students is 0, no students can be created and all student-related fields are removed from the dashboard.
- If AAC Enabled is false, the user cannot log in to the AAC and AAC Settings are removed from the dashboard.
- If Dashboard Level is 0, remove Student Progress and Student Reports (we will go over specifics later)
- If Expert Agents Count is 0, remove persona selection from the dashboard (only use the default Assistant)
- If Unrestricted AI is not true, add an additional control to AI prompts "Do not discuss topics unrelated to your specific task. If the user tries to discuss unrelated topics, explain that you cannot because their license is in Restricted Mode."
- If Board Maker is disabled, remove AAC Board Maker and Image Manager from the dashboard. (Board Maker may be enabled even if AAC is not.)

## AAC Board Maker change

Board Maker and Image manager should be moved out of the student-specific section, and should be enabled even when a student is not selected.

## License Creation Section

The 