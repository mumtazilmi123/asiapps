"""
Konversi 24 Shapefile Hasil Pemodelan HYSPLIT (21 Agustus 2026, 24 jam penuh)
dari folder hysplit/2026/concplot_260821_wide*.shp menjadi GeoJSON teroptimasi
untuk animasi 24 jam pada WebGIS (lokal & GitHub Pages).

Tahapan:
  1. Baca 24 shapefile berurutan (jam ke-1 = concplot_260821_wide.shp, jam ke-2..24 = _2.._24.shp)
  2. Reproyeksi dari EPSG:4269 (NAD83 HYSPLIT) ke EPSG:4326 (WGS 84)
  3. Dissolve per level konsentrasi (CONC) agar tiap jam terdiri dari 4 kontur bersih
  4. Hitung luas total sebaran asap (km²) pada proyeksi equal-area (EPSG:6933)
  5. Ekspor ke data/hysplit_2026_24h.geojson dan js/hysplit-2026-data.js
"""

import json
import os
from datetime import datetime, timedelta

import geopandas as gpd
from shapely import force_2d

SRC_DIR = "hysplit/2026"
OUT_GEOJSON = "data/hysplit_2026_24h.geojson"
OUT_JS = "js/hysplit-2026-data.js"

# Urutan level dari terendah (terluar) ke tertinggi (inti plume)
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
        return (
            dt_utc.strftime("%d %b %Y %H:%M UTC"),
            dt_wit.strftime("%d %b %Y %H:%M WIT"),
        )
    except ValueError:
        return f"{date_str} {time_str} UTC", f"{date_str} {time_str}"


def main():
    os.makedirs("data", exist_ok=True)
    frames = []
    max_area_km2 = 0.0

    for hour_idx in range(1, 25):
        fname = "concplot_260821_wide.shp" if hour_idx == 1 else f"concplot_260821_wide_{hour_idx}.shp"
        fpath = os.path.join(SRC_DIR, fname)
        if not os.path.exists(fpath):
            raise FileNotFoundError(f"Shapefile tidak ditemukan: {fpath}")

        gdf = gpd.read_file(fpath)
        if gdf.crs is None:
            gdf = gdf.set_crs(epsg=4269)
        gdf_4326 = gdf.to_crs(epsg=4326)

        # Hitung luas total envelope plume (union semua poligon pada jam ini) dalam km²
        gdf_eq = gdf_4326.to_crs(epsg=6933)
        total_area_km2 = round(float(gdf_eq.geometry.union_all().area) / 1e6, 1)
        if total_area_km2 > max_area_km2:
            max_area_km2 = total_area_km2

        date_str = str(gdf_4326["DATE"].iloc[0]).strip()
        time_str = str(gdf_4326["TIME"].iloc[0]).strip().zfill(4)
        llevel = str(gdf_4326["LLEVEL"].iloc[0]).strip()
        hlevel = str(gdf_4326["HLEVEL"].iloc[0]).strip()
        utc_label, wit_label = format_wit(date_str, time_str)

        # Konversi CONC ke float untuk pengurutan ascending (dari terluar/terendah ke inti/tertinggi)
        gdf_4326["conc_num"] = gdf_4326["CONC"].astype(float)
        dissolved = gdf_4326.dissolve(by="conc_num", as_index=False).sort_values("conc_num", ascending=True)

        hour_features = []
        unique_levels = list(dissolved["conc_num"])
        n_lvl = len(unique_levels)

        for rank, (_, row) in enumerate(dissolved.iterrows()):
            conc_val = float(row["conc_num"])
            # Map rank (0..n-1) ke 4 kelas warna konsisten
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
                    "tahun": 2026,
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
                    "sumber": f"HYSPLIT 21 Ags 2026 ({fname})",
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
            "geojson": {
                "type": "FeatureCollection",
                "features": hour_features,
            },
        })

        print(f"Jam {hour_idx:02d}/24 | {utc_label} ({wit_label}) | levels={unique_levels} | luas={total_area_km2:,.1f} km²")

    payload = {
        "tahun": 2026,
        "tanggal": "21 Agustus 2026",
        "total_jam": len(frames),
        "max_luas_km2": round(max_area_km2, 1),
        "lapisan": "0–100 m AGL",
        "sumber": "NOAA HYSPLIT concplot (21 Agustus 2026 · 24 Jam)",
        "frames": frames,
    }

    json_str = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    with open(OUT_GEOJSON, "w", encoding="utf-8") as f:
        f.write(json_str)

    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write("// Generated from hysplit/2026/concplot_260821_wide*.shp (24 Jam — 21 Agustus 2026)\n")
        f.write("window.HYSPLIT_2026_24H = ")
        f.write(json_str)
        f.write(";\n")

    print(f"\nSelesai! Ukuran {OUT_GEOJSON}: {os.path.getsize(OUT_GEOJSON):,} bytes | Max luas: {max_area_km2:,.1f} km²")


if __name__ == "__main__":
    main()
