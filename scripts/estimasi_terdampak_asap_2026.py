"""
Estimasi Dampak Jumlah Penduduk Terpapar Asap Karhutla (21 Agustus 2026, 24 Jam)
Menggabungkan:
  - 24 shapefile HYSPLIT: hysplit/2026/concplot_260821_wide*.shp (EPSG:4269 -> EPSG:4326)
  - Raster WorldPop 2026 Population Count: idn_pop_2026_CN_100m_R2025A_v1.tif (EPSG:4326)
  - Batas Administrasi Papua Selatan: AOI_Papua/AOI_PapuaSelatan.shp (EPSG:4326)

Metodologi (bebas double-counting):
  1. Potong raster WorldPop 2026 tepat pada jendela Papua Selatan sekali di awal (exact pixel values).
  2. Rasterisasi mask 4 kabupaten Papua Selatan pada grid piksel yang sama persis.
  3. Untuk setiap jam (Jam 1..24):
     - Rasterisasi masing-masing dari 4 level kontur HYSPLIT pada grid yang sama, menetapkan
       setiap piksel ke level konsentrasi TERTINGGI yang menutupinya (eksklusif, bebas hitung ganda).
     - Jumlahkan nilai piksel WorldPop 2026 di dalam Papua Selatan (total, per kabupaten, & per level kontur).
     - Akumulasikan mask union 24 jam untuk menghitung jumlah penduduk UNIK yang terpapar minimal
       1 jam sepanjang 24 jam penuh (21 Agustus 2026).
  4. Ekspor hasil ke CSV, JSON, dan JS module untuk WebGIS (lokal & GitHub Pages).
"""

import json
import os
from datetime import datetime, timedelta

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from rasterio.features import rasterize
from rasterio.mask import mask

SHP_ADMIN = "AOI_Papua/AOI_PapuaSelatan.shp"
TIF_POP_2026 = "idn_pop_2026_CN_100m_R2025A_v1.tif"
HYSPLIT_DIR = "hysplit/2026"

OUT_CSV_HOURLY = "data/dampak_asap_hysplit_2026_per_jam.csv"
OUT_CSV_SUMMARY = "data/dampak_asap_hysplit_2026_ringkasan.csv"
OUT_JSON = "data/dampak_asap_hysplit_2026.json"
OUT_JS = "js/dampak-asap-2026.js"

KAB_ID_MAP = {
    "Merauke": "merauke",
    "Boven Digoel": "boven_digoel",
    "Mappi": "mappi",
    "Asmat": "asmat",
}
KAB_ORDER = ["merauke", "asmat", "mappi", "boven_digoel"]


def format_wit(date_str, time_str):
    try:
        dt_utc = datetime.strptime(f"{date_str}{time_str}", "%Y%m%d%H%M")
        dt_wit = dt_utc + timedelta(hours=9)
        return dt_utc.strftime("%d %b %Y %H:%M UTC"), dt_wit.strftime("%d %b %Y %H:%M WIT")
    except ValueError:
        return f"{date_str} {time_str} UTC", f"{date_str} {time_str}"


