// src/i18n/en.ts
// English translations

export const en = {
  // ============================================================================
  // APP
  // ============================================================================
  app: {
    title: "CliniAACian",
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
    continue: "Continue",
    add: "Add",
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
    currentStudent: "Current Student",
    studentManagement: "Student Management",
  },

  // ============================================================================
  // HEADER
  // ============================================================================
  header: {
    title: "AAC Workspace",
    student: "Student",
    selectStudent: "Select student",
    noStudents: "No students",
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
    assistant: "Assistant",
    popupMode: "Popup",
    switchToPopup: "Switch to popup mode",
    expandMode: "Expand chat",
    minimize: "Minimize",
    popupWelcome: "Start a conversation...",
    placeholderShort: "Type a message...",
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
    save: "Save",
    saved: "Saved",
    savedDesc: "Board saved successfully",
    saveFailed: "Save Failed",
    saveFailedDesc: "Failed to save board",
    unsaved: "Unsaved",
    unsavedChanges: "Unsaved Changes",
    unsavedChangesDesc: "You have unsaved changes to this board. What would you like to do?",
    discardChanges: "Discard Changes",
    saveAndSwitch: "Save & Switch",
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
    subtitle: "Manage your preferences",
    darkMode: "Dark Mode",
    darkModeDesc: "Use dark theme for reduced eye strain",
    language: "Language",
    languageDesc: "Choose your display language",
    displayLanguage: "Display Language",
    displayLanguageDesc: "Select the language for the interface",
    notifications: "Notifications",
    notificationsDesc: "Manage your notification preferences",
    emailNotifications: "Email Notifications",
    emailNotificationsDesc: "Receive updates via email",
    deadlineReminders: "Deadline Reminders",
    deadlineRemindersDesc: "Get notified about upcoming deadlines",
    progressUpdates: "Progress Updates",
    progressUpdatesDesc: "Receive notifications about student progress",
    account: "Account",
    privacy: "Privacy",
    about: "About",
    profile: "Profile",
    profileDesc: "Your account information",
    editProfile: "Edit Profile",
    system: "System Settings",
    systemDesc: "Configure workflow and regional settings",
    workflowSystem: "Workflow System",
    systemTala: "TALA (Israel)",
    systemUs: "US IEP",
    talaDescription: "Israeli special education workflow",
    usIepDescription: "US Individualized Education Program",
    appearance: "Appearance",
    appearanceDesc: "Customize the look and feel",
    security: "Security",
    securityDesc: "Manage your account security",
    changePassword: "Change Password",
    manageSessions: "Manage Sessions",
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

  // ============================================================================
  // OVERVIEW (Dashboard)
  // ============================================================================
  overview: {
    title: "Dashboard Overview",
    subtitle: "Monitor student progress and upcoming deadlines",
    totalStudents: "Total Students",
    activeCases: "Active Cases",
    activePlans: "Active Plans",
    completedCases: "Completed",
    completed: "Completed",
    pendingReview: "Pending Review",
    enrolled: "Enrolled in program",
    fromLastMonth: "+2 from last month",
    ytd: "Year to date",
    attentionNeeded: "Needs attention",
    deadlineAlert: "Upcoming Deadlines",
    daysLeft: "days left",
    deadlineDesc: "{count} students have deadlines approaching",
    reviewBtn: "Review All",
    chartTitle: "Caseload by Phase",
    chartSubtitle: "Distribution of students across process phases",
    priorityFocus: "Priority Focus",
    priorityDesc: "Students requiring immediate attention",
    viewAll: "View All Students",
    viewAllPriority: "View All Priority Items",
    noUrgent: "No urgent items",
    phaseGoals: "Goals Development",
    phaseAssessment: "Assessment",
    phaseIntervention: "Intervention",
    phaseReeval: "Re-evaluation",
  },

  // ============================================================================
  // STUDENTS
  // ============================================================================
  students: {
    title: "Students",
    subtitle: "Manage student records and progress tracking",
    searchPlaceholder: "Search students...",
    filterStatus: "Status",
    filterSchool: "School",
    filterAll: "All Students",
    filterUrgent: "Urgent",
    filterActive: "Active",
    filterCompleted: "Completed",
    foundCount: "{count} students found",
    newStudent: "New Student",
    createTitle: "Add New Student",
    createDescription: "Create a new student profile to add to your caseload.",
    createRedirect: "You'll be redirected to the student profile creation flow.",
    idLabel: "ID",
    diagnosisLabel: "Diagnosis",
    progressLabel: "Progress",
    dueLabel: "Due",
    openTala: "Open Process",
    openIEP: "Open IEP",
    openProgress: "Open Progress",
    actions: "Actions",
    editDetails: "Edit Details",
    viewHistory: "View History",
    archive: "Archive",
    all: "All",
    active: "Active",
    completed: "Completed",
    noStudents: "No students yet",
    noStudentsDesc: "Add your first student to get started",
    noResults: "No students found",
    noResultsDesc: "Try adjusting your search or filters",
  },

  // ============================================================================
  // TALA PROCESS (Israel)
  // ============================================================================
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

  // ============================================================================
  // PHASE
  // ============================================================================
  phase: {
    p1: "Initial Assessment",
    p2: "Goals & Planning",
    p3: "Implementation",
    p4: "Review & Evaluation",
  },

  // ============================================================================
  // PROGRAM
  // ============================================================================
  program: {
    // General
    noStudentSelected: "No Student Selected",
    goToStudents: "Go to Students",
    
    // Create Program
    startNew: "Start New Program",
    startNewDesc: "Create a new IEP/TALA program for {name}",
    framework: "Program Framework",
    frameworkTala: "TALA (Israel)",
    frameworkIep: "US IEP",
    year: "Program Year",
    createAndStart: "Create Program",
    previousPrograms: "Previous Programs",
    
    // Status
    status: {
      draft: "Draft",
      active: "Active",
      archived: "Archived",
    },
    
    // Actions
    activate: "Activate Program",
    archive: "Archive Program",
    exportPdf: "Export PDF",
    share: "Share",
    settings: "Settings",
    created: "Program Created",
    createdDesc: "Your program has been created with default profile domains.",
    activated: "Program Activated",
    archived: "Program Archived",
    
    // Tabs
    tabs: {
      overview: "Overview",
      profile: "Profile",
      goals: "Goals",
      services: "Services",
      progress: "Progress",
      team: "Team",
    },
    
    // Stats
    stats: {
      activeGoals: "Active Goals",
      goalsAchieved: "Goals Achieved",
      weeklyMinutes: "Weekly Minutes",
      teamMembers: "Team Members",
    },
    
    // Overview
    overallProgress: "Overall Progress",
    goalCompletion: "Goal Completion",
    goalsByDomain: "Goals by Domain",
    timeline: "Timeline",
    dueDate: "Due Date",
    approvedDate: "Approved Date",
    
    // Profile/Domains
    functionalProfile: "Functional Profile",
    functionalProfileDesc: "Present levels of academic achievement and functional performance",
    domains: {
      cognitive_academic: "Cognitive & Academic",
      communication_language: "Communication & Language",
      social_emotional_behavioral: "Social, Emotional & Behavioral",
      motor_sensory: "Motor & Sensory",
      life_skills_preparation: "Life Skills & Transition Preparation",
      other: "Other",
    },
    goalsLinked: "goals linked",
    impactStatement: "Impact Statement",
    impactStatementPlaceholder: "Describe how the disability affects the student's involvement and progress in the general curriculum...",
    presentLevels: "Present Levels of Performance",
    presentLevelsPlaceholder: "Describe the student's current abilities and performance in this area...",
    strengths: "Strengths",
    strengthsPlaceholder: "List the student's strengths in this area...",
    needs: "Needs",
    needsPlaceholder: "Identify areas needing improvement...",
    educationalImpact: "Educational Impact",
    educationalImpactPlaceholder: "Describe how this affects the student's education...",
    parentInput: "Parent Input",
    parentInputPlaceholder: "Document parent concerns and priorities...",
    
    // Goals
    goalsAndObjectives: "Goals & Objectives",
    goalsAndObjectivesDesc: "Annual goals and short-term objectives for this program",
    noGoals: "No goals have been created yet",
    
    // Services
    servicesAndAccommodations: "Services & Accommodations",
    servicesAndAccommodationsDesc: "Related services, interventions, and accommodations",
    noServices: "No services have been added yet",
    accommodations: "Accommodations",
    
    // Progress
    progressTracking: "Progress Tracking",
    progressTrackingDesc: "Data collection and progress monitoring",
  },

  // ============================================================================
  // GOAL
  // ============================================================================
  goal: {
    add: "Add Goal",
    addFirst: "Add Your First Goal",
    new: "New Goal",
    edit: "Edit Goal",
    created: "Goal Created",
    updated: "Goal Updated",
    deleted: "Goal Deleted",
    confirmDelete: "Are you sure you want to delete this goal?",
    modalDescription: "Create a measurable annual goal aligned with the student's needs",
    
    // Form fields
    title: "Goal Title",
    titlePlaceholder: "e.g., Improve expressive communication",
    titleRequired: "Goal title is required",
    domain: "Profile Domain",
    selectDomain: "Select a domain",
    description: "Goal Description",
    descriptionPlaceholder: "Detailed description of the goal...",
    baseline: "Baseline Level",
    baselinePlaceholder: "Current performance level",
    target: "Target Level",
    targetPlaceholder: "Expected achievement level",
    targetDate: "Target Date",
    currentProgress: "Current Progress",
    
    // Status
    status: {
      draft: "Draft",
      active: "Active",
      achieved: "Achieved",
      modified: "Modified",
      discontinued: "Discontinued",
    },
  },

  // ============================================================================
  // OBJECTIVE
  // ============================================================================
  objective: {
    add: "Add Objective",
    new: "New Objective",
    created: "Objective Created",
    modalDescription: "Create a short-term, measurable objective for this goal",
    title: "Objective",
    noObjectives: "No objectives defined yet",

    
    description: "Objective Description",
    descriptionPlaceholder: "Describe the specific, measurable objective...",
    descriptionRequired: "Objective description is required",
    criteria: "Success Criteria",
    criteriaPlaceholder: "e.g., 80% accuracy over 3 consecutive sessions",
    targetDate: "Target Date",
    
    status: {
      not_started: "Not Started",
      in_progress: "In Progress",
      achieved: "Achieved",
      modified: "Modified",
      discontinued: "Discontinued",
    },
  },

  // ============================================================================
  // SERVICE
  // ============================================================================
  service: {
    add: "Add Service",
    addFirst: "Add Your First Service",
    new: "New Service",
    edit: "Edit Service",
    created: "Service Added",
    updated: "Service Updated",
    deleted: "Service Removed",
    confirmDelete: "Are you sure you want to remove this service?",
    modalDescription: "Add a related service or intervention",
    
    // Form fields
    type: "Service Type",
    name: "Service Name",
    namePlaceholder: "e.g., Individual Speech Therapy",
    nameRequired: "Service name is required",
    //frequency: "Frequency",
    period: "Period",
    duration: "Duration (min)",
    setting: "Setting",
    provider: "Provider",
    providerPlaceholder: "Name of service provider",
    
    // Types
    types: {
      speech_language_therapy: "Speech-Language Therapy",
      occupational_therapy: "Occupational Therapy",
      physical_therapy: "Physical Therapy",
      counseling: "Counseling",
      specialized_instruction: "Specialized Instruction",
      consultation: "Consultation",
      aac_support: "AAC Support",
      other: "Other",
    },
    
    // Frequency
    frequency: {
      daily: "Daily",
      weekly: "Weekly",
      monthly: "Monthly",
    },
    
    // Settings
    settings: {
      general_education: "General Education",
      resource_room: "Resource Room",
      self_contained: "Self-Contained",
      therapy_room: "Therapy Room",
      home: "Home",
      community: "Community",
    },
  },

  // ============================================================================
  // ACCOMMODATION
  // ============================================================================
  accommodation: {
    types: {
      visual_support: "Visual Support",
      aac_device: "AAC Device",
      modified_materials: "Modified Materials",
      extended_time: "Extended Time",
      simplified_language: "Simplified Language",
      environmental_modification: "Environmental Modification",
      other: "Other",
    },
    required: "Required",
  },

  // ============================================================================
  // DATA POINT
  // ============================================================================
  dataPoint: {
    record: "Record Data",
    add: "Add Data",
    created: "Data Point Recorded",
    quickEntry: "Quick Data Entry",
    modalDescription: "Record progress data for this goal",
    title: "Progress Data",
    noDataPoints: "No data recorded yet",
    collectedBy: "Collected by",
    moreCount: "+{{count}} more records",
    
    numericValue: "Numeric Value",
    numericPlaceholder: "e.g., 85",
    textValue: "Text Value",
    textPlaceholder: "e.g., Achieved with minimal prompting",
    notes: "Session Notes",
    notesPlaceholder: "Optional notes about this session...",
    valueRequired: "Please enter a numeric or text value",
  },

  // ============================================================================
  // PROGRESS REPORT
  // ============================================================================
  progressReport: {
    title: "Progress Reports",
    create: "Create Report",
    none: "No progress reports yet",
    shared: "Shared",
  },

  // ============================================================================
  // TEAM
  // ============================================================================
  team: {
    title: "Team Members",
    description: "People involved in the student's program",
    add: "Add Member",
    addMember: "Add Team Member",
    addMemberDescription: "Add a person to the IEP/TALA team",
    noMembers: "No team members added yet",
    memberAdded: "Team Member Added",
    memberRemoved: "Team Member Removed",
    confirmRemove: "Are you sure you want to remove this team member?",
    coordinator: "Coordinator",
    isCoordinator: "This person is the case coordinator",
    
    name: "Full Name",
    namePlaceholder: "Enter full name",
    nameRequired: "Name is required",
    role: "Role",
    email: "Email",
    emailPlaceholder: "email@example.com",
    phone: "Phone",
    phonePlaceholder: "+1 234 567 8900",
    
    roles: {
      parent_guardian: "Parent/Guardian",
      student: "Student",
      homeroom_teacher: "Homeroom Teacher",
      special_education_teacher: "Special Education Teacher",
      general_education_teacher: "General Education Teacher",
      speech_language_pathologist: "Speech-Language Pathologist",
      occupational_therapist: "Occupational Therapist",
      physical_therapist: "Physical Therapist",
      psychologist: "Psychologist",
      administrator: "Administrator",
      case_manager: "Case Manager",
      external_provider: "External Provider",
      other: "Other",
    },
  },

  // ============================================================================
  // MEETING
  // ============================================================================
  meeting: {
    title: "Meetings",
    description: "IEP/TALA team meetings",
    schedule: "Schedule Meeting",
    none: "No meetings scheduled",
    
    types: {
      initial_evaluation: "Initial Evaluation",
      annual_review: "Annual Review",
      reevaluation: "Reevaluation",
      amendment: "Amendment",
      transition_planning: "Transition Planning",
      progress_review: "Progress Review",
    },
  },

  // ============================================================================
  // CONSENT
  // ============================================================================
  consent: {
    title: "Consent Forms",
    description: "Required consent documentation",
    none: "No consent forms required",
    signed: "Signed",
    pending: "Pending",
    signedOn: "Signed on",
    
    types: {
      initial_evaluation: "Initial Evaluation Consent",
      reevaluation: "Reevaluation Consent",
      placement: "Placement Consent",
      release_of_information: "Release of Information",
      service_provision: "Service Provision Consent",
    },
  },

};