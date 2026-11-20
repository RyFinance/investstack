// map.js — one small wrapper around MapLibre GL (vendored in web/vendor) with OpenFreeMap tiles (no key).
// If the library or WebGL is unavailable the container shows a note and the page keeps working with its table.
//
//   const m = await mapView(el, { points, onClick, onHover, legend })
//   points: [{ id, lat, lon, v (0–100 or null → colour), label ("$240K"), html (popup markup), kind: "subject" | "comp" | undefined }]
//   m.setPoints(points, { fit: true })   m.select(id)   m.flyTo(lat, lon, zoom)   m.set3d(true)   m.destroy()
// Every map has a 3D button (tilt + extruded buildings); pass { tilt3d: true } to start in 3D.
// The map follows the app theme. Colours: v 0 → red, 50 → amber, 100 → green; null → blue; "subject" → gold and larger.
import { on, isDark } from "./core.js";

let lib = null;
export function loadLib() {
  if (lib) return lib;
  lib = new Promise((resolve, reject) => {
    if (window.maplibregl) return resolve(window.maplibregl);
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "vendor/maplibre-gl.css";
    document.head.append(css);
    const s = document.createElement("script");
    s.src = "vendor/maplibre-gl.js";
    s.onload = () => (window.maplibregl ? resolve(window.maplibregl) : reject(new Error("MapLibre did not load")));
    s.onerror = () => reject(new Error("MapLibre did not load"));
    document.head.append(s);
  });
  return lib;
}

export const STYLE = () => `https://tiles.openfreemap.org/styles/${isDark() ? "dark" : "positron"}`;

/** Repaint the basemap in the app's concrete greys (dark theme) so the map reads as part of the interface. */
export function concrete(map) {
  if (!isDark()) return;
  const set = (id, k, v) => { try { map.setPaintProperty(id, k, v); } catch (e) { /* layer has no such property */ } };
  for (const l of map.getStyle()?.layers || []) {
    const id = l.id.toLowerCase();
    if (["pts", "pts-l", "b3d"].includes(l.id) || id.startsWith("va-")) continue;
    if (l.type === "background") set(l.id, "background-color", "#232322");
    else if (l.type === "fill") set(l.id, "fill-color", /water|ocean|lake|river/.test(id) ? "#1a1a19" : /building/.test(id) ? "#34352f" : /park|wood|grass|green|landcover|landuse/.test(id) ? "#282927" : "#262624");
    else if (l.type === "line") set(l.id, "line-color", /water|river/.test(id) ? "#1a1a19" : /boundary|admin/.test(id) ? "#55564f" : /motorway|trunk|primary/.test(id) ? "#4d4e48" : /rail/.test(id) ? "#3d3e3a" : "#3a3b37");
    else if (l.type === "symbol") { set(l.id, "text-color", /place|city|town|country|state/.test(id) ? "#a8a9a1" : "#7d7e77"); set(l.id, "text-halo-color", "#232322"); set(l.id, "icon-opacity", 0.35); }
    else if (l.type === "fill-extrusion") set(l.id, "fill-extrusion-color", "#3d3e3a");
  }
}
const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
const RED = [201, 123, 108], AMB = [205, 176, 106], GRN = [157, 184, 154];
export function scoreColor(v) {
  if (v == null || !Number.isFinite(+v)) return "rgb(183,183,175)";
  const t = Math.max(0, Math.min(100, +v)) / 100;
  const c = t < 0.5 ? mix(RED, AMB, t * 2) : mix(AMB, GRN, (t - 0.5) * 2);
  return `rgb(${c.join(",")})`;
}

const geo = pts => ({
  type: "FeatureCollection",
  features: pts.filter(p => Number.isFinite(+p.lat) && Number.isFinite(+p.lon)).map(p => ({
    type: "Feature", id: +p.id || undefined, geometry: { type: "Point", coordinates: [+p.lon, +p.lat] },
    properties: { pid: String(p.id), c: p.color || (p.kind === "subject" ? "rgb(240,240,236)" : scoreColor(p.v)), label: p.label || "", html: p.html || "", big: p.kind === "subject" ? 1 : 0 },
  })),
});

