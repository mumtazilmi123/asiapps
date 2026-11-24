"""
Pengolahan Data Spasial & Zonal Statistics Jumlah Penduduk Kabupaten Papua Selatan (2023–2026)
Menggunakan:
  - geopandas   : membaca shapefile batas administrasi kabupaten (.shp)
  - rasterio    : membaca metadata, CRS, dan nilai nodata raster WorldPop (.tif)
  - rasterstats : menghitung Zonal Statistics (sum) piksel WorldPop Population Count per kabupaten
  - pandas      : mengolah tabel statistik, menghitung perubahan 2023–2026, dan ekspor CSV

Keluaran utama:
  - data/kabupaten_populasi_papua_selatan.geojson (format pertukaran utama untuk WebGIS / GitHub Pages)
  - data/aoi_papua_selatan.geojson & js/aoi-papua-selatan.js (sinkronisasi atribut & fallback)
  - data/populasi_papua_selatan_2023_2026.csv (rekapitulasi tabular)
"""

import json
import os

import geopandas as gpd
import pandas as pd
import rasterio
from rasterstats import zonal_stats
from shapely import force_2d

YEARS = [2023, 2024, 2025, 2026]
SHP_PATH = "AOI_Papua/AOI_PapuaSelatan.shp"
OUT_GEOJSON = "data/kabupaten_populasi_papua_selatan.geojson"
OUT_AOI_GEOJSON = "data/aoi_papua_selatan.geojson"
OUT_AOI_JS = "js/aoi-papua-selatan.js"
OUT_CSV = "data/populasi_papua_selatan_2023_2026.csv"

KAB_META = {
    "Merauke": {"id": "merauke", "ibukota": "Merauke"},
    "Boven Digoel": {"id": "boven_digoel", "ibukota": "Tanah Merah"},
    "Mappi": {"id": "mappi", "ibukota": "Kepi"},
    "Asmat": {"id": "asmat", "ibukota": "Agats"},
}


def round_coords(obj, ndigits=5):
    if isinstance(obj, list):
        if len(obj) == 2 and isinstance(obj[0], (int, float)):
            return [round(obj[0], ndigits), round(obj[1], ndigits)]
        return [round_coords(x, ndigits) for x in obj]
    return obj


