# Auto Generate Icons

When building a board using the AAC, we would like to create a better system for images than using emojis alone. To achieve this, we want to make a system that generates icons on-the-fly using Gemini and caching them in S3.

This is an opt-in system. AAC settings should include the following options:
- Generate symbols
- Use approved symbols
- Use unapproved symbols

If any of these options are enabled, when generating buttons, Gemini should recieve instructions to add an image_key for each button in addition to their default emoji. Image keys have a few rules:
- Always in English, except for language-specific concepts.
- Do not use proper nouns, except for globally-known concepts (like countries).
- Keys must be completely unambiguous in their meaning. Words with multiple meanings must be clarified using underscores.

Buttons that use custom symbols (not emojis) skip this.

When an image key is created, we check the database to see if a valid symbol associated with that key already exists. If so, use it. If not, send a SEPARATE message to Gemini (not containing any information about the conversation) that contains predefined style rules for converting the key into an image (simple, icon, using solid shapes and line art, transparent background).
After that image is created, we save it to S3 and in the database under that key, in uploads. These images are treated as public uploads and are NOT approved by default.

If the settings allow using unapproved symbols, when the symbol is generated, the button should automatically update on the frontend.

Unapproved images can be viewed using the image uploader by system admins and approved or deleted. If deleted, they should be removed from both the database and S3.