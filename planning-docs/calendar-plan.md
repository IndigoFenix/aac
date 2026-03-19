# Integrated Calendar System

This will be a calendar with events that can be managed in the client, either directly or using the AI chat. (This can be managed using memory, similar to how the AI manages )

Users, students, classrooms and institutes can be added to events. Events are visible in the calendar if there is an existing connection between:
- The logged in user
- The selected institute
- The selected student
If a classroom is added, this implies a connection with the institute.
The user who creates an event is always added to that event.

Figure out the most efficient way to organize this to ensure streamlined searches.

Events can be a single timespan, repeat daily, or certain days of the week.

## AI awareness of calendar events

The AI should always be able to search the calendar for events.
Events within a certain timeframe (like 1 day) should be mentioned in the prompt by default. The AAC needs to be aware of upcoming/recent events as well.