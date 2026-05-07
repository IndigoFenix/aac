// Per-regime printable Letter of Medical Necessity templates.
// Mirrors the openPrintableReport pattern in ReportsPanel: build HTML with
// inline CSS, open in a new browser tab, user invokes window.print() →
// browser-native PDF. No external dependencies.

import type { LetterOfMedicalNecessity } from '@shared/schema';
import type { LmnSections } from '@shared/insurance-lmn-types';
import type { BillingRegime } from '@shared/license-permissions';

interface InstituteInfo {
  name: string;
  logoUrl: string | null;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraphs(text: string): string {
  if (!text) return '';
  return text
    .split(/\n\s*\n/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

function bulletList(items: string[]): string {
  if (!items || items.length === 0) return '';
  return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins === 0 ? `${hrs}h` : `${hrs}h ${remMins}m`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

/**
 * US-market LMN template (matches the layout US payers expect for AAC SGD
 * approvals). Header → patient → diagnosis → metrics → severity → rule-out →
 * rationale → goals → attestation → signature.
 */
export function renderUsLmnHtml(
  lmn: LetterOfMedicalNecessity,
  sections: LmnSections,
  institute: InstituteInfo | null,
): string {
  const m = sections.metrics;
  const windowDays = Math.round(
    (new Date(m.windowEnd).getTime() - new Date(m.windowStart).getTime()) / (24 * 3600 * 1000),
  );

  const logoHtml = institute?.logoUrl
    ? `<img src="${escapeHtml(institute.logoUrl)}" alt="${escapeHtml(institute.name)}" class="logo" />`
    : '';
  const instituteNameHtml = institute?.name
    ? `<span class="institute-name">${escapeHtml(institute.name)}</span>`
    : '';

  const diagnosisLine =
    sections.diagnosis.primary || sections.diagnosis.primaryCode
      ? `${escapeHtml(sections.diagnosis.primary ?? '')}${
          sections.diagnosis.primaryCode
            ? ` <span class="code">(${escapeHtml(sections.diagnosis.primaryCode)})</span>`
            : ''
        }`
      : '<em>(none recorded)</em>';

  const finalizedBlock =
    lmn.status === 'finalized' && lmn.finalizedAt
      ? `<div class="status-stamp">FINALIZED ${formatDate(lmn.finalizedAt as unknown as string)}</div>`
      : `<div class="status-stamp draft">DRAFT — not for submission</div>`;

  const signatureBlock =
    lmn.status === 'finalized'
      ? `
        <div class="signature">
          <div class="sig-line"></div>
          <div class="sig-info">
            <div><strong>${escapeHtml(lmn.signatureName ?? '')}</strong>${
              lmn.signatureCredentials ? `, ${escapeHtml(lmn.signatureCredentials)}` : ''
            }</div>
            ${lmn.signatureLicense ? `<div>License #: ${escapeHtml(lmn.signatureLicense)}</div>` : ''}
            <div>Date: ${formatDate(lmn.signedAt as unknown as string)}</div>
          </div>
        </div>`
      : `
        <div class="signature draft">
          <div class="sig-line"></div>
          <div class="sig-info"><em>Signature placeholder — finalize the LMN to stamp.</em></div>
        </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Letter of Medical Necessity — ${escapeHtml(sections.patientId.name ?? '')}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Times New Roman', Georgia, serif; padding: 40px; color: #1a1a1a; max-width: 800px; margin: 0 auto; line-height: 1.5; }
    .header { display: flex; align-items: center; gap: 16px; padding-bottom: 16px; border-bottom: 2px solid #333; margin-bottom: 16px; }
    .logo { width: 64px; height: 64px; object-fit: contain; }
    .institute-name { font-size: 20px; font-weight: 600; }
    .doc-title { font-size: 22px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .status-stamp { display: inline-block; padding: 4px 10px; border: 1.5px solid #1a8a3a; color: #1a8a3a; font-size: 12px; font-weight: 700; letter-spacing: 1px; margin-bottom: 16px; }
    .status-stamp.draft { border-color: #c08000; color: #c08000; }
    .meta-grid { display: grid; grid-template-columns: 160px 1fr; gap: 4px 12px; font-size: 13px; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px dashed #aaa; }
    .meta-grid dt { font-weight: 600; }
    .section { margin-bottom: 18px; }
    .section h3 { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #333; border-bottom: 1px solid #ccc; padding-bottom: 3px; margin-bottom: 8px; }
    .section p { font-size: 14px; margin-bottom: 8px; }
    .section ul { list-style: disc; padding-inline-start: 22px; font-size: 14px; }
    .section li { margin-bottom: 3px; }
    .metrics-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .metrics-table th, .metrics-table td { border: 1px solid #ccc; padding: 5px 8px; text-align: start; }
    .metrics-table th { background: #f4f4f4; font-weight: 600; }
    .code { font-family: 'Courier New', monospace; font-size: 13px; color: #555; }
    .signature { margin-top: 40px; }
    .sig-line { border-top: 1px solid #333; margin-bottom: 6px; height: 1px; max-width: 320px; }
    .sig-info { font-size: 13px; }
    .signature.draft .sig-info { color: #888; }
    .no-print { margin-top: 32px; text-align: center; }
    @media print {
      body { padding: 20px; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="header">
    ${logoHtml}
    <div class="header-text">
      ${instituteNameHtml}
    </div>
  </div>
  <div class="doc-title">Letter of Medical Necessity</div>
  ${finalizedBlock}

  <dl class="meta-grid">
    <dt>Patient name:</dt><dd>${escapeHtml(sections.patientId.name ?? '—')}</dd>
    <dt>Date of birth:</dt><dd>${formatDate(sections.patientId.birthDate)}</dd>
    ${sections.patientId.idNumber ? `<dt>Patient ID:</dt><dd>${escapeHtml(sections.patientId.idNumber)}</dd>` : ''}
    <dt>Date generated:</dt><dd>${formatDate(lmn.createdAt as unknown as string)}</dd>
  </dl>

  <div class="section">
    <h3>Primary Diagnosis</h3>
    <p>${diagnosisLine}</p>
    ${
      sections.diagnosis.coMorbidities.length > 0
        ? `<p><strong>Co-morbidities:</strong></p>${bulletList(sections.diagnosis.coMorbidities)}`
        : ''
    }
    ${
      sections.diagnosis.secondary.length > 0
        ? `<p><strong>Secondary diagnoses:</strong></p>${bulletList(sections.diagnosis.secondary)}`
        : ''
    }
  </div>

  <div class="section">
    <h3>Communication Profile (trailing ${windowDays} days)</h3>
    <table class="metrics-table">
      <tr><th>Utterances recorded</th><td>${m.utteranceCount}</td></tr>
      <tr><th>Total words</th><td>${m.totalWords}</td></tr>
      <tr><th>Mean length of utterance (MLU)</th><td>${m.mlu}</td></tr>
      <tr><th>Number of different words (NDW)</th><td>${m.ndw}</td></tr>
      <tr><th>Active service time</th><td>${formatSeconds(m.totalActiveSeconds)}</td></tr>
      <tr><th>Communication rate</th><td>${m.communicationRatePerMin} utterances / active minute</td></tr>
    </table>
  </div>

  <div class="section">
    <h3>Impairment Severity</h3>
    ${paragraphs(sections.severityNarrative)}
  </div>

  <div class="section">
    <h3>Rule-Out of Natural Communication Modes</h3>
    ${paragraphs(sections.ruleOutNarrative)}
  </div>

  <div class="section">
    <h3>Device Selection Rationale</h3>
    ${paragraphs(sections.rationaleNarrative)}
  </div>

  <div class="section">
    <h3>Goals & Expected Outcomes</h3>
    ${paragraphs(sections.goalsNarrative)}
  </div>

  <div class="section">
    <h3>Clinician Attestation</h3>
    ${paragraphs(sections.attestationNarrative)}
  </div>

  ${signatureBlock}

  <div class="no-print">
    <button onclick="window.print()" style="padding:10px 32px;font-size:16px;cursor:pointer;border:1px solid #333;border-radius:6px;background:#fff;">
      Print
    </button>
  </div>
</body>
</html>`;
}

const TEMPLATE_BY_REGIME: Partial<
  Record<BillingRegime, (lmn: LetterOfMedicalNecessity, sections: LmnSections, institute: InstituteInfo | null) => string>
> = {
  us_cpt: renderUsLmnHtml,
};

/**
 * Open a printable LMN in a new browser tab. Falls back to the US template
 * for any regime that hasn't been configured — better than rendering nothing.
 */
export function openPrintableLmn(
  lmn: LetterOfMedicalNecessity,
  regime: BillingRegime,
  institute: InstituteInfo | null,
): void {
  const sections = lmn.sections as unknown as LmnSections;
  const renderer = TEMPLATE_BY_REGIME[regime] ?? renderUsLmnHtml;
  const html = renderer(lmn, sections, institute);
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
  }
}
