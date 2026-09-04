// scripts/ios-permission-strings.mjs
//
// The iOS permission dialog strings, in every language the AAC client ships.
//
// WHY THESE ARE NOT IN client-aac/src/i18n/: iOS renders these itself, before
// any JavaScript runs, and it picks the language from the DEVICE's preferred
// languages — not from the in-app language picker. They are read out of the
// app bundle's `<lang>.lproj/InfoPlist.strings` files, which is a native
// localization mechanism with no `t()` call site. So `validate-i18n` and
// `scan:i18n` cannot see them and would not know they exist; this file is the
// only place they are defined, and scripts/ios-configure.mjs writes the
// .lproj files from it.
//
// App Review reads these strings and rejects builds whose text does not
// explain the actual use, so keep them concrete rather than generic.
//
// BASE is the English text. ios-configure.mjs writes it into Info.plist as the
// fallback for any language not listed here, AND emits it as en.lproj — so the
// English cannot drift between the two.

/** @type {Record<string, string>} */
export const BASE_PERMISSION_STRINGS = {
  // The Observer agent watches the student through the front camera to read
  // attention, gaze, expression and (where enabled) seizure indicators.
  NSCameraUsageDescription:
    "Aivota uses the camera to see how the student is responding, so the communication board can adapt to them.",

  // Speech from the student and the people around them drives the Observer and
  // the speech-to-text pipeline.
  NSMicrophoneUsageDescription:
    "Aivota listens so it can understand speech and respond to the student.",

  // Eye-tracker companion software is reached over ws://localhost. On iOS any
  // local-network access prompts, and WITHOUT this key the app is terminated
  // rather than merely denied.
  NSLocalNetworkUsageDescription:
    "Aivota connects to eye-tracking hardware on this network so the student can select with their eyes.",
};

// Locale → .lproj directory name. The app's own locale codes are not all valid
// iOS bundle localizations:
//
//   zh  → zh-Hans   client-aac/src/i18n/zh.ts is Simplified ("保存").
//   yue → yue-Hant  yue.ts is Traditional ("儲存").
//   pt  → pt-BR AND pt
//                   pt.ts is Brazilian ("usuário", "Salvar", "tela"), but a
//                   device set to Portuguese (Portugal) reports pt-PT and
//                   would fall through to English on a pt-BR-only bundle. The
//                   same text is emitted under a plain `pt` as the catch-all,
//                   mirroring the app's single Portuguese locale.
//
// Everything else maps to itself.
export const LPROJ_FOR_LOCALE = {
  en: ["en"],
  ar: ["ar"],
  de: ["de"],
  es: ["es"],
  fr: ["fr"],
  he: ["he"],
  ko: ["ko"],
  pt: ["pt-BR", "pt"],
  ru: ["ru"],
  yue: ["yue-Hant"],
  zh: ["zh-Hans"],
};

/**
 * Translations of BASE_PERMISSION_STRINGS, keyed by the app's locale code.
 * `en` is intentionally absent — it comes from BASE_PERMISSION_STRINGS.
 */
