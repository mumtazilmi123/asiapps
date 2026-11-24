/**
 * Pengelola Dataset WebGIS Persebaran Asap Karhutla Papua Selatan (2023 – 2026)
 *
 * Struktur ini disiapkan agar Anda dapat dengan mudah mengganti data sementara
 * dengan data final:
 *  - Hotspot VIIRS (2023, 2024, 2025, 2026) -> format GeoJSON Point
 *  - Hasil Pemodelan HYSPLIT (2023 – 2026)  -> format GeoJSON Polygon / MultiPolygon
 *  - Populasi Papua Selatan (WorldPop)      -> GeoJSON atau ImageOverlay (PNG dari GeoTIFF)
 *  - Batas Administrasi Papua Selatan       -> sudah menggunakan AOI_PapuaSelatan.shp asli
 */

window.WEBGIS_DATASETS = (function () {
  const YEARS = [2023, 2024, 2025, 2026];

  const YEAR_COLORS = {
    2023: "#2563eb", // Biru
    2024: "#16a34a", // Hijau
    2025: "#f59e0b", // Oranye
    2026: "#dc2626"  // Merah
  };

  // 1. Batas Administrasi Asli Papua Selatan (hasil Zonal Statistics Python -> GeoJSON)
  let adminGeoJSON = window.AOI_PAPUA_SELATAN_GEOJSON || {
    type: "FeatureCollection",
    features: []
  };

  // Data Populasi WorldPop 100m (2023–2026) hasil zonal statistics
  const wp = window.WORLDPOP_DATA || null;
  const populationByYear = (wp && wp.years) || {};

  function setAdminGeoJSON(fc) {
    if (fc && fc.type === "FeatureCollection" && Array.isArray(fc.features)) {
      adminGeoJSON = fc;
      // Sinkronkan populationByYear langsung dari atribut GeoJSON (tanpa angka fiktif)
      YEARS.forEach((yr) => {
        const key = `pop_${yr}`;
        const densKey = `kepadatan_${yr}`;
        const pxKey = `piksel_${yr}`;
        const kabObj = {};
        let total = 0;
        let hasAny = false;
        fc.features.forEach((f) => {
          const p = f.properties || {};
          const val = p[key];
          if (typeof val === "number" && Number.isFinite(val)) {
            hasAny = true;
            total += val;
            kabObj[p.id] = {
              populasi: val,
              kepadatan_jiwa_km2: typeof p[densKey] === "number" ? p[densKey] : null,
              piksel_berpenghuni: typeof p[pxKey] === "number" ? p[pxKey] : null
            };
          }
        });
        if (hasAny) {
          populationByYear[yr] = {
            ...(populationByYear[yr] || {}),
            total_populasi: total,
            kabupaten: {
              ...((populationByYear[yr] && populationByYear[yr].kabupaten) || {}),
              ...kabObj
            }
          };
        }
      });
    }
  }

  // Jalankan sinkronisasi awal bila fallback JS sudah tersedia
  setAdminGeoJSON(adminGeoJSON);

  // 2. Data Hotspot VIIRS Asli per Tahun (disaring sesuai tanggal pemodelan HYSPLIT & AOI Papua Selatan)
  const hotspotsByYear = {
    2023: { type: "FeatureCollection", features: [] },
    2024: { type: "FeatureCollection", features: [] },
    2025: { type: "FeatureCollection", features: [] },
    2026: { type: "FeatureCollection", features: [] }
  };

  function setViirsHotspotsData(payload) {
    if (!payload || !payload.years) return;
    YEARS.forEach((yr) => {
      const fc = payload.years[yr] || payload.years[String(yr)];
      if (fc && Array.isArray(fc.features)) {
        hotspotsByYear[yr] = fc;
      }
    });
  }

  if (window.VIIRS_HOTSPOTS_2023_2026) {
    setViirsHotspotsData(window.VIIRS_HOTSPOTS_2023_2026);
  }

  // 3. Layer Hasil Pemodelan HYSPLIT per Tahun (Placeholder GeoJSON — siap diganti output HYSPLIT asli)
  function createPlumePolygon(originLon, originLat, lengthDeg, widthDeg, bearingDeg, seed) {
    const rad = (bearingDeg * Math.PI) / 180;
    const pts = [];
    const steps = 22;
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const along = (Math.cos(t) + 0.72) * (lengthDeg * 0.56);
      const taper = 0.52 + 0.48 * ((Math.cos(t) + 1) / 2);
      const across = Math.sin(t) * widthDeg * taper;
      const noise = 1 + 0.06 * Math.sin(t * 3 + seed) + 0.04 * Math.cos(t * 5 - seed);
      const dx = (along * Math.sin(rad) + across * Math.cos(rad)) * noise;
      const dy = (along * Math.cos(rad) - across * Math.sin(rad)) * noise;
      pts.push([+(originLon + dx).toFixed(4), +(originLat + dy).toFixed(4)]);
    }
    pts.push(pts[0]);
    return [pts];
  }

  function makeHysplitYear(year, scale, bearingDeg, areaTotalKm2) {
    return {
      type: "FeatureCollection",
      meta: { tahun: year, luas_km2: areaTotalKm2 },
      features: [
        {
          type: "Feature",
          properties: {
            tahun: year,
            kelas: "rendah",
            label: "Konsentrasi Rendah",
            rentang: "10 – 50 µg/m³",
            luas_km2: Math.round(areaTotalKm2 * 0.58),
            sumber: `Hasil Pemodelan HYSPLIT ${year} (Placeholder)`
          },
          geometry: {
            type: "Polygon",
            coordinates: createPlumePolygon(140.48, -8.15, 2.55 * scale, 0.85 * scale, bearingDeg, year * 0.1)
          }
        },
        {
          type: "Feature",
          properties: {
            tahun: year,
            kelas: "sedang",
            label: "Konsentrasi Sedang",
            rentang: "50 – 150 µg/m³",
            luas_km2: Math.round(areaTotalKm2 * 0.29),
            sumber: `Hasil Pemodelan HYSPLIT ${year} (Placeholder)`
          },
          geometry: {
            type: "Polygon",
            coordinates: createPlumePolygon(140.52, -8.12, 1.55 * scale, 0.48 * scale, bearingDeg, year * 0.2)
          }
        },
        {
          type: "Feature",
          properties: {
            tahun: year,
            kelas: "tinggi",
            label: "Konsentrasi Tinggi",
            rentang: "> 150 µg/m³",
            luas_km2: Math.round(areaTotalKm2 * 0.13),
            sumber: `Hasil Pemodelan HYSPLIT ${year} (Placeholder)`
          },
          geometry: {
            type: "Polygon",
            coordinates: createPlumePolygon(140.56, -8.10, 0.82 * scale, 0.24 * scale, bearingDeg, year * 0.3)
          }
        },
        // Plume sekunder Boven Digoel -> Mappi
        {
          type: "Feature",
          properties: {
            tahun: year,
            kelas: "rendah",
            label: "Konsentrasi Rendah",
            rentang: "10 – 50 µg/m³",
            luas_km2: Math.round(areaTotalKm2 * 0.22),
            sumber: `Hasil Pemodelan HYSPLIT ${year} (Placeholder)`
          },
          geometry: {
            type: "Polygon",
            coordinates: createPlumePolygon(140.28, -6.72, 1.85 * scale, 0.55 * scale, bearingDeg - 6, year * 0.4)
          }
        },
        {
          type: "Feature",
          properties: {
            tahun: year,
            kelas: "sedang",
            label: "Konsentrasi Sedang",
            rentang: "50 – 150 µg/m³",
            luas_km2: Math.round(areaTotalKm2 * 0.11),
            sumber: `Hasil Pemodelan HYSPLIT ${year} (Placeholder)`
          },
          geometry: {
            type: "Polygon",
            coordinates: createPlumePolygon(140.32, -6.70, 1.05 * scale, 0.30 * scale, bearingDeg - 6, year * 0.5)
          }
        }
      ]
    };
  }

  // Data HYSPLIT 24 jam nyata untuk seluruh tahun 2023, 2024, 2025, dan 2026
  const hysplit24hByYear = {};
  const hysplit24hPaths = {
    2023: "data/hysplit_2023_24h.geojson",
    2024: "data/hysplit_2024_24h.geojson",
    2025: "data/hysplit_2025_24h.geojson",
    2026: "data/hysplit_2026_24h.geojson"
  };

  function setHysplit24hData(year, payload) {
    if (payload && Array.isArray(payload.frames) && payload.frames.length > 0) {
      hysplit24hByYear[year] = payload;
      const lastFrame = payload.frames[payload.frames.length - 1];
      hysplitByYear[year] = {
        type: "FeatureCollection",
        meta: {
          tahun: year,
          luas_km2: Math.round(payload.max_luas_km2 || lastFrame.luas_km2 || 0),
          is24h: true
        },
        features: lastFrame.geojson.features
      };
    }
  }

  function hasHysplit24h(year) {
    return Boolean(hysplit24hByYear[year] && Array.isArray(hysplit24hByYear[year].frames) && hysplit24hByYear[year].frames.length > 0);
  }

  function getHysplit24hFrame(year, hour1to24) {
    if (!hasHysplit24h(year)) return null;
    const frames = hysplit24hByYear[year].frames;
    const idx = Math.max(0, Math.min(frames.length - 1, hour1to24 - 1));
    return frames[idx];
  }

  function getHysplit24hMeta(year) {
    return hysplit24hByYear[year] || null;
  }

  const hysplitByYear = {
    2023: makeHysplitYear(2023, 1.18, 314, 18450),
    2024: makeHysplitYear(2024, 0.78, 306, 9620),
    2025: makeHysplitYear(2025, 0.94, 318, 12840),
    2026: makeHysplitYear(2026, 1.02, 312, 14320)
  };

  if (window.HYSPLIT_2023_24H) setHysplit24hData(2023, window.HYSPLIT_2023_24H);
  if (window.HYSPLIT_2024_24H) setHysplit24hData(2024, window.HYSPLIT_2024_24H);
  if (window.HYSPLIT_2025_24H) setHysplit24hData(2025, window.HYSPLIT_2025_24H);
  if (window.HYSPLIT_2026_24H) setHysplit24hData(2026, window.HYSPLIT_2026_24H);

  // 4. Konfigurasi Layer Populasi Papua Selatan (WorldPop)
  const worldPopConfig = {
    imagesByYear: (wp && wp.imagesByYear) || {},
    bounds: (wp && wp.bounds) || [[-9.1275, 137.494165], [-4.540833, 141.020832]],
    sumber: (wp && wp.source) || "WorldPop Constrained 100m (R2025A v1)"
  };

  // 5. Data Estimasi Dampak Penduduk Terpapar Asap HYSPLIT per Tahun (WorldPop 2023–2026)
  const dampakAsapByYear = {};
  const dampakAsapPaths = {
    2023: "data/dampak_asap_hysplit_2023.json",
    2024: "data/dampak_asap_hysplit_2024.json",
    2025: "data/dampak_asap_hysplit_2025.json",
    2026: "data/dampak_asap_hysplit_2026.json"
  };

  function setDampakAsapData(year, payload) {
    if (payload && payload.provinsi && Array.isArray(payload.per_jam)) {
      dampakAsapByYear[year] = payload;
    }
  }

  function getDampakAsap(year) {
    return dampakAsapByYear[year] || null;
  }

  if (window.DAMPAK_ASAP_2023) setDampakAsapData(2023, window.DAMPAK_ASAP_2023);
  if (window.DAMPAK_ASAP_2024) setDampakAsapData(2024, window.DAMPAK_ASAP_2024);
  if (window.DAMPAK_ASAP_2025) setDampakAsapData(2025, window.DAMPAK_ASAP_2025);
  if (window.DAMPAK_ASAP_2026) setDampakAsapData(2026, window.DAMPAK_ASAP_2026);

  return {
    YEARS,
    YEAR_COLORS,
    get adminGeoJSON() {
      return adminGeoJSON;
    },
    setAdminGeoJSON,
    adminGeoJSONPath: "data/kabupaten_populasi_papua_selatan.geojson",
    viirsHotspotsPath: "data/viirs_hotspots_2023_2026.json",
    setViirsHotspotsData,
    hysplit24hPaths,
    dampakAsapPaths,
    setHysplit24hData,
    hasHysplit24h,
    getHysplit24hFrame,
    getHysplit24hMeta,
    setDampakAsapData,
    getDampakAsap,
    populationByYear,
    hotspotsByYear,
    hysplitByYear,
    worldPopConfig
  };
})();
