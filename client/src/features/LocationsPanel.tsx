// src/features/LocationsPanel.tsx
// Locations feature panel: register & edit institute GPS locations, with a
// Leaflet map picker and optional address → coordinate geocoding.

import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

import { apiRequest } from '@/lib/queryClient';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/hooks/useAuth';
import { useInstitute } from '@/hooks/useInstitute';
import { useToast } from '@/hooks/use-toast';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MapPin, Plus, Trash2, Edit2, Search, Loader2 } from 'lucide-react';

import type { Location } from '@shared/schema';

// Leaflet's default marker icon URLs break under bundlers; wire the imported
// assets back in once at module load.
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

interface LocationsPanelProps {
  isOpen?: boolean;
}

// Fallback map center when there's nothing else to anchor on.
const DEFAULT_CENTER: [number, number] = [32.0853, 34.7818];

interface LocationFormData {
  title: string;
  address: string;
  latitude: string;
  longitude: string;
}

const emptyForm: LocationFormData = { title: '', address: '', latitude: '', longitude: '' };

/** Recenters the map imperatively when the coords change (e.g. after geocoding). */
function Recenter({ lat, lng }: { lat: number | null; lng: number | null }) {
  const map = useMap();
  useEffect(() => {
    if (lat != null && lng != null) map.setView([lat, lng], Math.max(map.getZoom(), 15));
  }, [lat, lng, map]);
  return null;
}

