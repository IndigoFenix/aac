# CliniAACian project

## Purpose and goals
This is a project to help students with special needs communicate, interact with the world and learn.
Currently we are focusing on an AAC platform for children with Rett's Syndrome. We plan to expand this to serve a wide variety of educational needs.

## Structure
The platform contains two separate clients: The regular client, used by clinicians and caretakers, and the AAC client, used by the students themselves. Both share a common server.
All calls to the API from the client need to use the apiRequest function.
The project uses ES Modules, don't use __dirname

## Client
This operates through a standard web-based interface containing an AI chat. The chat should be capable of interacting with all parts of the platform if instructed.

## AAC Client
We are using the dynamic button system to generate AAC boards in real time.
The chat uses the live-relay system with Gemini, combined with a monitor agent that periodically evaluates the conversation, records notes, and provides guidance. The monitor agent can read personal information about the student such as goals, objectives, and medical information, but cannot directly edit it except for the low-security memory features such as notes.

## Database strategy
We update the database schema using npm run db:generate, followed by db:migrate.
Don't use drizzle-kit push, since this does not update the drizzle migration status properly.

## Chat System (General and Specific)
In server/services, files in the chat and providers folders should be treated as though they may be ported to a general AI chat application. Features that are likely to be useful for a wide variety of applications (such as chat behaviors and memory storage) should go there. Features that are specific to CliniAACian's use cases go in external files.

## AWS Strategy
We have 2 separate AWS systems which are served from github actions. Currently we are using the Lambda system to save costs. Later we will begin using the ecs system. Updates made to the Lambda system should be made to the ecs system as well, apart from using Lambda vs ECS.

There are 2 different deployment paths in Terraform. The lightweight one we are using now is to save costs. There is also a path with higher security (HIPAA compliance) that we will enable once we are ready to move to production. Keep both in mind when handling AWS systems.

## Translations
The client (both of them) uses i18n translations with a t() function for English and Hebrew.
Whenever the term "student" is used, we use ts() instead, which swaps "student" for "child" when relevant.
If you add any strings to the client, add their translations.
If you see any missing translations on the client while working, add them.