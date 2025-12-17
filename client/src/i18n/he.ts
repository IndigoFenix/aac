// src/i18n/he.ts
// Hebrew translations (עברית)

export const he = {
  // ============================================================================
  // APP
  // ============================================================================
  app: {
    title: "CliniAACian",
    subtitle: 'כלי עזר מתקדם לפרוש תקשורת תומכת חלופית (תת"ח).',
  },

  // ============================================================================
  // COMMON
  // ============================================================================
  common: {
    loading: "טוען...",
    error: "שגיאה",
    success: "הצלחה",
    save: "שמור",
    cancel: "ביטול",
    delete: "מחק",
    edit: "ערוך",
    close: "סגור",
    back: "חזור",
    next: "הבא",
    submit: "שלח",
    search: "חיפוש",
    filter: "סינון",
    clear: "נקה",
    confirm: "אישור",
    yes: "כן",
    no: "לא",
    ok: "אישור",
    send: "שלח",
    retry: "נסה שוב",
    refresh: "רענן",
    start: "התחלה",
    continue: "המשך",
    add: "הוסף",
  },

  // ============================================================================
  // AUTH
  // ============================================================================
  auth: {
    login: "התחברות",
    logout: "התנתקות",
    signUp: "הרשמה",
    email: "אימייל",
    password: "סיסמה",
    forgotPassword: "שחזור סיסמה",
    rememberMe: "זכור אותי",
    noAccount: "אין חשבון? הירשמו כאן",
    hasAccount: "חשבון קיים? התחברו",
    loginSuccess: "התחברות הצליחה",
    logoutSuccess: "ההתנתקות הצליחה",
    invalidCredentials: "אימייל או סיסמה שגויים",
    loginTitle: "התחברות",
    loginDescription: "הכניסו כתובת האימייל והסיסמה כדי לגשת לחשבון",
    emailPlaceholder: "אימייל",
    passwordPlaceholder: "סיסמה",
    loginWithEmail: "התחברות",
    googleLogin: "המשך עם Google",
    or: "או",
    inactive: "בקרוב",
    googleDisabled: "התחברות עם Google אינה פעילה כרגע",
    loggingIn: "מתחבר...",
    error: "שגיאה",
    fieldsRequired: "אנא מלאו את כל השדות",
    welcomeBack: "ברוך הבא!",
    loginFailed: "ההתחברות נכשלה",
    loginError: "אירעה שגיאה במהלך ההתחברות",
    registerTitle: "יצירת חשבון",
    firstName: "שם פרטי",
    lastName: "שם משפחה",
    firstNamePlaceholder: "שם פרטי",
    lastNamePlaceholder: "שם משפחה",
    confirmPassword: "אימות סיסמה",
    confirmPasswordPlaceholder: "אימות סיסמה",
    registerButton: "יצירת חשבון",
    registering: "יוצר חשבון...",
    backToLogin: "חשבון קיים? התחברו",
    passwordMismatch: "הסיסמאות אינן תואמות",
    registerSuccess: "החשבון נוצר בהצלחה",
    registerSuccessDesc: "החשבון נוצר. כעת ניתן להתחבר.",
    registerFailed: "הרשמה נכשלה",
    registerError: "אירעה שגיאה במהלך הרשמה",
  },

  // ============================================================================
  // NAVIGATION
  // ============================================================================
  nav: {
    main: "קליניאאקיאן",
    interpret: "קומיוניאאקט",
    boards: "לוחות סינטאאקס",
    docuslp: "דוחות דוקיוסאלפי",
    settings: "הגדרות",
    workspace: "סביבת עבודה",
    toggleSidebar: "החלף סרגל צד",
    overview: "סקירה כללית",
    students: "תלמידים",
    progress: "התקדמות תלמידים",
    currentStudent: "תלמיד נוכחי",
    studentManagement: "ניהול תלמידים",
  },

  // ============================================================================
  // HEADER
  // ============================================================================
  header: {
    title: "סביבת עבודה AAC",
    student: "תלמיד",
    selectStudent: "בחר תלמיד",
    noStudents: "אין משתמשי AAC",
    loadingStudents: "טוען תלמידים...",
    credits: "קרדיטים",
    active: "פעיל",
    admin: "פאנל ניהול",
  },

  // ============================================================================
  // CHAT
  // ============================================================================
  chat: {
    placeholder: "שאל את קליניאאקיאן",
    placeholderWithUser: "שאל על {name}...",
    greeting: {
      morning: "בוקר טוב",
      afternoon: "צהריים טובים",
      evening: "ערב טוב",
    },
    welcomeMessage: "מה אתה צריך לעשות היום?",
    welcomeWithUser: "איך אני יכול לעזור לך עם {name} היום?",
    workingWith: "עובד כרגע עם:",
    newConversation: "התחל שיחה חדשה",
    addAttachment: "הוסף קובץ מצורף",
    tools: "כלים",
    voiceInput: "קלט קולי",
    sendMessage: "שלח הודעה",
    suggestions: {
      communicationPrefs: "העדפות תקשורת",
      milestones: "הצעות לאבני דרך",
      dailyTips: "טיפים לתמיכה יומית",
    },
    prompts: {
      communicationPrefs: "ספר לי על העדפות התקשורת של {name}",
      milestones: "על אילו אבני דרך כדאי לעבוד עם {name}?",
      dailyTips: "איך אני יכול לתמוך טוב יותר בתקשורת של {name} היום?",
    },
    typing: "מקליד...",
    error: "שליחת ההודעה נכשלה",
    assistant: "עוזר",
    popupMode: "צף",
    switchToPopup: "עבור למצב צף",
    expandMode: "הרחב צ׳אט",
    minimize: "מזער",
    popupWelcome: "התחל שיחה...",
    placeholderShort: "הקלד הודעה...",
  },

  // ============================================================================
  // INPUT (CommuniAACte)
  // ============================================================================
  input: {
    text: "טקסט",
    textAnalysis: "מה תרצו לפרש?",
    image: "תמונה",
    textPlaceholder: "הקלידו/הדביקו כאן את הטקסט לניתוח...",
    imageChoose: "בחירת קובץ",
    imageSelected: "נבחר: {filename} (לחיצה לחיתוך)",
    original: "קלט מקורי",
    imageCropped: "תצוגה מקדימה של תמונה חתוכה:",
  },

  // ============================================================================
  // BUTTONS (Actions)
  // ============================================================================
  button: {
    interpret: "פירוש תקשורת",
    processImage: "עיבוד תמונה ופירוש",
    processing: "מעבד...",
    clear: "נקה",
    save: "שמור",
    delete: "מחק",
    cancel: "ביטול",
    applyCrop: "החלת חיתוך",
    start: "התחלה",
    editor: "עורך כפתורים",
    editProperties: "ערוך מאפיינים",
    newButton: "כפתור חדש",
    label: "תווית",
    labelPlaceholder: "טקסט הכפתור",
    spokenText: "טקסט מדובר",
    spokenTextPlaceholder: "טקסט להשמעה",
    color: "צבע",
    icon: "אייקון",
    iconPlaceholder: "לדוגמה: fas fa-home",
    chooseIcon: "בחר אייקון",
    upload: "העלה",
    action: "פעולה",
    actionSpeak: "השמע טקסט",
    actionJump: "דלג לעמוד",
    actionBack: "חזור",
    actionHome: "חזור לעמוד הבית",
    actionYoutube: "נגן YouTube",
    textToSpeak: "טקסט להשמעה",
    videoId: "מזהה סרטון (למשל dQw4w9WgXcQ)",
    videoTitle: "כותרת הסרטון",
    target: "יעד",
    noBoard: "אין לוח",
    notSet: "לא הוגדר",
    choosePage: "בחר עמוד",
    chooseTargetPage: "בחר עמוד יעד",
    selectPageToJump: "בחר עמוד לניווט.",
    goToPage: "עבור לעמוד",
    backDescription: "חזרה לעמוד שנצפה קודם.",
    homeDescription: "קפיצה לעמוד הראשון בלוח.",
    selfClosing: "סגירה עצמית",
    selfClosingDescription: "חזרה אוטומטית לאחר לחיצה",
    position: "מיקום",
    row: "שורה",
    column: "עמודה",
    duplicate: "שכפל",
  },

  // ============================================================================
  // CROP
  // ============================================================================
  crop: {
    title: "חיתוך תמונה לניתוח טוב יותר",
    description: "חיתכו את התמונה להתמקד באזור התקשורת המסייעת לדיוק פרשנות טוב יותר.",
  },

  // ============================================================================
  // RESULT
  // ============================================================================
  result: {
    interpretation: "פרשנות",
    meaning: "משמעות מפורשת",
    meaningShort: "פרשנות",
    aacText: "טקסט תת״ח",
    analysis: "ניתוח",
    confidence: "רמת ביטחון",
    suggestedResponse: "תגובה מוצעת",
    confidenceHigh: "רמת ביטחון גבוהה",
    confidenceMedium: "רמת ביטחון בינונית",
    confidenceLow: "רמת ביטחון נמוכה",
  },

  // ============================================================================
  // SHARE
  // ============================================================================
  share: {
    title: "שיתוף תוצאות",
    whatsapp: "וואטסאפ",
    copy: "העתקת טקסט",
    email: "אימייל",
  },

  // ============================================================================
  // CONTEXT
  // ============================================================================
  context: {
    title: "הוספת מידע הקשר",
    description: "מתן הקשר עוזר לשיפור דיוק הפרשנות. כל השדות הם אופציונליים.",
    time: "זמן",
    timePlaceholder: "מתי נאמרה התקשורת הזו?",
    useCurrentTime: "שימוש בזמן הנוכחי",
    location: "מיקום",
    locationPlaceholder: "איפה נאמרה התקשורת הזו?",
    useCurrentLocation: "שימוש במיקום הנוכחי (GPS)",
    background: "הקשר רקע",
    backgroundPlaceholder: "מצב כללי או סביבה כשזה התקשר...",
    previousEvents: "אירועים קודמים",
    previousEventsPlaceholder: "מה קרה לפני התקשורת הזו?",
    futureEvents: "אירועים עתידיים",
    futureEventsPlaceholder: "אירועים עתידיים שעלולים להיות קשורים?",
    cancel: "ביטול",
    continue: "המשך לפרשנות",
  },

  // ============================================================================
  // HISTORY
  // ============================================================================
  history: {
    title: "פרשנויות אחרונות",
    empty: "אין עדיין פרשנויות. נסה לפרש תקשורת מסייעת כלשהי!",
    origin: "מקור",
    text: "טקסט",
    image: "תמונה",
  },

  // ============================================================================
  // TOAST NOTIFICATIONS
  // ============================================================================
  toast: {
    invalidFile: "סוג קובץ לא תקין",
    invalidFileDesc: "אנא בחר קובץ תמונה תקין (JPG, PNG, וכו')",
    imageRequired: "דרושה תמונה",
    imageRequiredDesc: "אנא בחרו וחיתכו קובץ תמונה לפרשנות.",
    textRequired: "דרוש טקסט",
    textRequiredDesc: "אנא הכניסו טקסט לפרשנות.",
    imageCropped: "תמונה נחתכה",
    imageCroppedDesc: "התמונה נחתכה ומוכנה לפרשנות.",
    cropFailed: "חיתוך נכשל",
    cropFailedDesc: "נכשל בחיתוך התמונה. אנא נסו שוב.",
    saved: "נשמר",
    savedDesc: "הפרשנות נשמרה בהצלחה.",
    deleted: "נמחק",
    deletedDesc: "הפרשנות נמחקה.",
    copied: "הועתק",
    copiedDesc: "תוצאות הפרשנות הועתקו ללוח.",
    copyFailed: "העתקה נכשלה",
    copyFailedDesc: "כשלון בהעתקה ללוח. אנא נסו שוב.",
    // AAC User management
    studentCreated: "משתמש.ת תת״ח נוצר",
    studentCreatedDesc: "משתמש.ת תת״ח חדש נוסף בהצלחה",
    studentCreateFailed: "יצירת משתמש.ת נכשלה",
    studentCreateFailedDesc: "לא ניתן ליצור משתמש.ת תת״ח",
    studentUpdated: "משתמש.ת תת״ח עודכן",
    studentUpdatedDesc: "פרטי משתמש.ת תת״ח עודכנו בהצלחה",
    studentUpdateFailed: "עדכון נכשל",
    studentUpdateFailedDesc: "לא ניתן לעדכן משתמש.ת תת״ח",
    studentDeleted: "משתמש.ת תת״ח נמחק",
    studentDeletedDesc: "משתמש.ת תת״ח הוסר בהצלחה",
    studentDeleteFailed: "מחיקה נכשלה",
    studentDeleteFailedDesc: "לא ניתן למחוק משתמש.ת תת״ח",
    // Profile management
    profileUpdated: "פרופיל עודכן",
    profileUpdatedDesc: "הפרופיל שלך עודכן בהצלחה",
    profileUpdateFailed: "עדכון נכשל",
    profileUpdateFailedDesc: "לא ניתן לעדכן פרופיל",
    imageUploaded: "תמונה הועלתה",
    imageUploadedDesc: "תמונת הפרופיל שלך עודכנה בהצלחה",
    imageUploadFailed: "העלאה נכשלה",
    imageUploadFailedDesc: "לא ניתן להעלות תמונה",
    // Invite code management
    inviteCreated: "קוד הזמנה נוצר",
    inviteCreatedDesc: "קוד ההזמנה נוצר בהצלחה",
    inviteCreateFailed: "יצירת קוד נכשלה",
    inviteCreateFailedDesc: "לא ניתן ליצור קוד הזמנה",
    inviteRedeemed: "קוד הזמנה מומש",
    inviteRedeemedDesc: 'משתמש.ת תת״ח "{alias}" נוסף בהצלחה',
    inviteRedeemFailed: "מימוש קוד נכשל",
    inviteRedeemFailedDesc: "לא ניתן למימוש קוד הזמנה",
    inviteDeleted: "קוד הזמנה נמחק",
    inviteDeletedDesc: "קוד ההזמנה הוסר בהצלחה",
    inviteDeleteFailed: "מחיקה נכשלה",
    inviteDeleteFailedDesc: "לא ניתן למחוק קוד הזמנה",
    // Location management
    locationSaved: "מיקום נשמר",
    locationSavedDesc: "המיקום נשמר בהצלחה",
    locationSaveFailed: "שמירה נכשלה",
    locationSaveFailedDesc: "לא ניתן לשמור מיקום",
    locationDeleted: "מיקום נמחק",
    locationDeletedDesc: "המיקום הוסר בהצלחה",
    locationDeleteFailed: "מחיקה נכשלה",
    locationDeleteFailedDesc: "לא ניתן למחוק מיקום",
    // Interpretation
    interpretationSuccess: "תקשורת פורשה",
    interpretationSuccessDesc: "התקשורת התומכת חלופית נותחה בהצלחה.",
    interpretationFailed: "פרשנות נכשלה",
    interpretationFailedDesc: "לא ניתן לפרש את התקשורת.",
    imageProcessed: "תמונה עובדה",
    imageProcessedDesc: "התמונה עובדה ופורשה בהצלחה.",
    imageProcessingFailed: "עיבוד תמונה נכשל",
    imageProcessingFailedDesc: "לא ניתן לעבד את התמונה.",
  },

  // ============================================================================
  // UI LABELS
  // ============================================================================
  ui: {
    loading: "טוען...",
    creating: "יוצר...",
    redeeming: "מממש...",
    noStudents: "אין משתמשי תת״ח זמינים",
    createInviteCode: "יצירת קוד הזמנה",
    redeemInviteCode: "מימוש קוד הזמנה",
    enterInviteCode: "הזינו קוד הזמנה (8 תווים)",
    inviteCodePlaceholder: "לדוגמה: ABC12345",
    inviteCodeError: "קוד הזמנה חייב להכיל בדיוק 8 תווים",
    redeemCode: "מימוש קוד",
    myInviteCodes: "קודי ההזמנה שלי",
    showHide: "הצגה/הסתרה",
    created: "נוצר",
    redeemed: "מומש",
    copyInviteCode: "העתקת קוד הזמנה",
    deleteInviteCode: "מחיקת קוד הזמנה",
    noInviteCodes: "אין קודי הזמנה פעילים",
    close: "סגור",
  },

  // ============================================================================
  // LABELS
  // ============================================================================
  label: {
    student: "משתמש.ת תת״ח",
    age: "גיל",
    gender: "מגדר",
    condition: "אבחנה",
    backgroundContext: "רקע נוסף",
  },

  // ============================================================================
  // ERROR MESSAGES
  // ============================================================================
  error: {
    title: "שגיאה",
    selectStudent: 'חובה לבחור משתמש.ת תת"ח לפני המשך הפרשנות',
    locationUnavailable: "לא ניתן לקבל מיקום",
    generic: "משהו השתבש",
    networkError: "שגיאת רשת. אנא בדוק את החיבור שלך.",
    sessionExpired: "הסשן שלך פג. אנא התחבר שוב.",
    notFound: "לא נמצא",
    unauthorized: "לא מורשה",
    forbidden: "הגישה נדחתה",
  },

  // ============================================================================
  // BOARD (SyntAACx)
  // ============================================================================
  board: {
    title: "לוחות סינטאאקס",
    valid: "תקין",
    hasErrors: "מכיל שגיאות",
    pages: "עמודים",
    buttons: "כפתורים",
    newBoard: "לוח חדש",
    selectBoard: "בחר לוח",
    noBoards: "אין לוחות זמינים",
    generate: "צור",
    generating: "יוצר...",
    preview: "תצוגה מקדימה",
    edit: "עריכה",
    editMode: "מצב עריכה",
    previewMode: "מצב תצוגה",
    inspector: "בודק כפתורים",
    builder: "בניית לוח",
    settings: "הגדרות לוח",
    noBoard: "אין לוח",
    createEmptyBoard: "צור לוח ריק",
    manageBoards: "ניהול לוחות",
    saveBoard: "שמור לוח",
    saving: "שומר…",
    noBoardYet: "עדיין אין לוח",
    noBoardDescription: "השתמש בלוח ההנחיות כדי ליצור לוח AAC ראשון או ליצור לוח ריק",
    grid: "רשת",
    page: "עמוד",
    of: "מתוך",
    manage: "ניהול",
    addPage: "הוסף עמוד",
    untitledPage: "עמוד ללא שם",
    pagesInBoard: "העמודים בלוח זה",
    pagesDescription: "שנה שם, סדר או מחק עמודים. העמוד הראשון הוא עמוד הבית.",
    current: "נוכחי",
    home: "ראשי",
    open: "פתח",
    createdPages: "נוצרו עמודים וכפתורים עבור הלוח שלך.",
    updated: "הלוח עודכן עם כפתורים חדשים.",
    pagesAdded: "עמודים נוספו",
    boardUpdated: "הלוח עודכן",
    addedPagesDesc: "עמוד/ים חדשים נוספו.",
    updatedDesc: "עודכן עם כפתורים ותתי־עמודים חדשים.",
    generated: "לוח נוצר",
    generatedMultiPage: "נוצר לוח חדש עם מספר עמודים.",
    generatedSinglePage: "נוצר לוח חדש.",
    generateError: "מצטער, לא הצלחתי לייצר את זה. נסה שוב.",
    generationFailed: "היצירה נכשלה",
    somethingWrong: "אירעה שגיאה במהלך היצירה.",
    modes: {
      generate: "יצירה",
      select: "הלוחות שלי",
      history: "היסטוריה",
    },
    prompt: {
      title: "יוצר לוחות",
      placeholder: "תאר את הלוח שאתה רוצה ליצור...",
      generate: "צור לוח",
      description: "תאר את הלוח שתרצה ליצור",
      hint: "לחץ Enter לשליחה, Shift+Enter לשורה חדשה",
      example1: "לוח צרכים בסיסיים עם לאכול, לשתות, שירותים, עזרה",
      example2: "לוח רגשות עם שמח, עצוב, כועס, מפוחד",
      example3: "לוח בני משפחה עם אמא, אבא, אחות, אח",
      example4: "לוח פעילויות עם משחק, קריאה, טלוויזיה, מוזיקה",
    },
    save: "שמור לוח",
    saved: "נשמר",
    savedDesc: "הלוח נשמר בהצלחה",
    saveFailed: "שמירה נכשלה",
    saveFailedDesc: "לא ניתן לשמור את הלוח",
    unsaved: "לא נשמר",
    unsavedChanges: "שינויים לא נשמרו",
    unsavedChangesDesc: "יש שינויים שלא נשמרו בלוח זה.",
    discardChanges: "התעלם מהשינויים",
    saveAndSwitch: "שמור והחלף",
  },

  // ============================================================================
  // EXPORT
  // ============================================================================
  export: {
    title: "ייצוא",
    download: "הורדה",
    upload: "העלה לענן",
    uploadSuccess: "העלאה הצליחה",
    uploadSuccessDesc: "הקובץ הועלה ל־Dropbox",
    uploadFailed: "העלאה נכשלה",
    beta: "בטא",
  },

  // ============================================================================
  // SETTINGS
  // ============================================================================
  settings: {
    title: "הגדרות",
    subtitle: "נהל את ההעדפות שלך",
    darkMode: "מצב כהה",
    darkModeDesc: "השתמש בערכת נושא כהה להפחתת עומס על העיניים",
    language: "שפה",
    languageDesc: "בחר את שפת התצוגה",
    displayLanguage: "שפת תצוגה",
    displayLanguageDesc: "בחר את השפה לממשק",
    notifications: "התראות",
    notificationsDesc: "נהל את העדפות ההתראות שלך",
    emailNotifications: "התראות אימייל",
    emailNotificationsDesc: "קבל עדכונים באימייל",
    deadlineReminders: "תזכורות תאריכי יעד",
    deadlineRemindersDesc: "קבל התראות על תאריכי יעד מתקרבים",
    progressUpdates: "עדכוני התקדמות",
    progressUpdatesDesc: "קבל התראות על התקדמות תלמידים",
    account: "חשבון",
    privacy: "פרטיות",
    about: "אודות",
    profile: "פרופיל",
    profileDesc: "פרטי החשבון שלך",
    editProfile: "עריכת פרופיל",
    system: "הגדרות מערכת",
    systemDesc: "הגדר תהליך עבודה ואזור",
    workflowSystem: "מערכת עבודה",
    systemTala: "תל״א (ישראל)",
    systemUs: "US IEP",
    talaDescription: "תהליך חינוך מיוחד ישראלי",
    usIepDescription: "תוכנית חינוך אישית אמריקאית",
    appearance: "מראה",
    appearanceDesc: "התאם את המראה והתחושה",
    security: "אבטחה",
    securityDesc: "נהל את אבטחת החשבון שלך",
    changePassword: "שנה סיסמה",
    manageSessions: "נהל הפעלות",
  },

  // ============================================================================
  // FEATURES
  // ============================================================================
  features: {
    comingSoon: "בקרוב",
    docuslpDesc: "כתיבת דוקיוסאלפי",
  },

  // ============================================================================
  // LANGUAGE
  // ============================================================================
  language: {
    english: "English",
    hebrew: "עברית",
  },

  // ============================================================================
  // FOOTER
  // ============================================================================
  footer: {
    text: "מתמחה בפרשנות תקשורת מסייעת עם מומחיות בטיפול בדיבור",
  },

  // ============================================================================
  // OVERVIEW (Dashboard)
  // ============================================================================
  overview: {
    title: "לוח בקרה",
    subtitle: "מעקב אחר התקדמות תלמידים ומועדים קרובים",
    totalStudents: "סה״כ תלמידים",
    activeCases: "תיקים פעילים",
    activePlans: "תוכניות פעילות",
    completedCases: "הושלמו",
    completed: "הושלמו",
    pendingReview: "ממתינים לאישור",
    enrolled: "רשומים לתוכנית",
    fromLastMonth: "+2 מהחודש שעבר",
    ytd: "מתחילת השנה",
    attentionNeeded: "דורש תשומת לב",
    deadlineAlert: "מועדים מתקרבים",
    daysLeft: "ימים נותרו",
    deadlineDesc: "ל-{count} תלמידים יש מועדים מתקרבים",
    reviewBtn: "סקור הכל",
    chartTitle: "התפלגות לפי שלב",
    chartSubtitle: "התפלגות תלמידים לפי שלבי התהליך",
    priorityFocus: "עדיפות גבוהה",
    priorityDesc: "תלמידים הדורשים תשומת לב מיידית",
    viewAll: "הצג את כל התלמידים",
    viewAllPriority: "צפה בכל הפריטים",
    noUrgent: "אין פריטים דחופים",
    phaseGoals: "קביעת יעדים",
    phaseAssessment: "הערכה",
    phaseIntervention: "התערבות",
    phaseReeval: "הערכה מחדש",
  },

  // ============================================================================
  // STUDENTS
  // ============================================================================
  students: {
    title: "תלמידים",
    subtitle: "ניהול רשומות תלמידים ומעקב התקדמות",
    searchPlaceholder: "חיפוש תלמידים...",
    filterStatus: "סטטוס",
    filterSchool: "בית ספר",
    filterAll: "כל התלמידים",
    filterUrgent: "דחוף",
    filterActive: "פעיל",
    filterCompleted: "הושלם",
    foundCount: "נמצאו {count} תלמידים",
    newStudent: "תלמיד חדש",
    createTitle: "הוספת תלמיד חדש",
    createDescription: "צור פרופיל תלמיד חדש להוספה לרשימה שלך.",
    createRedirect: "תועבר לתהליך יצירת פרופיל תלמיד.",
    idLabel: "ת.ז",
    diagnosisLabel: "אבחנה",
    progressLabel: "התקדמות",
    dueLabel: "תאריך יעד",
    openTala: "פתח תהליך",
    openIEP: "פתח IEP",
    openProgress: "פתח התקדמות",
    actions: "פעולות",
    editDetails: "ערוך פרטים",
    viewHistory: "הצג היסטוריה",
    archive: "העבר לארכיון",
    all: "הכל",
    active: "פעילים",
    completed: "הושלמו",
    noStudents: "אין תלמידים עדיין",
    noStudentsDesc: "הוסף את התלמיד הראשון שלך להתחיל",
    noResults: "לא נמצאו תלמידים",
    noResultsDesc: "נסה לשנות את החיפוש או הסינון",
  },

  // ============================================================================
  // TALA PROCESS (Israel)
  // ============================================================================
  tala: {
    title: "תהליך תל״א",
    titleSuffix: " - תהליך תל״א",
    backButton: "חזרה לתלמידים",
    nextDeadline: "מועד הבא",
    share: "שתף",
    exportPdf: "ייצוא PDF",
    roadmap: "מפת התהליך",
    roadmapDesc: "מעקב התקדמות בכל שלב",
    phaseCurrent: "שלב נוכחי",
    phase1Title: "הערכה ראשונית",
    phase2Title: "מטרות ותכנון",
    phase3Title: "יישום",
    phase4Title: "סיכום והערכה",
    inProgress: "בתהליך",
    phase2Desc: "הגדרת מטרות מדידות ואסטרטגיות התערבות",
    deadlineLabel: "מועד אחרון",
    goal1Title: "מטרת תקשורת",
    goal1Desc: "התלמיד ישפר שפה אקספרסיבית באמצעות מכשיר AAC ברמת דיוק של 80%.",
    goal2Title: "מטרת אינטראקציה חברתית",
    goal2Desc: "התלמיד ייזום אינטראקציות עם עמיתים 3 פעמים בכל מפגש.",
    editGoal: "ערוך מטרה",
    addGoal: "הוסף מטרה חדשה",
    lastSaved: "נשמר לאחרונה: לפני 2 דקות",
    saveDraft: "שמור טיוטה",
    submitApproval: "הגש לאישור",
    viewData: "הצג נתונים",
    locked: "נעול",
  },

  // ============================================================================
  // PHASE
  // ============================================================================
  phase: {
    p1: "הערכה ראשונית",
    p2: "מטרות ותכנון",
    p3: "יישום",
    p4: "סיכום והערכה",
  },
  
  // ============================================================================
  // PROGRAM
  // ============================================================================
  program: {
    // General
    noStudentSelected: "לא נבחר תלמיד",
    goToStudents: "עבור לתלמידים",
    
    // Create Program
    startNew: "התחל תוכנית חדשה",
    startNewDesc: "צור תוכנית תל״א/IEP חדשה עבור {name}",
    framework: "מסגרת התוכנית",
    frameworkTala: "תל״א (ישראל)",
    frameworkIep: "IEP (ארה״ב)",
    year: "שנת התוכנית",
    createAndStart: "צור תוכנית",
    previousPrograms: "תוכניות קודמות",
    
    // Status
    status: {
      draft: "טיוטה",
      active: "פעילה",
      archived: "בארכיון",
    },
    
    // Actions
    activate: "הפעל תוכנית",
    archive: "העבר לארכיון",
    exportPdf: "ייצוא PDF",
    share: "שתף",
    settings: "הגדרות",
    created: "התוכנית נוצרה",
    createdDesc: "התוכנית נוצרה עם תחומי פרופיל ברירת מחדל.",
    activated: "התוכנית הופעלה",
    archived: "התוכנית הועברה לארכיון",
    
    // Tabs
    tabs: {
      overview: "סקירה",
      profile: "פרופיל",
      goals: "מטרות",
      services: "שירותים",
      progress: "התקדמות",
      team: "צוות",
    },
    
    // Stats
    stats: {
      activeGoals: "מטרות פעילות",
      goalsAchieved: "מטרות הושגו",
      weeklyMinutes: "דקות שבועיות",
      teamMembers: "חברי צוות",
    },
    
    // Overview
    overallProgress: "התקדמות כללית",
    goalCompletion: "השלמת מטרות",
    goalsByDomain: "מטרות לפי תחום",
    timeline: "ציר זמן",
    dueDate: "תאריך יעד",
    approvedDate: "תאריך אישור",
    
    // Profile/Domains
    functionalProfile: "פרופיל תפקודי",
    functionalProfileDesc: "רמות ביצוע אקדמיות ותפקודיות נוכחיות",
    domains: {
      cognitive_academic: "קוגניטיבי ואקדמי",
      communication_language: "תקשורת ושפה",
      social_emotional_behavioral: "חברתי, רגשי והתנהגותי",
      motor_sensory: "מוטורי וחושי",
      life_skills_preparation: "מיומנויות חיים והכנה למעבר",
      other: "אחר",
    },
    goalsLinked: "מטרות מקושרות",
    impactStatement: "הצהרת השפעה",
    impactStatementPlaceholder: "תאר כיצד תחום זה משפיע על החינוך של התלמיד...",
    presentLevels: "רמות ביצוע נוכחיות",
    presentLevelsPlaceholder: "תאר את היכולות והביצועים הנוכחיים של התלמיד בתחום זה...",
    strengths: "חוזקות",
    strengthsPlaceholder: "רשום את החוזקות של התלמיד בתחום זה...",
    needs: "צרכים",
    needsPlaceholder: "זהה תחומים הדורשים שיפור...",
    educationalImpact: "השפעה חינוכית",
    educationalImpactPlaceholder: "תאר כיצד זה משפיע על החינוך של התלמיד...",
    parentInput: "קלט הורים",
    parentInputPlaceholder: "תעד דאגות ועדיפויות של ההורים...",
    
    // Goals
    goalsAndObjectives: "מטרות ויעדים",
    goalsAndObjectivesDesc: "מטרות שנתיות ויעדים קצרי טווח לתוכנית זו",
    noGoals: "טרם נוצרו מטרות",
    
    // Services
    servicesAndAccommodations: "שירותים והתאמות",
    servicesAndAccommodationsDesc: "שירותים נלווים, התערבויות והתאמות",
    noServices: "טרם נוספו שירותים",
    accommodations: "התאמות",
    
    // Progress
    progressTracking: "מעקב התקדמות",
    progressTrackingDesc: "איסוף נתונים וניטור התקדמות",
  },

  // ============================================================================
  // GOAL
  // ============================================================================
  goal: {
    add: "הוסף מטרה",
    addFirst: "הוסף את המטרה הראשונה",
    new: "מטרה חדשה",
    edit: "ערוך מטרה",
    created: "המטרה נוצרה",
    updated: "המטרה עודכנה",
    deleted: "המטרה נמחקה",
    confirmDelete: "האם אתה בטוח שברצונך למחוק מטרה זו?",
    modalDescription: "צור מטרה שנתית מדידה המותאמת לצרכי התלמיד",
    
    // Form fields
    title: "כותרת המטרה",
    titlePlaceholder: "לדוגמה: שיפור תקשורת אקספרסיבית",
    titleRequired: "נדרשת כותרת למטרה",
    domain: "תחום פרופיל",
    selectDomain: "בחר תחום",
    description: "תיאור המטרה",
    descriptionPlaceholder: "תיאור מפורט של המטרה...",
    baseline: "רמת בסיס",
    baselinePlaceholder: "רמת ביצוע נוכחית",
    target: "רמת יעד",
    targetPlaceholder: "רמת ההישג הצפויה",
    targetDate: "תאריך יעד",
    currentProgress: "התקדמות נוכחית",
    
    // Status
    status: {
      draft: "טיוטה",
      active: "פעילה",
      achieved: "הושגה",
      modified: "שונתה",
      discontinued: "הופסקה",
    },
  },

  // ============================================================================
  // OBJECTIVE
  // ============================================================================
  objective: {
    add: "הוסף יעד",
    new: "יעד חדש",
    created: "היעד נוצר",
    modalDescription: "צור יעד קצר טווח ומדיד עבור מטרה זו",
    title: "יעדים",
    noObjectives: "עדיין לא הוגדרו יעדים",
    
    description: "תיאור היעד",
    descriptionPlaceholder: "תאר את היעד הספציפי והמדיד...",
    descriptionRequired: "נדרש תיאור יעד",
    criteria: "קריטריון הצלחה",
    criteriaPlaceholder: "לדוגמה: 80% דיוק ב-3 מפגשים רצופים",
    targetDate: "תאריך יעד",
    
    status: {
      not_started: "לא התחיל",
      in_progress: "בתהליך",
      achieved: "הושג",
      modified: "שונה",
      discontinued: "הופסק",
    },
  },

  // ============================================================================
  // SERVICE
  // ============================================================================
  service: {
    add: "הוסף שירות",
    addFirst: "הוסף את השירות הראשון",
    new: "שירות חדש",
    edit: "ערוך שירות",
    created: "השירות נוסף",
    updated: "השירות עודכן",
    deleted: "השירות הוסר",
    confirmDelete: "האם אתה בטוח שברצונך להסיר שירות זה?",
    modalDescription: "הוסף שירות נלווה או התערבות",
    
    // Form fields
    type: "סוג שירות",
    name: "שם השירות",
    namePlaceholder: "לדוגמה: טיפול קלינאות תקשורת פרטני",
    nameRequired: "נדרש שם שירות",
    //frequency: "תדירות",
    period: "תקופה",
    duration: "משך (דקות)",
    setting: "מיקום",
    provider: "נותן שירות",
    providerPlaceholder: "שם נותן השירות",
    
    // Types
    types: {
      speech_language_therapy: "קלינאות תקשורת",
      occupational_therapy: "ריפוי בעיסוק",
      physical_therapy: "פיזיותרפיה",
      counseling: "ייעוץ",
      specialized_instruction: "הוראה מותאמת",
      consultation: "ייעוץ מקצועי",
      aac_support: "תמיכה בתת״ח",
      other: "אחר",
    },
    
    // Frequency
    frequency: {
      daily: "יומי",
      weekly: "שבועי",
      monthly: "חודשי",
    },
    
    // Settings
    settings: {
      general_education: "חינוך רגיל",
      resource_room: "חדר אם",
      self_contained: "כיתת חינוך מיוחד",
      therapy_room: "חדר טיפולים",
      home: "בית",
      community: "קהילה",
    },
  },

  // ============================================================================
  // ACCOMMODATION
  // ============================================================================
  accommodation: {
    types: {
      visual_support: "תמיכה חזותית",
      aac_device: "מכשיר תת״ח",
      modified_materials: "חומרים מותאמים",
      extended_time: "הארכת זמן",
      simplified_language: "שפה מפושטת",
      environmental_modification: "התאמה סביבתית",
      other: "אחר",
    },
    required: "נדרש",
  },

  // ============================================================================
  // DATA POINT
  // ============================================================================
  dataPoint: {
    record: "רשום נתונים",
    add: "הוסף נתון",
    created: "נקודת הנתונים נרשמה",
    quickEntry: "הזנת נתונים מהירה",
    modalDescription: "רשום נתוני התקדמות עבור מטרה זו",
    title: "נתוני התקדמות",
    noDataPoints: "עדיין לא נרשמו נתונים",
    collectedBy: "נאסף על ידי",
    moreCount: "+{{count}} רשומות נוספות",
    
    numericValue: "ערך מספרי",
    numericPlaceholder: "לדוגמה: 85",
    textValue: "ערך טקסטואלי",
    textPlaceholder: "לדוגמה: הושג עם הנחיה מינימלית",
    notes: "הערות מפגש",
    notesPlaceholder: "הערות אופציונליות על המפגש...",
    valueRequired: "יש להזין ערך מספרי או טקסטואלי",
  },

  // ============================================================================
  // PROGRESS REPORT
  // ============================================================================
  progressReport: {
    title: "דוחות התקדמות",
    create: "צור דוח",
    none: "אין עדיין דוחות התקדמות",
    shared: "שותף",
  },

  // ============================================================================
  // TEAM
  // ============================================================================
  team: {
    title: "חברי צוות",
    description: "אנשים המעורבים בתוכנית התלמיד",
    add: "הוסף חבר",
    addMember: "הוסף חבר צוות",
    addMemberDescription: "הוסף אדם לצוות התל״א/IEP",
    noMembers: "טרם נוספו חברי צוות",
    memberAdded: "חבר הצוות נוסף",
    memberRemoved: "חבר הצוות הוסר",
    confirmRemove: "האם אתה בטוח שברצונך להסיר חבר צוות זה?",
    coordinator: "מתאם/ת",
    isCoordinator: "אדם זה הוא מתאם/ת התיק",
    
    name: "שם מלא",
    namePlaceholder: "הזן שם מלא",
    nameRequired: "נדרש שם",
    role: "תפקיד",
    email: "אימייל",
    emailPlaceholder: "email@example.com",
    phone: "טלפון",
    phonePlaceholder: "050-1234567",
    
    roles: {
      parent_guardian: "הורה/אפוטרופוס",
      student: "תלמיד/ה",
      homeroom_teacher: "מחנך/ת",
      special_education_teacher: "מורה לחינוך מיוחד",
      general_education_teacher: "מורה בחינוך הרגיל",
      speech_language_pathologist: "קלינאי/ת תקשורת",
      occupational_therapist: "מרפא/ה בעיסוק",
      physical_therapist: "פיזיותרפיסט/ית",
      psychologist: "פסיכולוג/ית",
      administrator: "מנהל/ת",
      case_manager: "מנהל/ת תיק",
      external_provider: "נותן שירות חיצוני",
      other: "אחר",
    },
  },

  // ============================================================================
  // MEETING
  // ============================================================================
  meeting: {
    title: "פגישות",
    description: "פגישות צוות התל״א/IEP",
    schedule: "קבע פגישה",
    none: "אין פגישות מתוכננות",
    
    types: {
      initial_evaluation: "הערכה ראשונית",
      annual_review: "סיכום שנתי",
      reevaluation: "הערכה מחדש",
      amendment: "תיקון",
      transition_planning: "תכנון מעבר",
      progress_review: "סיכום התקדמות",
    },
  },

  // ============================================================================
  // CONSENT
  // ============================================================================
  consent: {
    title: "טופסי הסכמה",
    description: "תיעוד הסכמות נדרש",
    none: "אין טופסי הסכמה נדרשים",
    signed: "חתום",
    pending: "ממתין",
    signedOn: "נחתם בתאריך",
    
    types: {
      initial_evaluation: "הסכמה להערכה ראשונית",
      reevaluation: "הסכמה להערכה מחדש",
      placement: "הסכמה להשמה",
      release_of_information: "שחרור מידע",
      service_provision: "הסכמה למתן שירות",
    },
  },
};