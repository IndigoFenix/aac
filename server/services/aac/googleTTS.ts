import { TextToSpeechClient } from '@google-cloud/text-to-speech';

/**
 * Parse Google Cloud credentials from environment variable
 * Handles the common issue where \n in private_key becomes literal strings
 */
function parseGoogleCredentials(jsonString: string): any {
  // Clean the JSON string - remove any extra quotes or whitespace
  let cleanKey = jsonString.trim().replace(/^"/, '').replace(/"$/, '');

  const credentials = JSON.parse(cleanKey);

  // Fix private_key newlines - env vars often have literal \n instead of actual newlines
  if (credentials.private_key && typeof credentials.private_key === 'string') {
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  }

  return credentials;
}

// Lazy-loaded client to prevent server crash on startup if credentials are missing
let client: TextToSpeechClient | null = null;
let clientError: string | null = null;

function getClient(): TextToSpeechClient {
  if (clientError) {
    throw new Error(clientError);
  }

  if (!client) {
    try {
      const options: any = {
        projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
      };

      if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
        // Use JSON credentials from env var with newline fix
        options.credentials = parseGoogleCredentials(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        // Use file path to credentials
        options.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }
      // Otherwise, rely on default credentials (GCP environment)

      console.log("Initializing Google TTS client with options:", options);

      client = new TextToSpeechClient(options);
    } catch (error: any) {
      clientError = `Google TTS client initialization failed: ${error.message}`;
      console.error(clientError);
      throw new Error(clientError);
    }
  }

  return client;
}

interface UserProfile {
  age?: number;
  gender?: string;
}

export async function generateSpeechWithGoogle(
  text: string,
  language: string = "en",
  userProfile?: UserProfile
): Promise<Buffer> {
  let ttsClient: TextToSpeechClient;

  try {
    ttsClient = getClient();
  } catch (error: any) {
    console.error("Google TTS not available:", error.message);
    throw new Error(`Google TTS not available: ${error.message}`);
  }

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
          voiceName = "he-IL-Standard-B";
          ssmlGender = "MALE";
        } else {
          voiceName = "he-IL-Standard-A";
          ssmlGender = "FEMALE";
        }
      } else {
        if (isMale) {
          voiceName = "he-IL-Standard-B";
          ssmlGender = "MALE";
        } else {
          voiceName = "he-IL-Standard-A";
          ssmlGender = "FEMALE";
        }
      }
    } else {
      languageCode = "en-US";

      if (isChild) {
        if (isMale) {
          voiceName = "en-US-Standard-B";
          ssmlGender = "MALE";
        } else {
          voiceName = "en-US-Standard-H";
          ssmlGender = "FEMALE";
        }
      } else {
        if (isMale) {
          voiceName = "en-US-Standard-B";
          ssmlGender = "MALE";
        } else {
          voiceName = "en-US-Standard-H";
          ssmlGender = "FEMALE";
        }
      }
    }

    // Adjust pitch and speaking rate
    let pitch = 0.0;
    let speakingRate = 1.0;

    if (language === "he") {
      if (isChild) {
        pitch = isMale ? 2.0 : 5.0;
        speakingRate = 1.0;
      } else {
        if (!isMale) {
          pitch = 2.0;
          speakingRate = 0.95;
        }
      }
    } else {
      if (isChild) {
        pitch = isMale ? 2.0 : 4.0;
        speakingRate = 1.1;
      }
    }

    console.log(`Voice selection: ${voiceName} (${ssmlGender}), pitch: ${pitch}, child: ${isChild}`);

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

    const [response] = await ttsClient.synthesizeSpeech(request);

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
    const ttsClient = getClient();
    const [response] = await ttsClient.listVoices({
      languageCode: languageCode
    });

    return response.voices || [];
  } catch (error) {
    console.error("Error fetching Google TTS voices:", error);
    return [];
  }
}

export function isGoogleTTSAvailable(): boolean {
  try {
    getClient();
    return true;
  } catch {
    return false;
  }
}
