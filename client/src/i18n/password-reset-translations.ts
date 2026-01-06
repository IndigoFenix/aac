// Add these translations to your en.ts and he.ts files

// ============= ENGLISH TRANSLATIONS =============
export const passwordResetTranslationsEN = {
  auth: {
    // Forgot Password Page
    forgotPassword: 'Forgot Password?',
    forgotPasswordDesc: "Enter your email address and we'll send you a link to reset your password.",
    sendResetLink: 'Send Reset Link',
    sending: 'Sending...',
    emailRequired: 'Email is required',
    invalidEmail: 'Please enter a valid email address',
    
    // Check Email (after submission)
    checkEmail: 'Check Your Email',
    resetEmailSent: "If an account exists with this email, we've sent a password reset link.",
    sentTo: 'Sent to',
    checkSpam: "Don't see it? Check your spam folder or try again with a different email.",
    tryDifferentEmail: 'Try a different email',
    
    // Invalid Token
    invalidResetLink: 'Invalid Reset Link',
    invalidResetLinkDesc: 'This password reset link is invalid or has expired. Please request a new one.',
    requestNewLink: 'Request New Link',
    validatingLink: 'Validating reset link...',
    
    // Reset Password Form
    resetPassword: 'Reset Password',
    resetPasswordDesc: 'Enter your new password below.',
    resettingFor: 'Resetting password for',
    newPassword: 'New Password',
    newPasswordPlaceholder: 'Enter new password',
    resetPasswordButton: 'Reset Password',
    resetting: 'Resetting...',
    
    // Password validation
    passwordRequired: 'Password is required',
    passwordTooShort: 'Password must be at least 6 characters',
    passwordMismatch: 'Passwords do not match',
    passwordStrength: 'Strength',
    passwordRequirements: 'Password requirements',
    minCharacters: 'At least 6 characters',
    
    // Success
    passwordResetSuccess: 'Password Reset!',
    passwordResetSuccessDesc: 'Your password has been updated successfully. You can now log in with your new password.',
    goToLogin: 'Go to Login',
    
    // Errors
    passwordResetFailed: 'Failed to reset password',
  },
};

// ============= HEBREW TRANSLATIONS =============
export const passwordResetTranslationsHE = {
  auth: {
    // Forgot Password Page
    forgotPassword: 'שכחת סיסמה?',
    forgotPasswordDesc: 'הזן את כתובת האימייל שלך ונשלח לך קישור לאיפוס הסיסמה.',
    sendResetLink: 'שלח קישור איפוס',
    sending: 'שולח...',
    emailRequired: 'נדרש אימייל',
    invalidEmail: 'נא להזין כתובת אימייל תקינה',
    
    // Check Email (after submission)
    checkEmail: 'בדוק את האימייל שלך',
    resetEmailSent: 'אם קיים חשבון עם אימייל זה, שלחנו קישור לאיפוס הסיסמה.',
    sentTo: 'נשלח אל',
    checkSpam: 'לא רואה? בדוק את תיקיית הספאם או נסה שוב עם אימייל אחר.',
    tryDifferentEmail: 'נסה אימייל אחר',
    
    // Invalid Token
    invalidResetLink: 'קישור איפוס לא תקין',
    invalidResetLinkDesc: 'קישור איפוס הסיסמה לא תקין או שפג תוקפו. אנא בקש קישור חדש.',
    requestNewLink: 'בקש קישור חדש',
    validatingLink: 'מאמת קישור איפוס...',
    
    // Reset Password Form
    resetPassword: 'איפוס סיסמה',
    resetPasswordDesc: 'הזן את הסיסמה החדשה שלך למטה.',
    resettingFor: 'מאפס סיסמה עבור',
    newPassword: 'סיסמה חדשה',
    newPasswordPlaceholder: 'הזן סיסמה חדשה',
    resetPasswordButton: 'אפס סיסמה',
    resetting: 'מאפס...',
    
    // Password validation
    passwordRequired: 'נדרשת סיסמה',
    passwordTooShort: 'הסיסמה חייבת להכיל לפחות 6 תווים',
    passwordMismatch: 'הסיסמאות אינן תואמות',
    passwordStrength: 'חוזק',
    passwordRequirements: 'דרישות סיסמה',
    minCharacters: 'לפחות 6 תווים',
    
    // Success
    passwordResetSuccess: 'הסיסמה אופסה!',
    passwordResetSuccessDesc: 'הסיסמה שלך עודכנה בהצלחה. כעת תוכל להתחבר עם הסיסמה החדשה.',
    goToLogin: 'עבור להתחברות',
    
    // Errors
    passwordResetFailed: 'איפוס הסיסמה נכשל',
  },
};