export async function mapView(el, o = {}) {
  el.classList.add("map");
  let gl;
  try { gl = await loadLib(); } catch (e) {
    el.innerHTML = `<div class="map-off">The map could not load. Everything else on this page still works.</div>`;
    return { setPoints() {}, select() {}, flyTo() {}, destroy() {}, off: true };
  }
  el.innerHTML = "";
  let pts = o.points || [], selected = o.selected ?? null, dead = false, ready = false, map;
  try {
    map = new gl.Map({ container: el, style: STYLE(), center: [-96, 38.5], zoom: 3.2, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false });
  } catch (e) {
    el.innerHTML = `<div class="map-off">The map needs WebGL, which is not available here.</div>`;
    return { setPoints() {}, select() {}, flyTo() {}, destroy() {}, off: true };
  }
  map.addControl(new gl.NavigationControl({ showCompass: false }), "top-right");
  // 3D: tilt the camera and extrude the building footprints (heights from OpenStreetMap via OpenFreeMap).
  let is3d = !!o.tilt3d;
  const b3 = document.createElement("button");
  b3.className = "map-3d"; b3.type = "button"; b3.textContent = "3D"; b3.title = "Tilt the map and show buildings in 3D";
  el.append(b3);
  const apply3d = () => {
    b3.classList.toggle("on", is3d);
    if (!map.getSource("openmaptiles")) return;
    if (is3d && !map.getLayer("b3d")) {
      map.addLayer({ id: "b3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 13,
        paint: { "fill-extrusion-color": isDark() ? "#4a4b46" : "#c9c9c2", "fill-extrusion-opacity": 0.85,
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6], "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0] } },
        map.getLayer("pts") ? "pts" : undefined);
    } else if (!is3d && map.getLayer("b3d")) map.removeLayer("b3d");
    map.easeTo({ pitch: is3d ? 58 : 0, bearing: is3d ? -18 : 0, zoom: is3d ? Math.max(map.getZoom(), 15.5) : map.getZoom(), duration: 500 });
    map.dragRotate[is3d ? "enable" : "disable"]();
  };
  b3.addEventListener("click", () => { is3d = !is3d; apply3d(); });
  const popup = new gl.Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: "260px" });
  if (o.legend) {
    const lg = document.createElement("div");
    lg.className = "map-legend";
    lg.innerHTML = `<span>${o.legend[0] || "low"}</span><i></i><span>${o.legend[1] || "high"}</span>`;
    el.append(lg);
  }

  const addLayers = () => {
    if (map.getSource("pts")) return;
    map.addSource("pts", { type: "geojson", data: geo(pts) });
    map.addLayer({ id: "pts", type: "circle", source: "pts", paint: {
      "circle-radius": ["case", ["==", ["get", "big"], 1], 9, ["==", ["get", "pid"], String(selected ?? "")], 8, 5.5],
      "circle-color": ["get", "c"], "circle-opacity": 0.9,
      "circle-stroke-width": ["case", ["==", ["get", "pid"], String(selected ?? "")], 2.5, 1],
      "circle-stroke-color": ["case", ["==", ["get", "pid"], String(selected ?? "")], "#ffffff", "rgba(20,20,19,.8)"] } });
    if (o.labels) map.addLayer({ id: "pts-l", type: "symbol", source: "pts", minzoom: 12.5, layout: { "text-field": ["get", "label"], "text-size": 10, "text-offset": [0, 1.2], "text-anchor": "top", "text-font": ["Noto Sans Regular"] },
      paint: { "text-color": isDark() ? "#F0F0EC" : "#262624", "text-halo-color": isDark() ? "#232322" : "#ffffff", "text-halo-width": 1.2 } });
  };
  const restyleSel = () => {
    if (!map.getLayer("pts")) return;
    const s = String(selected ?? "");
    map.setPaintProperty("pts", "circle-radius", ["case", ["==", ["get", "big"], 1], 9, ["==", ["get", "pid"], s], 8, 5.5]);
    map.setPaintProperty("pts", "circle-stroke-width", ["case", ["==", ["get", "pid"], s], 2.5, 1]);
    map.setPaintProperty("pts", "circle-stroke-color", ["case", ["==", ["get", "pid"], s], "#ffffff", "rgba(0,0,0,.55)"]);
  };
  const fit = () => {
    const ok = pts.filter(p => Number.isFinite(+p.lat) && Number.isFinite(+p.lon));
    if (!ok.length) return;
    if (ok.length === 1) { map.jumpTo({ center: [+ok[0].lon, +ok[0].lat], zoom: 14 }); return; }
    const b = new gl.LngLatBounds();
    ok.forEach(p => b.extend([+p.lon, +p.lat]));
    map.fitBounds(b, { padding: 36, maxZoom: 15, duration: 0 });
  };
  map.on("load", () => { ready = true; concrete(map); addLayers(); fit(); if (is3d) apply3d(); });
  map.on("styledata", () => { if (ready && !map.getSource("pts")) { try { concrete(map); addLayers(); if (is3d) apply3d(); } catch (e) { /* style still loading */ } } });
  map.on("click", "pts", e => { const p = e.features?.[0]?.properties; if (p && o.onClick) o.onClick(p.pid); });
  map.on("mousemove", "pts", e => {
    const ft = e.features?.[0];
    if (!ft) return;
    map.getCanvas().style.cursor = "pointer";
    if (ft.properties.html) popup.setLngLat(ft.geometry.coordinates).setHTML(ft.properties.html).addTo(map);
    o.onHover?.(ft.properties.pid);
  });
  map.on("mouseleave", "pts", () => { map.getCanvas().style.cursor = ""; popup.remove(); o.onHover?.(null); });
  map.on("error", () => { /* tiles offline: keep the points on a blank background */ });
  const ro = new ResizeObserver(() => { if (!dead) map.resize(); });
  ro.observe(el);
  const offTheme = on("theme", () => { if (!dead) map.setStyle(STYLE()); });

  return {
    setPoints(next, opt = {}) {
      pts = next || [];
      const s = map.getSource("pts");
      if (s) s.setData(geo(pts));
      if (opt.fit) (ready ? fit() : map.once("load", fit));
    },
    select(id) { selected = id; restyleSel(); },
    flyTo(lat, lon, zoom = 14) { if (Number.isFinite(+lat) && Number.isFinite(+lon)) map.easeTo({ center: [+lon, +lat], zoom, duration: 400 }); },
    set3d(v) { is3d = !!v; apply3d(); },
    destroy() { if (dead) return; dead = true; ro.disconnect(); offTheme(); popup.remove(); map.remove(); },
  };
}
