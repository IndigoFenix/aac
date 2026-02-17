Don't worry about voice cloning right now - we already have custom voices we want to use  
  as options (in addition to the systems that we're using now).                              
  Let's maximize our options.                                                                
  There are two separate voices associated with each student - the AI persona voice, and     
  the interpreted student voice. They should be selected in the client.                      
  For each, we will need the fallback (picked from a set of basic options,                   
  boy/girl/man/woman) and a custom voice from ElevenLabs (may be null).                      
  Voices should be a database object that can be added through the admin panel (only         
  accessible to admin users). They should have an externalId and a source (only elevenlabs   
  for now, maybe more later).                                                                
  When available, use the custom voice. Otherwise, use the fallback.                         
  When streaming from OpenAI, if an ElevenLabs voice is selected, stream through it (even    
  if it adds latency). Otherwise, use the current system.                                    
  To reduce latency, voices can be fetched from the database at the same time the AI is      
  processing, since they're not needed until it's done.