# Aivota project

## Purpose and goals
This is a project to help students with special needs communicate, interact with the world and learn.
Currently we are focusing on an AAC platform for children with Rett's Syndrome. We plan to expand this to serve a wide variety of educational needs.

## Structure
The platform contains two separate clients: The regular (clinician) client, used by clinicians and caretakers, and the AAC client, used by the students themselves. Both share a common server.
All calls to the API from the client need to use the apiRequest function.
The project uses ES Modules, don't use __dirname

## Client
This operates through a standard web-based interface containing an AI chat. The chat should be capable of interacting with all parts of the platform if instructed.

## AAC Client
We are using the dynamic button system to generate AAC boards in real time.
The chat uses the live-relay system with Gemini, combined with a monitor agent that periodically evaluates the conversation, records notes, and provides guidance. The monitor agent can read personal information about the student such as goals, objectives, and medical information, but cannot directly edit it except for the low-security memory features such as notes.

## AAC Settings
All AAC settings should be able to be managed from both the Clinician client and the AAC client, except for those related to security, which should not be selectable from the AAC client.

## Database strategy
We update the database schema using npm run db:generate, followed by db:migrate.
Don't use drizzle-kit push, since this does not update the drizzle migration status properly.
Never update the _journal.json or create drizzle files manually - this creates bugs.

## Chat System (General and Specific)
In server/services, files in the chat and providers folders should be treated as though they may be ported to a general AI chat application. Features that are likely to be useful for a wide variety of applications (such as chat behaviors and memory storage) should go there. Features that are specific to CliniAACian's use cases go in external files.

## AWS Strategy
We have 2 separate AWS systems which are served from github actions. Currently we are using the Lambda system to save costs. Later we will begin using the ecs system. Updates made to the Lambda system should be made to the ecs system as well, apart from using Lambda vs ECS.

There are 2 different deployment paths in Terraform. The lightweight one we are using now is to save costs. There is also a path with higher security (HIPAA compliance) that we will enable once we are ready to move to production. Keep both in mind when handling AWS systems.

## Translations
Both the clinician and AAC clients use i18n translations with a t() function for multilingual support.
Whenever the term "student" is used, we use ts() instead, which swaps "student" for "child" when relevant.
If you add any strings to the client, add their translations.
If you see any missing translations on the client while working, add them.
All translation files should have identical keys on identical lines.
Use the scripts/validate-i18n.ts to check for this after editing translation files.

## Testing
At the end of each minor task, check to see if we have a testing suite set up for that part of the system. If not, create one. If so, test it.
Run a full npm test after completing major tasks that touch a large part of the system.
The npm test does not call the real LLM - we use a mock LLM for this instead.
Don't run test:llm or test:ai without being instructed to.

## General Behaviors
Use logs whenever needed - preferably logging to a file rather than the console.
If you try to fix an error and fail, don't hesitate to create a log that will help uncover the issue. The log can always be removed when the issue is fixed.