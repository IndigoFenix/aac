# Landing Page Chat (CRM)

There should be a chatbot on the landing page that can explain the system to potential customers.
This can reuse a lot of our existing architecture - sessionService, etc. But there are a few differences:
- There is no user.
- We should store their IP and country of origin. Returning potential customers can be identified by their IP.
- A small memory store, using the existing memory system, should be associated with each potential customer so that the AI can remember them if they return. This includes a first name, last name, email, school district or organization, role, and an array of notes.
- This uses a separate LLM provider, selectable from the admin. (We will probably use a cheap one, like ChatGPT 4o-mini).
- The CRM chat prompt can also be edited from the admin. (If disabled, the chat will not appear.)
- We should be able to view all potential customers and their sessions, as well as delete them, from the admin.