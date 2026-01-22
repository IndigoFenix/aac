import { ElevenLabsClient } from "elevenlabs";
import { generateSpeechWithGoogle } from "./googleTTS";

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY || "",
});

export async function generateSpeech(text: string, language: string = "en", userProfile?: any): Promise<Buffer> {
  // Primary: Try Google Cloud Text-to-Speech (more reliable for Hebrew)
  try {
    console.log("Trying Google Cloud TTS first...");
    return await generateSpeechWithGoogle(text, language, userProfile);
  } catch (googleError) {
    console.log("Google TTS failed (API not enabled), falling back to ElevenLabs:", (googleError as Error).message);
    
    // Fallback: Try ElevenLabs
    try {
      console.log("Generating speech with ElevenLabs:", text.substring(0, 50) + "...", "Language:", language);
      
      // Select appropriate model and voice based on language and user profile
      const modelId = language === "he" ? "eleven_multilingual_v2" : "eleven_monolingual_v1";
      
      // Select voice based on user profile for Hebrew
      let selectedVoice = "FGY2WhTYpPnrIDTdsKH5"; // Default AI chat agent voice
      
      if (language === "he" && userProfile) {
        const isMale = userProfile.gender === 'male';
        if (!isMale) {
          // Use a more feminine Hebrew voice for female users
          selectedVoice = "ThT5KcBeYPX3keUQqHPh"; // More feminine Hebrew voice option
        }
      }
      
      const audioStream = await elevenlabs.generate({
        voice: selectedVoice,
        text: text,
        model_id: modelId,
        voice_settings: {
          stability: 0.75,
          similarity_boost: 0.8,
          style: language === "he" ? 0.2 : 0.0, // Slight style adjustment for Hebrew
        }
      });

      const chunks: Buffer[] = [];
      for await (const chunk of audioStream) {
        chunks.push(chunk);
      }
      
      const audioBuffer = Buffer.concat(chunks);
      console.log("ElevenLabs speech generation completed");
      return audioBuffer;
    } catch (elevenLabsError) {
      console.error("Both Google TTS and ElevenLabs failed. Google TTS API not enabled, ElevenLabs authentication failed:", (elevenLabsError as Error).message);
      throw new Error("Failed to generate speech - Google TTS API not enabled and ElevenLabs authentication failed. Browser TTS will be used as fallback.");
    }
  }
}

export async function getAvailableVoices() {
  try {
    const voices = await elevenlabs.voices.getAll();
    return voices;
  } catch (error) {
    console.error("Error fetching voices:", error);
    return [];
  }
}