def main():
    os.makedirs("data", exist_ok=True)

    # 1. Baca batas administrasi Papua Selatan (EPSG:4326)
    gdf_admin = gpd.read_file(SHP_ADMIN)
    if gdf_admin.crs is None or gdf_admin.crs.to_epsg() != 4326:
        gdf_admin = gdf_admin.to_crs(epsg=4326)

    # 2. Potong raster WorldPop 2026 pada union Provinsi Papua Selatan (nilai piksel utuh)
    with rasterio.open(TIF_POP_2026) as src:
        nodata = src.nodata
        if src.crs and gdf_admin.crs != src.crs:
            gdf_admin = gdf_admin.to_crs(src.crs)
        union_geom = gdf_admin.geometry.union_all()
        pop_masked, pop_transform = mask(src, [union_geom], crop=True, filled=False, all_touched=False)
        band = pop_masked[0]
        raw = np.ma.filled(band, 0.0) if np.ma.isMaskedArray(band) else band
        valid = np.isfinite(raw) & (raw > 0)
        if nodata is not None:
            valid &= raw != nodata
        pop_arr = np.where(valid, raw, 0.0).astype(np.float64)
        grid_shape = pop_arr.shape
        raster_crs = src.crs

    # 3. Rasterisasi ID kabupaten (1..4) pada grid WorldPop Papua Selatan yang identik
    kab_codes = {}
    kab_names = {}
    kab_pop_total = {}
    shapes_admin = []
    for idx, (_, row) in enumerate(gdf_admin.iterrows(), start=1):
        namobj = str(row["NAMOBJ"]).strip()
        kid = KAB_ID_MAP[namobj]
        kab_codes[kid] = idx
        kab_names[kid] = f"Kabupaten {namobj}"
        shapes_admin.append((row.geometry, idx))

    kab_grid = rasterize(
        shapes_admin,
        out_shape=grid_shape,
        transform=pop_transform,
        fill=0,
        dtype=np.uint8,
        all_touched=False,
    )

    # Hitung populasi 2026 baseline per kabupaten langsung pada grid yang sama agar persentase konsisten 100%
    for kid in KAB_ORDER:
        kab_pop_total[kid] = int(round(float(pop_arr[kab_grid == kab_codes[kid]].sum())))
    prov_pop_total = sum(kab_pop_total.values())

    # 4. Proses ke-24 jam shapefile HYSPLIT 21 Agustus 2026
    hourly_records = []
    union_smoke_mask = np.zeros(grid_shape, dtype=bool)
    max_level_24h = np.zeros(grid_shape, dtype=np.uint8)  # 0=tidak kena, 1..4=level tertinggi selama 24 jam
    peak_hour_per_kab = {kid: {"jam_ke": 1, "terpapar": 0, "waktu_wit": ""} for kid in KAB_ORDER}
    peak_hour_prov = {"jam_ke": 1, "terpapar": 0, "waktu_wit": ""}

    for hour_idx in range(1, 25):
        fname = "concplot_260821_wide.shp" if hour_idx == 1 else f"concplot_260821_wide_{hour_idx}.shp"
        fpath = os.path.join(HYSPLIT_DIR, fname)
        gdf_hy = gpd.read_file(fpath)
        if gdf_hy.crs is None:
            gdf_hy = gdf_hy.set_crs(epsg=4269)
        if raster_crs and gdf_hy.crs != raster_crs:
            gdf_hy = gdf_hy.to_crs(raster_crs)

        date_str = str(gdf_hy["DATE"].iloc[0]).strip()
        time_str = str(gdf_hy["TIME"].iloc[0]).strip().zfill(4)
        utc_label, wit_label = format_wit(date_str, time_str)

        gdf_hy["conc_num"] = gdf_hy["CONC"].astype(float)
        unique_levels = sorted(gdf_hy["conc_num"].unique())
        n_lvl = len(unique_levels)

        # Tetapkan tiap piksel ke level konsentrasi TERTINGGI (1..4) agar eksklusif / bebas double-count
        level_grid = np.zeros(grid_shape, dtype=np.uint8)
        for rank, cval in enumerate(unique_levels):
            lvl_code = min(4, round((rank / max(1, n_lvl - 1)) * 3) + 1) if n_lvl > 1 else 3
            geoms_lvl = gdf_hy.loc[gdf_hy["conc_num"] == cval, "geometry"].tolist()
            if not geoms_lvl:
                continue
            lvl_mask = rasterize(
                [(g, 1) for g in geoms_lvl if g is not None and not g.is_empty],
                out_shape=grid_shape,
                transform=pop_transform,
                fill=0,
                dtype=np.uint8,
                all_touched=False,
            )
            level_grid = np.where(lvl_mask == 1, np.maximum(level_grid, lvl_code), level_grid)

        in_papua = kab_grid > 0
        smoke_in_papua = (level_grid > 0) & in_papua
        union_smoke_mask |= smoke_in_papua
        max_level_24h = np.where(in_papua, np.maximum(max_level_24h, level_grid), max_level_24h)

        # Total & per kabupaten pada jam ini
        per_kab = {}
        for kid in KAB_ORDER:
            k_mask = (kab_grid == kab_codes[kid]) & (level_grid > 0)
            exp_val = int(round(float(pop_arr[k_mask].sum())))
            pct_val = round((exp_val / kab_pop_total[kid]) * 100.0, 2) if kab_pop_total[kid] > 0 else 0.0
            per_kab[kid] = {"terpapar": exp_val, "persen": pct_val}
            if exp_val > peak_hour_per_kab[kid]["terpapar"]:
                peak_hour_per_kab[kid] = {"jam_ke": hour_idx, "terpapar": exp_val, "waktu_wit": wit_label}

        total_hour = sum(per_kab[k]["terpapar"] for k in KAB_ORDER)
        pct_prov = round((total_hour / prov_pop_total) * 100.0, 2) if prov_pop_total > 0 else 0.0
        if total_hour > peak_hour_prov["terpapar"]:
            peak_hour_prov = {"jam_ke": hour_idx, "terpapar": total_hour, "waktu_wit": wit_label}

        # Breakdown per level kontur (eksklusif: level 1..4)
        per_level = {}
        for lcode, lname in [(1, "level_1_terluar"), (2, "level_2_rendah"), (3, "level_3_sedang"), (4, "level_4_tinggi")]:
            l_mask = (level_grid == lcode) & in_papua
            per_level[lname] = int(round(float(pop_arr[l_mask].sum())))

        hourly_records.append({
            "jam_ke": hour_idx,
            "date": date_str,
            "time_utc": time_str,
            "waktu_utc": utc_label,
            "waktu_wit": wit_label,
            "total_terpapar": total_hour,
            "persen_provinsi": pct_prov,
            "kabupaten": per_kab,
            "per_level": per_level,
        })

    # 5. Hitung Total Penduduk UNIK Terpapar Selama 24 Jam Penuh (Union 24 jam)
    summary_kab = {}
    summary_rows = []
    for kid in KAB_ORDER:
        u_mask = (kab_grid == kab_codes[kid]) & union_smoke_mask
        uniq_val = int(round(float(pop_arr[u_mask].sum())))
        pop_tot = kab_pop_total[kid]
        pct_uniq = round((uniq_val / pop_tot) * 100.0, 2) if pop_tot > 0 else 0.0

        # Breakdown level tertinggi yang pernah dialami penduduk selama 24 jam
        lvl_24 = {}
        for lcode, lname in [(1, "level_1_terluar"), (2, "level_2_rendah"), (3, "level_3_sedang"), (4, "level_4_tinggi")]:
            lvl_24[lname] = int(round(float(pop_arr[(kab_grid == kab_codes[kid]) & (max_level_24h == lcode)].sum())))

        summary_kab[kid] = {
            "kabupaten": kab_names[kid],
            "populasi_2026": pop_tot,
            "unik_terpapar_24j": uniq_val,
            "persen_unik_24j": pct_uniq,
            "puncak_per_jam": peak_hour_per_kab[kid],
            "level_tertinggi_24j": lvl_24,
        }
        summary_rows.append({
            "kabupaten_id": kid,
            "kabupaten": kab_names[kid],
            "populasi_2026": pop_tot,
            "unik_terpapar_24j": uniq_val,
            "persen_terpapar_24j": pct_uniq,
            "puncak_jam_ke": peak_hour_per_kab[kid]["jam_ke"],
            "puncak_terpapar_jiwa": peak_hour_per_kab[kid]["terpapar"],
            "level_1_terluar": lvl_24["level_1_terluar"],
            "level_2_rendah": lvl_24["level_2_rendah"],
            "level_3_sedang": lvl_24["level_3_sedang"],
            "level_4_tinggi": lvl_24["level_4_tinggi"],
        })

    prov_uniq_24j = sum(summary_kab[k]["unik_terpapar_24j"] for k in KAB_ORDER)
    prov_pct_24j = round((prov_uniq_24j / prov_pop_total) * 100.0, 2) if prov_pop_total > 0 else 0.0
    prov_lvl_24 = {
        lname: sum(summary_kab[k]["level_tertinggi_24j"][lname] for k in KAB_ORDER)
        for lname in ["level_1_terluar", "level_2_rendah", "level_3_sedang", "level_4_tinggi"]
    }

    # 6. Simpan CSV per jam & CSV ringkasan menggunakan pandas
    df_hourly = pd.DataFrame([
        {
            "jam_ke": r["jam_ke"],
            "waktu_utc": r["waktu_utc"],
            "waktu_wit": r["waktu_wit"],
            "total_terpapar_jiwa": r["total_terpapar"],
            "persen_papua_selatan": r["persen_provinsi"],
            "merauke_jiwa": r["kabupaten"]["merauke"]["terpapar"],
            "asmat_jiwa": r["kabupaten"]["asmat"]["terpapar"],
            "mappi_jiwa": r["kabupaten"]["mappi"]["terpapar"],
            "boven_digoel_jiwa": r["kabupaten"]["boven_digoel"]["terpapar"],
            "level_1_terluar": r["per_level"]["level_1_terluar"],
            "level_2_rendah": r["per_level"]["level_2_rendah"],
            "level_3_sedang": r["per_level"]["level_3_sedang"],
            "level_4_tinggi": r["per_level"]["level_4_tinggi"],
        }
        for r in hourly_records
    ])
    df_hourly.to_csv(OUT_CSV_HOURLY, index=False, encoding="utf-8")

    df_summary = pd.DataFrame(summary_rows)
    df_summary.to_csv(OUT_CSV_SUMMARY, index=False, encoding="utf-8")

    # 7. Simpan JSON & JS untuk WebGIS
    payload = {
        "tanggal": "21 Agustus 2026",
        "sumber_asap": "NOAA HYSPLIT concplot (24 Jam — 0–100 m AGL)",
        "sumber_populasi": "WorldPop Population Count Constrained 100m 2026 (R2025A v1)",
        "provinsi": {
            "populasi_2026": prov_pop_total,
            "unik_terpapar_24j": prov_uniq_24j,
            "persen_unik_24j": prov_pct_24j,
            "puncak_per_jam": peak_hour_prov,
            "level_tertinggi_24j": prov_lvl_24,
        },
        "kabupaten": summary_kab,
        "per_jam": hourly_records,
    }

    json_str = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write("// Generated by scripts/estimasi_terdampak_asap_2026.py (HYSPLIT 24h x WorldPop 2026)\n")
        f.write("window.DAMPAK_ASAP_2026 = ")
        f.write(json_str)
        f.write(";\n")

    # Cetak ringkasan hasil
    print("=== ESTIMASI DAMPAK PENDUDUK TERPAPAR ASAP HYSPLIT (21 AGUSTUS 2026) ===")
    print(f"Total Populasi Papua Selatan 2026 : {prov_pop_total:,} jiwa")
    print(f"Total Unik Terpapar (Union 24 Jam): {prov_uniq_24j:,} jiwa ({prov_pct_24j}%)")
    print(f"Puncak Terpapar Serentak (1 Jam)  : {peak_hour_prov['terpapar']:,} jiwa (Jam {peak_hour_prov['jam_ke']:02d} — {peak_hour_prov['waktu_wit']})")
    print(f"Rincian Level Tertinggi 24 Jam    : L1={prov_lvl_24['level_1_terluar']:,} | L2={prov_lvl_24['level_2_rendah']:,} | L3={prov_lvl_24['level_3_sedang']:,} | L4={prov_lvl_24['level_4_tinggi']:,}")
    print("\n--- Ringkasan per Kabupaten ---")
    print(df_summary[["kabupaten", "populasi_2026", "unik_terpapar_24j", "persen_terpapar_24j", "puncak_jam_ke", "puncak_terpapar_jiwa"]].to_string(index=False))
    print("\n--- Ringkasan Per Jam (sampel tiap 3 jam + jam 24) ---")
    print(df_hourly[df_hourly["jam_ke"].isin([1, 3, 6, 9, 12, 15, 18, 21, 24])][["jam_ke", "waktu_wit", "total_terpapar_jiwa", "persen_papua_selatan", "merauke_jiwa", "mappi_jiwa", "asmat_jiwa", "boven_digoel_jiwa"]].to_string(index=False))


if __name__ == "__main__":
    main()
