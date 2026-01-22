import { generateSpeechWithGoogle } from './googleTTS';
import { generateSpeech } from './elevenlabs';

interface UserProfile {
  age?: number;
  gender?: string;
  voiceType?: string; // auto, man, woman, boy, girl
}

/**
 * Chat Agent Voice - Always uses female voice regardless of user profile
 */
export async function generateChatAgentVoice(
  text: string,
  language: string = "en"
): Promise<Buffer> {
  try {
    // Remove emojis from text before speech generation
    const cleanText = text.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim();
    console.log(`Generating chat agent voice (female): ${cleanText.substring(0, 50)}...`)
    
    // Chat agent always uses female voice
    const chatAgentProfile = {
      age: 30, // Adult voice
      gender: 'female' // Always female for chat agent
    };
    
    // Try Google TTS first for chat agent
    try {
      return await generateSpeechWithGoogle(cleanText, language, chatAgentProfile);
    } catch (googleError) {
      console.log("Google TTS failed for chat agent, trying ElevenLabs...", googleError);
      
      // Fallback to ElevenLabs with female voice
      const voiceId = language === "he" ? "pNInz6obpgDQGcFmaJgB" : "EXAVITQu4vr4xnSDxMaL"; // Female voices
      return await generateSpeech(cleanText, language);
    }
  } catch (error) {
    console.error("All chat agent voice generation failed:", error);
    throw error;
  }
}

/**
 * User Symbol Voice - Uses age/gender matching based on user profile
 */
export async function generateUserSymbolVoice(
  text: string,
  language: string = "en",
  userProfile?: UserProfile
): Promise<Buffer> {
  try {
    console.log(`Generating user symbol voice (age: ${userProfile?.age}, gender: ${userProfile?.gender}, voiceType: ${userProfile?.voiceType}): ${text.substring(0, 50)}...`);
    
    // Override age/gender based on voiceType setting if specified
    let effectiveProfile = { ...userProfile };
    if (userProfile?.voiceType && userProfile.voiceType !== "auto") {
      switch (userProfile.voiceType) {
        case "man":
          effectiveProfile = { ...userProfile, age: 30, gender: "male" };
          break;
        case "woman":
          effectiveProfile = { ...userProfile, age: 30, gender: "female" };
          break;
        case "boy":
          effectiveProfile = { ...userProfile, age: 12, gender: "male" };
          break;
        case "girl":
          effectiveProfile = { ...userProfile, age: 12, gender: "female" };
          break;
      }
    }
    
    // Use effective profile for symbol responses
    try {
      return await generateSpeechWithGoogle(text, language, effectiveProfile);
    } catch (googleError) {
      console.log("Google TTS failed for user symbols, trying ElevenLabs...", googleError);
      
      // Fallback to ElevenLabs with appropriate voice
      let voiceId: string;
      const isChild = effectiveProfile?.age && effectiveProfile.age < 18;
      const isMale = effectiveProfile?.gender === 'male';
      
      if (language === "he") {
        // Hebrew voices
        if (isChild) {
          voiceId = isMale ? "pNInz6obpgDQGcFmaJgB" : "pNInz6obpgDQGcFmaJgB"; // Use best available
        } else {
          voiceId = isMale ? "pNInz6obpgDQGcFmaJgB" : "pNInz6obpgDQGcFmaJgB"; // Use best available
        }
      } else {
        // English voices
        if (isChild) {
          voiceId = isMale ? "ErXwobaYiN019PkySvjV" : "EXAVITQu4vr4xnSDxMaL"; // Boy/Girl
        } else {
          voiceId = isMale ? "VR6AewLTigWG4xSOukaG" : "EXAVITQu4vr4xnSDxMaL"; // Man/Woman
        }
      }
      
      return await generateSpeech(text, language, userProfile);
    }
  } catch (error) {
    console.error("All user symbol voice generation failed:", error);
    throw error;
  }
}