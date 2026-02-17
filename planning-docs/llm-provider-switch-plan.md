# LLM Provider and Model Switcher Plan

For this task, we want to add options for switching between different AI providers and models in the admin so we can experiment with them and determine which is best for our purposes.

This will require some updates to the server/services/chat system. Mostly it's the gpt.ts file that needs to be changed (currently uses only OpenAI), though other systems (like chat-handler.ts) will need to pass the new parameters down to it.
server/services/sessionService as well as the server/services/dual-agent are the main systems that call the LLMs.

Each use case may use a different provider and model. Currently we have 3 use cases.
Everything connected to the chatbot in the "client" folder uses one agent (the clinician chat, intended for adults)
The client-aac uses a dual-agent model, with one interactive chat agent (fast, simpler, interacts directly with children) and one moderator agent (manages memory, takes notes, injects instructions to the interactive agent)
So the use cases are
- Clinician
- AAC Chat
- AAC Moderator

Provider options should be:
- OpenAI
- Gemini
- Claude

And models should include the most recommended options, including mini, regular, and strongest.

Providers apply system-wide, but we will store the selected parameters for each use case on the database.
Selectable options may be hard-coded (put them in the shared folder).
DO NOT fetch the provider options from the database from functions stored inside the chat folder - get them in the calling functions (sessionService, etc) and pass them to the chat handlers.
If no provider is defined in the database, default to the currently selected options (OpenAI 4o, OpenAI 4o-mini for AAC chat.)

The client admin page should include a section that allows selecting the model for each of the 3 use cases, as well as a short description of the benefits of each model, as well as its monetary cost.