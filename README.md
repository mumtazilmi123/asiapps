# WebGIS Persebaran Asap Karhutla — Provinsi Papua Selatan (2023–2026)

WebGIS sederhana berbasis **Leaflet.js** dan **OpenStreetMap** untuk memvisualisasikan hasil pemodelan **HYSPLIT**, **Hotspot VIIRS**, **Batas Administrasi Papua Selatan**, dan **Populasi Papua Selatan (WorldPop)** pada tahun **2023, 2024, 2025, dan 2026**.

## Fitur Utama
1. **Panel Kontrol Layer (dapat aktif bersamaan):**
   - Layer Hotspot (VIIRS)
   - Layer Hasil Pemodelan HYSPLIT (+ slider opasitas)
   - Batas Administrasi Papua Selatan (`AOI_PapuaSelatan.shp`)
   - Populasi Papua Selatan (WorldPop, + slider opasitas)
2. **Filter Tahun (2023, 2024, 2025, 2026)** + tombol **Reset Filter**.
3. **Popup Informasi:**
   - Hotspot: Koordinat (Latitude, Longitude), Kabupaten, Kecamatan/Desa, Tanggal, Satelit, Confidence.
   - Wilayah Administrasi: Nama Kabupaten, Provinsi, Kode Kabupaten, Ibu Kota, Luas Wilayah, Estimasi Populasi, dan jumlah hotspot aktif.
4. **Basemap OpenStreetMap**, **Legenda Peta Dinamis** (mengikuti layer aktif), serta tombol **Zoom ke Papua Selatan** dan **Tampilan Awal**.
5. **Fitur Perbandingan Tahun (2023–2026):**
   - **Peta Berdampingan (Split Map tersinkronisasi)** untuk membandingkan dua tahun secara visual.
   - **Grafik & Tabel Perbandingan 2023–2026** per kabupaten dan luas sebaran HYSPLIT.

## Cara Mengganti dengan Data Final Anda
Semua data terpusat di [js/datasets.js](file:///c:/ITB/GEODESI/Semester%207/SIG/PjBL/WebGIS/js/datasets.js):
- **Hotspot VIIRS (2023–2026):** Ganti `hotspotsByYear[2023..2026]` dengan GeoJSON titik VIIRS Anda (*tahun 2026 sudah memakai data asli `hotspot_papua_21_8_26.xlsx`*).
- **Hasil Pemodelan HYSPLIT (2023–2026):** Ganti `hysplitByYear[2023..2026]` dengan GeoJSON poligon/kontur keluaran HYSPLIT Anda.
- **Populasi WorldPop:** Ekspor raster `Populasi_2024_PapuaSelatan.tif` ke PNG transparan di folder `data/`, lalu isi `worldPopConfig.imageUrl` di [js/datasets.js](file:///c:/ITB/GEODESI/Semester%207/SIG/PjBL/WebGIS/js/datasets.js).

## Cara Menjalankan
Cukup jalankan server statis sederhana:
```bash
python -m http.server 8080
```
Buka: **http://localhost:8080**
