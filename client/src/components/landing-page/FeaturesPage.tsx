/**
 * Marketing features page — /features
 *
 * Copy source of record: planning-docs/website-features-copy.md. Its thesis is
 * the loop between the two sides of the platform, so the layout gives every
 * feature group a dedicated "loop" callout rather than burying the crossover
 * line in body text.
 *
 * Not the landing page. It lives at its own URL until the copy is signed off;
 * only then does it get per-locale routes (/he/features, ...) and an entry in
 * scripts/prerender-landing.ts. Until that happens there is deliberately no
 * URL<->locale sync here: switching language re-renders in place and the
 * address bar stays at /features.
 *
 * Image slots render as labelled placeholders. Each one already carries its
 * translated alt text, so dropping a real file in is a one-line change:
 * `<Shot alt={...} src={someImport} />`.
 *
 * The copy says "AAC user" literally and uses NO {{student}} placeholder, which
 * is a deliberate reversal of §2 of the copy doc. t() runs adaptStudentLabel on
 * every value, and that resolves the placeholder in the CURRENT UI LANGUAGE
 * against a module-level institute type — so on a public page with English text
 * and no organization, switching the picker to Spanish spliced "estudiante"
 * (or "paciente", depending on leftover institute state) into an English
 * sentence. The label is only coherent when it varies WITH the reader's
 * organization; a marketing page has no organization, so it names the audience
 * outright. Don't reintroduce the placeholder here.
 */
import { ArrowRight, ClipboardList, Image as ImageIcon, MessageSquare, Radio, Repeat } from "lucide-react";
import { useLanguage, SUPPORTED_LANGUAGES, type LanguageCode } from "@/contexts/LanguageContext";
import logo from "@assets/aivota_icon.png";
import "./landing-page.css";
import "./features-page.css";

/** The landing endpoint that serves a given locale. English lives at the root. */
function localePath(code: LanguageCode): string {
  return code === "en" ? "/" : `/${code}`;
}

/**
 * An image slot. With no `src` it draws a dashed frame captioned with the alt
 * text of the picture that belongs there — a placeholder that documents itself
 * and needs no untranslated developer copy.
 */
function Shot({ alt, src, wide }: { alt: string; src?: string; wide?: boolean }) {
  const { t } = useLanguage();
  const className = `fp-shot${wide ? " fp-shot-wide" : ""}`;

  if (src) {
    return (
      <div className={className}>
        <img src={src} alt={alt} loading="lazy" decoding="async" />
      </div>
    );
  }

  return (
    <div className={`${className} fp-shot-empty`} role="img" aria-label={alt}>
      <ImageIcon size={28} strokeWidth={1.5} aria-hidden="true" />
      <span className="fp-shot-badge">{t("featuresPage.imagePlaceholder")}</span>
      <span className="fp-shot-caption">{alt}</span>
    </div>
  );
}

/**
 * One feature group: headline, lede, the crossover callout, then the proof
 * points. `flip` puts the image on the opposite side so a band of groups
 * alternates down the page.
 */
function Feature({
  base,
  points,
  flip,
}: {
  /** i18n key prefix, e.g. "featuresPage.clinician.chat" */
  base: string;
  /** leaf names of the proof points, in display order */
  points: readonly string[];
  flip?: boolean;
}) {
  const { t } = useLanguage();

  return (
    <article className={`fp-feature${flip ? " fp-feature-flip" : ""}`}>
      <div className="fp-feature-text">
        <h3>{t(`${base}.title`)}</h3>
        <p className="fp-feature-lede">{t(`${base}.body`)}</p>

        <div className="fp-loop-note">
          <span className="fp-loop-note-label">
            <Repeat size={14} strokeWidth={2.25} aria-hidden="true" />
            {t("featuresPage.loopLabel")}
          </span>
          <p>{t(`${base}.loop`)}</p>
        </div>

        <ul className="fp-points">
          {points.map((point) => (
            <li key={point}>{t(`${base}.${point}`)}</li>
          ))}
        </ul>
      </div>

      <div className="fp-feature-media">
        <Shot alt={t(`${base}.imageAlt`)} />
      </div>
    </article>
  );
}

const LOOP_STEPS = [
  { key: "plan", Icon: ClipboardList },
  { key: "session", Icon: Radio },
  { key: "evidence", Icon: MessageSquare },
] as const;

