"""
Konversi 24 Shapefile HYSPLIT 2025 (2 September 2025 — hysplit/2025/concplot_250902_avg1_{1..24}.shp)
menjadi GeoJSON 24 jam teroptimasi sekaligus menghitung estimasi jumlah penduduk terpapar asap
berdasarkan raster WorldPop 2025 (idn_pop_2025_CN_100m_R2025A_v1.tif) dan AOI_PapuaSelatan.shp.
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
from shapely import force_2d

YEAR = 2025
DATE_LABEL = "2 September 2025"
SRC_DIR = "hysplit/2025"
SHP_ADMIN = "AOI_Papua/AOI_PapuaSelatan.shp"
TIF_POP = "idn_pop_2025_CN_100m_R2025A_v1.tif"

OUT_HYSPLIT_GEOJSON = "data/hysplit_2025_24h.geojson"
OUT_HYSPLIT_JS = "js/hysplit-2025-data.js"
OUT_CSV_HOURLY = "data/dampak_asap_hysplit_2025_per_jam.csv"
OUT_CSV_SUMMARY = "data/dampak_asap_hysplit_2025_ringkasan.csv"
OUT_DAMPAK_JSON = "data/dampak_asap_hysplit_2025.json"
OUT_DAMPAK_JS = "js/dampak-asap-2025.js"

KAB_ID_MAP = {
    "Merauke": "merauke",
    "Boven Digoel": "boven_digoel",
    "Mappi": "mappi",
    "Asmat": "asmat",
}
KAB_ORDER = ["merauke", "asmat", "mappi", "boven_digoel"]

LEVEL_META = [
    ("sangat_rendah", "Kontur Level 1 (Terluar / Sangat Tipis)"),
    ("rendah", "Kontur Level 2 (Rendah / Tipis)"),
    ("sedang", "Kontur Level 3 (Sedang)"),
    ("tinggi", "Kontur Level 4 (Tinggi / Inti Plume)"),
]


def round_coords(obj, ndigits=4):
    if isinstance(obj, list):
        if len(obj) == 2 and isinstance(obj[0], (int, float)):
            return [round(obj[0], ndigits), round(obj[1], ndigits)]
        return [round_coords(x, ndigits) for x in obj]
    return obj


def format_wit(date_str, time_str):
    try:
        dt_utc = datetime.strptime(f"{date_str}{time_str}", "%Y%m%d%H%M")
        dt_wit = dt_utc + timedelta(hours=9)
        return dt_utc.strftime("%d %b %Y %H:%M UTC"), dt_wit.strftime("%d %b %Y %H:%M WIT")
    except ValueError:
        return f"{date_str} {time_str} UTC", f"{date_str} {time_str}"


def main():
    os.makedirs("data", exist_ok=True)

    # 1. Baca batas administrasi Papua Selatan & potong raster WorldPop 2025
    gdf_admin = gpd.read_file(SHP_ADMIN)
    if gdf_admin.crs is None or gdf_admin.crs.to_epsg() != 4326:
        gdf_admin = gdf_admin.to_crs(epsg=4326)

    with rasterio.open(TIF_POP) as src:
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

    # Rasterisasi 4 kabupaten pada grid WorldPop 2025
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

    for kid in KAB_ORDER:
        kab_pop_total[kid] = int(round(float(pop_arr[kab_grid == kab_codes[kid]].sum())))
    prov_pop_total = sum(kab_pop_total.values())

    # 2. Proses ke-24 jam shapefile HYSPLIT 2025
    frames = []
    hourly_records = []
    max_area_km2 = 0.0
    union_smoke_mask = np.zeros(grid_shape, dtype=bool)
    max_level_24h = np.zeros(grid_shape, dtype=np.uint8)
    peak_hour_per_kab = {kid: {"jam_ke": 1, "terpapar": 0, "waktu_wit": ""} for kid in KAB_ORDER}
    peak_hour_prov = {"jam_ke": 1, "terpapar": 0, "waktu_wit": ""}

    for hour_idx in range(1, 25):
        fname = f"concplot_250902_avg1_{hour_idx}.shp"
        fpath = os.path.join(SRC_DIR, fname)
        if not os.path.exists(fpath):
            raise FileNotFoundError(f"Shapefile tidak ditemukan: {fpath}")

        gdf = gpd.read_file(fpath)
        if gdf.crs is None:
            gdf = gdf.set_crs(epsg=4269)
        gdf_4326 = gdf.to_crs(epsg=4326)
        gdf_ras = gdf.to_crs(raster_crs) if (raster_crs and gdf.crs != raster_crs) else gdf_4326

        # Luas total sebaran asap (km²)
        total_area_km2 = round(float(gdf_4326.to_crs(epsg=6933).geometry.union_all().area) / 1e6, 1)
        if total_area_km2 > max_area_km2:
            max_area_km2 = total_area_km2

        date_str = str(gdf_4326["DATE"].iloc[0]).strip()
        time_str = str(gdf_4326["TIME"].iloc[0]).strip().zfill(4)
        llevel = str(gdf_4326["LLEVEL"].iloc[0]).strip()
        hlevel = str(gdf_4326["HLEVEL"].iloc[0]).strip()
        utc_label, wit_label = format_wit(date_str, time_str)

        gdf_4326["conc_num"] = gdf_4326["CONC"].astype(float)
        gdf_ras["conc_num"] = gdf_ras["CONC"].astype(float)
        dissolved = gdf_4326.dissolve(by="conc_num", as_index=False).sort_values("conc_num", ascending=True)
        unique_levels = list(dissolved["conc_num"])
        n_lvl = len(unique_levels)

        # GeoJSON kontur 4 level untuk WebGIS
        hour_features = []
        for rank, (_, row) in enumerate(dissolved.iterrows()):
            conc_val = float(row["conc_num"])
            meta_idx = min(3, round((rank / max(1, n_lvl - 1)) * 3)) if n_lvl > 1 else 2
            kelas, label = LEVEL_META[meta_idx]
            geom = force_2d(row.geometry).simplify(0.0025, preserve_topology=True)
            if geom.is_empty:
                continue
            geom_json = json.loads(gpd.GeoSeries([geom]).to_json())["features"][0]["geometry"]
            geom_json["coordinates"] = round_coords(geom_json["coordinates"], 4)
            hour_features.append({
                "type": "Feature",
                "properties": {
                    "tahun": YEAR,
                    "jam_ke": hour_idx,
                    "date": date_str,
                    "time_utc": time_str,
                    "waktu_utc": utc_label,
                    "waktu_wit": wit_label,
                    "conc_exp": conc_val,
                    "conc_label": f"10^{int(conc_val) if conc_val.is_integer() else conc_val} (log10={conc_val:g})",
                    "kelas": kelas,
                    "label": label,
                    "lapisan": f"{int(llevel)}–{int(hlevel)} m AGL",
                    "luas_jam_km2": total_area_km2,
                    "sumber": f"HYSPLIT {DATE_LABEL} ({fname})",
                },
                "geometry": geom_json,
            })

        frames.append({
            "jam_ke": hour_idx,
            "date": date_str,
            "time_utc": time_str,
            "waktu_utc": utc_label,
            "waktu_wit": wit_label,
            "luas_km2": total_area_km2,
            "conc_levels": [float(v) for v in unique_levels],
            "geojson": {"type": "FeatureCollection", "features": hour_features},
        })

        # Estimasi dampak paparan penduduk (eksklusif level tertinggi 1..4)
        level_grid = np.zeros(grid_shape, dtype=np.uint8)
        for rank, cval in enumerate(unique_levels):
            lvl_code = min(4, round((rank / max(1, n_lvl - 1)) * 3) + 1) if n_lvl > 1 else 3
            geoms_lvl = gdf_ras.loc[gdf_ras["conc_num"] == cval, "geometry"].tolist()
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

        per_level = {}
        for lcode, lname in [(1, "level_1_terluar"), (2, "level_2_rendah"), (3, "level_3_sedang"), (4, "level_4_tinggi")]:
            per_level[lname] = int(round(float(pop_arr[(level_grid == lcode) & in_papua].sum())))

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

    # 3. Simpan HYSPLIT 2025 24h GeoJSON & JS
    hysplit_payload = {
        "tahun": YEAR,
        "tanggal": DATE_LABEL,
        "total_jam": len(frames),
        "max_luas_km2": round(max_area_km2, 1),
        "lapisan": "0–100 m AGL",
        "sumber": f"NOAA HYSPLIT concplot ({DATE_LABEL} · 24 Jam)",
        "frames": frames,
    }
    hy_str = json.dumps(hysplit_payload, separators=(",", ":"), ensure_ascii=False)
    with open(OUT_HYSPLIT_GEOJSON, "w", encoding="utf-8") as f:
        f.write(hy_str)
    with open(OUT_HYSPLIT_JS, "w", encoding="utf-8") as f:
        f.write(f"// Generated from hysplit/2025/concplot_250902_avg1_*.shp (24 Jam — {DATE_LABEL})\n")
        f.write("window.HYSPLIT_2025_24H = ")
        f.write(hy_str)
        f.write(";\n")

    # 4. Ringkasan Unik 24 Jam & Simpan CSV / JSON / JS
    summary_kab = {}
    summary_rows = []
    for kid in KAB_ORDER:
        u_mask = (kab_grid == kab_codes[kid]) & union_smoke_mask
        uniq_val = int(round(float(pop_arr[u_mask].sum())))
        pop_tot = kab_pop_total[kid]
        pct_uniq = round((uniq_val / pop_tot) * 100.0, 2) if pop_tot > 0 else 0.0
        lvl_24 = {
            lname: int(round(float(pop_arr[(kab_grid == kab_codes[kid]) & (max_level_24h == lcode)].sum())))
            for lcode, lname in [(1, "level_1_terluar"), (2, "level_2_rendah"), (3, "level_3_sedang"), (4, "level_4_tinggi")]
        }
        summary_kab[kid] = {
            "kabupaten": kab_names[kid],
            "populasi_2025": pop_tot,
            "unik_terpapar_24j": uniq_val,
            "persen_unik_24j": pct_uniq,
            "puncak_per_jam": peak_hour_per_kab[kid],
            "level_tertinggi_24j": lvl_24,
        }
        summary_rows.append({
            "kabupaten_id": kid,
            "kabupaten": kab_names[kid],
            "populasi_2025": pop_tot,
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

    pd.DataFrame([
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
    ]).to_csv(OUT_CSV_HOURLY, index=False, encoding="utf-8")

    df_sum = pd.DataFrame(summary_rows)
    df_sum.to_csv(OUT_CSV_SUMMARY, index=False, encoding="utf-8")

    dampak_payload = {
        "tahun": YEAR,
        "tanggal": DATE_LABEL,
        "sumber_asap": f"NOAA HYSPLIT concplot (24 Jam — {DATE_LABEL})",
        "sumber_populasi": "WorldPop Population Count Constrained 100m 2025 (R2025A v1)",
        "provinsi": {
            "populasi": prov_pop_total,
            "unik_terpapar_24j": prov_uniq_24j,
            "persen_unik_24j": prov_pct_24j,
            "puncak_per_jam": peak_hour_prov,
            "level_tertinggi_24j": prov_lvl_24,
        },
        "kabupaten": summary_kab,
        "per_jam": hourly_records,
    }
    damp_str = json.dumps(dampak_payload, separators=(",", ":"), ensure_ascii=False)
    with open(OUT_DAMPAK_JSON, "w", encoding="utf-8") as f:
        json.dump(dampak_payload, f, indent=2, ensure_ascii=False)
    with open(OUT_DAMPAK_JS, "w", encoding="utf-8") as f:
        f.write(f"// Generated by scripts/process_hysplit_2025.py (HYSPLIT 24h x WorldPop 2025)\n")
        f.write("window.DAMPAK_ASAP_2025 = ")
        f.write(damp_str)
        f.write(";\n")

    print(f"=== HYSPLIT 2025 ({DATE_LABEL}) + ESTIMASI DAMPAK WORLDPOP 2025 ===")
    print(f"GeoJSON 24h: {OUT_HYSPLIT_GEOJSON} ({os.path.getsize(OUT_HYSPLIT_GEOJSON):,} bytes) | Max luas: {max_area_km2:,.1f} km²")
    print(f"Populasi Papua Selatan 2025       : {prov_pop_total:,} jiwa")
    print(f"Total Unik Terpapar (Union 24 Jam): {prov_uniq_24j:,} jiwa ({prov_pct_24j}%)")
    print(f"Puncak Serentak (1 Jam)           : {peak_hour_prov['terpapar']:,} jiwa (Jam {peak_hour_prov['jam_ke']:02d} — {peak_hour_prov['waktu_wit']})")
    print(f"Level Tertinggi 24 Jam            : L1={prov_lvl_24['level_1_terluar']:,} | L2={prov_lvl_24['level_2_rendah']:,} | L3={prov_lvl_24['level_3_sedang']:,} | L4={prov_lvl_24['level_4_tinggi']:,}")
    print("\n--- Ringkasan per Kabupaten (2025) ---")
    print(df_sum[["kabupaten", "populasi_2025", "unik_terpapar_24j", "persen_terpapar_24j", "puncak_jam_ke", "puncak_terpapar_jiwa"]].to_string(index=False))


if __name__ == "__main__":
    main()
