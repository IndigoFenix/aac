// One-shot codemod: replace the English-fallback placeholders I inserted
// during the MoE work (SSO labels, SAML admin form, nav.home) with proper
// translations for each of 9 non-EN/HE locales. After this runs, the only
// English-text remaining in those locales is anything that was already
// English-anchored in the codebase.
//
// All keys + English source values match what was added 2026-05-06/07.
// The `find` strings are exact-match — no regex — and use the single-quote
// form the inserter scripts produced.

import fs from "node:fs";

const KEYS = [
  // auth.* SSO block
  { en: "ssoLogin: 'Sign in with {provider}'," },
  { en: "ssoError: 'Sign-in via SSO failed'," },
  { en: "ssoNoAccount: 'No account is linked to that identity. Please log in with your password and link the SSO provider from your account settings.'," },
  { en: "ssoUserNotFound: 'The linked account no longer exists. Contact your administrator.'," },
  { en: "ssoLoginFailed: 'SSO sign-in could not establish a session. Please try again.'," },
  { en: "ssoInvalidState: 'SSO session expired. Please retry.'," },
  // nav.home — uses double-quoted form because the inserter wrote it that way
  { en: 'home: "Go to home",' },
  // admin.identityProviders.saml* block
  { en: "samlSsoUrl: 'SAML SSO URL'," },
  { en: "samlEntityId: 'IdP Entity ID'," },
  { en: "samlX509Cert: 'IdP X.509 Certificate'," },
  { en: "samlNameIdFormat: 'NameID Format'," },
  { en: "samlSloUrl: 'Single Logout URL'," },
  { en: "samlWantAssertionsSigned: 'Require signed assertions'," },
  { en: "samlSignAuthnRequests: 'Sign AuthnRequests'," },
  { en: "samlSpEntityId: 'SP Entity ID (override)'," },
  { en: "samlSpEntityIdPlaceholder: '(default derived from APP_URL)'," },
  { en: "samlSpPrivateKey: 'SP Private Key'," },
  { en: "samlSpCertificate: 'SP Certificate'," },
  { en: "samlMetadataLabel: 'SP metadata URL (give this to the IdP):'," },
];

