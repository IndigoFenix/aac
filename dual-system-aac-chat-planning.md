# Overview of Dual AAC Chat System (Monitor + Interactive)

This is a plan for implementing a dual-agent AAC chat system.
The purpose of the dual system is to handle two competing goals with the AAC chat, which is designed to interact with a child and present buttons for them to press: The chat agent must be attentive and respond quickly to the surroundings, but it must also be able to perform deep searches on the child's data and take notes.
To solve this, we will implement a system where two agents run simultaneously: one to handle fast interactions, the other to manage complex database interactions.

1. Interactive Agent
- Continually monitors the surroundings, responds quickly to button presses and proactively interacts in accordance with its goals.
- Uses multimodal processing for context-awareness (sound and camera input). Can handle voice input.
- Streams voice output and text (needs frontend integration as well)
- Creates response buttons - the buttons must be appropriate responses to the voice output, so they should be generated in the same output. The buttons should appear as soon as they are available.
- Uses a lightweight, fast AI for quick responses (4o-mini)
- Should have the ability to "think carefully" when it needs to. This turns control of the conversation over to the Monitor Agent. It may turn this mode on and off depending on the situation.
- Even when in "think carefully" mode, it should stream its final responses (add this as an optional integration into the existing chat system).
- When not in thinking mode, it may use its own system if this is easier.

2. Monitor Agent
- Uses the sessionService and all of its integrated systems to interact with the database
- Uses 4o for better memory management
- Initializes the Interactive Agent when creating a new session, creating its system prompt based on student needs. Part of this prompt comes from the student table and is not editable by the AI, but it can also add additional commands based on its context.
- Monitors the interactions between the user and the Interactive Agent.
- Reads from the database using the structured memory system
- Takes notes and writes to the database
- Periodically injects system-level commands into the Interactive Agent's conversation to update it with new goals or parameters

## Guidelines
- Session-related objects may be cached on the backend in the short term, but assume the backend may be short-lived (we are currently using Lambda, though we do plan on switching over to ECS). Always have a fallback to reload objects from the database.
- Store all data specific to a single session in a single chat_sessions row.

## Specifics
- We should avoid multiple entities operating on the same session column in the database at the same time.
- When creating a new session, use the Monitor to define a new Interactive agent, stored on the backend.
- Whenever the backend recieves input, if not in thinking mode, the interactive agent should always respond immediately. At the same time, it should cache the latest messages on the backend as "messages pending". When a message is added this way, check if the monitor is busy. If not, add all pending messages to the message log and chat state, and then send them to the monitor for processing. This way, we avoid editing these fields while the monitor is working with them.
- When the monitor responds, it may edit the Interactive agent's prompt and/or inject system-level commands into the conversation that the interactive agent can see.
- If in thinking mode, the monitor responds directly after thinking.

The current sessionService and chat systems already have the necessary systems for memory handling.
The current chat system is similar to thinking mode, but voice input and output needs to be added.
There are some leftovers on the backend from a system that used Realtime chat through the frontend. You may use these functions for non-thinking mode, but there also needs to be an implementation that does all voice processing on the backend.