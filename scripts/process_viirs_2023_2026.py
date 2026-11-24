"""
Pengolahan Data Hotspot VIIRS (2023–2026) untuk Provinsi Papua Selatan
Menyaring viirs/Data_VIIRS_{tahun}.csv tepat pada tanggal pemodelan HYSPLIT:
  - 2023: 2023-10-26 (26 Oktober 2023)
  - 2024: 2024-09-30 (30 September 2024)
  - 2025: 2025-09-02 (2 September 2025)
  - 2026: 2026-08-21 (21 Agustus 2026)

Melakukan spatial join (Point-in-Polygon) dengan AOI_Papua/AOI_PapuaSelatan.shp
untuk mendapatkan jumlah hotspot akurat di dalam Papua Selatan per kabupaten,
lalu mengekspor ke JSON, JS module, dan CSV rekapitulasi.
"""

import json
import os
from datetime import datetime, timedelta

import geopandas as gpd
import pandas as pd

SHP_ADMIN = "AOI_Papua/AOI_PapuaSelatan.shp"
OUT_JSON = "data/viirs_hotspots_2023_2026.json"
OUT_JS = "js/viirs-hotspots-2023-2026.js"
OUT_CSV = "data/rekap_viirs_hotspot_2023_2026.csv"

TARGETS = [
    (2023, "2023-10-26", "26 Oktober 2023"),
    (2024, "2024-09-30", "30 September 2024"),
    (2025, "2025-09-02", "2 September 2025"),
    (2026, "2026-08-21", "21 Agustus 2026"),
]

KAB_ID_MAP = {
    "Merauke": "merauke",
    "Boven Digoel": "boven_digoel",
    "Mappi": "mappi",
    "Asmat": "asmat",
}

CONF_MAP = {
    "h": "High",
    "high": "High",
    "n": "Nominal",
    "nominal": "Nominal",
    "l": "Low",
    "low": "Low",
}


def format_wit(date_str, time_raw):
    t4 = str(int(time_raw)).zfill(4) if pd.notna(time_raw) else "0000"
    try:
        dt_utc = datetime.strptime(f"{date_str} {t4}", "%Y-%m-%d %H%M")
        dt_wit = dt_utc + timedelta(hours=9)
        return dt_wit.strftime("%H:%M WIT"), f"{t4[:2]}:{t4[2:]} UTC"
    except ValueError:
        return t4, t4


def main():
    os.makedirs("data", exist_ok=True)
    gdf_admin = gpd.read_file(SHP_ADMIN)
    if gdf_admin.crs is None or gdf_admin.crs.to_epsg() != 4326:
        gdf_admin = gdf_admin.to_crs(epsg=4326)
    gdf_admin = gdf_admin[["NAMOBJ", "KDPKAB", "geometry"]].copy()

    by_year = {}
    summary_rows = []

    for year, acq_date, date_label in TARGETS:
        csv_path = f"viirs/Data_VIIRS_{year}.csv"
        df = pd.read_csv(csv_path)
        df_day = df[df["acq_date"].astype(str).str.strip() == acq_date].copy()

        gdf_pts = gpd.GeoDataFrame(
            df_day,
            geometry=gpd.points_from_xy(df_day["longitude"], df_day["latitude"]),
            crs="EPSG:4326",
        )
        # Spatial join tepat di dalam batas AOI Provinsi Papua Selatan
        joined = gpd.sjoin(gdf_pts, gdf_admin, how="inner", predicate="within")

        features = []
        kab_counts = {"merauke": 0, "asmat": 0, "mappi": 0, "boven_digoel": 0}
        conf_counts = {"High": 0, "Nominal": 0, "Low": 0}

        for idx, (_, row) in enumerate(joined.iterrows(), start=1):
            namobj = str(row["NAMOBJ"]).strip()
            kid = KAB_ID_MAP[namobj]
            kab_counts[kid] += 1

            conf_raw = str(row.get("confidence", "n")).strip().lower()
            conf_label = CONF_MAP.get(conf_raw, str(row.get("confidence", "-")))
            if conf_label in conf_counts:
                conf_counts[conf_label] += 1

            waktu_wit, waktu_utc = format_wit(acq_date, row.get("acq_time"))
            sat_raw = str(row.get("satellite", "SNPP")).strip()
            sat_label = f"VIIRS {sat_raw}" if not sat_raw.upper().startswith("VIIRS") else sat_raw
            dn = "Siang" if str(row.get("daynight", "D")).strip().upper() == "D" else "Malam"

            lat = round(float(row["latitude"]), 5)
            lon = round(float(row["longitude"]), 5)
            frp = round(float(row["frp"]), 2) if pd.notna(row.get("frp")) else None
            bright = round(float(row["brightness"]), 2) if pd.notna(row.get("brightness")) else None

            features.append({
                "type": "Feature",
                "properties": {
                    "id": f"VIIRS-{year}-{idx:04d}",
                    "tahun": year,
                    "kabupatenId": kid,
                    "kab_kota": f"Kabupaten {namobj}",
                    "tanggal": acq_date,
                    "tanggal_label": date_label,
                    "waktu": f"{waktu_wit} ({waktu_utc})",
                    "satelit": sat_label,
                    "confidence": conf_label,
                    "frp": frp,
                    "brightness": bright,
                    "daynight": dn,
                },
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
            })

        by_year[year] = {
            "type": "FeatureCollection",
            "meta": {
                "tahun": year,
                "tanggal": acq_date,
                "tanggal_label": date_label,
                "total_csv_hari": int(len(df_day)),
                "total_papua_selatan": len(features),
                "kabupaten": kab_counts,
                "confidence": conf_counts,
            },
            "features": features,
        }

        summary_rows.append({
            "tahun": year,
            "tanggal": acq_date,
            "total_csv_sebelum_clip": int(len(df_day)),
            "total_papua_selatan": len(features),
            "merauke": kab_counts["merauke"],
            "asmat": kab_counts["asmat"],
            "mappi": kab_counts["mappi"],
            "boven_digoel": kab_counts["boven_digoel"],
            "conf_high": conf_counts["High"],
            "conf_nominal": conf_counts["Nominal"],
            "conf_low": conf_counts["Low"],
        })

    payload = {
        "source": "NASA FIRMS VIIRS (Data_VIIRS_2023..2026.csv — disaring tepat pada tanggal HYSPLIT & AOI Papua Selatan)",
        "years": by_year,
    }

    json_str = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        f.write(json_str)
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write("// Generated by scripts/process_viirs_2023_2026.py (VIIRS 2023–2026 clipped to AOI Papua Selatan)\n")
        f.write("window.VIIRS_HOTSPOTS_2023_2026 = ")
        f.write(json_str)
        f.write(";\n")

    df_sum = pd.DataFrame(summary_rows)
    df_sum.to_csv(OUT_CSV, index=False, encoding="utf-8")

    print("=== HASIL HOTSPOT VIIRS PAPUA SELATAN SESUAI TANGGAL HYSPLIT (2023–2026) ===")
    print(df_sum.to_string(index=False))
    print(f"\nTersimpan: {OUT_JSON} ({os.path.getsize(OUT_JSON):,} bytes) & {OUT_CSV}")


if __name__ == "__main__":
    main()
