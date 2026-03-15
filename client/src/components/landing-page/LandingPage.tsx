import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest } from "@/lib/queryClient";
import { Redirect } from "wouter";
import logo from "@assets/aivota_icon.png";
import raz from "@assets/landing-page/raz.png";
import opher from "@assets/landing-page/opher.png";
import screenshot from "@assets/landing-page/screenshot.png";
import "./landing-page.css";

const ROLE_OPTIONS = [
  "district_administrator",
  "wing_administrator",
  "supervisor",
  "training",
  "school_administrator",
  "educator",
  "educator_SLP",
  "educator_OP",
  "educator_PT",
  "other",
] as const;

export default function LandingPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const { t, isRTL, language, setLanguage } = useLanguage();

  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    organization: "",
    role: "" as string,
    message: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (isAuthenticated) {
    return <Redirect to="/home" />;
  }

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    setError("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.firstName || !form.lastName || !form.email || !form.organization || !form.role) {
      setError(t("landing.form.required"));
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await apiRequest("POST", "/api/contact", form);
      setSubmitted(true);
    } catch {
      setError(t("landing.form.error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="landing" dir={isRTL ? "rtl" : "ltr"}>
      <header className="landing-header">
        <div className="landing-container">
          <a href="#" className="landing-logo">
            <img src={logo} alt="Aivota" />
            aivota
          </a>
          <div className="landing-header-actions">
            <button
              className="landing-lang-toggle"
              onClick={() => setLanguage(language === "en" ? "he" : "en")}
            >
              {language === "en" ? "עב" : "EN"}
            </button>
            <a href="/login" className="landing-btn landing-btn-sm">
              {t("landing.nav.login")}
            </a>
          </div>
        </div>
      </header>

      <section className="landing-hero">
        <div className="landing-container">
          <div className="landing-hero-grid">
            <div className="landing-hero-content">
              <span className="landing-tagline">{t("landing.hero.tagline")}</span>
              <h1>{t("landing.hero.title")}</h1>
              <p className="landing-hero-subtitle">{t("landing.hero.subtitle")}</p>
              <a href="#pilot" className="landing-btn landing-btn-primary">
                {t("landing.hero.cta")}
              </a>
            </div>
            <div className="landing-screenshot">
              <img
                src={screenshot}
                alt={t("landing.hero.screenshotAlt")}
                loading="lazy"
              />
            </div>
          </div>
        </div>
      </section>

      <section className="landing-section landing-section-alt">
        <div className="landing-container">
          <div className="landing-section-header">
            <h2>{t("landing.pillars.title")}</h2>
            <p>{t("landing.pillars.subtitle")}</p>
          </div>
          <div className="landing-pillar-grid">
            <div className="landing-card">
              <span className="landing-tagline">{t("landing.pillars.iep.label")}</span>
              <h3>{t("landing.pillars.iep.title")}</h3>
              <p>{t("landing.pillars.iep.description")}</p>
            </div>
            <div className="landing-card">
              <span className="landing-tagline">{t("landing.pillars.aac.label")}</span>
              <h3>{t("landing.pillars.aac.title")}</h3>
              <p>{t("landing.pillars.aac.description")}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-container">
          <div className="landing-founder-grid">
            <img
              src={opher}
              alt={t("landing.founder.imageAlt")}
              className="landing-founder-photo"
            />
            <div>
              <span className="landing-tagline">{t("landing.founder.label")}</span>
              <h2>{t("landing.founder.title")}</h2>
              <p className="landing-founder-bio">{t("landing.founder.bio")}</p>
              <div className="landing-founder-callout">
                <p className="landing-founder-callout-title">{t("landing.founder.calloutTitle")}</p>
                <p>{t("landing.founder.calloutText")}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="landing-container">
        <section className="landing-testimonial">
          <div className="landing-testimonial-inner">
            <img
              src={raz}
              alt={t("landing.testimonial.authorName")}
              className="landing-testimonial-avatar"
            />
            <p className="landing-testimonial-quote">"{t("landing.testimonial.quote")}"</p>
            <p className="landing-testimonial-name">{t("landing.testimonial.authorName")}</p>
            <p className="landing-testimonial-role">{t("landing.testimonial.authorRole")}</p>
          </div>
        </section>
      </div>

      <section className="landing-section landing-section-alt" id="pilot">
        <div className="landing-container" style={{ textAlign: "center" }}>
          <h2>{t("landing.pilot.title")}</h2>
          <p className="landing-pilot-subtitle">{t("landing.pilot.subtitle")}</p>
          <div className="landing-contact-frame">
            {submitted ? (
              <div className="landing-form-success">
                <p>{t("landing.form.success")}</p>
              </div>
            ) : (
              <form className="landing-form" onSubmit={handleSubmit}>
                <div className="landing-form-row">
                  <div className="landing-form-group">
                    <label htmlFor="firstName">{t("landing.form.firstName")}</label>
                    <input
                      id="firstName"
                      name="firstName"
                      type="text"
                      value={form.firstName}
                      onChange={handleChange}
                      required
                    />
                  </div>
                  <div className="landing-form-group">
                    <label htmlFor="lastName">{t("landing.form.lastName")}</label>
                    <input
                      id="lastName"
                      name="lastName"
                      type="text"
                      value={form.lastName}
                      onChange={handleChange}
                      required
                    />
                  </div>
                </div>
                <div className="landing-form-group">
                  <label htmlFor="email">{t("landing.form.email")}</label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    value={form.email}
                    onChange={handleChange}
                    required
                  />
                </div>
                <div className="landing-form-group">
                  <label htmlFor="organization">{t("landing.form.organization")}</label>
                  <input
                    id="organization"
                    name="organization"
                    type="text"
                    value={form.organization}
                    onChange={handleChange}
                    required
                  />
                </div>
                <div className="landing-form-group">
                  <label htmlFor="role">{t("landing.form.role")}</label>
                  <select
                    id="role"
                    name="role"
                    value={form.role}
                    onChange={handleChange}
                    required
                  >
                    <option value="">{t("landing.form.selectRole")}</option>
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {t(`landing.form.roles.${r}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="landing-form-group">
                  <label htmlFor="message">{t("landing.form.message")}</label>
                  <textarea
                    id="message"
                    name="message"
                    rows={4}
                    value={form.message}
                    onChange={handleChange}
                  />
                </div>
                {error && <p className="landing-form-error">{error}</p>}
                <button
                  type="submit"
                  className="landing-btn landing-btn-primary"
                  disabled={submitting}
                  style={{ width: "100%" }}
                >
                  {submitting ? t("common.saving") : t("landing.form.submit")}
                </button>
              </form>
            )}
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <p>{t("landing.footer.text")}</p>
        <div style={{ marginTop: '0.75rem', display: 'flex', justifyContent: 'center', gap: '1rem', flexWrap: 'wrap', fontSize: '0.8rem' }}>
          <a href="/terms-of-service" style={{ color: 'inherit', textDecoration: 'none' }} className="hover:underline">
            {t("landing.footer.terms")}
          </a>
          <a href="/privacy-policy" style={{ color: 'inherit', textDecoration: 'none' }} className="hover:underline">
            {t("landing.footer.privacy")}
          </a>
          <a href="/cookie-policy" style={{ color: 'inherit', textDecoration: 'none' }} className="hover:underline">
            {t("landing.footer.cookies")}
          </a>
          <a href="/accessibility" style={{ color: 'inherit', textDecoration: 'none' }} className="hover:underline">
            {t("landing.footer.accessibility")}
          </a>
        </div>
      </footer>
    </div>
  );
}