def main():
    os.makedirs("data", exist_ok=True)

    # 1. Baca shapefile batas administrasi kabupaten Papua Selatan
    gdf = gpd.read_file(SHP_PATH)
    if gdf.crs is None:
        raise ValueError("Shapefile tidak memiliki CRS (sistem koordinat).")
    print(f"Shapefile dimuat: {len(gdf)} kabupaten | CRS awal: {gdf.crs}")

    # Simpan salinan dalam EPSG:4326 untuk ekspor GeoJSON (standar RFC 7946 / Leaflet)
    gdf_4326 = gdf.to_crs(epsg=4326) if gdf.crs.to_epsg() != 4326 else gdf.copy()

    # Siapkan DataFrame pandas untuk menggabungkan hasil Zonal Statistics tiap tahun
    df_stats = pd.DataFrame({
        "namobj": gdf_4326["NAMOBJ"].astype(str).str.strip(),
        "kode_kab": gdf_4326["KDPKAB"].astype(str).str.strip(),
        "provinsi": gdf_4326["WADMPR"].astype(str).str.strip(),
        "luas_km2": gdf_4326["LUASWH"].astype(float).round(2),
    })
    df_stats["id"] = df_stats["namobj"].map(lambda n: KAB_META[n]["id"])
    df_stats["nama"] = df_stats["namobj"].map(lambda n: f"Kabupaten {n}")
    df_stats["ibukota"] = df_stats["namobj"].map(lambda n: KAB_META[n]["ibukota"])

    # 2. Loop setiap tahun (2023, 2024, 2025, 2026) & jalankan Zonal Statistics (sum)
    for year in YEARS:
        tif_path = f"idn_pop_{year}_CN_100m_R2025A_v1.tif"
        if not os.path.exists(tif_path):
            print(f"[PERINGATAN] Raster {tif_path} tidak ditemukan. Atribut pop_{year} diset None.")
            df_stats[f"pop_{year}"] = None
            df_stats[f"kepadatan_{year}"] = None
            continue

        with rasterio.open(tif_path) as src:
            raster_crs = src.crs
            nodata_val = src.nodata
            print(f"Memproses {tif_path} | CRS: {raster_crs} | NoData: {nodata_val}")

        # Pastikan CRS shapefile sama dengan CRS raster sebelum Zonal Statistics
        gdf_aligned = gdf.to_crs(raster_crs) if gdf.crs != raster_crs else gdf

        zs = zonal_stats(
            gdf_aligned.geometry,
            tif_path,
            stats=["sum", "count", "max"],
            nodata=nodata_val,
            all_touched=False,
        )

        zs_df = pd.DataFrame(zs)
        df_stats[f"pop_{year}"] = zs_df["sum"].apply(
            lambda v: int(round(float(v))) if pd.notna(v) else None
        )
        df_stats[f"kepadatan_{year}"] = [
            round(p / luas, 2) if (pd.notna(p) and luas > 0) else None
            for p, luas in zip(df_stats[f"pop_{year}"], df_stats["luas_km2"])
        ]
        df_stats[f"piksel_{year}"] = zs_df["count"].apply(
            lambda v: int(v) if pd.notna(v) else None
        )

    # 3. Hitung perubahan jumlah penduduk dari 2023 hingga 2026 menggunakan pandas
    def calc_diff(row):
        if pd.notna(row["pop_2023"]) and pd.notna(row["pop_2026"]):
            return int(row["pop_2026"] - row["pop_2023"])
        return None

    def calc_pct(row):
        if pd.notna(row["pop_2023"]) and pd.notna(row["pop_2026"]) and row["pop_2023"] > 0:
            return round(((row["pop_2026"] - row["pop_2023"]) / row["pop_2023"]) * 100.0, 2)
        return None

    df_stats["perubahan_2023_2026"] = df_stats.apply(calc_diff, axis=1)
    df_stats["persen_perubahan_2023_2026"] = df_stats.apply(calc_pct, axis=1)

    # 4. Ekspor tabel CSV ringkas menggunakan pandas
    csv_cols = [
        "kode_kab", "id", "nama", "ibukota", "provinsi", "luas_km2",
        "pop_2023", "pop_2024", "pop_2025", "pop_2026",
        "perubahan_2023_2026", "persen_perubahan_2023_2026",
        "kepadatan_2023", "kepadatan_2024", "kepadatan_2025", "kepadatan_2026",
    ]
    df_stats[csv_cols].to_csv(OUT_CSV, index=False, encoding="utf-8")

    # 5. Bangun GeoJSON dengan geometri teroptimasi (2D, simplify topologi 0.002°) + seluruh atribut populasi
    features = []
    for idx, geom_raw in enumerate(gdf_4326.geometry):
        row = df_stats.iloc[idx]
        geom = force_2d(geom_raw).simplify(0.002, preserve_topology=True)
        c = geom.representative_point()
        minx, miny, maxx, maxy = geom.bounds

        def clean_val(v):
            if pd.isna(v):
                return None
            if hasattr(v, "item"):
                return v.item()
            return v

        props = {
            "id": str(row["id"]),
            "namobj": str(row["namobj"]),
            "nama": str(row["nama"]),
            "ibukota": str(row["ibukota"]),
            "kode_kab": str(row["kode_kab"]),
            "provinsi": str(row["provinsi"]),
            "luas_km2": clean_val(row["luas_km2"]),
            "pop_2023": clean_val(row["pop_2023"]),
            "pop_2024": clean_val(row["pop_2024"]),
            "pop_2025": clean_val(row["pop_2025"]),
            "pop_2026": clean_val(row["pop_2026"]),
            "kepadatan_2023": clean_val(row["kepadatan_2023"]),
            "kepadatan_2024": clean_val(row["kepadatan_2024"]),
            "kepadatan_2025": clean_val(row["kepadatan_2025"]),
            "kepadatan_2026": clean_val(row["kepadatan_2026"]),
            "piksel_2023": clean_val(row["piksel_2023"]),
            "piksel_2024": clean_val(row["piksel_2024"]),
            "piksel_2025": clean_val(row["piksel_2025"]),
            "piksel_2026": clean_val(row["piksel_2026"]),
            "perubahan_2023_2026": clean_val(row["perubahan_2023_2026"]),
            "persen_perubahan_2023_2026": clean_val(row["persen_perubahan_2023_2026"]),
            "sumber_populasi": "WorldPop Population Count Constrained 100m (R2025A v1)",
            "center": [round(c.y, 4), round(c.x, 4)],
            "bounds": [[round(miny, 4), round(minx, 4)], [round(maxy, 4), round(maxx, 4)]],
        }

        geom_json = json.loads(gpd.GeoSeries([geom]).to_json())["features"][0]["geometry"]
        geom_json["coordinates"] = round_coords(geom_json["coordinates"], 5)

        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": geom_json,
        })

    fc = {
        "type": "FeatureCollection",
        "name": "kabupaten_populasi_papua_selatan",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": features,
    }

    geojson_str = json.dumps(fc, separators=(",", ":"), ensure_ascii=False)
    with open(OUT_GEOJSON, "w", encoding="utf-8") as f:
        f.write(geojson_str)
    with open(OUT_AOI_GEOJSON, "w", encoding="utf-8") as f:
        f.write(geojson_str)
    with open(OUT_AOI_JS, "w", encoding="utf-8") as f:
        f.write("// Generated by scripts/zonal_populasi_kabupaten.py (rasterstats + geopandas + pandas)\n")
        f.write("window.AOI_PAPUA_SELATAN_GEOJSON = ")
        f.write(geojson_str)
        f.write(";\n")

    print("\n=== HASIL ZONAL STATISTICS (rasterstats) POPULASI KABUPATEN PAPUA SELATAN ===")
    print(df_stats[["nama", "pop_2023", "pop_2024", "pop_2025", "pop_2026", "perubahan_2023_2026", "persen_perubahan_2023_2026"]].to_string(index=False))
    print(f"\nGeoJSON tersimpan di: {OUT_GEOJSON} ({os.path.getsize(OUT_GEOJSON):,} bytes)")
    print(f"CSV tersimpan di    : {OUT_CSV}")


if __name__ == "__main__":
    main()
