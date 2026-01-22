import { detectPersonWithVertex } from './vertexai';

interface UserCameraDetectionResult {
  personPresent: boolean;
  isMainUser: boolean;
  detectedAge: number | null;
  detectedGender: string;
  facialExpression: string;
  emotionalState: string;
  confidence: number;
  cameraType: 'user' | 'environment' | 'unknown';
}

/**
 * Detect main user specifically from user-facing camera only
 * This ensures system standby mode only exits when main user is detected on the appropriate camera
 */
export async function detectMainUserFromUserCamera(
  imageBuffer: Buffer,
  expectedAge?: number,
  expectedGender?: string,
  cameraType: 'user' | 'environment' | 'unknown' = 'unknown'
): Promise<UserCameraDetectionResult> {
  
  console.log(`Detecting person from ${cameraType} camera`);
  
  // PRIORITY: Integrated camera should be the primary source for main user validation
  // Only perform full main user detection from user-facing cameras (integrated camera)
  if (cameraType === 'user') {
    console.log(`Performing primary main user detection on integrated camera for user validation`);
    console.log(`Performing main user identification on integrated camera with expected: age ${expectedAge}, gender ${expectedGender}`);
  } else {
    console.log(`Performing secondary detection on ${cameraType} camera - environment analysis only`);
    console.log(`Environmental camera person detection with expected: age ${expectedAge}, gender ${expectedGender}`);
  }
  
  const detection = await detectPersonWithVertex(imageBuffer, expectedAge, expectedGender);
  
  return {
    personPresent: detection.personPresent,
    isMainUser: cameraType === 'user' ? detection.isMainUser : false, // Only validate main user from integrated camera
    detectedAge: detection.detectedAge || null,
    detectedGender: detection.detectedGender || 'unknown',
    facialExpression: detection.facialExpression || 'unknown',
    emotionalState: detection.emotionalState || 'No detection',
    confidence: detection.confidence,
    cameraType
  };
}

/**
 * Determine camera type from device label
 */
export function determineCameraType(deviceLabel: string): 'user' | 'environment' | 'unknown' {
  const label = deviceLabel.toLowerCase();
  
  // Priority: Integrated cameras are always user-facing for main user validation
  if (label.includes('integrated') || label.includes('builtin') || label.includes('built-in')) {
    return 'user';
  }
  
  // External cameras are typically environment-facing
  if (label.includes('hd webcam') || label.includes('usb') || label.includes('external')) {
    return 'environment';
  }
  
  // Standard patterns
  if (label.includes('front') || label.includes('user') || label.includes('facetime')) {
    return 'user';
  } else if (label.includes('back') || label.includes('rear') || label.includes('environment')) {
    return 'environment';
  }
  
  return 'unknown';
}