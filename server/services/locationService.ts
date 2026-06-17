// server/services/locationService.ts
// Business logic for registered GPS locations: institute-scoped CRUD plus
// opt-in address → coordinate geocoding (Nominatim, with a Google fallback).

import { locationRepository, instituteRepository } from "../repositories";
import type { Location, InsertLocation, UpdateLocation } from "@shared/schema";

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
  provider: "nominatim" | "google";
}

class LocationService {
  // ── Access scoping ──
  // A user may view/manage locations for institutes they belong to. Edits and
  // deletes additionally require the institute admin role OR being the creator
  // (mirrors the calendar event edit gate).

  private async isInstituteMember(userId: string, instituteId: string): Promise<boolean> {
    const link = await instituteRepository.getInstituteUserLink(instituteId, userId);
    return !!link;
  }

  private async canEdit(location: Location, userId: string): Promise<boolean> {
    if (location.createdByUserId === userId) return true;
    const link = await instituteRepository.getInstituteUserLink(location.instituteId, userId);
    return !!link?.isAdmin;
  }

  /** List active locations for an institute the user belongs to. */
  async listForInstitute(instituteId: string, userId: string): Promise<Location[] | null> {
    if (!(await this.isInstituteMember(userId, instituteId))) return null;
    return locationRepository.listByInstitute(instituteId);
  }

  async get(id: string, userId: string): Promise<Location | null> {
    const loc = await locationRepository.getById(id);
    if (!loc) return null;
    if (!(await this.isInstituteMember(userId, loc.instituteId))) return null;
    return loc;
  }

  async create(data: InsertLocation, userId: string): Promise<Location | null> {
    if (!(await this.isInstituteMember(userId, data.instituteId))) return null;
    return locationRepository.create(data, userId);
  }

  async update(id: string, updates: UpdateLocation, userId: string): Promise<Location | null> {
    const loc = await locationRepository.getById(id);
    if (!loc) return null;
    if (!(await this.canEdit(loc, userId))) return null;
    return (await locationRepository.update(id, updates)) ?? null;
  }

  async remove(id: string, userId: string): Promise<boolean> {
    const loc = await locationRepository.getById(id);
    if (!loc) return false;
    if (!(await this.canEdit(loc, userId))) return false;
    return locationRepository.deactivate(id);
  }

  // ── Geocoding ──
  // Explicit (button-triggered) only. Sends only the institute address (not
  // student PHI). Tries Nominatim first; on failure or no result, falls back to
  // the Google Geocoding API when GOOGLE_GEOCODING_API_KEY is configured.

  async geocodeAddress(address: string): Promise<GeocodeResult | null> {
    const trimmed = address.trim();
    if (!trimmed) return null;

    try {
      const viaNominatim = await this.geocodeNominatim(trimmed);
      if (viaNominatim) return viaNominatim;
    } catch (err) {
      console.warn("[locationService] Nominatim geocode failed, trying Google fallback:", err);
    }

    try {
      const viaGoogle = await this.geocodeGoogle(trimmed);
      if (viaGoogle) return viaGoogle;
    } catch (err) {
      console.warn("[locationService] Google geocode failed:", err);
    }

    return null;
  }

  private async geocodeNominatim(address: string): Promise<GeocodeResult | null> {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", address);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");

    const res = await fetch(url, {
      headers: {
        // OSM usage policy requires an identifying User-Agent.
        "User-Agent": "Aivota-CliniAACian/1.0 (location geocoding)",
        "Accept-Language": "en",
      },
    });
    if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);

    const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    if (!Array.isArray(data) || data.length === 0) return null;

    const hit = data[0];
    const lat = parseFloat(hit.lat);
    const lng = parseFloat(hit.lon);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

    return { lat, lng, displayName: hit.display_name ?? address, provider: "nominatim" };
  }

  private async geocodeGoogle(address: string): Promise<GeocodeResult | null> {
    const key = process.env.GOOGLE_GEOCODING_API_KEY;
    if (!key) return null; // gracefully skip the fallback when unconfigured

    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", key);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google geocode returned ${res.status}`);

    const data = (await res.json()) as {
      status: string;
      results?: Array<{ formatted_address: string; geometry: { location: { lat: number; lng: number } } }>;
    };
    if (data.status !== "OK" || !data.results?.length) return null;

    const hit = data.results[0];
    return {
      lat: hit.geometry.location.lat,
      lng: hit.geometry.location.lng,
      displayName: hit.formatted_address ?? address,
      provider: "google",
    };
  }
}

export const locationService = new LocationService();