export default function FeaturesPage() {
  const { t, isRTL, language, setLanguage } = useLanguage();

  return (
    <div className="landing features-page" dir={isRTL ? "rtl" : "ltr"}>
      <a href="#fp-main" className="fp-skip-link">
        {t("featuresPage.skipToContent")}
      </a>

      <header className="landing-header">
        <div className="landing-container">
          <a href="/" className="landing-logo" aria-label="Aivota">
            <img src={logo} alt="" />
            aivota
          </a>
          <div className="landing-header-actions">
            <a href="/" className="fp-nav-link">
              {t("featuresPage.nav.home")}
            </a>
            <select
              className="landing-lang-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value as LanguageCode)}
              aria-label={t("landing.nav.languageLabel")}
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.nativeName}
                </option>
              ))}
            </select>
            <a href="/login" className="landing-btn landing-btn-sm">
              {t("landing.nav.login")}
            </a>
          </div>
        </div>
      </header>

      <main id="fp-main">
        <section className="landing-hero fp-hero">
          <div className="landing-container">
            <div className="landing-hero-grid">
              <div className="landing-hero-content">
                <span className="landing-tagline">{t("featuresPage.hero.tagline")}</span>
                <h1>{t("featuresPage.hero.title")}</h1>
                <p className="landing-hero-subtitle">{t("featuresPage.hero.subtitle")}</p>
                <a href="#fp-demo" className="landing-btn landing-btn-primary">
                  {t("featuresPage.hero.cta")}
                </a>
              </div>
              <Shot alt={t("featuresPage.hero.imageAlt")} wide />
            </div>
          </div>
        </section>

        {/* The thesis, stated once before any feature appears. */}
        <section className="landing-section landing-section-alt">
          <div className="landing-container">
            <div className="landing-section-header">
              <h2>{t("featuresPage.loop.title")}</h2>
              <p>{t("featuresPage.loop.subtitle")}</p>
            </div>
            <div className="fp-loop-diagram">
              <ol className="fp-loop-track">
                {LOOP_STEPS.map(({ key, Icon }, i) => (
                  <li key={key} className="fp-loop-step">
                    <div className="fp-loop-step-icon">
                      <Icon size={26} strokeWidth={1.75} aria-hidden="true" />
                    </div>
                    <h3>{t(`featuresPage.loop.${key}.title`)}</h3>
                    <p>{t(`featuresPage.loop.${key}.body`)}</p>
                    {/* Connector into the next step. Decorative — the <ol>
                        already carries the sequence for assistive tech. */}
                    {i < LOOP_STEPS.length - 1 && (
                      <span className="fp-loop-arrow" aria-hidden="true">
                        <ArrowRight size={20} strokeWidth={2} />
                      </span>
                    )}
                  </li>
                ))}
              </ol>
              {/* The return path: evidence feeds the next plan, so the third
                  step runs back under the row into the first. Drawn rather than
                  implied, because the cycle closing IS the section's argument.
                  Hidden once the steps stack — a line under a column has
                  nothing to return across. */}
              <span className="fp-loop-return" aria-hidden="true" />
            </div>
          </div>
        </section>

        <section className="landing-section fp-band" id="fp-clinician">
          <div className="landing-container">
            <div className="landing-section-header">
              <span className="landing-tagline">{t("featuresPage.clinician.tagline")}</span>
              <h2>{t("featuresPage.clinician.title")}</h2>
              <p>{t("featuresPage.clinician.subtitle")}</p>
            </div>
            <Feature
              base="featuresPage.clinician.chat"
              points={["personas", "library", "gated"]}
            />
            <Feature
              base="featuresPage.clinician.boards"
              points={["glyphs", "symbols", "packages"]}
              flip
            />
            <Feature
              base="featuresPage.clinician.program"
              points={["evidence", "reports"]}
            />
            <Feature
              base="featuresPage.clinician.analysis"
              points={["patterns", "draft", "video"]}
              flip
            />
          </div>
        </section>

        <section className="landing-section landing-section-alt fp-band" id="fp-student">
          <div className="landing-container">
            <div className="landing-section-header">
              <span className="landing-tagline">{t("featuresPage.student.tagline")}</span>
              <h2>{t("featuresPage.student.title")}</h2>
              <p>{t("featuresPage.student.subtitle")}</p>
            </div>
            <Feature
              base="featuresPage.student.board"
              points={["builder", "voice"]}
            />
            <Feature
              base="featuresPage.student.helper"
              points={["modes", "boundary"]}
              flip
            />
            <Feature
              base="featuresPage.student.social"
              points={["adjustable", "debrief", "safe"]}
            />
            <Feature
              base="featuresPage.student.wordfinder"
              points={["deterministic", "remembered", "evidence"]}
              flip
            />
          </div>
        </section>

        {/* Apps and games: mentioned, not itemized, and with no crossover line
            of its own — so it gets a single wide card rather than a feature row. */}
        <section className="landing-section">
          <div className="landing-container">
            <div className="fp-apps">
              <div className="fp-apps-text">
                <h2>{t("featuresPage.apps.title")}</h2>
                <p className="fp-feature-lede">{t("featuresPage.apps.body")}</p>
                <ul className="fp-points fp-points-row">
                  {(["aware", "curated", "access"] as const).map((point) => (
                    <li key={point}>{t(`featuresPage.apps.${point}`)}</li>
                  ))}
                </ul>
              </div>
              <Shot alt={t("featuresPage.apps.imageAlt")} />
            </div>
          </div>
        </section>

        <section className="landing-section landing-section-alt fp-cta" id="fp-demo">
          <div className="landing-container">
            <h2>{t("featuresPage.cta.title")}</h2>
            <p>{t("featuresPage.cta.subtitle")}</p>
            {/* The contact form lives on the landing page; this hands off to it
                rather than standing up a second copy of the same form. */}
            <a href="/#pilot" className="landing-btn landing-btn-primary">
              {t("featuresPage.cta.button")}
            </a>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <nav className="landing-lang-links" aria-label={t("landing.nav.languageLabel")}>
          {SUPPORTED_LANGUAGES.map((lang) => (
            <a
              key={lang.code}
              href={localePath(lang.code)}
              hrefLang={lang.code}
              lang={lang.code}
              dir={lang.direction}
              // Same reason as the landing page's copy of this nav: these are real
              // navigations, and "/" cannot say that it means English (/en 301s to
              // it), so the choice has to be recorded before the browser leaves.
              onClick={() => setLanguage(lang.code)}
            >
              {lang.nativeName}
            </a>
          ))}
        </nav>
        <p>{t("landing.footer.text")}</p>
        <div className="fp-footer-links">
          <a href="/terms-of-service">{t("landing.footer.terms")}</a>
          <a href="/privacy-policy">{t("landing.footer.privacy")}</a>
          <a href="/cookie-policy">{t("landing.footer.cookies")}</a>
          <a href="/accessibility">{t("landing.footer.accessibility")}</a>
          <a href="/ai-policy">{t("landing.footer.aiPolicy")}</a>
        </div>
        <p className="fp-footer-rights">{t("landing.footer.rights")}</p>
      </footer>
    </div>
  );
}
