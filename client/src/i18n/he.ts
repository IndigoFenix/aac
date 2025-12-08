// src/i18n/he.ts
// Hebrew translations (עברית)

export const he = {
    // ============================================================================
    // APP
    // ============================================================================
    app: {
      title: "CommuniAACte - מפרש תקשורת מסייעת",
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
      aacUserCreated: "משתמש.ת תת״ח נוצר",
      aacUserCreatedDesc: "משתמש.ת תת״ח חדש נוסף בהצלחה",
      aacUserCreateFailed: "יצירת משתמש.ת נכשלה",
      aacUserCreateFailedDesc: "לא ניתן ליצור משתמש.ת תת״ח",
      aacUserUpdated: "משתמש.ת תת״ח עודכן",
      aacUserUpdatedDesc: "פרטי משתמש.ת תת״ח עודכנו בהצלחה",
      aacUserUpdateFailed: "עדכון נכשל",
      aacUserUpdateFailedDesc: "לא ניתן לעדכן משתמש.ת תת״ח",
      aacUserDeleted: "משתמש.ת תת״ח נמחק",
      aacUserDeletedDesc: "משתמש.ת תת״ח הוסר בהצלחה",
      aacUserDeleteFailed: "מחיקה נכשלה",
      aacUserDeleteFailedDesc: "לא ניתן למחוק משתמש.ת תת״ח",
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
      noAacUsers: "אין משתמשי תת״ח זמינים",
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
      aacUser: "משתמש.ת תת״ח",
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
      selectAacUser: 'חובה לבחור משתמש.ת תת"ח לפני המשך הפרשנות',
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
      darkMode: "מצב כהה",
      language: "שפה",
      notifications: "התראות",
      account: "חשבון",
      privacy: "פרטיות",
      about: "אודות",
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
  };