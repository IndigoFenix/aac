import { TextToSpeechClient } from '@google-cloud/text-to-speech';

// Initialize Google Cloud Text-to-Speech client
const client = new TextToSpeechClient({
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ? undefined : undefined,
  credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ? 
    JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) : undefined
});

interface UserProfile {
  age?: number;
  gender?: string;
}

export async function generateSpeechWithGoogle(
  text: string, 
  language: string = "en",
  userProfile?: UserProfile
): Promise<Buffer> {
  try {
    console.log(`Generating speech with Google TTS: ${text.substring(0, 50)}... Language: ${language}`);
    
    // Configure voice based on language and user profile
    let languageCode: string;
    let voiceName: string;
    let ssmlGender: 'NEUTRAL' | 'FEMALE' | 'MALE';
    
    // Determine voice characteristics based on user profile
    const isChild = userProfile?.age && userProfile.age < 18;
    const isMale = userProfile?.gender === 'male';
    
    if (language === "he") {
      languageCode = "he-IL";
      
      if (isChild) {
        if (isMale) {
          // Boy voice - use higher pitch male voice
          voiceName = "he-IL-Standard-B"; // Male Hebrew voice for boys
          ssmlGender = "MALE";
        } else {
          // Girl voice - use distinctly feminine Hebrew voice with higher pitch
          voiceName = "he-IL-Standard-A"; // Primary female Hebrew voice for girls
          ssmlGender = "FEMALE";
        }
      } else {
        if (isMale) {
          // Man voice
          voiceName = "he-IL-Standard-B"; // Male Hebrew voice
          ssmlGender = "MALE";
        } else {
          // Woman voice - ensure fully feminine Hebrew pronunciation
          voiceName = "he-IL-Standard-A"; // Best female Hebrew voice available
          ssmlGender = "FEMALE";
        }
      }
    } else {
      languageCode = "en-US";
      
      if (isChild) {
        if (isMale) {
          // Boy voice - use higher pitch male voice
          voiceName = "en-US-Standard-B"; // Male voice for boys
          ssmlGender = "MALE";
        } else {
          // Girl voice - use female voice
          voiceName = "en-US-Standard-H"; // Female voice for girls
          ssmlGender = "FEMALE";
        }
      } else {
        if (isMale) {
          // Man voice
          voiceName = "en-US-Standard-B"; // Deep male voice
          ssmlGender = "MALE";
        } else {
          // Woman voice
          voiceName = "en-US-Standard-H"; // Natural female voice
          ssmlGender = "FEMALE";
        }
      }
    }
    
    // Adjust pitch and speaking rate for natural feminine Hebrew pronunciation
    let pitch = 0.0;
    let speakingRate = 1.0;
    
    if (language === "he") {
      if (isChild) {
        pitch = isMale ? 2.0 : 5.0; // Extra high pitch for Hebrew girl voices for natural femininity
        speakingRate = 1.0; // Standard rate for Hebrew clarity
      } else {
        if (!isMale) {
          // Adult woman Hebrew voice - enhanced feminine characteristics
          pitch = 2.0; // Elevated pitch for fully feminine Hebrew pronunciation
          speakingRate = 0.95; // Slightly slower for clear feminine Hebrew articulation
        }
      }
    } else {
      // English voice adjustments
      if (isChild) {
        pitch = isMale ? 2.0 : 4.0; // Higher pitch for children (boys slightly lower than girls)
        speakingRate = 1.1; // Slightly faster for children
      }
    }
    
    console.log(`Voice selection: ${voiceName} (${ssmlGender}), pitch: ${pitch}, child: ${isChild}`);
    
    // Construct the request
    const request = {
      input: { text: text },
      voice: {
        languageCode: languageCode,
        name: voiceName,
        ssmlGender: ssmlGender,
      },
      audioConfig: {
        audioEncoding: 'MP3' as const,
        speakingRate: speakingRate,
        pitch: pitch,
        volumeGainDb: 0.0,
      },
    };

    // Perform the text-to-speech request
    const [response] = await client.synthesizeSpeech(request);
    
    if (!response.audioContent) {
      throw new Error("No audio content received from Google TTS");
    }
    
    const audioBuffer = Buffer.from(response.audioContent as Uint8Array);
    console.log(`Google TTS generation completed. Audio buffer size: ${audioBuffer.length} bytes`);
    
    return audioBuffer;
    
  } catch (error: any) {
    console.error("Error generating speech with Google TTS:", {
      message: error.message,
      code: error.code,
      details: error.details,
      status: error.status
    });
    throw new Error(`Failed to generate speech with Google TTS: ${error.message || error}`);
  }
}

export async function getAvailableGoogleVoices(languageCode?: string) {
  try {
    const [response] = await client.listVoices({
      languageCode: languageCode
    });
    
    return response.voices || [];
  } catch (error) {
    console.error("Error fetching Google TTS voices:", error);
    return [];
  }
}