export const IOS_PERMISSION_STRINGS = {
  ar: {
    NSCameraUsageDescription:
      "يستخدم Aivota الكاميرا لمعرفة كيف يستجيب الطالب، حتى يتمكن لوح التواصل من التكيّف معه.",
    NSMicrophoneUsageDescription:
      "يستمع Aivota لكي يفهم الكلام ويستجيب للطالب.",
    NSLocalNetworkUsageDescription:
      "يتصل Aivota بأجهزة تتبّع العين على هذه الشبكة ليتمكن الطالب من الاختيار بعينيه.",
  },
  de: {
    NSCameraUsageDescription:
      "Aivota verwendet die Kamera, um zu sehen, wie der Schüler reagiert, damit sich die Kommunikationstafel an ihn anpassen kann.",
    NSMicrophoneUsageDescription:
      "Aivota hört zu, um Sprache zu verstehen und dem Schüler zu antworten.",
    NSLocalNetworkUsageDescription:
      "Aivota verbindet sich mit Eyetracking-Geräten in diesem Netzwerk, damit der Schüler mit den Augen auswählen kann.",
  },
  es: {
    NSCameraUsageDescription:
      "Aivota usa la cámara para ver cómo responde el estudiante, de modo que el tablero de comunicación pueda adaptarse a él.",
    NSMicrophoneUsageDescription:
      "Aivota escucha para poder entender el habla y responder al estudiante.",
    NSLocalNetworkUsageDescription:
      "Aivota se conecta a dispositivos de seguimiento ocular en esta red para que el estudiante pueda seleccionar con la mirada.",
  },
  fr: {
    NSCameraUsageDescription:
      "Aivota utilise la caméra pour voir comment l'élève réagit, afin que le tableau de communication puisse s'adapter à lui.",
    NSMicrophoneUsageDescription:
      "Aivota écoute afin de comprendre la parole et de répondre à l'élève.",
    NSLocalNetworkUsageDescription:
      "Aivota se connecte au matériel d'oculométrie présent sur ce réseau pour que l'élève puisse sélectionner avec les yeux.",
  },
  he: {
    NSCameraUsageDescription:
      "Aivota משתמשת במצלמה כדי לראות כיצד התלמיד מגיב, כך שלוח התקשורת יוכל להתאים את עצמו אליו.",
    NSMicrophoneUsageDescription:
      "Aivota מאזינה כדי להבין דיבור ולהגיב לתלמיד.",
    NSLocalNetworkUsageDescription:
      "Aivota מתחברת לחומרת מעקב עיניים ברשת הזו כדי שהתלמיד יוכל לבחור בעזרת העיניים.",
  },
  ko: {
    NSCameraUsageDescription:
      "Aivota는 학생이 어떻게 반응하는지 보기 위해 카메라를 사용하며, 이를 통해 의사소통 보드가 학생에게 맞춰집니다.",
    NSMicrophoneUsageDescription:
      "Aivota는 말을 이해하고 학생에게 응답하기 위해 소리를 듣습니다.",
    NSLocalNetworkUsageDescription:
      "Aivota는 학생이 눈으로 선택할 수 있도록 이 네트워크의 시선 추적 장치에 연결합니다.",
  },
  pt: {
    NSCameraUsageDescription:
      "A Aivota usa a câmera para ver como o usuário de CAA está respondendo, para que a prancha de comunicação possa se adaptar a ele.",
    NSMicrophoneUsageDescription:
      "A Aivota escuta para poder entender a fala e responder ao usuário de CAA.",
    NSLocalNetworkUsageDescription:
      "A Aivota se conecta a equipamentos de rastreamento ocular nesta rede para que o usuário de CAA possa selecionar com os olhos.",
  },
  ru: {
    NSCameraUsageDescription:
      "Aivota использует камеру, чтобы видеть, как реагирует ученик, и адаптировать под него коммуникационную доску.",
    NSMicrophoneUsageDescription:
      "Aivota слушает, чтобы понимать речь и отвечать ученику.",
    NSLocalNetworkUsageDescription:
      "Aivota подключается к оборудованию для отслеживания взгляда в этой сети, чтобы ученик мог выбирать глазами.",
  },
  yue: {
    NSCameraUsageDescription:
      "Aivota 用鏡頭睇學生點樣回應，等溝通板可以配合佢。",
    NSMicrophoneUsageDescription:
      "Aivota 會聆聽，從而理解說話並回應學生。",
    NSLocalNetworkUsageDescription:
      "Aivota 連接呢個網絡上嘅眼動追蹤裝置，等學生可以用眼睛揀選。",
  },
  zh: {
    NSCameraUsageDescription:
      "Aivota 使用摄像头观察学生的反应，以便沟通板能够适应他们。",
    NSMicrophoneUsageDescription:
      "Aivota 会聆听，以便理解语音并回应学生。",
    NSLocalNetworkUsageDescription:
      "Aivota 连接此网络上的眼动追踪设备，让学生可以用眼睛进行选择。",
  },
};
