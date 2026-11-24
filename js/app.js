/**
 * WebGIS Persebaran Asap Karhutla Papua Selatan (Sederhana & Terfokus)
 * Fitur:
 * 1. Kontrol 4 Layer bersamaan: Hotspot (VIIRS), Hasil HYSPLIT, Batas Administrasi Papua Selatan, Populasi (WorldPop)
 * 2. Filter Tahun (2023, 2024, 2025, 2026) + Tombol Reset Filter
 * 3. Popup Informasi (Koordinat Hotspot; Nama Kabupaten & info pendukung Administrasi)
 * 4. Basemap OpenStreetMap saja + Legenda Dinamis + Tombol Zoom Papua Selatan & Tampilan Awal
 * 5. Perbandingan Data Tahun 2023–2026 (Peta Berdampingan tersinkronisasi + Grafik & Tabel)
 */

(function () {
  const DS = window.WEBGIS_DATASETS;

  // Tampilan awal peta (Indonesia Timur / Papua) sebelum zoom ke Papua Selatan
  const INITIAL_VIEW = { center: [-5.5, 137.8], zoom: 6 };

  // State Aplikasi (default: tahun 2026 aktif; klik tahun lain untuk langsung berpindah)
  const state = {
    selectedYears: new Set([2026]),
    layers: {
      hotspot: true,
      hysplit: true,
      admin: true,
      pop: false
    },
    hysplitOpacity: 0.58,
    popOpacity: 0.45,
    // State Animasi 24 Jam HYSPLIT 2026 (21 Agustus 2026)
    hysplitHour: 1,
    hysplitPlaying: false,
    hysplitSpeedMs: 550,
    hysplitTimer: null
  };

  let map;
  let adminLayer, popLayer, hysplitLayer, hotspotLayer;
  let hotspotSvgRenderer = null;
  let papuaBounds = null;

  // State Panel Informasi Penduduk Kabupaten & Highlight Poligon
  let selectedKabId = null;
  let lastDeselectKabId = null;
  let lastDeselectTime = 0;
  let kabPopup = null;
  let kabPopChart = null;
  const adminFeatureLayers = new Map();

  // State Mode Perbandingan
  let mapLeft = null;
  let mapRight = null;
  let leftGroup = null;
  let rightGroup = null;
  let compareChart = null;
  let compareExposureChart = null;
  let syncingMaps = false;

  // Format angka Indonesia dengan pemisah ribuan berupa titik (tanpa membuat angka fiktif)
  function formatIndoInt(val) {
    if (typeof val !== "number" || !Number.isFinite(val)) return null;
    return Math.round(val).toLocaleString("id-ID");
  }

  function getKabPopValue(props, year) {
    if (!props) return null;
    const direct = props[`pop_${year}`];
    if (typeof direct === "number" && Number.isFinite(direct)) return direct;
    const fromStore = DS.populationByYear[year]?.kabupaten?.[props.id]?.populasi;
    return typeof fromStore === "number" && Number.isFinite(fromStore) ? fromStore : null;
  }

  function getKabDensityValue(props, year) {
    if (!props) return null;
    const direct = props[`kepadatan_${year}`];
    if (typeof direct === "number" && Number.isFinite(direct)) return direct;
    const fromStore = DS.populationByYear[year]?.kabupaten?.[props.id]?.kepadatan_jiwa_km2;
    return typeof fromStore === "number" && Number.isFinite(fromStore) ? fromStore : null;
  }

  // =========================================================================
  // 1. INISIALISASI PETA UTAMA (OPENSTREETMAP SAJA)
  // =========================================================================
  function initMainMap() {
    map = L.map("map", {
      center: INITIAL_VIEW.center,
      zoom: INITIAL_VIEW.zoom,
      minZoom: 4,
      maxZoom: 18
    });

    // Basemap tunggal: OpenStreetMap
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19
    }).addTo(map);

    // Urutan layer (pane): adminPane di atas hysplitPane agar klik kabupaten selalu menampilkan populasi & info terpapar, sementara titik hotspot tetap paling atas
    map.createPane("popPane").style.zIndex = 310;
    map.createPane("hysplitPane").style.zIndex = 330;
    map.createPane("adminPane").style.zIndex = 350;
    const hsPane = map.createPane("hotspotPane");
    hsPane.style.zIndex = 460;
    hsPane.style.pointerEvents = "none";

    // Gunakan SVG renderer khusus hotspotPane (bukan Canvas) agar ruang kosong antar titik hotspot meneruskan klik/hover ke poligon kabupaten di bawahnya
    hotspotSvgRenderer = L.svg({ pane: "hotspotPane", padding: 0.25 });

    popLayer = L.layerGroup();
    adminLayer = L.layerGroup().addTo(map);
    hysplitLayer = L.layerGroup().addTo(map);
    hotspotLayer = L.layerGroup().addTo(map);

    // Hitung bounds AOI Papua Selatan & zoom otomatis saat awal buka
    const tempAdmin = L.geoJSON(DS.adminGeoJSON);
    if (tempAdmin.getBounds().isValid()) {
      papuaBounds = tempAdmin.getBounds();
      map.fitBounds(papuaBounds, { padding: [24, 24] });
    }
  }

  // =========================================================================
  // 2. RENDER 4 LAYER UTAMA
  // =========================================================================
  function getFilteredHotspots() {
    const out = [];
    DS.YEARS.forEach((yr) => {
      if (!state.selectedYears.has(yr)) return;
      const fc = DS.hotspotsByYear[yr];
      if (fc && Array.isArray(fc.features)) {
        fc.features.forEach((f) => out.push(f));
      }
    });
    return out;
  }

  function getActivePopYear() {
    const active = DS.YEARS.filter((y) => state.selectedYears.has(y));
    return active.length ? active[active.length - 1] : 2026;
  }

  function getAdminFeatureStyle(kabId) {
    const isSelected = selectedKabId && kabId === selectedKabId;
    if (isSelected) {
      return {
        color: "#7c3aed",
        weight: 3.5,
        dashArray: null,
        fillColor: "#8b5cf6",
        fillOpacity: 0.22
      };
    }
    return {
      color: "#1e293b",
      weight: 2,
      dashArray: "5 3",
      fillColor: "#334155",
      fillOpacity: 0.04
    };
  }

  function buildKabTooltipAndPopup(p, popYear, isSingleYear, hsCount) {
    const kabNama = p.nama || "Wilayah Tanpa Nama";
    const popVal = getKabPopValue(p, popYear);
    const popText = popVal !== null ? `${formatIndoInt(popVal)} jiwa` : "Data tidak tersedia";
    const animYr = getActiveAnimYear();
    const damp = animYr ? DS.getDampakAsap(animYr) : null;
    const kabDamp = damp && damp.kabupaten && damp.kabupaten[p.id];
    const hrDamp = damp && damp.per_jam && damp.per_jam[state.hysplitHour - 1];
    const kabHr = hrDamp && hrDamp.kabupaten && hrDamp.kabupaten[p.id];
    const jamStr = String(state.hysplitHour).padStart(2, "0");

    const expTooltipRow = kabHr
      ? `<br/>Terpapar Jam ${jamStr}: <strong style="color:#c2410c;">${formatIndoInt(kabHr.terpapar)} jiwa (${kabHr.persen.toLocaleString("id-ID")}%)</strong>`
      : "";
    const expPopupRows = kabDamp
      ? `
        <tr><td>Terpapar Jam ${jamStr}/24</td><td style="color:#c2410c;">${kabHr ? `${formatIndoInt(kabHr.terpapar)} jiwa (${kabHr.persen.toLocaleString("id-ID")}%)` : "-"}</td></tr>
        <tr><td>Terpapar Unik 24 Jam</td><td style="color:#c2410c;">${formatIndoInt(kabDamp.unik_terpapar_24j)} jiwa (${kabDamp.persen_unik_24j.toLocaleString("id-ID")}%)</td></tr>
      `
      : "";

    const tooltipHtml = `<strong>${kabNama}</strong><br/>Penduduk ${popYear}: <strong>${popText}</strong>${expTooltipRow}`;
    const popupHtml = `
      <div class="popup-title">${kabNama}</div>
      <table class="popup-table">
        <tr><td>Provinsi</td><td>${p.provinsi || "Papua Selatan"}</td></tr>
        <tr><td>Ibu Kota</td><td>${p.ibukota || "Data tidak tersedia"}</td></tr>
        <tr><td>Luas Wilayah</td><td>${typeof p.luas_km2 === "number" ? Number(p.luas_km2).toLocaleString("id-ID") + " km²" : "Data tidak tersedia"}</td></tr>
        <tr><td>Penduduk (${popYear})</td><td style="color:#6d28d9;">${popText}</td></tr>
        ${expPopupRows}
        <tr><td>Hotspot (${isSingleYear ? popYear : "2023–2026"})</td><td>${hsCount.toLocaleString("id-ID")} titik</td></tr>
      </table>
      <div style="margin-top:6px;font-size:10.5px;color:#64748b;">Detail tampil di panel kanan · Klik lagi / klik 2× batas untuk deselect.</div>
    `;
    return { tooltipHtml, popupHtml };
  }

  function syncAdminExposureLabels() {
    const activeYears = DS.YEARS.filter((y) => state.selectedYears.has(y));
    const isSingleYear = activeYears.length === 1;
    const popYear = getActivePopYear();
    adminFeatureLayers.forEach((entry, id) => {
      const { layer, feature, hsCount } = entry;
      const { tooltipHtml, popupHtml } = buildKabTooltipAndPopup(feature.properties || {}, popYear, isSingleYear, hsCount || 0);
      entry.popupHtml = popupHtml;
      if (layer.getTooltip()) layer.setTooltipContent(tooltipHtml);
      if (selectedKabId === id && kabPopup && map.hasLayer(kabPopup)) {
        kabPopup.setContent(popupHtml);
      }
    });
  }

  function renderAdminLayer() {
    adminLayer.clearLayers();
    adminFeatureLayers.clear();
    const filteredHotspots = getFilteredHotspots();
    const activeYears = DS.YEARS.filter((y) => state.selectedYears.has(y));
    const isSingleYear = activeYears.length === 1;
    const popYear = getActivePopYear();

    L.geoJSON(DS.adminGeoJSON, {
      pane: "adminPane",
      style: (feature) => getAdminFeatureStyle(feature.properties.id),
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        const hsCount = filteredHotspots.filter((h) => h.properties.kabupatenId === p.id).length;
        const { tooltipHtml, popupHtml } = buildKabTooltipAndPopup(p, popYear, isSingleYear, hsCount);

        adminFeatureLayers.set(p.id, { layer, feature, hsCount, popupHtml });

        layer.bindTooltip(tooltipHtml, { sticky: true });

        layer.on("mouseover", () => {
          if (selectedKabId !== p.id) {
            layer.setStyle({ weight: 3, fillOpacity: 0.14 });
          }
        });
        layer.on("mouseout", () => {
          layer.setStyle(getAdminFeatureStyle(p.id));
        });
        layer.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          handleKabupatenClick(p.id, e.latlng);
        });
        layer.on("dblclick", (e) => {
          L.DomEvent.stopPropagation(e);
          L.DomEvent.preventDefault(e);
          handleKabupatenDblClick(p.id);
        });
      }
    }).addTo(adminLayer);

    // Jika ada kabupaten yang sedang terpilih, perbarui panel informasinya otomatis sesuai filter tahun
    if (selectedKabId && adminFeatureLayers.has(selectedKabId)) {
      renderKabupatenInfoPanel(selectedKabId);
    }
  }

  function handleKabupatenClick(kabId, latlng) {
    // Klik ke-2 (klik ulang) pada kabupaten yang sedang terpilih -> deselect
    if (selectedKabId === kabId) {
      lastDeselectKabId = kabId;
      lastDeselectTime = Date.now();
      closeKabupatenInfoPanel();
      return;
    }
    // Cegah klik ke-2 dari double-click cepat langsung memilih ulang setelah baru saja di-deselect
    if (lastDeselectKabId === kabId && Date.now() - lastDeselectTime < 450) {
      return;
    }
    lastDeselectKabId = null;
    selectKabupaten(kabId, latlng);
  }

  function handleKabupatenDblClick(kabId) {
    if (selectedKabId === kabId) {
      lastDeselectKabId = kabId;
      lastDeselectTime = Date.now();
      closeKabupatenInfoPanel();
    }
  }

  function selectKabupaten(kabId, latlng) {
    selectedKabId = kabId;
    adminFeatureLayers.forEach(({ layer }, id) => {
      layer.setStyle(getAdminFeatureStyle(id));
      if (id === kabId && layer.bringToFront) layer.bringToFront();
    });
    const entry = adminFeatureLayers.get(kabId);
    if (entry && entry.popupHtml) {
      const targetLatLng = latlng || (entry.layer.getBounds ? entry.layer.getBounds().getCenter() : null);
      if (targetLatLng) {
        kabPopup = L.popup().setLatLng(targetLatLng).setContent(entry.popupHtml).openOn(map);
      }
    }
    renderKabupatenInfoPanel(kabId);
  }

  function closeKabupatenInfoPanel() {
    selectedKabId = null;
    document.getElementById("kab-info-panel").classList.add("hidden");
    if (kabPopup && map && map.hasLayer(kabPopup)) {
      map.closePopup(kabPopup);
    }
    kabPopup = null;
    adminFeatureLayers.forEach(({ layer }, id) => {
      layer.setStyle(getAdminFeatureStyle(id));
    });
  }

  function renderKabupatenInfoPanel(kabId) {
    const entry = adminFeatureLayers.get(kabId);
    if (!entry) return;
    const p = entry.feature.properties || {};
    const panel = document.getElementById("kab-info-panel");
    panel.classList.remove("hidden");

    const kabNama = p.nama || "Data nama kabupaten tidak tersedia";
    const activeYears = DS.YEARS.filter((y) => state.selectedYears.has(y));
    const isSingleYear = activeYears.length === 1;
    const focusYear = getActivePopYear();

    document.getElementById("kab-panel-title").textContent = kabNama;
    const metaParts = [
      p.provinsi || "Papua Selatan",
      p.kode_kab ? `Kode ${p.kode_kab}` : null,
      p.ibukota ? `Ibu Kota: ${p.ibukota}` : null,
      typeof p.luas_km2 === "number" ? `${p.luas_km2.toLocaleString("id-ID")} km²` : null
    ].filter(Boolean);
    document.getElementById("kab-panel-meta").textContent = metaParts.join(" · ");

    // Sorotan tahun aktif (terintegrasi dengan filter tahun)
    const focusVal = getKabPopValue(p, focusYear);
    const focusDens = getKabDensityValue(p, focusYear);
    document.getElementById("kab-active-year-label").textContent = isSingleYear
      ? `Estimasi Jumlah Penduduk Tahun ${focusYear} (Filter Aktif)`
      : `Estimasi Jumlah Penduduk Tahun ${focusYear} (Terbaru)`;
    document.getElementById("kab-active-year-value").textContent =
      focusVal !== null ? `${formatIndoInt(focusVal)} jiwa` : "Data tidak tersedia";
    document.getElementById("kab-active-year-sub").textContent =
      focusDens !== null
        ? `Kepadatan: ${focusDens.toLocaleString("id-ID")} jiwa/km²`
        : "Informasi kepadatan tidak tersedia";

    // Tabel Estimasi Jumlah Penduduk 2023–2026 (format titik ribuan Indonesia)
    const valuesByYear = DS.YEARS.map((yr) => ({ yr, val: getKabPopValue(p, yr) }));
    document.getElementById("kab-pop-table-body").innerHTML = valuesByYear
      .map(({ yr, val }) => {
        const isRowActive = isSingleYear && yr === focusYear;
        const formatted = val !== null ? `${formatIndoInt(val)} jiwa` : "Data tidak tersedia";
        return `
          <tr class="${isRowActive ? "row-active" : ""}">
            <td>${yr}${isRowActive ? " (Dipilih)" : ""}</td>
            <td>${formatted}</td>
          </tr>
        `;
      })
      .join("");

    // Perubahan jumlah penduduk 2023 hingga 2026 (langsung dari atribut GeoJSON / selisih data nyata)
    const pop2023 = getKabPopValue(p, 2023);
    const pop2026 = getKabPopValue(p, 2026);
    const changeEl = document.getElementById("kab-pop-change");

    let diff = typeof p.perubahan_2023_2026 === "number" ? p.perubahan_2023_2026 : null;
    if (diff === null && pop2023 !== null && pop2026 !== null) diff = pop2026 - pop2023;
    let pct = typeof p.persen_perubahan_2023_2026 === "number" ? p.persen_perubahan_2023_2026 : null;
    if (pct === null && diff !== null && pop2023 > 0) pct = +((diff / pop2023) * 100).toFixed(2);

    if (diff !== null) {
      const sign = diff >= 0 ? "+" : "-";
      const absStr = formatIndoInt(Math.abs(diff));
      const pctStr = pct !== null ? ` (${pct >= 0 ? "+" : ""}${pct.toLocaleString("id-ID")}%)` : "";
      changeEl.classList.remove("is-missing");
      changeEl.innerHTML = `
        <span>Perubahan 2023 → 2026</span>
        <strong>${sign}${absStr} jiwa${pctStr}</strong>
      `;
    } else {
      changeEl.classList.add("is-missing");
      changeEl.innerHTML = `<span>Perubahan 2023 → 2026</span><strong>Data tidak tersedia</strong>`;
    }

    document.getElementById("kab-panel-source").textContent =
      `Sumber: ${p.sumber_populasi || "WorldPop Population Count 100m (Zonal Statistics)"}`;

    // Estimasi Penduduk Terpapar Asap HYSPLIT (mengikuti tahun aktif bila memiliki data 24 jam, mis. 2025 / 2026)
    const expBox = document.getElementById("kab-exposure-box");
    const animYr = getActiveAnimYear();
    const damp = animYr ? DS.getDampakAsap(animYr) : null;
    const kabDamp = damp && damp.kabupaten && damp.kabupaten[p.id];
    const hrDamp = damp && damp.per_jam && damp.per_jam[state.hysplitHour - 1];
    const kabHr = hrDamp && hrDamp.kabupaten && hrDamp.kabupaten[p.id];
    if (kabDamp) {
      const jamStr = String(state.hysplitHour).padStart(2, "0");
      const hrText = kabHr
        ? `${formatIndoInt(kabHr.terpapar)} jiwa (${kabHr.persen.toLocaleString("id-ID")}%)`
        : "Data tidak tersedia";
      const uniqText = `${formatIndoInt(kabDamp.unik_terpapar_24j)} jiwa (${kabDamp.persen_unik_24j.toLocaleString("id-ID")}%)`;
      const l4Val = kabDamp.level_tertinggi_24j ? kabDamp.level_tertinggi_24j.level_4_tinggi : null;
      expBox.classList.remove("hidden");
      expBox.innerHTML = `
        <div class="kab-exposure-title">Estimasi Terpapar Asap HYSPLIT (${damp.tanggal || animYr})</div>
        <div class="kab-exposure-row">
          <span>Jam ke-${jamStr}/24</span>
          <strong>${hrText}</strong>
        </div>
        <div class="kab-exposure-row">
          <span>Unik 24 Jam (Kumulatif)</span>
          <strong>${uniqText}</strong>
        </div>
        ${l4Val !== null ? `<div class="kab-exposure-row"><span>Paparan Asap Pekat (Tertinggi)</span><strong>${formatIndoInt(l4Val)} jiwa</strong></div>` : ""}
      `;
    } else {
      expBox.classList.add("hidden");
    }

    // Grafik Perubahan Jumlah Penduduk 2023–2026 menggunakan Chart.js
    const ctx = document.getElementById("chart-kab-pop").getContext("2d");
    if (kabPopChart) kabPopChart.destroy();

    const pointRadii = valuesByYear.map(({ yr }) => (isSingleYear && yr === focusYear ? 7 : 4.5));
    const pointColors = valuesByYear.map(({ yr }) => (isSingleYear && yr === focusYear ? "#ea580c" : "#7c3aed"));

    kabPopChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: DS.YEARS.map(String),
        datasets: [
          {
            label: "Estimasi Penduduk (jiwa)",
            data: valuesByYear.map((d) => d.val),
            borderColor: "#7c3aed",
            backgroundColor: "rgba(124, 58, 237, 0.14)",
            borderWidth: 2.5,
            fill: true,
            tension: 0.25,
            pointRadius: pointRadii,
            pointHoverRadius: 7,
            pointBackgroundColor: pointColors,
            pointBorderColor: "#ffffff",
            pointBorderWidth: 1.8
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) =>
                item.raw !== null && item.raw !== undefined
                  ? ` ${Number(item.raw).toLocaleString("id-ID")} jiwa`
                  : " Data tidak tersedia"
            }
          }
        },
        scales: {
          x: {
            grid: { display: false }
          },
          y: {
            grid: { color: "rgba(148, 163, 184, 0.2)" },
            ticks: {
              font: { size: 10 },
              callback: (v) => Number(v).toLocaleString("id-ID")
            }
          }
        }
      }
    });
  }

  function renderPopulationLayer() {
    popLayer.clearLayers();
    const cfg = DS.worldPopConfig;
    const popYear = getActivePopYear();
    const imgUrl = cfg.imagesByYear && cfg.imagesByYear[popYear];
    const totalProv = DS.populationByYear[popYear]?.total_populasi;

    const subEl = document.getElementById("pop-layer-subtitle");
    if (subEl) {
      subEl.textContent = totalProv
        ? `Tahun ${popYear}: ${totalProv.toLocaleString("id-ID")} jiwa (WorldPop 100m)`
        : "Raster WorldPop 100m";
    }

    if (imgUrl) {
      L.imageOverlay(imgUrl, cfg.bounds, {
        pane: "popPane",
        opacity: state.popOpacity
      }).addTo(popLayer);
    }

    // Batas tipis interaktif agar tiap kabupaten tetap bisa diklik saat layer Populasi aktif (meski Batas Admin dimatikan)
    L.geoJSON(DS.adminGeoJSON, {
      pane: "popPane",
      style: {
        color: "#6d28d9",
        weight: 1,
        fillColor: "#7c3aed",
        fillOpacity: imgUrl ? 0.01 : state.popOpacity * 0.4
      },
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        const popVal = getKabPopValue(p, popYear);
        const popText = popVal !== null ? `${formatIndoInt(popVal)} jiwa` : "Data tidak tersedia";
        layer.bindTooltip(`<strong>${p.nama || "Kabupaten"}</strong><br/>Penduduk ${popYear}: <strong>${popText}</strong>`, { sticky: true });
        layer.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          handleKabupatenClick(p.id, e.latlng);
        });
        layer.on("dblclick", (e) => {
          L.DomEvent.stopPropagation(e);
          L.DomEvent.preventDefault(e);
          handleKabupatenDblClick(p.id);
        });
      }
    }).addTo(popLayer);
  }

  function getHysplitStyle(kelas, opacity) {
    if (kelas === "tinggi") {
      return { color: "#b91c1c", weight: 1.3, fillColor: "#dc2626", fillOpacity: Math.min(0.92, opacity * 1.05) };
    }
    if (kelas === "sedang") {
      return { color: "#ea580c", weight: 1.1, fillColor: "#f97316", fillOpacity: opacity * 0.82 };
    }
    if (kelas === "rendah") {
      return { color: "#ca8a04", weight: 0.9, fillColor: "#fde047", fillOpacity: opacity * 0.65 };
    }
    // sangat_rendah (kontur terluar khas HYSPLIT concplot)
    return { color: "#0284c7", weight: 0.8, fillColor: "#38bdf8", fillOpacity: opacity * 0.44 };
  }

  // Tentukan tahun animasi 24 jam yang sedang aktif (tahun terbaru yang dipilih & punya data 24 jam, mis. 2025 atau 2026)
  function getActiveAnimYear() {
    const active = DS.YEARS.filter((y) => state.selectedYears.has(y) && DS.hasHysplit24h(y));
    return active.length ? active[active.length - 1] : null;
  }

  function updateHysplitPlayerVisibility() {
    const playerEl = document.getElementById("hysplit-player");
    const animYr = getActiveAnimYear();
    const show = state.layers.hysplit && animYr !== null;
    playerEl.classList.toggle("hidden", !show);
    if (!show && state.hysplitPlaying) {
      stopHysplitAnimation();
    }
  }

  function updateHysplitPlayerUI(animYr, frame) {
    const timeEl = document.getElementById("hysplit-time-label");
    const areaEl = document.getElementById("hysplit-area-label");
    const expEl = document.getElementById("hysplit-exposure-label");
    const slider = document.getElementById("hysplit-hour-slider");
    const subEl = document.getElementById("hysplit-layer-subtitle");

    if (slider) slider.value = state.hysplitHour;
    if (animYr && frame) {
      const jamStr = String(frame.jam_ke).padStart(2, "0");
      const meta = DS.getHysplit24hMeta(animYr);
      timeEl.textContent = `Jam ${jamStr}/24 · ${frame.waktu_wit}`;
      areaEl.textContent = `Luas: ${Number(frame.luas_km2).toLocaleString("id-ID")} km²`;
      const damp = DS.getDampakAsap(animYr);
      const hrDamp = damp && damp.per_jam && damp.per_jam[frame.jam_ke - 1];
      if (expEl) {
        if (hrDamp && damp.provinsi) {
          expEl.classList.remove("hidden");
          expEl.textContent = `Terpapar Jam ${jamStr}: ${formatIndoInt(hrDamp.total_terpapar)} jiwa (${hrDamp.persen_provinsi.toLocaleString("id-ID")}%) · Unik 24j: ${formatIndoInt(damp.provinsi.unik_terpapar_24j)} jiwa (${damp.provinsi.persen_unik_24j.toLocaleString("id-ID")}%)`;
        } else {
          expEl.classList.add("hidden");
        }
      }
      if (subEl) subEl.textContent = `${meta ? meta.tanggal : animYr} · Jam ${jamStr}/24`;
    } else {
      if (expEl) expEl.classList.add("hidden");
      if (subEl) subEl.textContent = "Sebaran asap hasil pemodelan";
    }
    updateExposureSummary();
    syncAdminExposureLabels();
    if (selectedKabId && adminFeatureLayers.has(selectedKabId)) {
      renderKabupatenInfoPanel(selectedKabId);
    }
  }

  function updateExposureSummary() {
    const box = document.getElementById("stat-exposure-box");
    const animYr = getActiveAnimYear();
    const damp = animYr ? DS.getDampakAsap(animYr) : null;
    const show = Boolean(damp && damp.provinsi);
    box.classList.toggle("hidden", !show);
    if (!show) return;

    const hrDamp = damp.per_jam && damp.per_jam[state.hysplitHour - 1];
    const jamStr = String(state.hysplitHour).padStart(2, "0");
    document.getElementById("stat-exposure-label").textContent = `Terpapar Asap ${animYr} (Jam ${jamStr}/24)`;
    document.getElementById("stat-exposure").textContent = hrDamp
      ? `${formatIndoInt(hrDamp.total_terpapar)} jiwa (${hrDamp.persen_provinsi.toLocaleString("id-ID")}%)`
      : "Data tidak tersedia";
    document.getElementById("stat-exposure-sub").textContent =
      `Unik 24 Jam: ${formatIndoInt(damp.provinsi.unik_terpapar_24j)} jiwa (${damp.provinsi.persen_unik_24j.toLocaleString("id-ID")}%) · Asap Pekat: ${formatIndoInt(damp.provinsi.level_tertinggi_24j.level_4_tinggi)} jiwa`;
  }

  function startHysplitAnimation() {
    if (state.hysplitPlaying) return;
    state.hysplitPlaying = true;
    document.getElementById("icon-hysplit-play").classList.add("hidden");
    document.getElementById("icon-hysplit-pause").classList.remove("hidden");
    state.hysplitTimer = setInterval(() => {
      state.hysplitHour = state.hysplitHour >= 24 ? 1 : state.hysplitHour + 1;
      renderHysplitLayer();
      updateDynamicLegend();
    }, state.hysplitSpeedMs);
  }

  function stopHysplitAnimation() {
    state.hysplitPlaying = false;
    if (state.hysplitTimer) {
      clearInterval(state.hysplitTimer);
      state.hysplitTimer = null;
    }
    document.getElementById("icon-hysplit-play").classList.remove("hidden");
    document.getElementById("icon-hysplit-pause").classList.add("hidden");
  }

  function renderHysplitLayer() {
    hysplitLayer.clearLayers();
    const animYr = getActiveAnimYear();
    let activeFrame = null;

    DS.YEARS.forEach((yr) => {
      if (!state.selectedYears.has(yr)) return;

      let fc = null;
      if (DS.hasHysplit24h(yr)) {
        const fr = DS.getHysplit24hFrame(yr, state.hysplitHour);
        if (yr === animYr) activeFrame = fr;
        fc = fr ? fr.geojson : DS.hysplitByYear[yr];
      } else {
        fc = DS.hysplitByYear[yr];
      }
      if (!fc) return;

      L.geoJSON(fc, {
        pane: "hysplitPane",
        style: (feature) => getHysplitStyle(feature.properties.kelas, state.hysplitOpacity),
        onEachFeature: (feature, layer) => {
          const p = feature.properties;
          const waktuRow = p.waktu_wit
            ? `<tr><td>Waktu</td><td>${p.waktu_wit} (Jam ${p.jam_ke}/24)</td></tr>`
            : "";
          const concRow = p.conc_label
            ? `<tr><td>Konsentrasi (PM2.5)</td><td>${p.conc_label}</td></tr>`
            : `<tr><td>Rentang Konsentrasi</td><td>${p.rentang || "-"}</td></tr>`;
          const lapisRow = p.lapisan
            ? `<tr><td>Lapisan Ketinggian</td><td>${p.lapisan}</td></tr>`
            : "";
          const luasVal = p.luas_jam_km2 ?? p.luas_km2 ?? 0;

          layer.bindPopup(`
            <div class="popup-title">Hasil Pemodelan HYSPLIT (${p.tahun})</div>
            <table class="popup-table">
              ${waktuRow}
              <tr><td>Kategori</td><td>${p.label}</td></tr>
              ${concRow}
              ${lapisRow}
              <tr><td>Luas Sebaran</td><td>${Number(luasVal).toLocaleString("id-ID")} km²</td></tr>
              <tr><td>Sumber</td><td>${p.sumber}</td></tr>
            </table>
          `);
        }
      }).addTo(hysplitLayer);
    });

    updateHysplitPlayerVisibility();
    updateHysplitPlayerUI(animYr, activeFrame);
  }

  function renderHotspotLayer() {
    hotspotLayer.clearLayers();
    const hotspots = getFilteredHotspots();
    const isDense = hotspots.length > 400;

    hotspots.forEach((feat) => {
      const p = feat.properties;
      const [lon, lat] = feat.geometry.coordinates;
      const color = DS.YEAR_COLORS[p.tahun] || "#dc2626";

      L.circleMarker([lat, lon], {
        renderer: hotspotSvgRenderer,
        pane: "hotspotPane",
        radius: isDense ? 3.8 : 5.2,
        fillColor: color,
        color: "#ffffff",
        weight: isDense ? 0.7 : 1.2,
        fillOpacity: 0.9
      })
        .bindPopup(() => `
          <div class="popup-title">Hotspot VIIRS ${p.tahun} (${p.id})</div>
          <table class="popup-table">
            <tr><td>Koordinat (Lat, Lon)</td><td>${lat.toFixed(5)}, ${lon.toFixed(5)}</td></tr>
            <tr><td>Kabupaten</td><td>${p.kab_kota || "-"}</td></tr>
            <tr><td>Tanggal</td><td>${p.tanggal_label || p.tanggal || p.tahun}</td></tr>
            <tr><td>Waktu Akuisisi</td><td>${p.waktu || "-"} (${p.daynight || "-"})</td></tr>
            <tr><td>Satelit / Confidence</td><td>${p.satelit || "VIIRS"} (${p.confidence || "-"})</td></tr>
            ${p.frp !== null && p.frp !== undefined ? `<tr><td>FRP (Daya Radiasi)</td><td>${p.frp} MW</td></tr>` : ""}
            ${p.brightness !== null && p.brightness !== undefined ? `<tr><td>Brightness Temp.</td><td>${p.brightness} K</td></tr>` : ""}
          </table>
        `)
        .addTo(hotspotLayer);
    });

    // Update ringkasan angka
    const activeYears = DS.YEARS.filter((y) => state.selectedYears.has(y));
    const singleMeta = activeYears.length === 1 ? DS.hotspotsByYear[activeYears[0]]?.meta : null;
    document.getElementById("count-hotspot-label").textContent = singleMeta
      ? `${hotspots.length.toLocaleString("id-ID")} titik (${singleMeta.tanggal_label})`
      : `${hotspots.length.toLocaleString("id-ID")} titik aktif pada filter`;
    document.getElementById("stat-hotspots").textContent = hotspots.length.toLocaleString("id-ID");
  }

  // =========================================================================
  // 3. LEGENDA PETA DINAMIS (HANYA MENAMPILKAN LAYER YANG AKTIF)
  // =========================================================================
  function updateDynamicLegend() {
    const el = document.getElementById("legend-content");
    const blocks = [];

    if (state.layers.hotspot) {
      const activeYears = DS.YEARS.filter((y) => state.selectedYears.has(y));
      const rows = activeYears.length
        ? activeYears
            .map(
              (y) =>
                `<div class="legend-item"><span class="lg-dot" style="background:${DS.YEAR_COLORS[y]};"></span> Hotspot Tahun ${y}</div>`
            )
            .join("")
        : `<div class="lg-empty">Tidak ada tahun dipilih</div>`;
      blocks.push(`<div><div class="legend-section-title">Hotspot (VIIRS)</div>${rows}</div>`);
    }

    if (state.layers.hysplit) {
      const animYr = getActiveAnimYear();
      const fr = animYr ? DS.getHysplit24hFrame(animYr, state.hysplitHour) : null;
      const titleSuffix = fr ? ` ${animYr} (Jam ${String(fr.jam_ke).padStart(2, "0")}/24)` : "";
      blocks.push(`
        <div>
          <div class="legend-section-title">Sebaran Asap HYSPLIT${titleSuffix}</div>
          ${animYr ? '<div class="legend-item"><span class="lg-box" style="background:rgba(56,189,248,0.55);border:1px solid #0284c7;"></span> Level 1 — Terluar (Tipis)</div>' : ""}
          <div class="legend-item"><span class="lg-box" style="background:rgba(253,224,71,0.7);border:1px solid #ca8a04;"></span> ${animYr ? "Level 2 — Rendah" : "Konsentrasi Rendah"}</div>
          <div class="legend-item"><span class="lg-box" style="background:rgba(249,115,22,0.78);border:1px solid #ea580c;"></span> ${animYr ? "Level 3 — Sedang" : "Konsentrasi Sedang"}</div>
          <div class="legend-item"><span class="lg-box" style="background:rgba(220,38,38,0.88);border:1px solid #b91c1c;"></span> ${animYr ? "Level 4 — Asap Pekat (Tertinggi)" : "Konsentrasi Tinggi"}</div>
        </div>
      `);
    }

    if (state.layers.admin) {
      blocks.push(`
        <div>
          <div class="legend-section-title">Wilayah Administrasi</div>
          <div class="legend-item"><span class="lg-box" style="background:rgba(51,65,85,0.08);border:2px dashed #1e293b;"></span> Batas Kabupaten Papua Selatan</div>
        </div>
      `);
    }

    if (state.layers.pop) {
      const popYear = getActivePopYear();
      blocks.push(`
        <div>
          <div class="legend-section-title">Populasi WorldPop (${popYear})</div>
          <div class="legend-item"><span class="lg-box" style="background:#fde68a;border:1px solid #d97706;"></span> Permukiman Kecil</div>
          <div class="legend-item"><span class="lg-box" style="background:#f59e0b;border:1px solid #b45309;"></span> Kepadatan Menengah</div>
          <div class="legend-item"><span class="lg-box" style="background:#c026d3;border:1px solid #86198f;"></span> Pusat Permukiman</div>
          <div class="legend-item"><span class="lg-box" style="background:#581c87;border:1px solid #3b0764;"></span> Kepadatan Tinggi (Kota)</div>
        </div>
      `);
    }

    el.innerHTML = blocks.length
      ? blocks.join("")
      : `<div class="lg-empty">Aktifkan minimal satu layer untuk menampilkan legenda.</div>`;
  }

  function renderProvincialYearlyExposure() {
    const container = document.getElementById("prov-exposure-yearly");
    if (!container) return;

    const isAll = state.selectedYears.size === DS.YEARS.length;
    container.innerHTML = DS.YEARS.map((yr) => {
      const damp = DS.getDampakAsap(yr);
      const prov = damp && damp.provinsi;
      const totalPop = DS.populationByYear[yr]?.total_populasi || (prov && (prov.populasi || prov.populasi_2026)) || null;
      const uniq = prov ? prov.unik_terpapar_24j : null;
      const pct = prov ? prov.persen_unik_24j : null;
      const l4 = prov && prov.level_tertinggi_24j ? prov.level_tertinggi_24j.level_4_tinggi : null;
      const isActive = !isAll && state.selectedYears.has(yr);
      const color = DS.YEAR_COLORS[yr] || "#ea580c";
      const barPct = pct !== null ? Math.max(1.5, Math.min(100, pct)) : 0;

      return `
        <button type="button" class="prov-yr-row${isActive ? " active" : ""}" data-prov-year="${yr}" title="Klik untuk menampilkan tahun ${yr}">
          <div class="prov-yr-top">
            <span class="prov-yr-badge"><i style="background:${color};"></i>${yr}</span>
            <span class="prov-yr-val">${uniq !== null ? `${formatIndoInt(uniq)} jiwa (${pct.toLocaleString("id-ID")}%)` : "Data tidak tersedia"}</span>
          </div>
          <div class="prov-yr-bar-bg">
            <div class="prov-yr-bar-fill" style="width:${barPct}%;background:${color};"></div>
          </div>
          <div class="prov-yr-sub">
            <span>Pop: ${totalPop ? formatIndoInt(totalPop) : "-"}</span>
            <span>Asap Pekat: ${l4 !== null ? formatIndoInt(l4) + " jiwa" : "-"}</span>
          </div>
        </button>
      `;
    }).join("");

    container.querySelectorAll(".prov-yr-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        const yr = Number(btn.dataset.provYear);
        state.selectedYears = new Set([yr]);
        document.querySelectorAll(".year-btn").forEach((yb) => {
          yb.classList.toggle("active", Number(yb.dataset.year) === yr);
        });
        document.getElementById("btn-select-all-years").classList.remove("active");
        refreshAll();
      });
    });
  }

  function updateSummaryText() {
    const yrs = DS.YEARS.filter((y) => state.selectedYears.has(y));
    const popYear = getActivePopYear();
    const totalPop = DS.populationByYear[popYear]?.total_populasi;
    document.getElementById("stat-years").textContent =
      yrs.length === 4 ? "2023–2026" : yrs.length === 0 ? "Tidak ada" : yrs.join(", ");
    document.getElementById("stat-pop-label").textContent =
      yrs.length === 1 ? `Populasi Papua Selatan (${popYear})` : `Populasi Papua Selatan (${popYear})`;
    document.getElementById("stat-pop").textContent =
      totalPop ? `${totalPop.toLocaleString("id-ID")} jiwa` : "-";
    renderProvincialYearlyExposure();
  }

  function refreshAll() {
    renderAdminLayer();
    renderPopulationLayer();
    renderHysplitLayer();
    renderHotspotLayer();
    updateSummaryText();
    updateDynamicLegend();
  }

  // =========================================================================
  // 4. FITUR PERBANDINGAN DATA TAHUN 2023, 2024, 2025, DAN 2026
  // =========================================================================
  function initCompareView() {
    if (!mapLeft) {
      mapLeft = L.map("map-compare-left", { center: [-6.95, 139.55], zoom: 7, preferCanvas: true });
      mapRight = L.map("map-compare-right", { center: [-6.95, 139.55], zoom: 7, preferCanvas: true });

      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap",
        maxZoom: 19
      }).addTo(mapLeft);

      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap",
        maxZoom: 19
      }).addTo(mapRight);

      leftGroup = L.layerGroup().addTo(mapLeft);
      rightGroup = L.layerGroup().addTo(mapRight);

      // Sinkronisasi gerak & zoom antara Peta Kiri dan Peta Kanan
      const sync = (src, dst) => {
        if (syncingMaps) return;
        syncingMaps = true;
        dst.setView(src.getCenter(), src.getZoom(), { animate: false });
        syncingMaps = false;
      };
      mapLeft.on("move", () => sync(mapLeft, mapRight));
      mapRight.on("move", () => sync(mapRight, mapLeft));
    }

    setTimeout(() => {
      mapLeft.invalidateSize();
      mapRight.invalidateSize();
      if (papuaBounds) {
        mapLeft.fitBounds(papuaBounds, { padding: [18, 18] });
        mapRight.fitBounds(papuaBounds, { padding: [18, 18] });
      }
      renderCompareMap(leftGroup, Number(document.getElementById("compare-year-left").value), "split-stat-left");
      renderCompareMap(rightGroup, Number(document.getElementById("compare-year-right").value), "split-stat-right");
      renderCompareStats();
    }, 80);
  }

  function renderCompareMap(group, year, statElId) {
    group.clearLayers();

    // Batas AOI Papua Selatan
    L.geoJSON(DS.adminGeoJSON, {
      style: { color: "#1e293b", weight: 1.6, dashArray: "4 3", fillOpacity: 0.04 }
    }).addTo(group);

    // HYSPLIT tahun terpilih
    const hy = DS.hysplitByYear[year];
    if (hy) {
      L.geoJSON(hy, {
        style: (f) => getHysplitStyle(f.properties.kelas, 0.58)
      }).addTo(group);
    }

    // Hotspot tahun terpilih
    const hs = DS.hotspotsByYear[year];
    const count = hs ? hs.features.length : 0;
    if (hs) {
      hs.features.forEach((f) => {
        const [lon, lat] = f.geometry.coordinates;
        L.circleMarker([lat, lon], {
          radius: 4.5,
          fillColor: DS.YEAR_COLORS[year],
          color: "#fff",
          weight: 1,
          fillOpacity: 0.9
        })
          .bindPopup(`<strong>Hotspot ${year}</strong><br/>Koordinat: ${lat.toFixed(5)}, ${lon.toFixed(5)}<br/>Kabupaten: ${f.properties.kab_kota || "-"}`)
          .addTo(group);
      });
    }

    const areaKm2 = hy && hy.meta ? hy.meta.luas_km2 : 0;
    const damp = DS.getDampakAsap(year);
    const expStr = damp && damp.provinsi
      ? ` · Terpapar 24j: ${formatIndoInt(damp.provinsi.unik_terpapar_24j)} jiwa (${damp.provinsi.persen_unik_24j.toLocaleString("id-ID")}%)`
      : "";
    document.getElementById(statElId).textContent = `${count} hotspot · HYSPLIT ±${areaKm2.toLocaleString("id-ID")} km²${expStr}`;
  }

  function renderCompareStats() {
    const rows = DS.YEARS.map((yr) => {
      const feats = (DS.hotspotsByYear[yr] && DS.hotspotsByYear[yr].features) || [];
      const byKab = { merauke: 0, boven_digoel: 0, mappi: 0, asmat: 0 };
      feats.forEach((f) => {
        const k = f.properties.kabupatenId;
        if (byKab[k] !== undefined) byKab[k]++;
      });
      const hyArea = (DS.hysplitByYear[yr] && DS.hysplitByYear[yr].meta && DS.hysplitByYear[yr].meta.luas_km2) || 0;
      const wpTotal = DS.populationByYear[yr]?.total_populasi || 0;
      const damp = DS.getDampakAsap(yr);
      const expUniq = damp && damp.provinsi ? damp.provinsi.unik_terpapar_24j : null;
      const expPct = damp && damp.provinsi ? damp.provinsi.persen_unik_24j : null;
      const expL4 = damp && damp.provinsi && damp.provinsi.level_tertinggi_24j
        ? damp.provinsi.level_tertinggi_24j.level_4_tinggi
        : null;
      return { year: yr, total: feats.length, ...byKab, hyArea, wpTotal, expUniq, expPct, expL4 };
    });

    // Isi Tabel
    document.getElementById("compare-table-body").innerHTML = rows
      .map(
        (r) => `
      <tr>
        <td><strong style="color:${DS.YEAR_COLORS[r.year]};">${r.year}</strong></td>
        <td><strong>${r.total.toLocaleString("id-ID")}</strong></td>
        <td>${r.merauke.toLocaleString("id-ID")}</td>
        <td>${r.boven_digoel.toLocaleString("id-ID")}</td>
        <td>${r.mappi.toLocaleString("id-ID")}</td>
        <td>${r.asmat.toLocaleString("id-ID")}</td>
        <td>${r.hyArea.toLocaleString("id-ID")}</td>
        <td>${r.wpTotal ? r.wpTotal.toLocaleString("id-ID") : "-"}</td>
        <td><strong>${r.expUniq !== null ? formatIndoInt(r.expUniq) + " jiwa (" + r.expPct.toLocaleString("id-ID") + "%)" : "-"}</strong></td>
        <td>${r.expL4 !== null ? formatIndoInt(r.expL4) + " jiwa" : "-"}</td>
      </tr>
    `
      )
      .join("");

    // Render / Update Grafik Perbandingan 2023–2026
    // Catatan Chart.js: nilai order lebih kecil digambar di ATAS, sehingga garis HYSPLIT (order: 1) selalu tampil di depan batang Hotspot (order: 2)
    const barFillColors = {
      2023: "rgba(37, 99, 235, 0.78)",
      2024: "rgba(22, 163, 74, 0.78)",
      2025: "rgba(245, 158, 11, 0.82)",
      2026: "rgba(220, 38, 38, 0.78)"
    };
    const ctx = document.getElementById("chart-compare-years").getContext("2d");
    if (compareChart) compareChart.destroy();
    compareChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: rows.map((r) => String(r.year)),
        datasets: [
          {
            label: "Luas Sebaran HYSPLIT (km²)",
            data: rows.map((r) => r.hyArea),
            type: "line",
            order: 1,
            borderColor: "#0f172a",
            backgroundColor: "rgba(15, 23, 42, 0.08)",
            borderWidth: 3,
            tension: 0.25,
            pointRadius: 6,
            pointHoverRadius: 8,
            pointBackgroundColor: "#ffffff",
            pointBorderColor: "#0f172a",
            pointBorderWidth: 2.5,
            yAxisID: "y1"
          },
          {
            label: "Jumlah Hotspot (titik)",
            data: rows.map((r) => r.total),
            type: "bar",
            order: 2,
            backgroundColor: rows.map((r) => barFillColors[r.year] || DS.YEAR_COLORS[r.year]),
            borderColor: rows.map((r) => DS.YEAR_COLORS[r.year]),
            borderWidth: 1.5,
            borderRadius: 6,
            barPercentage: 0.56,
            categoryPercentage: 0.72,
            yAxisID: "y"
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => {
                const val = Number(item.raw || 0).toLocaleString("id-ID");
                return item.dataset.yAxisID === "y1"
                  ? ` Luas HYSPLIT: ${val} km²`
                  : ` Jumlah Hotspot: ${val} titik`;
              }
            }
          }
        },
        scales: {
          y: {
            position: "left",
            beginAtZero: true,
            title: { display: true, text: "Jumlah Hotspot (titik)" },
            ticks: { callback: (v) => Number(v).toLocaleString("id-ID") }
          },
          y1: {
            position: "right",
            beginAtZero: true,
            suggestedMax: 320000,
            grid: { drawOnChartArea: false },
            title: { display: true, text: "Luas Sebaran HYSPLIT (km²)" },
            ticks: { callback: (v) => Number(v).toLocaleString("id-ID") }
          }
        }
      }
    });

    // Render / Update Grafik Populasi Terdampak Asap 1 Provinsi per Tahun (2023–2026)
    const expCanvas = document.getElementById("chart-compare-exposure");
    if (expCanvas) {
      const expCtx = expCanvas.getContext("2d");
      if (compareExposureChart) compareExposureChart.destroy();
      compareExposureChart = new Chart(expCtx, {
        type: "bar",
        data: {
          labels: rows.map((r) => String(r.year)),
          datasets: [
            {
              label: "Total Populasi Provinsi",
              data: rows.map((r) => r.wpTotal || 0),
              backgroundColor: "rgba(148, 163, 184, 0.45)",
              borderColor: "#64748b",
              borderWidth: 1.2,
              borderRadius: 5
            },
            {
              label: "Terpapar Unik 24 Jam",
              data: rows.map((r) => r.expUniq || 0),
              backgroundColor: "rgba(234, 88, 12, 0.85)",
              borderColor: "#c2410c",
              borderWidth: 1.2,
              borderRadius: 5
            },
            {
              label: "Paparan Asap Pekat (Tertinggi)",
              data: rows.map((r) => r.expL4 || 0),
              backgroundColor: "rgba(185, 28, 28, 0.88)",
              borderColor: "#991b1b",
              borderWidth: 1.2,
              borderRadius: 5
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (item) => {
                  const row = rows[item.dataIndex];
                  const val = Number(item.raw || 0);
                  const pct = row && row.wpTotal > 0 ? ((val / row.wpTotal) * 100).toFixed(2).replace(".", ",") : null;
                  if (item.datasetIndex === 0) {
                    return ` Total Populasi Provinsi: ${val.toLocaleString("id-ID")} jiwa`;
                  }
                  return ` ${item.dataset.label}: ${val.toLocaleString("id-ID")} jiwa${pct ? ` (${pct}%)` : ""}`;
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              suggestedMax: 600000,
              title: { display: true, text: "Jumlah Penduduk (jiwa)" },
              ticks: { callback: (v) => Number(v).toLocaleString("id-ID") }
            }
          }
        }
      });
    }
  }

  // =========================================================================
  // 5. EVENT LISTENERS
  // =========================================================================
  function bindEvents() {
    // Toggle Sidebar
    document.getElementById("btn-toggle-sidebar").addEventListener("click", () => {
      document.getElementById("sidebar").classList.toggle("collapsed");
      setTimeout(() => map.invalidateSize(), 220);
    });

    // Toggle 4 Layer (dapat aktif bersamaan)
    const bindLayerToggle = (id, key, layer) => {
      document.getElementById(id).addEventListener("change", (e) => {
        state.layers[key] = e.target.checked;
        if (e.target.checked) {
          if (!map.hasLayer(layer)) layer.addTo(map);
        } else {
          if (map.hasLayer(layer)) map.removeLayer(layer);
        }
        if (key === "hysplit") updateHysplitPlayerVisibility();
        updateDynamicLegend();
      });
    };
    bindLayerToggle("toggle-hotspot", "hotspot", hotspotLayer);
    bindLayerToggle("toggle-hysplit", "hysplit", hysplitLayer);
    bindLayerToggle("toggle-admin", "admin", adminLayer);
    bindLayerToggle("toggle-pop", "pop", popLayer);

    // Slider Opasitas HYSPLIT & Populasi
    document.getElementById("opacity-hysplit").addEventListener("input", (e) => {
      state.hysplitOpacity = parseFloat(e.target.value);
      document.getElementById("opacity-hysplit-val").textContent = `${Math.round(state.hysplitOpacity * 100)}%`;
      renderHysplitLayer();
    });

    document.getElementById("opacity-pop").addEventListener("input", (e) => {
      state.popOpacity = parseFloat(e.target.value);
      document.getElementById("opacity-pop-val").textContent = `${Math.round(state.popOpacity * 100)}%`;
      renderPopulationLayer();
    });

    // Filter Tahun (klik 2023 -> langsung hanya 2023 aktif; sama untuk 2024, 2025, 2026)
    const syncYearButtons = () => {
      const isAll = state.selectedYears.size === DS.YEARS.length;
      document.querySelectorAll(".year-btn").forEach((btn) => {
        const yr = Number(btn.dataset.year);
        btn.classList.toggle("active", !isAll && state.selectedYears.has(yr));
      });
      document.getElementById("btn-select-all-years").classList.toggle("active", isAll);
    };

    document.querySelectorAll(".year-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const yr = Number(btn.dataset.year);
        state.selectedYears = new Set([yr]);
        syncYearButtons();
        refreshAll();
      });
    });

    document.getElementById("btn-select-all-years").addEventListener("click", () => {
      state.selectedYears = new Set(DS.YEARS);
      syncYearButtons();
      refreshAll();
    });

    // Tombol Reset Filter
    document.getElementById("btn-reset-filter").addEventListener("click", () => {
      stopHysplitAnimation();
      state.hysplitHour = 1;
      state.selectedYears = new Set([2026]);
      syncYearButtons();

      // Kembalikan kondisi layer default
      const defaults = { hotspot: true, hysplit: true, admin: true, pop: false };
      const mapLayers = { hotspot: hotspotLayer, hysplit: hysplitLayer, admin: adminLayer, pop: popLayer };
      Object.entries(defaults).forEach(([k, val]) => {
        state.layers[k] = val;
        document.getElementById(`toggle-${k}`).checked = val;
        if (val && !map.hasLayer(mapLayers[k])) mapLayers[k].addTo(map);
        if (!val && map.hasLayer(mapLayers[k])) map.removeLayer(mapLayers[k]);
      });

      if (papuaBounds) map.fitBounds(papuaBounds, { padding: [24, 24] });
      refreshAll();
    });

    // Tombol Zoom ke Papua Selatan & Tampilan Awal
    document.getElementById("btn-zoom-papua").addEventListener("click", () => {
      if (papuaBounds) map.fitBounds(papuaBounds, { padding: [24, 24] });
    });

    document.getElementById("btn-initial-view").addEventListener("click", () => {
      map.flyTo(INITIAL_VIEW.center, INITIAL_VIEW.zoom, { duration: 0.75 });
    });

    // Collapse Legenda Dinamis
    document.getElementById("legend-toggle").addEventListener("click", () => {
      document.getElementById("dynamic-legend").classList.toggle("collapsed");
    });

    // Tutup Panel Informasi Penduduk Kabupaten
    document.getElementById("btn-close-kab-panel").addEventListener("click", closeKabupatenInfoPanel);

    // Kontrol Animasi 24 Jam HYSPLIT 2026 (Play / Pause / Prev / Next / Slider / Speed)
    document.getElementById("btn-hysplit-play").addEventListener("click", () => {
      if (state.hysplitPlaying) stopHysplitAnimation();
      else startHysplitAnimation();
    });

    document.getElementById("btn-hysplit-prev").addEventListener("click", () => {
      stopHysplitAnimation();
      state.hysplitHour = state.hysplitHour <= 1 ? 24 : state.hysplitHour - 1;
      renderHysplitLayer();
      updateDynamicLegend();
    });

    document.getElementById("btn-hysplit-next").addEventListener("click", () => {
      stopHysplitAnimation();
      state.hysplitHour = state.hysplitHour >= 24 ? 1 : state.hysplitHour + 1;
      renderHysplitLayer();
      updateDynamicLegend();
    });

    document.getElementById("hysplit-hour-slider").addEventListener("input", (e) => {
      stopHysplitAnimation();
      state.hysplitHour = Number(e.target.value);
      renderHysplitLayer();
      updateDynamicLegend();
    });

    document.getElementById("hysplit-speed").addEventListener("change", (e) => {
      state.hysplitSpeedMs = Number(e.target.value);
      if (state.hysplitPlaying) {
        stopHysplitAnimation();
        startHysplitAnimation();
      }
    });

    // Modal / Overlay Perbandingan Tahun (2023–2026)
    const overlay = document.getElementById("compare-overlay");
    document.getElementById("btn-compare").addEventListener("click", () => {
      overlay.classList.remove("hidden");
      initCompareView();
    });

    document.getElementById("btn-close-compare").addEventListener("click", () => {
      overlay.classList.add("hidden");
    });

    document.querySelectorAll(".compare-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".compare-tab").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".compare-pane").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(btn.dataset.ctab).classList.add("active");
        if (btn.dataset.ctab === "ctab-maps" && mapLeft && mapRight) {
          setTimeout(() => {
            mapLeft.invalidateSize();
            mapRight.invalidateSize();
          }, 60);
        }
      });
    });

    document.getElementById("compare-year-left").addEventListener("change", (e) => {
      renderCompareMap(leftGroup, Number(e.target.value), "split-stat-left");
    });

    document.getElementById("compare-year-right").addEventListener("change", (e) => {
      renderCompareMap(rightGroup, Number(e.target.value), "split-stat-right");
    });
  }

  async function loadExternalGeoJSON() {
    const tasks = [
      fetch(DS.adminGeoJSONPath)
        .then((r) => (r.ok ? r.json() : null))
        .then((fc) => {
          if (fc) {
            DS.setAdminGeoJSON(fc);
            const temp = L.geoJSON(DS.adminGeoJSON);
            if (temp.getBounds().isValid()) {
              papuaBounds = temp.getBounds();
              map.fitBounds(papuaBounds, { padding: [24, 24] });
            }
          }
        }),
      fetch(DS.viirsHotspotsPath)
        .then((r) => (r.ok ? r.json() : null))
        .then((payload) => {
          if (payload) DS.setViirsHotspotsData(payload);
        })
    ];

    Object.entries(DS.hysplit24hPaths).forEach(([yr, path]) => {
      tasks.push(
        fetch(path)
          .then((r) => (r.ok ? r.json() : null))
          .then((payload) => {
            if (payload) DS.setHysplit24hData(Number(yr), payload);
          })
      );
    });

    Object.entries(DS.dampakAsapPaths).forEach(([yr, path]) => {
      tasks.push(
        fetch(path)
          .then((r) => (r.ok ? r.json() : null))
          .then((payload) => {
            if (payload) DS.setDampakAsapData(Number(yr), payload);
          })
      );
    });

    await Promise.allSettled(tasks);
  }

  // Bootstrap
  document.addEventListener("DOMContentLoaded", async () => {
    initMainMap();
    bindEvents();
    await loadExternalGeoJSON();
    refreshAll();
  });
})();