// Per-locale translations, indexed in the same order as KEYS above.
const TRANSLATIONS = {
  ar: [
    "ssoLogin: 'تسجيل الدخول باستخدام {provider}',",
    "ssoError: 'فشل تسجيل الدخول عبر SSO',",
    "ssoNoAccount: 'لا يوجد حساب مرتبط بهذه الهوية. يرجى تسجيل الدخول بكلمة المرور وربط مزود SSO من إعدادات حسابك.',",
    "ssoUserNotFound: 'الحساب المرتبط لم يعد موجودًا. اتصل بمسؤول النظام.',",
    "ssoLoginFailed: 'تعذّر إنشاء جلسة عبر SSO. يرجى المحاولة مرة أخرى.',",
    "ssoInvalidState: 'انتهت صلاحية جلسة SSO. يرجى المحاولة مرة أخرى.',",
    'home: "الذهاب إلى الصفحة الرئيسية",',
    "samlSsoUrl: 'عنوان SAML SSO',",
    "samlEntityId: 'معرّف كيان IdP',",
    "samlX509Cert: 'شهادة X.509 لـ IdP',",
    "samlNameIdFormat: 'صيغة NameID',",
    "samlSloUrl: 'عنوان تسجيل الخروج الموحّد',",
    "samlWantAssertionsSigned: 'مطلوب توقيع التأكيدات',",
    "samlSignAuthnRequests: 'توقيع طلبات AuthnRequest',",
    "samlSpEntityId: 'معرّف كيان SP (تجاوز)',",
    "samlSpEntityIdPlaceholder: '(الافتراضي مستمد من APP_URL)',",
    "samlSpPrivateKey: 'المفتاح الخاص لـ SP',",
    "samlSpCertificate: 'شهادة SP',",
    "samlMetadataLabel: 'عنوان البيانات الوصفية لـ SP (قدّمه إلى IdP):',",
  ],
  de: [
    "ssoLogin: 'Mit {provider} anmelden',",
    "ssoError: 'Anmeldung über SSO fehlgeschlagen',",
    "ssoNoAccount: 'Mit dieser Identität ist kein Konto verknüpft. Bitte melden Sie sich mit Ihrem Passwort an und verknüpfen Sie den SSO-Anbieter in Ihren Kontoeinstellungen.',",
    "ssoUserNotFound: 'Das verknüpfte Konto existiert nicht mehr. Wenden Sie sich an Ihren Administrator.',",
    "ssoLoginFailed: 'Die SSO-Anmeldung konnte keine Sitzung herstellen. Bitte erneut versuchen.',",
    "ssoInvalidState: 'SSO-Sitzung abgelaufen. Bitte erneut versuchen.',",
    'home: "Zur Startseite",',
    "samlSsoUrl: 'SAML-SSO-URL',",
    "samlEntityId: 'IdP-Entity-ID',",
    "samlX509Cert: 'IdP-X.509-Zertifikat',",
    "samlNameIdFormat: 'NameID-Format',",
    "samlSloUrl: 'Single-Logout-URL',",
    "samlWantAssertionsSigned: 'Signierte Assertions erforderlich',",
    "samlSignAuthnRequests: 'AuthnRequests signieren',",
    "samlSpEntityId: 'SP-Entity-ID (Überschreibung)',",
    "samlSpEntityIdPlaceholder: '(Standard aus APP_URL abgeleitet)',",
    "samlSpPrivateKey: 'Privater SP-Schlüssel',",
    "samlSpCertificate: 'SP-Zertifikat',",
    "samlMetadataLabel: 'SP-Metadaten-URL (an IdP übergeben):',",
  ],
  es: [
    "ssoLogin: 'Iniciar sesión con {provider}',",
    "ssoError: 'Error al iniciar sesión con SSO',",
    "ssoNoAccount: 'No hay ninguna cuenta vinculada a esa identidad. Inicie sesión con su contraseña y vincule el proveedor de SSO desde la configuración de su cuenta.',",
    "ssoUserNotFound: 'La cuenta vinculada ya no existe. Contacte a su administrador.',",
    "ssoLoginFailed: 'El inicio de sesión por SSO no pudo establecer una sesión. Inténtelo nuevamente.',",
    "ssoInvalidState: 'La sesión de SSO expiró. Inténtelo nuevamente.',",
    'home: "Ir al inicio",',
    "samlSsoUrl: 'URL de SAML SSO',",
    "samlEntityId: 'ID de entidad del IdP',",
    "samlX509Cert: 'Certificado X.509 del IdP',",
    "samlNameIdFormat: 'Formato de NameID',",
    "samlSloUrl: 'URL de cierre de sesión único',",
    "samlWantAssertionsSigned: 'Requerir aserciones firmadas',",
    "samlSignAuthnRequests: 'Firmar AuthnRequests',",
    "samlSpEntityId: 'ID de entidad de SP (sobrescribir)',",
    "samlSpEntityIdPlaceholder: '(predeterminado derivado de APP_URL)',",
    "samlSpPrivateKey: 'Clave privada del SP',",
    "samlSpCertificate: 'Certificado del SP',",
    "samlMetadataLabel: 'URL de metadatos del SP (entréguela al IdP):',",
  ],
  fr: [
    "ssoLogin: 'Se connecter avec {provider}',",
    "ssoError: 'Échec de la connexion via SSO',",
    "ssoNoAccount: \"Aucun compte n'est lié à cette identité. Veuillez vous connecter avec votre mot de passe et lier le fournisseur SSO depuis les paramètres de votre compte.\",",
    "ssoUserNotFound: \"Le compte lié n'existe plus. Contactez votre administrateur.\",",
    "ssoLoginFailed: \"La connexion SSO n'a pas pu établir de session. Veuillez réessayer.\",",
    "ssoInvalidState: 'La session SSO a expiré. Veuillez réessayer.',",
    'home: "Aller à l\'accueil",',
    "samlSsoUrl: 'URL SAML SSO',",
    "samlEntityId: \"ID d'entité IdP\",",
    "samlX509Cert: \"Certificat X.509 de l'IdP\",",
    "samlNameIdFormat: 'Format NameID',",
    "samlSloUrl: 'URL de déconnexion unique',",
    "samlWantAssertionsSigned: 'Exiger des assertions signées',",
    "samlSignAuthnRequests: 'Signer les AuthnRequests',",
    "samlSpEntityId: \"ID d'entité SP (remplacement)\",",
    "samlSpEntityIdPlaceholder: '(par défaut dérivé de APP_URL)',",
    "samlSpPrivateKey: 'Clé privée SP',",
    "samlSpCertificate: 'Certificat SP',",
    "samlMetadataLabel: \"URL des métadonnées SP (à fournir à l'IdP) :\",",
  ],
  ko: [
    "ssoLogin: '{provider}(으)로 로그인',",
    "ssoError: 'SSO 로그인 실패',",
    "ssoNoAccount: '해당 신원에 연결된 계정이 없습니다. 비밀번호로 로그인한 후 계정 설정에서 SSO 공급자를 연결하세요.',",
    "ssoUserNotFound: '연결된 계정이 더 이상 존재하지 않습니다. 관리자에게 문의하세요.',",
    "ssoLoginFailed: 'SSO 로그인이 세션을 설정하지 못했습니다. 다시 시도하세요.',",
    "ssoInvalidState: 'SSO 세션이 만료되었습니다. 다시 시도하세요.',",
    'home: "홈으로 이동",',
    "samlSsoUrl: 'SAML SSO URL',",
    "samlEntityId: 'IdP 엔터티 ID',",
    "samlX509Cert: 'IdP X.509 인증서',",
    "samlNameIdFormat: 'NameID 형식',",
    "samlSloUrl: '단일 로그아웃 URL',",
    "samlWantAssertionsSigned: '서명된 어설션 필요',",
    "samlSignAuthnRequests: 'AuthnRequest 서명',",
    "samlSpEntityId: 'SP 엔터티 ID (재정의)',",
    "samlSpEntityIdPlaceholder: '(기본값은 APP_URL에서 파생됨)',",
    "samlSpPrivateKey: 'SP 개인 키',",
    "samlSpCertificate: 'SP 인증서',",
    "samlMetadataLabel: 'SP 메타데이터 URL (IdP에 제공):',",
  ],
  pt: [
    "ssoLogin: 'Entrar com {provider}',",
    "ssoError: 'Falha ao entrar via SSO',",
    "ssoNoAccount: 'Nenhuma conta está vinculada a essa identidade. Faça login com sua senha e vincule o provedor SSO nas configurações da conta.',",
    "ssoUserNotFound: 'A conta vinculada não existe mais. Contate o administrador.',",
    "ssoLoginFailed: 'O login via SSO não conseguiu estabelecer uma sessão. Tente novamente.',",
    "ssoInvalidState: 'A sessão SSO expirou. Tente novamente.',",
    'home: "Ir para a página inicial",',
    "samlSsoUrl: 'URL do SAML SSO',",
    "samlEntityId: 'ID da entidade do IdP',",
    "samlX509Cert: 'Certificado X.509 do IdP',",
    "samlNameIdFormat: 'Formato do NameID',",
    "samlSloUrl: 'URL de Logout Único',",
    "samlWantAssertionsSigned: 'Exigir afirmações assinadas',",
    "samlSignAuthnRequests: 'Assinar AuthnRequests',",
    "samlSpEntityId: 'ID da entidade do SP (substituir)',",
    "samlSpEntityIdPlaceholder: '(padrão derivado de APP_URL)',",
    "samlSpPrivateKey: 'Chave privada do SP',",
    "samlSpCertificate: 'Certificado do SP',",
    "samlMetadataLabel: 'URL de metadados do SP (forneça ao IdP):',",
  ],
  ru: [
    "ssoLogin: 'Войти через {provider}',",
    "ssoError: 'Не удалось выполнить вход через SSO',",
    "ssoNoAccount: 'С этой учётной записью не связан ни один пользователь. Войдите с паролем и подключите провайдера SSO в настройках учётной записи.',",
    "ssoUserNotFound: 'Связанная учётная запись больше не существует. Обратитесь к администратору.',",
    "ssoLoginFailed: 'Не удалось установить сессию SSO. Попробуйте ещё раз.',",
    "ssoInvalidState: 'Сессия SSO истекла. Попробуйте ещё раз.',",
    'home: "На главную",',
    "samlSsoUrl: 'URL SAML SSO',",
    "samlEntityId: 'Entity ID IdP',",
    "samlX509Cert: 'Сертификат X.509 IdP',",
    "samlNameIdFormat: 'Формат NameID',",
    "samlSloUrl: 'URL единого выхода',",
    "samlWantAssertionsSigned: 'Требовать подписанные утверждения',",
    "samlSignAuthnRequests: 'Подписывать AuthnRequest',",
    "samlSpEntityId: 'Entity ID SP (переопределить)',",
    "samlSpEntityIdPlaceholder: '(по умолчанию из APP_URL)',",
    "samlSpPrivateKey: 'Закрытый ключ SP',",
    "samlSpCertificate: 'Сертификат SP',",
    "samlMetadataLabel: 'URL метаданных SP (передать IdP):',",
  ],
  yue: [
    "ssoLogin: '用 {provider} 登入',",
    "ssoError: '經 SSO 登入失敗',",
    "ssoNoAccount: '冇帳戶連繫到呢個身份。請用密碼登入,然後喺帳戶設定度連繫 SSO 供應商。',",
    "ssoUserNotFound: '已連繫嘅帳戶唔再存在。請聯絡管理員。',",
    "ssoLoginFailed: 'SSO 登入冇辦法建立工作階段。請再試吓。',",
    "ssoInvalidState: 'SSO 工作階段已過期。請再試吓。',",
    'home: "返回主頁",',
    "samlSsoUrl: 'SAML SSO 網址',",
    "samlEntityId: 'IdP 實體 ID',",
    "samlX509Cert: 'IdP X.509 憑證',",
    "samlNameIdFormat: 'NameID 格式',",
    "samlSloUrl: '單一登出網址',",
    "samlWantAssertionsSigned: '要求簽名嘅斷言',",
    "samlSignAuthnRequests: '簽署 AuthnRequest',",
    "samlSpEntityId: 'SP 實體 ID(覆寫)',",
    "samlSpEntityIdPlaceholder: '(預設由 APP_URL 推導)',",
    "samlSpPrivateKey: 'SP 私鑰',",
    "samlSpCertificate: 'SP 憑證',",
    "samlMetadataLabel: 'SP 元資料網址(交畀 IdP):',",
  ],
  zh: [
    "ssoLogin: '使用 {provider} 登录',",
    "ssoError: '通过 SSO 登录失败',",
    "ssoNoAccount: '没有账户与该身份关联。请使用密码登录,然后在账户设置中关联 SSO 提供商。',",
    "ssoUserNotFound: '关联的账户不再存在。请联系管理员。',",
    "ssoLoginFailed: 'SSO 登录无法建立会话。请重试。',",
    "ssoInvalidState: 'SSO 会话已过期。请重试。',",
    'home: "前往首页",',
    "samlSsoUrl: 'SAML SSO URL',",
    "samlEntityId: 'IdP 实体 ID',",
    "samlX509Cert: 'IdP X.509 证书',",
    "samlNameIdFormat: 'NameID 格式',",
    "samlSloUrl: '单点登出 URL',",
    "samlWantAssertionsSigned: '要求签名断言',",
    "samlSignAuthnRequests: '签署 AuthnRequest',",
    "samlSpEntityId: 'SP 实体 ID(覆盖)',",
    "samlSpEntityIdPlaceholder: '(默认从 APP_URL 派生)',",
    "samlSpPrivateKey: 'SP 私钥',",
    "samlSpCertificate: 'SP 证书',",
    "samlMetadataLabel: 'SP 元数据 URL(提供给 IdP):',",
  ],
};

let totalReplaced = 0;
let totalMissed = 0;
for (const [lang, translations] of Object.entries(TRANSLATIONS)) {
  if (translations.length !== KEYS.length) {
    console.error(`[${lang}] translation count ${translations.length} ≠ key count ${KEYS.length}`);
    process.exit(1);
  }
  const path = `client/src/i18n/${lang}.ts`;
  let src = fs.readFileSync(path, "utf8");
  let replaced = 0;
  let missed = 0;
  for (let i = 0; i < KEYS.length; i++) {
    const en = KEYS[i].en;
    const tr = translations[i];
    if (!src.includes(en)) {
      console.warn(`[${lang}] not found: ${en.slice(0, 60)}`);
      missed++;
      continue;
    }
    src = src.replace(en, tr);
    replaced++;
  }
  fs.writeFileSync(path, src);
  console.log(`[${lang}] replaced ${replaced}/${KEYS.length}${missed ? ` (${missed} not found)` : ""}`);
  totalReplaced += replaced;
  totalMissed += missed;
}
console.log("");
console.log(`Total: ${totalReplaced} replaced, ${totalMissed} not found across ${Object.keys(TRANSLATIONS).length} locales.`);
