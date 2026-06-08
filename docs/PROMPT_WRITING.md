# Writing good prompts for small LLMs

Consult this file whenever creating or editing a prompt or function that needs to be sent to an LLM, especially those that go to Gemini. (Claude's a bit more lenient, but it's still a good idea to use good practice.)

### Break things up
*Avoid long strings*: Whenever you see a single line that's more than 130 characters, consider breaking it up into smaller, bulleted lists.
*Avoid long lists*: Whenever you see a single bulleted list that's more than 4-5 items, consider breaking it up into smaller sub-lists. 8 should be the maximum.
*Use nested layers*: The same goes for any list of lists.

### Use global constants to organize canonical terminology
- When describing a specific feature of our system, extract it into a file of global constants to ensure that it is always referred to by the same name.
- Using ALL CAPS for canonical terms is usually a good pattern, to prevent the LLM from mistaking it for a generic term.

### Avoid bloat
- As a general rule, the shorter, the better.
- Instruct rather than explain, unless the agent in question will need to make judgement calls.

### Examples > Explanations
- Especially when dealing with rigid patterns.

### Tag patterns
- Gemini seems to respond well to tag-based markup.

### Tool descriptions
- When describing how to use a tool, it's good to put the explanation into the tool description.
- When describing when to use one tool over another, or for cross-cutting behaviors, it's better to use the system prompt.
- Avoid duplicating the same information on both locations.