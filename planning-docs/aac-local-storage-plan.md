# AAC Local Storage

- This system will need to store everything that happens in the AAC - including session logs and monitor agent notes - on the user's device, so that the AAC works the same across sessions without us storing any new data on the database itself.

- Stored data should be encrypted with a key associated with the student, so that platform users can't actually read it. This should be able to be disabled for testing purposes.

- It should work in both the browser-based system and the electron app system.

- Local storage and remote storage can each be enabled or disabled independently. (If both are disabled, the platform will have no long-term memory.)

- Even if both are disabled, we should also store the current session state in the client, so that it can be rebuilt if there is a server or connection issue and we aren't storing anything in the database.

- Old session logs can be deleted after some time. Only the current session state needs to be stored.