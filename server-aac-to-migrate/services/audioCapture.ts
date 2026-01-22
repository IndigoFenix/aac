import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';

// Initialize Gemini AI client with API key authentication
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

console.log('Initialized Gemini API client for audio analysis');

export interface AudioContext {
  transcript: string;
  detectedLanguage?: string;
  confidence: number;
  ambientSounds: string[];
  speechPresent: boolean;
  timestamp: Date;
}

export class AudioCaptureService {
  private isRecording = false;
  private recordingTimeout: NodeJS.Timeout | null = null;

  /**
   * Process audio file using Gemini API
   */
  async processAudioFile(audioFilePath: string): Promise<AudioContext> {
    try {
      console.log('Processing audio with Gemini API...');
      
      // Check if file exists
      if (!fs.existsSync(audioFilePath)) {
        throw new Error(`Audio file not found: ${audioFilePath}`);
      }

      // Get file stats for validation
      const stats = fs.statSync(audioFilePath);
      console.log(`Audio file size: ${stats.size} bytes`);

      // Read audio file as base64
      const audioBytes = fs.readFileSync(audioFilePath);
      const audioBase64 = audioBytes.toString('base64');

      // Use Gemini 2.5 Flash for audio analysis
      const model = genAI.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  data: audioBase64,
                  mimeType: "audio/webm", // WebM format from MediaRecorder
                },
              },
              {
                text: `Analyze this audio file and provide a comprehensive analysis. Please respond with a JSON object containing:
                {
                  "transcript": "exact transcription of any speech/words heard",
                  "detectedLanguage": "detected language code (en, he, es, fr, etc.)",
                  "confidence": number between 0-1 indicating transcription quality,
                  "speechPresent": boolean indicating if human speech was detected,
                  "ambientSounds": array of detected background sounds like ["music", "typing", "traffic", "conversation", "machinery", "water", "wind", etc.],
                  "emotionalTone": "detected emotional tone of speech if present",
                  "speakerCount": estimated number of speakers,
                  "audioQuality": "clear/muffled/noisy/quiet"
                }
                
                Be precise with the transcript - include every word you can clearly hear. For ambient sounds, focus on environmental context that would be useful for understanding the user's situation. If no speech is detected, leave transcript empty but still analyze ambient sounds.`
              }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json"
        }
      });

      const response = await model;
      const analysisText = response.text;

      if (!analysisText) {
        throw new Error('No response from Gemini API');
      }

      // Parse the JSON response
      let analysis;
      try {
        analysis = JSON.parse(analysisText);
      } catch (parseError) {
        console.error('Failed to parse Gemini response as JSON:', analysisText);
        throw new Error('Invalid JSON response from Gemini API');
      }

      const transcript = analysis.transcript || '';
      const detectedLanguage = analysis.detectedLanguage || 'en';
      const confidence = Math.max(0, Math.min(1, analysis.confidence || 0));
      const speechPresent = analysis.speechPresent || transcript.trim().length > 0;
      const ambientSounds = Array.isArray(analysis.ambientSounds) ? analysis.ambientSounds : [];

      console.log(`Gemini audio analysis completed: "${transcript}"`);
      console.log(`Detected language: ${detectedLanguage}, Speech present: ${speechPresent}`);
      console.log(`Confidence: ${confidence}, Ambient sounds:`, ambientSounds);
      console.log(`Additional details - Emotional tone: ${analysis.emotionalTone}, Speaker count: ${analysis.speakerCount}, Audio quality: ${analysis.audioQuality}`);

      return {
        transcript,
        detectedLanguage,
        confidence,
        ambientSounds,
        speechPresent,
        timestamp: new Date()
      };

    } catch (error) {
      console.error('Error processing audio with Gemini API:', error);
      console.log('Falling back to basic audio analysis...');
      
      // Provide basic fallback analysis when Gemini fails
      const fallbackAnalysis = this.provideFallbackAnalysis(audioFilePath);
      return {
        transcript: '',
        confidence: 0.1, // Low confidence for fallback
        ambientSounds: fallbackAnalysis.ambientSounds,
        speechPresent: fallbackAnalysis.speechPresent,
        timestamp: new Date()
      };
    }
  }

  /**
   * Process audio buffer directly
   */
  async processAudioBuffer(audioBuffer: Buffer, filename: string = 'audio.wav'): Promise<AudioContext> {
    try {
      // Create temporary file
      const tempDir = path.join(process.cwd(), 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const tempFilePath = path.join(tempDir, `${Date.now()}_${filename}`);
      
      // Write buffer to temporary file
      fs.writeFileSync(tempFilePath, audioBuffer);
      
      // Process the file
      const result = await this.processAudioFile(tempFilePath);
      
      // Clean up temporary file
      try {
        fs.unlinkSync(tempFilePath);
      } catch (cleanupError) {
        console.warn('Failed to clean up temporary audio file:', cleanupError);
      }
      
      return result;

    } catch (error) {
      console.error('Error processing audio buffer:', error);
      return {
        transcript: '',
        confidence: 0,
        ambientSounds: [],
        speechPresent: false,
        timestamp: new Date()
      };
    }
  }





  /**
   * Start continuous audio monitoring (placeholder for future implementation)
   */
  async startContinuousMonitoring(intervalMs: number = 10000): Promise<void> {
    if (this.isRecording) {
      console.log('Audio monitoring already active');
      return;
    }

    this.isRecording = true;
    console.log(`Starting continuous audio monitoring every ${intervalMs}ms`);
    
    // This would integrate with actual audio capture in a real implementation
    // For now, we'll just log that monitoring has started
    this.recordingTimeout = setTimeout(() => {
      this.stopContinuousMonitoring();
    }, 300000); // Stop after 5 minutes by default
  }

  /**
   * Stop continuous audio monitoring
   */
  stopContinuousMonitoring(): void {
    if (this.recordingTimeout) {
      clearTimeout(this.recordingTimeout);
      this.recordingTimeout = null;
    }
    this.isRecording = false;
    console.log('Audio monitoring stopped');
  }

  /**
   * Get current recording status
   */
  getRecordingStatus(): boolean {
    return this.isRecording;
  }

  /**
   * Provide basic fallback analysis when Whisper is unavailable
   */
  private provideFallbackAnalysis(audioFilePath: string): { ambientSounds: string[], speechPresent: boolean } {
    try {
      const stats = fs.statSync(audioFilePath);
      const fileSizeKb = stats.size / 1024;
      
      // Basic heuristics based on file size and duration estimation
      const estimatedDurationSeconds = fileSizeKb / 16; // Rough estimate for compressed audio
      
      let ambientSounds: string[] = [];
      let speechPresent = false;
      
      // Simple heuristics - in a real implementation, this could use Web Audio API analysis
      if (fileSizeKb > 50) { // Larger files likely have more content
        ambientSounds.push('activity_detected');
        speechPresent = true;
      } else if (fileSizeKb > 20) {
        ambientSounds.push('ambient_noise');
      }
      
      if (estimatedDurationSeconds > 10) {
        ambientSounds.push('extended_audio');
      }
      
      return { ambientSounds, speechPresent };
      
    } catch (error) {
      console.error('Fallback analysis failed:', error);
      return { ambientSounds: ['unknown'], speechPresent: false };
    }
  }
}

export const audioCaptureService = new AudioCaptureService();