import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import type { LatLng } from '../types';

export interface MapMarker extends LatLng {
  id: string;
  kind: 'restaurant' | 'customer' | 'driver' | 'order';
  label?: string;
}

const GLYPH: Record<MapMarker['kind'], string> = { restaurant: '🍕', customer: '🏠', driver: '🛵', order: '📦' };

function icon(kind: MapMarker['kind']): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="pin pin-${kind}" aria-hidden="true">${GLYPH[kind]}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

interface Props {
  center: LatLng;
  markers: MapMarker[];
  /** Radius in kilometres around the centre (delivery area). */
  radiusKm?: number;
  onPick?: (p: LatLng) => void;
  /** Fit the view to the markers whenever the set of markers changes. */
  fit?: boolean;
  height?: number;
  label: string;
}

export function MapView({ center, markers, radiusKm, onPick, fit = true, height = 320, label }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const live = useRef(new Map<string, L.Marker>());
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { scrollWheelZoom: false }).setView([center.lat, center.lng], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on('click', (e) => pick.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    map.current = m;
    const markersNow = live.current;
    return () => {
      m.remove();
      map.current = null;
      markersNow.clear();
    };
    // The map is created once; centre changes are handled through the markers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || radiusKm === undefined) return;
    const circle = L.circle([center.lat, center.lng], {
      radius: radiusKm * 1000,
      color: '#b3261a',
      weight: 1,
      fillOpacity: 0.04,
      interactive: false,
    }).addTo(m);
    return () => {
      circle.remove();
    };
  }, [center.lat, center.lng, radiusKm]);

  const shape = markers.map((m) => `${m.id}:${m.kind}`).join('|');
  useEffect(() => {
    const m = map.current;
    const group = layer.current;
    if (!m || !group) return;
    const seen = new Set<string>();
    for (const mk of markers) {
      seen.add(mk.id);
      const existing = live.current.get(mk.id);
      if (existing) {
        existing.setLatLng([mk.lat, mk.lng]); // moving driver: move it, do not recreate
      } else {
        const created = L.marker([mk.lat, mk.lng], { icon: icon(mk.kind), title: mk.label, alt: mk.label ?? mk.kind });
        if (mk.label) created.bindTooltip(mk.label);
        created.addTo(group);
        live.current.set(mk.id, created);
      }
    }
    for (const [id, marker] of live.current) {
      if (!seen.has(id)) {
        marker.remove();
        live.current.delete(id);
      }
    }
  });

  useEffect(() => {
    const m = map.current;
    if (!m || !fit || markers.length === 0) return;
    if (markers.length === 1) m.setView([markers[0]!.lat, markers[0]!.lng], 14);
    else m.fitBounds(L.latLngBounds(markers.map((x) => [x.lat, x.lng] as [number, number])).pad(0.25));
    // Fit only when the set of markers changes, not on every location update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, fit]);

  return <div ref={el} className="map" style={{ height }} role="application" aria-label={label} />;
}
