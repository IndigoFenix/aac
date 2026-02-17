# Automated Symbol Generation

We want to make a system that allows the creation of new symbols for the AAC for concepts that aren't covered by existing emojis. These symbols should be stored on AWS in S3 and used by the AAC when appropriate.

## Database Storage

Each symbol may have an optional key string and an optional description string, and has a link to the S3 object. These will be stored on the database.
Symbols may be flagged as public.
(Note: Description is not just a physical description of the image, it may also include its symbolic meaning to a given student. This should be considered when evaluating where to use it and how to interpret button presses.)
Symbols may be associated with users, students, or institutes. A single symbol may have many associations.
When a symbol is associated with a user, student, or institute, this association may have its own key or description overriding the default.
All associations, as well as the symbol itself, should have an "approved" field. For now, this will always be checked (we will create a system for auto-generated suggestions later)

## Symbol Management panel

It should be possible to manage symbols through the client in a symbols panel.

The client interface allows creating, editing, deleting, approving, and generating (or regenerating) symbols.

### Applying Symbols

The client interface has options for "My Symbols" "Student symbols" (available only if the user manages a student), "Institute symbols" (available only if the user is an admin manager for an institute) and "Public symbols" (available only if the user is a system admin, shows Public symbols).
The student/institute selectors in these sections should be connected to the global student/institute selections.
Any of these sections allows creating symbols, which creates a create symbol popup.
Any of these sections (except Global symbols) allows adding symbols, which creates a search popup.
Any of these sections allows editing symbols, which creates an editor popup.

### Creating symbols

Images may be uploaded here or the user can make a request to the generator. It is not stored on S3 until they confirm it.
When a user creates a new symbol, it is automatically associated with them, as well as the object they were creating it for.
Only Public symbols have their key and descriptions added to the symbol object in the database itself. They are automatically set to public.
Symbols created for users, students or institutes are not public and do not have names or descriptions in the database on the symbol object itself.
Symbols automatically compress to 256x256 pixels if larger than this.

#### Symbol Generator

The symbol generator should use Nano Banana (Gemini key). We will include a file with example images as a style guide. Put this in its own function, we will later use it to generate symbols automatically during AAC usage.

### Editing symbols

Editing a symbol modifies its link to that object (example: Editing a symbol from the student section modifies the key and description for that student/symbol link, not the symbol object itself.) Only Global symbols modifies the symbol database object itself. (Only admins may do this.)

### Symbol Search

The client interface allows the user to search for symbols. This list consists of:
 - Symbols flagged as public
 - any symbol associated with an institute they are a part of
 - any symbol associated with a student they are a part of.
They can also filter by student or institute.

Symbols found in the search can be "saved" (creating a user association) or applied to institutes or students directly if they have permission to do so.

## Permanent deletion

If a symbol is deleted from a user, student, or institute list, check to see if it has any more associations remaining. If not, and it is not flagged as public, delete it from S3 and the database.

## Symbol usage

Symbols are used by the AAC button generator.

If a symbol is associated with a student, or an institute the student is a current member of, or public, its key and description should be inserted into the interactive AAC agent's system prompt, and it can be selected as a button icon in place of an emoji.

Specific keys and descriptions override general ones. Student > Institute > Global.
If two symbols share a key, mark them with numbers.

Only approved symbols may be used.

The prebuilt board generator can also select these same symbols automatically, based on the list of symbols available to the student it is being created for.

In the board editor, where "icon" is defined, add a button that allows selecting a symbol in a popup. This should start with a list of symbols available to that student already, and should also allow opening the same symbol search window from above, which allows selecting a symbol. If a symbol is selected and is not already added to that student, it should be added automatically.