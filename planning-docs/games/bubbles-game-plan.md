# Bubbles Game

This is a built-in AAC app, similar to the other AAC apps, designed to help train hand-eye coordination in students with motor difficulties, and may also be used for question-answer type games later. It should use the eye tracking for collecting information, but popping bubbles should require clicking or touch-screen.

It uses a canvas for display.

Bubbles appear on-screen and float around, sometimes moving in from the outside of the screen, and sometimes appearing inside the screen growing from a tiny size to full size in a few seconds. The student must touch them to pop them. Only initial touches (not holding) register as a touch.

It has multiple parameters to adjust difficulty:
- Bubble size
- Bubble speed
- Bubble movement randomness

Bubbles have random adjustment around the average. Popping bubbles quickly causes difficulty to increase. If the student seems to be having difficulty, the difficulty lowers.

When a bubble is touched, its graphic expands slightly for about 200 ms. If another screen point is touched within that period (due to multi-touch detection) and the other point is not within the bubble, the bubble should take half-damage and bounce away. Another touch pops it.

Sometimes a special bubble appears with a sparkling effect, and with higher difficulty.

The AI doesn't need to be watching the screen, but if the eye tracker notices the student tracking the bubble but not trying to touch it, the AI should get a message to encourage the student to try and touch it with their hands. It should periodically get comments on the student's success rate and react accordingly.