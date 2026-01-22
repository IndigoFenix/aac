import { GoogleGenAI } from "@google/genai";
import { studentService } from "../studentService";
import type { AACKnownPerson } from "@shared/schema";

const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

interface PersonAnalysis {
  personDetected: boolean;
  isMainUser: boolean;
  confidence: number;
  description: string;
  newPerson?: {
    age: string;
    gender: string;
    description: string;
    suggestedRole: string;
  };
}

export async function detectPersonInImage(base64Image: string): Promise<boolean> {
  try {
    const contents = [
      {
        inlineData: {
          data: base64Image,
          mimeType: "image/jpeg",
        },
      },
      `Analyze this image and determine if there is a person visible in the frame.

Respond with a simple JSON object:
{
  "personDetected": true/false,
  "confidence": 0.0-1.0,
  "description": "Brief description of what you see"
}

Look for:
- Human faces, bodies, or silhouettes
- People partially visible in the frame
- Any human presence, even if not fully visible

Return true only if you can clearly identify human presence.`,
    ];

    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: contents,
    });

    let responseText = response.text || "{}";
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    const result = JSON.parse(responseText);
    console.log("Person detection result:", result);

    return result.personDetected === true && result.confidence > 0.7;
  } catch (error) {
    console.error("Error detecting person:", error);
    // If detection fails, assume no person to be safe
    return false;
  }
}

/**
 * Analyze person and role in image for AAC context
 * Uses studentId to get student profile instead of userId
 */
export async function analyzePersonAndRole(base64Image: string, studentId: string): Promise<PersonAnalysis> {
  try {
    // Get student profile to understand who the main user is
    const student = await studentService.getStudentById(studentId);
    if (!student) {
      throw new Error("Student not found");
    }

    const studentAge = student.age || "unknown age";
    const studentGender = student.gender || "unknown gender";
    const knownPeople = (student.aacKnownPeople as AACKnownPerson[]) || [];

    const contents = [
      {
        inlineData: {
          data: base64Image,
          mimeType: "image/jpeg",
        },
      },
      `Analyze this image to understand who is present and their relationship to the main AAC user.

MAIN USER PROFILE:
- Age: ${studentAge} years old
- Gender: ${studentGender}
- Known people: ${knownPeople.length > 0 ? knownPeople.map(p => `${p.name} (${p.relationship})`).join(', ') : 'None registered'}

Analyze the image and respond with JSON:
{
  "personDetected": true/false,
  "isMainUser": true/false,
  "confidence": 0.0-1.0,
  "description": "Description of person(s) visible",
  "newPerson": {
    "age": "estimated age range (child/teen/adult/elderly)",
    "gender": "male/female/unknown",
    "description": "physical description",
    "suggestedRole": "parent/caregiver/sibling/friend/therapist/teacher/unknown"
  }
}

Guidelines:
- isMainUser should be true only if the person matches the main user's age and gender profile
- If you see someone who doesn't match the main user profile, they are likely a caregiver/family member
- newPerson should only be included if this appears to be someone not in the known people list
- Consider age appropriateness (a 7-year-old vs adult is very different)`,
    ];

    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: contents,
    });

    let responseText = response.text || "{}";
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    const result = JSON.parse(responseText);
    console.log("Person and role analysis:", result);

    return {
      personDetected: result.personDetected === true,
      isMainUser: result.isMainUser === true,
      confidence: Math.max(0, Math.min(1, result.confidence || 0)),
      description: result.description || "Person detected",
      newPerson: result.newPerson
    };
  } catch (error) {
    console.error("Error analyzing person and role:", error);
    return {
      personDetected: false,
      isMainUser: false,
      confidence: 0,
      description: "Analysis failed"
    };
  }
}
