# Main Project: Clinician + AAC

## Clinician Client

This operates through a standard web-based interface containing an AI chat. The chat should be capable of interacting with all parts of the platform if instructed.

## AAC Client
We are using the dynamic button system to generate AAC boards in real time.
The chat uses the live-relay system with Gemini, combined with a monitor agent that periodically evaluates the conversation, records notes, and provides guidance. The monitor agent can read personal information about the student such as goals, objectives, and medical information, but cannot directly edit it except for the low-security memory features such as notes.

## AAC Settings
AAC Settings are managed from the clinician client, not the AAC itself.

## Database strategy
We update the database schema using npm run db:generate, followed by db:migrate.
Don't use drizzle-kit push, since this does not update the drizzle migration status properly.
Never update the _journal.json or create drizzle files manually - this creates bugs.

## Chat System (General and Specific)
In server/services, files in the chat and providers folders should be treated as though they may be ported to a general AI chat application. Features that are likely to be useful for a wide variety of applications (such as chat behaviors and memory storage) should go there. Features that are specific to CliniAACian's use cases go in external files.