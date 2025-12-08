// src/i18n/en.ts
// English translations

export const en = {
    // ============================================================================
    // APP
    // ============================================================================
    app: {
      title: "CommuniAACte - AAC Communication Interpreter",
      subtitle: "AI-powered speech therapy analysis for better understanding",
    },
  
    // ============================================================================
    // COMMON
    // ============================================================================
    common: {
      loading: "Loading...",
      error: "Error",
      success: "Success",
      save: "Save",
      cancel: "Cancel",
      delete: "Delete",
      edit: "Edit",
      close: "Close",
      back: "Back",
      next: "Next",
      submit: "Submit",
      search: "Search",
      filter: "Filter",
      clear: "Clear",
      confirm: "Confirm",
      yes: "Yes",
      no: "No",
      ok: "OK",
      send: "Send",
      retry: "Retry",
      refresh: "Refresh",
      start: "Start",
    },
  
    // ============================================================================
    // AUTH
    // ============================================================================
    auth: {
      login: "Log In",
      logout: "Log Out",
      signUp: "Sign Up",
      email: "Email",
      password: "Password",
      forgotPassword: "Forgot Password?",
      rememberMe: "Remember me",
      noAccount: "Don't have an account?",
      hasAccount: "Already have an account?",
      loginSuccess: "Successfully logged in",
      logoutSuccess: "Successfully logged out",
      invalidCredentials: "Invalid email or password",
      loginTitle: "Login",
      loginDescription: "Enter your email and password to access your account",
      emailPlaceholder: "Email",
      passwordPlaceholder: "Password",
      loginWithEmail: "Login",
      googleLogin: "Continue with Google",
      or: "or",
      inactive: "Coming soon",
      googleDisabled: "Google login is currently inactive",
      loggingIn: "Logging in...",
      error: "Error",
      fieldsRequired: "Please fill in all fields",
      welcomeBack: "Welcome back!",
      loginFailed: "Login Failed",
      loginError: "An error occurred during login",
      registerTitle: "Create Account",
      firstName: "First Name",
      lastName: "Last Name",
      firstNamePlaceholder: "First Name",
      lastNamePlaceholder: "Last Name",
      confirmPassword: "Confirm Password",
      confirmPasswordPlaceholder: "Confirm Password",
      registerButton: "Create Account",
      registering: "Creating account...",
      backToLogin: "Already have an account? Login",
      passwordMismatch: "Passwords do not match",
      registerSuccess: "Account Created Successfully",
      registerSuccessDesc: "Account created. You can now login.",
      registerFailed: "Registration Failed",
      registerError: "An error occurred during registration",
    },
  
    // ============================================================================
    // NAVIGATION
    // ============================================================================
    nav: {
      main: "CliniAACian",
      interpret: "CommuniAACte",
      boards: "SyntAACx Boards",
      docuslp: "DocuSLP Reports",
      settings: "Settings",
      workspace: "Workspace",
      toggleSidebar: "Toggle Sidebar",
      overview: "Overview",
      students: "Students",
      progress: "Student Progress",
    },
  
    // ============================================================================
    // HEADER
    // ============================================================================
    header: {
      title: "AAC Workspace",
      student: "Student",
      selectStudent: "Select student",
      noStudents: "No AAC users",
      loadingStudents: "Loading students...",
      credits: "credits",
      active: "Active",
      admin: "Admin Panel",
    },
  
    // ============================================================================
    // CHAT
    // ============================================================================
    chat: {
      placeholder: "Ask CliniAACian",
      placeholderWithUser: "Ask about {name}...",
      greeting: {
        morning: "Good morning",
        afternoon: "Good afternoon",
        evening: "Good evening",
      },
      welcomeMessage: "What do you need to do today?",
      welcomeWithUser: "How can I help you with {name} today?",
      workingWith: "Currently working with:",
      newConversation: "Start new conversation",
      addAttachment: "Add attachment",
      tools: "Tools",
      voiceInput: "Voice input",
      sendMessage: "Send message",
      suggestions: {
        communicationPrefs: "Communication preferences",
        milestones: "Milestone suggestions",
        dailyTips: "Daily support tips",
      },
      prompts: {
        communicationPrefs: "Tell me about {name}'s communication preferences",
        milestones: "What milestones should we work on with {name}?",
        dailyTips: "How can I better support {name}'s communication today?",
      },
      typing: "Typing...",
      error: "Failed to send message",
    },
  
    // ============================================================================
    // INPUT (CommuniAACte)
    // ============================================================================
    input: {
      text: "Text Input",
      textAnalysis: "What would you like to interpret?",
      image: "Image Upload",
      textPlaceholder: "Enter AAC communication text here...",
      imageChoose: "Choose File",
      imageSelected: "Selected: {filename} (Click to crop)",
      original: "Original Input",
      imageCropped: "Cropped Image Preview:",
    },
  
    // ============================================================================
    // BUTTONS (Actions)
    // ============================================================================
    button: {
      interpret: "Interpret Communication",
      processImage: "Process Image & Interpret",
      processing: "Processing...",
      clear: "Clear",
      save: "Save",
      delete: "Delete",
      cancel: "Cancel",
      applyCrop: "Apply Crop",
      start: "Start",
      editor: "Button Editor",
      editProperties: "Edit Properties",
      newButton: "New Button",
      label: "Label",
      labelPlaceholder: "Button text",
      spokenText: "Spoken Text",
      spokenTextPlaceholder: "Text to speak",
      color: "Color",
      icon: "Icon",
      iconPlaceholder: "e.g., fas fa-home",
      chooseIcon: "Choose Icon",
      upload: "Upload",
      action: "Action",
      actionSpeak: "Speak Text",
      actionJump: "Jump to Page",
      actionBack: "Go Back",
      actionHome: "Go to Home Page",
      actionYoutube: "Play YouTube",
      textToSpeak: "Text to Speak",
      videoId: "Video ID (e.g., dQw4w9WgXcQ)",
      videoTitle: "Video Title",
      target: "Target",
      noBoard: "No Board",
      notSet: "Not Set",
      choosePage: "Choose Page",
      chooseTargetPage: "Choose Target Page",
      selectPageToJump: "Select a page to navigate to.",
      goToPage: "Go to Page",
      backDescription: "Return to the previously viewed page.",
      homeDescription: "Jump to the first page in the board.",
      selfClosing: "Self-closing",
      selfClosingDescription: "Automatically return after click",
      position: "Position",
      row: "Row",
      column: "Column",
      duplicate: "Duplicate",
    },
  
    // ============================================================================
    // CROP
    // ============================================================================
    crop: {
      title: "Crop Image for Better Analysis",
      description: "Crop the image to focus on the AAC communication area for better interpretation accuracy.",
    },
  
    // ============================================================================
    // RESULT
    // ============================================================================
    result: {
      interpretation: "Interpretation",
      meaning: "Interpreted Meaning",
      meaningShort: "Meaning",
      aacText: "AAC text",
      analysis: "Analysis",
      confidence: "Confidence",
      suggestedResponse: "Suggested Response",
      confidenceHigh: "High confidence",
      confidenceMedium: "Medium confidence",
      confidenceLow: "Low confidence",
    },
  
    // ============================================================================
    // SHARE
    // ============================================================================
    share: {
      title: "Share Results",
      whatsapp: "WhatsApp",
      copy: "Copy Text",
      email: "Email",
    },
  
    // ============================================================================
    // CONTEXT
    // ============================================================================
    context: {
      title: "Add Context Information",
      description: "Providing context helps improve interpretation accuracy. All fields are optional.",
      time: "Time",
      timePlaceholder: "When was this communication said?",
      useCurrentTime: "Use current time",
      location: "Location",
      locationPlaceholder: "Where was this communication said?",
      useCurrentLocation: "Use current location (GPS)",
      background: "Background Context",
      backgroundPlaceholder: "General situation or environment when this was communicated...",
      previousEvents: "Previous Events",
      previousEventsPlaceholder: "What happened before this communication?",
      futureEvents: "Future Events",
      futureEventsPlaceholder: "Any upcoming events that might be related?",
      cancel: "Cancel",
      continue: "Continue with Interpretation",
    },
  
    // ============================================================================
    // HISTORY
    // ============================================================================
    history: {
      title: "Recent Interpretations",
      empty: "No interpretations yet. Try interpreting some AAC communication!",
      origin: "Origin",
      text: "Text",
      image: "Image",
    },
  
    // ============================================================================
    // TOAST NOTIFICATIONS
    // ============================================================================
    toast: {
      invalidFile: "Invalid file type",
      invalidFileDesc: "Please select a valid image file (JPG, PNG, etc.)",
      imageRequired: "Image required",
      imageRequiredDesc: "Please select and crop an image file for interpretation.",
      textRequired: "Text required",
      textRequiredDesc: "Please enter text for interpretation.",
      imageCropped: "Image cropped",
      imageCroppedDesc: "Image has been cropped and is ready for interpretation.",
      cropFailed: "Crop failed",
      cropFailedDesc: "Failed to crop image. Please try again.",
      saved: "Saved",
      savedDesc: "Interpretation saved successfully.",
      deleted: "Deleted",
      deletedDesc: "Interpretation deleted.",
      copied: "Copied",
      copiedDesc: "Interpretation results copied to clipboard.",
      copyFailed: "Copy failed",
      copyFailedDesc: "Failed to copy to clipboard. Please try again.",
      // AAC User management
      aacUserCreated: "AAC User Created",
      aacUserCreatedDesc: "AAC user has been created successfully",
      aacUserCreateFailed: "Creation Failed",
      aacUserCreateFailedDesc: "Failed to create AAC user",
      aacUserUpdated: "AAC User Updated",
      aacUserUpdatedDesc: "AAC user has been updated successfully",
      aacUserUpdateFailed: "Update Failed",
      aacUserUpdateFailedDesc: "Failed to update AAC user",
      aacUserDeleted: "AAC User Deleted",
      aacUserDeletedDesc: "AAC user has been removed successfully",
      aacUserDeleteFailed: "Deletion Failed",
      aacUserDeleteFailedDesc: "Failed to delete AAC user",
      // Profile management
      profileUpdated: "Profile Updated",
      profileUpdatedDesc: "Your profile has been updated successfully",
      profileUpdateFailed: "Update Failed",
      profileUpdateFailedDesc: "Failed to update profile",
      imageUploaded: "Image Uploaded",
      imageUploadedDesc: "Your profile image has been updated successfully",
      imageUploadFailed: "Upload Failed",
      imageUploadFailedDesc: "Failed to upload image",
      // Invite code management
      inviteCreated: "Invite Code Created",
      inviteCreatedDesc: "Invite code has been created successfully",
      inviteCreateFailed: "Creation Failed",
      inviteCreateFailedDesc: "Failed to create invite code",
      inviteRedeemed: "Invite Code Redeemed",
      inviteRedeemedDesc: 'AAC user "{alias}" has been added successfully',
      inviteRedeemFailed: "Redemption Failed",
      inviteRedeemFailedDesc: "Failed to redeem invite code",
      inviteDeleted: "Invite Code Deleted",
      inviteDeletedDesc: "Invite code has been removed successfully",
      inviteDeleteFailed: "Deletion Failed",
      inviteDeleteFailedDesc: "Failed to delete invite code",
      // Location management
      locationSaved: "Location Saved",
      locationSavedDesc: "Location has been saved successfully",
      locationSaveFailed: "Save Failed",
      locationSaveFailedDesc: "Failed to save location",
      locationDeleted: "Location Deleted",
      locationDeletedDesc: "Location has been removed successfully",
      locationDeleteFailed: "Deletion Failed",
      locationDeleteFailedDesc: "Failed to delete location",
      // Interpretation
      interpretationSuccess: "Communication Interpreted",
      interpretationSuccessDesc: "The AAC communication has been successfully analyzed.",
      interpretationFailed: "Interpretation Failed",
      interpretationFailedDesc: "Unable to interpret the communication.",
      imageProcessed: "Image Processed",
      imageProcessedDesc: "The image has been successfully processed and interpreted.",
      imageProcessingFailed: "Image Processing Failed",
      imageProcessingFailedDesc: "Unable to process the image.",
    },
  
    // ============================================================================
    // UI LABELS
    // ============================================================================
    ui: {
      loading: "Loading...",
      creating: "Creating...",
      redeeming: "Redeeming...",
      noAacUsers: "No AAC users available",
      createInviteCode: "Create Invite Code",
      redeemInviteCode: "Redeem Invite Code",
      enterInviteCode: "Enter Invite Code (8 characters)",
      inviteCodePlaceholder: "e.g., ABC12345",
      inviteCodeError: "Invite code must be exactly 8 characters",
      redeemCode: "Redeem Code",
      myInviteCodes: "My Invite Codes",
      showHide: "Show/Hide",
      created: "Created",
      redeemed: "Redeemed",
      copyInviteCode: "Copy invite code",
      deleteInviteCode: "Delete invite code",
      noInviteCodes: "No active invite codes",
      close: "Close",
    },
  
    // ============================================================================
    // LABELS
    // ============================================================================
    label: {
      aacUser: "AAC User",
      age: "Age",
      gender: "Gender",
      condition: "Condition",
      backgroundContext: "Background context",
    },
  
    // ============================================================================
    // ERROR MESSAGES
    // ============================================================================
    error: {
      title: "Error",
      selectAacUser: "You must select an AAC user before continuing with the interpretation",
      locationUnavailable: "Location unavailable",
      generic: "Something went wrong",
      networkError: "Network error. Please check your connection.",
      sessionExpired: "Your session has expired. Please log in again.",
      notFound: "Not found",
      unauthorized: "Unauthorized",
      forbidden: "Access denied",
    },
  
    // ============================================================================
    // BOARD (SyntAACx)
    // ============================================================================
    board: {
      title: "SyntAACx Boards",
      valid: "Valid",
      hasErrors: "Has errors",
      pages: "pages",
      buttons: "buttons",
      newBoard: "New Board",
      selectBoard: "Select a board",
      noBoards: "No boards available",
      generate: "Generate",
      generating: "Generating...",
      preview: "Preview",
      edit: "Edit",
      editMode: "Edit Mode",
      previewMode: "Preview Mode",
      inspector: "Button Inspector",
      builder: "Board Builder",
      settings: "Board Settings",
      noBoard: "No Board",
      createEmptyBoard: "Create Empty Board",
      manageBoards: "Manage Boards",
      saveBoard: "Save Board",
      saving: "Saving...",
      noBoardYet: "No board yet",
      noBoardDescription: "Use the prompt panel to create your first AAC board or create an empty board",
      grid: "Grid",
      page: "Page",
      of: "of",
      manage: "Manage",
      addPage: "Add Page",
      untitledPage: "Untitled Page",
      pagesInBoard: "Pages in this board",
      pagesDescription: "Rename, reorder, or delete pages. The first page is the home page.",
      current: "Current",
      home: "Home",
      open: "Open",
      createdPages: "Created pages and buttons for your board.",
      updated: "The board has been updated with new buttons.",
      pagesAdded: "Pages Added",
      boardUpdated: "Board Updated",
      addedPagesDesc: "New page(s) have been added.",
      updatedDesc: "Updated with new buttons and sub-pages.",
      generated: "Board Generated",
      generatedMultiPage: "A new multi-page board has been created.",
      generatedSinglePage: "A new board has been created.",
      generateError: "Sorry, I couldn't generate that. Please try again.",
      generationFailed: "Generation Failed",
      somethingWrong: "An error occurred during generation.",
      modes: {
        generate: "Generate",
        select: "My Boards",
        history: "History",
      },
      prompt: {
        title: "Board Generator",
        placeholder: "Describe the board you want to create...",
        generate: "Generate Board",
        description: "Describe the board you want to create",
        hint: "Press Enter to send, Shift+Enter for new line",
        example1: "Basic needs board with eat, drink, toilet, help",
        example2: "Emotions board with happy, sad, angry, scared",
        example3: "Family members board with mom, dad, sister, brother",
        example4: "Activities board with play, read, TV, music",
      },
    },
  
    // ============================================================================
    // EXPORT
    // ============================================================================
    export: {
      title: "Export",
      download: "Download",
      upload: "Upload to Cloud",
      uploadSuccess: "Upload Successful",
      uploadSuccessDesc: "File uploaded to Dropbox",
      uploadFailed: "Upload Failed",
      beta: "Beta",
    },
  
    // ============================================================================
    // SETTINGS
    // ============================================================================
    settings: {
      title: "Settings",
      darkMode: "Dark Mode",
      language: "Language",
      notifications: "Notifications",
      account: "Account",
      privacy: "Privacy",
      about: "About",
    },
  
    // ============================================================================
    // FEATURES
    // ============================================================================
    features: {
      comingSoon: "Coming soon",
      docuslpDesc: "DocuSLP drafting",
    },
  
    // ============================================================================
    // LANGUAGE
    // ============================================================================
    language: {
      english: "English",
      hebrew: "Hebrew",
    },
  
    // ============================================================================
    // FOOTER
    // ============================================================================
    footer: {
      text: "Specialized in AAC interpretation with speech therapy expertise",
    },

    overview: {
      title: "Dashboard Overview",
      subtitle: "Monitor student progress and upcoming deadlines",
      totalStudents: "Total Students",
      activeCases: "Active Cases",
      completedCases: "Completed",
      pendingReview: "Pending Review",
      enrolled: "Enrolled in program",
      fromLastMonth: "+2 from last month",
      ytd: "Year to date",
      attentionNeeded: "Needs attention",
      deadlineAlert: "Upcoming Deadlines",
      daysLeft: "7 days left",
      deadlineDesc: "{count} students have deadlines approaching",
      reviewBtn: "Review All",
      chartTitle: "Caseload by Phase",
      chartSubtitle: "Distribution of students across process phases",
      priorityFocus: "Priority Focus",
      priorityDesc: "Students requiring immediate attention",
      viewAll: "View All Students",
    },

    students: {
      title: "Students",
      subtitle: "Manage student records and progress tracking",
      searchPlaceholder: "Search students...",
      filterStatus: "Status",
      filterSchool: "School",
      foundCount: "{count} students found",
      newStudent: "New Student",
      idLabel: "ID",
      diagnosisLabel: "Diagnosis",
      progressLabel: "Progress",
      dueLabel: "Due",
      openTala: "Open Process",
      openIEP: "Open IEP",
      actions: "Actions",
      editDetails: "Edit Details",
      viewHistory: "View History",
      archive: "Archive",
      all: "All",
      active: "Active",
      completed: "Completed",
    },

    tala: {
      title: "Tala Process",
      titleSuffix: "'s Tala Process",
      backButton: "Back to Students",
      nextDeadline: "Next Deadline",
      share: "Share",
      exportPdf: "Export PDF",
      roadmap: "Process Roadmap",
      roadmapDesc: "Track progress through each phase",
      phaseCurrent: "Current Phase",
      phase1Title: "Initial Assessment",
      phase2Title: "Goals & Planning",
      phase3Title: "Implementation",
      phase4Title: "Review & Evaluation",
      inProgress: "In Progress",
      phase2Desc: "Define measurable goals and intervention strategies",
      deadlineLabel: "Deadline",
      goal1Title: "Communication Goal",
      goal1Desc: "The student will improve expressive language using AAC device with 80% accuracy.",
      goal2Title: "Social Interaction Goal",
      goal2Desc: "The student will initiate peer interactions 3 times per session.",
      editGoal: "Edit Goal",
      addGoal: "Add New Goal",
      lastSaved: "Last saved: 2 minutes ago",
      saveDraft: "Save Draft",
      submitApproval: "Submit for Approval",
      viewData: "View Data",
      locked: "Locked",
    },

    phase: {
      p1: "Initial Assessment",
      p2: "Goals & Planning",
      p3: "Implementation",
      p4: "Review & Evaluation",
    },

    iep: {
      title: "IEP Development",
      clinicalModule: "Clinical Documentation Module",
      plaafpTitle: "PLAAFP Baseline",
      currentPerformance: "Current Performance",
      impactStatement: "Adverse Impact",
      smartGoalTitle: "SMART Goal Development",
      smartGoalDesc: "AI-assisted goal writing with compliance checking",
      generateDraft: "Generate Draft",
      finalizeGoal: "Finalize Goal",
      complianceTitle: "Compliance Checklist",
      serviceRecommendation: "Service Recommendation",
      export: "Export",
      exportComponent: "Export to IEP Document",
    },

  };