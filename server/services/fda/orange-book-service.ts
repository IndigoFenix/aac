// server/services/fda/orange-book-service.ts
// Wraps the openFDA Drugs@FDA API for Orange Book drug lookups.
// Docs: https://open.fda.gov/apis/drug/drugsfda/

import fetch from "node-fetch";

const BASE_URL = "https://api.fda.gov/drug/drugsfda.json";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ActiveIngredient {
  name: string;
  strength: string;
}

export interface DrugProduct {
  brandName: string;
  activeIngredients: ActiveIngredient[];
  dosageForm: string;
  route: string;
  marketingStatus: string;
  teCode: string | null;
  referenceDrug: boolean;
}

export interface DrugSubmission {
  type: string;
  number: string;
  status: string;
  statusDate: string | null;
  reviewPriority: string | null;
}

export interface DrugApplication {
  applicationNumber: string;
  sponsorName: string;
  products: DrugProduct[];
  submissions: DrugSubmission[];
}

export interface OrangeBookResult {
  total: number;
  drugs: DrugApplication[];
}

export interface OrangeBookQuery {
  brandName?: string;
  genericName?: string;
  applicationNumber?: string;
  sponsorName?: string;
  activeIngredient?: string;
  exactMatch?: boolean;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSearchClause(field: string, value: string, exact: boolean): string {
  const escaped = value.replace(/"/g, "");
  if (exact) {
    return `${field}:"${escaped}"`;
  }
  // Unquoted: tokenized search, matches any record containing the words
  return `${field}:${encodeURIComponent(escaped)}`;
}

function formatDate(raw: string | undefined | null): string | null {
  if (!raw || raw.length !== 8) return raw ?? null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function parseProduct(p: any): DrugProduct {
  return {
    brandName: p.brand_name ?? "",
    activeIngredients: (p.active_ingredients ?? []).map((ai: any) => ({
      name: ai.name ?? "",
      strength: ai.strength ?? "",
    })),
    dosageForm: p.dosage_form ?? "",
    route: p.route ?? "",
    marketingStatus: p.marketing_status ?? "",
    teCode: p.te_code ?? null,
    referenceDrug: p.reference_drug === "Yes",
  };
}

function parseSubmission(s: any): DrugSubmission {
  return {
    type: s.submission_type ?? "",
    number: s.submission_number ?? "",
    status: s.submission_status ?? "",
    statusDate: formatDate(s.submission_status_date),
    reviewPriority: s.review_priority ?? null,
  };
}

function parseApplication(r: any): DrugApplication {
  return {
    applicationNumber: r.application_number ?? "",
    sponsorName: r.sponsor_name ?? "",
    products: (r.products ?? []).map(parseProduct),
    submissions: (r.submissions ?? [])
      .filter((s: any) => s.submission_type === "ORIG" || s.submission_status === "AP")
      .slice(0, 5)
      .map(parseSubmission),
  };
}

// ---------------------------------------------------------------------------
// Main lookup function
// ---------------------------------------------------------------------------

export async function lookupOrangeBook(
  query: OrangeBookQuery
): Promise<OrangeBookResult> {
  const exact = query.exactMatch !== false; // default true
  const clauses: string[] = [];

  if (query.brandName) {
    clauses.push(buildSearchClause("openfda.brand_name", query.brandName, exact));
  }
  if (query.genericName) {
    clauses.push(buildSearchClause("openfda.generic_name", query.genericName, exact));
  }
  if (query.applicationNumber) {
    clauses.push(
      buildSearchClause("application_number", query.applicationNumber, exact)
    );
  }
  if (query.sponsorName) {
    clauses.push(buildSearchClause("sponsor_name", query.sponsorName, exact));
  }
  if (query.activeIngredient) {
    clauses.push(
      buildSearchClause(
        "products.active_ingredients.name",
        query.activeIngredient,
        exact
      )
    );
  }

  if (clauses.length === 0) {
    return { total: 0, drugs: [] };
  }

  const search = clauses.join("+AND+");
  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const apiKey = process.env.FDA_API_KEY;
  const keyParam = apiKey ? `api_key=${apiKey}&` : "";
  const url = `${BASE_URL}?${keyParam}search=${search}&limit=${limit}`;

  const response = await fetch(url);

  if (!response.ok) {
    // openFDA returns 404 when there are zero results
    if (response.status === 404) {
      return { total: 0, drugs: [] };
    }
    const body = await response.text();
    throw new Error(`openFDA API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as any;
  const total: number = data.meta?.results?.total ?? 0;
  const drugs: DrugApplication[] = (data.results ?? []).map(parseApplication);

  return { total, drugs };
}