/** Captures map clicks and reports the picked point. */
function ClickCapture({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export function LocationsPanel({ isOpen }: LocationsPanelProps) {
  const { t, isRTL } = useLanguage();
  const { user } = useAuth();
  const { currentInstitute } = useInstitute();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<Location | null>(null);
  const [form, setForm] = useState<LocationFormData>(emptyForm);
  const [geocoding, setGeocoding] = useState(false);

  const instituteId = currentInstitute?.id;

  const { data: locationsData, isLoading } = useQuery({
    queryKey: ['/api/locations', instituteId],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/locations?instituteId=${encodeURIComponent(instituteId!)}`);
      const json = await res.json();
      return json.locations as Location[];
    },
    enabled: !!user && !!instituteId,
  });

  const locations = locationsData || [];

  const lat = form.latitude.trim() === '' ? null : Number(form.latitude);
  const lng = form.longitude.trim() === '' ? null : Number(form.longitude);
  const hasValidPoint = lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng);

  const mapCenter = useMemo<[number, number]>(() => {
    if (hasValidPoint) return [lat!, lng!];
    if (locations.length > 0) return [locations[0].latitude, locations[0].longitude];
    return DEFAULT_CENTER;
  }, [hasValidPoint, lat, lng, locations]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['/api/locations', instituteId] });

  const createMutation = useMutation({
    mutationFn: async (body: any) => (await apiRequest('POST', '/api/locations', body)).json(),
    onSuccess: () => { invalidate(); closeDialog(); },
    onError: () => toast({ title: t('locations.saveFailed'), variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: any }) =>
      (await apiRequest('PATCH', `/api/locations/${id}`, body)).json(),
    onSuccess: () => { invalidate(); closeDialog(); },
    onError: () => toast({ title: t('locations.saveFailed'), variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => (await apiRequest('DELETE', `/api/locations/${id}`)).json(),
    onSuccess: invalidate,
    onError: () => toast({ title: t('locations.deleteFailed'), variant: 'destructive' }),
  });

  function openNew() {
    setEditing(null);
    setForm(emptyForm);
    setShowDialog(true);
  }

  function openEdit(loc: Location) {
    setEditing(loc);
    setForm({
      title: loc.title,
      address: loc.address ?? '',
      latitude: String(loc.latitude),
      longitude: String(loc.longitude),
    });
    setShowDialog(true);
  }

  function closeDialog() {
    setShowDialog(false);
    setEditing(null);
    setForm(emptyForm);
  }

  async function handleGeocode() {
    if (!form.address.trim()) return;
    setGeocoding(true);
    try {
      const res = await apiRequest('POST', '/api/locations/geocode', { address: form.address });
      const json = await res.json();
      if (json.success && typeof json.lat === 'number' && typeof json.lng === 'number') {
        setForm((f) => ({ ...f, latitude: String(json.lat), longitude: String(json.lng) }));
      } else {
        toast({ title: t('locations.geocodeFailed'), variant: 'destructive' });
      }
    } catch {
      toast({ title: t('locations.geocodeFailed'), variant: 'destructive' });
    } finally {
      setGeocoding(false);
    }
  }

  function handleSubmit() {
    if (!form.title.trim() || !hasValidPoint || !instituteId) return;
    const body = {
      title: form.title.trim(),
      address: form.address.trim() || null,
      latitude: lat,
      longitude: lng,
    };
    if (editing) updateMutation.mutate({ id: editing.id, body });
    else createMutation.mutate({ ...body, instituteId });
  }

  if (!isOpen) return null;

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="h-full flex flex-col p-4 gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <MapPin className="w-5 h-5" /> {t('locations.title')}
        </h2>
        <Button onClick={openNew} disabled={!instituteId} data-testid="button-new-location">
          <Plus className="w-4 h-4 me-1" /> {t('locations.new')}
        </Button>
      </div>

      {!instituteId ? (
        <p className="text-muted-foreground">{t('locations.selectInstitute')}</p>
      ) : isLoading ? (
        <p className="text-muted-foreground">{t('common.loading')}</p>
      ) : locations.length === 0 ? (
        <p className="text-muted-foreground">{t('locations.empty')}</p>
      ) : (
        <ScrollArea className="flex-1">
          <div className="grid gap-2">
            {locations.map((loc) => (
              <Card key={loc.id} data-testid={`location-card-${loc.id}`}>
                <CardContent className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{loc.title}</div>
                    {loc.address && <div className="text-sm text-muted-foreground truncate">{loc.address}</div>}
                    <div className="text-xs text-muted-foreground">
                      {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(loc)} aria-label={t('common.edit')}>
                      <Edit2 className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteMutation.mutate(loc.id)}
                      aria-label={t('common.delete')}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </ScrollArea>
      )}

      <Dialog open={showDialog} onOpenChange={(o) => (o ? setShowDialog(true) : closeDialog())}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{editing ? t('locations.edit') : t('locations.new')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="loc-title">{t('locations.titleField')}</Label>
              <Input
                id="loc-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                data-testid="input-location-title"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="loc-address">{t('locations.address')}</Label>
              <div className="flex gap-2">
                <Input
                  id="loc-address"
                  value={form.address}
                  onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                  data-testid="input-location-address"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleGeocode}
                  disabled={geocoding || !form.address.trim()}
                  data-testid="button-geocode"
                >
                  {geocoding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  <span className="ms-1">{t('locations.findFromAddress')}</span>
                </Button>
              </div>
            </div>

            <div className="space-y-1">
              <Label>{t('locations.pickOnMap')}</Label>
              <div className="h-64 rounded-md overflow-hidden border">
                <MapContainer center={mapCenter} zoom={hasValidPoint ? 15 : 5} style={{ height: '100%', width: '100%' }}>
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <ClickCapture
                    onPick={(la, lo) => setForm((f) => ({ ...f, latitude: String(la), longitude: String(lo) }))}
                  />
                  <Recenter lat={hasValidPoint ? lat : null} lng={hasValidPoint ? lng : null} />
                  {hasValidPoint && <Marker position={[lat!, lng!]} />}
                </MapContainer>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="loc-lat">{t('locations.latitude')}</Label>
                <Input
                  id="loc-lat"
                  inputMode="decimal"
                  value={form.latitude}
                  onChange={(e) => setForm((f) => ({ ...f, latitude: e.target.value }))}
                  data-testid="input-location-lat"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="loc-lng">{t('locations.longitude')}</Label>
                <Input
                  id="loc-lng"
                  inputMode="decimal"
                  value={form.longitude}
                  onChange={(e) => setForm((f) => ({ ...f, longitude: e.target.value }))}
                  data-testid="input-location-lng"
                />
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>{t('common.cancel')}</Button>
            <Button onClick={handleSubmit} disabled={!form.title.trim() || !hasValidPoint || saving} data-testid="button-save-location">
              {saving ? <Loader2 className="w-4 h-4 animate-spin me-1" /> : null}
              {editing ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
