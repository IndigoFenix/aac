## Integration plan of AAC Board Generator with AAC Automatic Board Control

Right now, we have a system for building static AAC boards in the user client, and a system for automatically generating AAC boards in real-time in the AAC client. We want to combine them.

- Currently, the AAC board always takes 12 items. Make this number variable and sent from the client. Update the prompt accordingly. The AI cannot change this number. 12 should be the default.
- When using REBUILD_BOARD, the maximum will be set to 12. The interactive agent should know this.
- In the board builder, add fields on the boardset level (not each page) for "Automatic Selection" (boolean) and "Automatic Selection Hint". This will allow the AI to select these preset boardsets. The board builder AI should be able to set these values, as should the user.
- When initially creating the interactive agent's prompt, load the name and hint for all boards with automatic selection enabled. Expose these values to the interactive agent, and let it select them using the key [SET_BOARD] name.
- When a board is selected, create a message so the AI doesn't continuously try to select the same already loaded board.
- When a board is selected, load its home page into the AAC. Set the maximum item number accordingly and update its buttons. The boards use a row/column system; make sure to translate to the automatic AAC system accordingly.
- Continue using the automatic system even after a custom board is loaded. The AI can see, add and remove buttons as it normally does.
- Navigation and back buttons should work - navigating to a page loads the buttons based on that page.
- Navigation and back events should be sent to the AI.
- When navigating, first load the page, then send the message to the AI along with the already updated page buttons. That way it can update the buttons according to circumstance, but will have the default visible so it doesn't try to rebuild the whole board if not necessary.
- The fixed footer buttons should remain constant.