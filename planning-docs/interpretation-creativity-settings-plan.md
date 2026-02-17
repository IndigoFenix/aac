# Interpretation settings

Students may vary substantially in cognitive capability. We need to ensure that the INTERPRET function conveys as much of their actual intent as possible.
Add per-student settings which will impact the interactive agent prompt.

Interpretation level:
- 0: No [INTERPRET] function. The words on the pushed button are converted to voice exactly as they are, bypassing the AI entirely, the AI's only function is to provide the user with context-appropriate buttons.
- 1: Minimalistic interpretation of button presses (no phrases or gestures). The AI never runs [INTERPRET] except immediately after a button is pressed, and only interprets the intent behind the button press. It may use context and gestures to convert those button presses into phrases but will not speak on behalf of the student unless they push a button.
- 2: Conservative interpretation of phrases and gestures. The AI may recognize known, pre-recorded words and gestures from the student as input and interpret them conservatively according to context.
- 3: Creative interpretation of gestures. The AI may guess the meaning of unknown gestures based on context.
- 4: Autonomous conversation handling. The AI conducts conversations on behalf of the student, using their observed emotional state, attention, and needs as guidance.