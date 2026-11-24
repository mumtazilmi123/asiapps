"""
Hitung jumlah populasi per kabupaten Provinsi Papua Selatan (2023-2026)
dari raster WorldPop (idn_pop_{tahun}_CN_100m_R2025A_v1.tif) menggunakan
batas resmi AOI_Papua/AOI_PapuaSelatan.shp, serta ekspor PNG overlay
terpotong untuk visualisasi di WebGIS.
"""

import csv
import json
import os

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from rasterio.mask import mask

YEARS = [2023, 2024, 2025, 2026]
SHP_PATH = "AOI_Papua/AOI_PapuaSelatan.shp"

ID_MAP = {
    "Merauke": "merauke",
    "Boven Digoel": "boven_digoel",
    "Mappi": "mappi",
    "Asmat": "asmat",
}


def render_worldpop_png(arr2d, out_path):
    """
    Downsample block-sum faktor 4 agar permukiman kecil tetap terlihat jelas,
    lalu warnai dengan skala logaritmik transparan (kuning -> jingga -> ungu tua).
    """
    h, w = arr2d.shape
    factor = 4
    nh = h // factor
    nw = w // factor
    trimmed = arr2d[: nh * factor, : nw * factor]
    clean = np.where((trimmed > 0) & np.isfinite(trimmed), trimmed, 0.0)
    block = clean.reshape(nh, factor, nw, factor).sum(axis=(1, 3))

    rgba = np.zeros((nh, nw, 4), dtype=np.uint8)
    pos = block > 0.01
    if np.any(pos):
        # Logaritmik agar variasi dari desa kecil hingga kota Merauke terbaca jelas
        vals = np.log1p(block[pos])
        vmax = float(np.percentile(vals, 99.0))
        vmax = max(vmax, 1.0)
        t = np.clip(vals / vmax, 0.0, 1.0)

        # Gradien: #fde68a (253,230,138) -> #f59e0b (245,158,11) -> #c026d3 (192,38,211) -> #581c87 (88,28,135)
        stops = [
            (0.00, (253, 230, 138)),
            (0.35, (245, 158, 11)),
            (0.70, (192, 38, 211)),
            (1.00, (88, 28, 135)),
        ]
        r = np.zeros_like(t)
        g = np.zeros_like(t)
        b = np.zeros_like(t)
        for i in range(len(stops) - 1):
            t0, c0 = stops[i]
            t1, c1 = stops[i + 1]
            sel = (t >= t0) & (t <= t1)
            local = np.where(sel, (t - t0) / (t1 - t0), 0.0)
            r = np.where(sel, c0[0] + (c1[0] - c0[0]) * local, r)
            g = np.where(sel, c0[1] + (c1[1] - c0[1]) * local, g)
            b = np.where(sel, c0[2] + (c1[2] - c0[2]) * local, b)

        rgba[pos, 0] = np.clip(r, 0, 255).astype(np.uint8)
        rgba[pos, 1] = np.clip(g, 0, 255).astype(np.uint8)
        rgba[pos, 2] = np.clip(b, 0, 255).astype(np.uint8)
        rgba[pos, 3] = np.clip(165 + t * 85, 165, 250).astype(np.uint8)

    Image.fromarray(rgba, mode="RGBA").save(out_path, optimize=True)


def main():
    os.makedirs("data", exist_ok=True)
    gdf = gpd.read_file(SHP_PATH)
    if gdf.crs is None or gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(epsg=4326)

    union_geom = gdf.geometry.union_all()
    all_rows = []
    years_dict = {}
    images_by_year = {}
    raster_bounds = None

    for year in YEARS:
        tif_path = f"idn_pop_{year}_CN_100m_R2025A_v1.tif"
        if not os.path.exists(tif_path):
            raise FileNotFoundError(f"Raster tidak ditemukan: {tif_path}")

        with rasterio.open(tif_path) as src:
            nodata = src.nodata
            if src.crs and gdf.crs != src.crs:
                gdf_proj = gdf.to_crs(src.crs)
                union_proj = gdf_proj.geometry.union_all()
            else:
                gdf_proj = gdf
                union_proj = union_geom

            year_kabs = {}
            total_pop = 0
            total_luas = 0.0

            for _, row in gdf_proj.iterrows():
                namobj = str(row["NAMOBJ"]).strip()
                kab_id = ID_MAP[namobj]
                kode_kab = str(row["KDPKAB"]).strip()
                luas_km2 = round(float(row["LUASWH"]), 2)

                masked, _ = mask(src, [row.geometry], crop=True, filled=False, all_touched=False)
                band = masked[0]
                if np.ma.isMaskedArray(band):
                    raw = band.compressed()
                else:
                    raw = band.ravel()

                valid_mask = np.isfinite(raw) & (raw > 0)
                if nodata is not None:
                    valid_mask &= raw != nodata
                valid = raw[valid_mask]

                pop_exact = float(valid.sum()) if valid.size > 0 else 0.0
                pop_int = int(round(pop_exact))
                kepadatan = round(pop_int / luas_km2, 2) if luas_km2 > 0 else 0.0
                px_count = int(valid.size)
                max_px = round(float(valid.max()), 2) if valid.size > 0 else 0.0

                total_pop += pop_int
                total_luas += luas_km2

                rec = {
                    "tahun": year,
                    "kode_kab": kode_kab,
                    "kabupaten_id": kab_id,
                    "kabupaten": f"Kabupaten {namobj}",
                    "luas_km2": luas_km2,
                    "populasi": pop_int,
                    "populasi_exact": round(pop_exact, 2),
                    "kepadatan_jiwa_km2": kepadatan,
                    "piksel_berpenghuni": px_count,
                    "max_per_piksel": max_px,
                }
                all_rows.append(rec)
                year_kabs[kab_id] = rec

            years_dict[year] = {
                "total_populasi": total_pop,
                "total_luas_km2": round(total_luas, 2),
                "kabupaten": year_kabs,
            }

            # Potong raster ke union Provinsi Papua Selatan untuk PNG overlay WebGIS
            u_masked, u_transform = mask(src, [union_proj], crop=True, filled=True, nodata=0.0)
            arr2d = u_masked[0]
            out_h, out_w = arr2d.shape
            minx = u_transform.c
            maxy = u_transform.f
            maxx = minx + out_w * u_transform.a
            miny = maxy + out_h * u_transform.e
            raster_bounds = [
                [round(float(miny), 6), round(float(minx), 6)],
                [round(float(maxy), 6), round(float(maxx), 6)],
            ]

            png_rel = f"data/worldpop_papua_selatan_{year}.png"
            render_worldpop_png(arr2d, png_rel)
            images_by_year[year] = png_rel

    # Simpan CSV
    csv_path = "data/populasi_papua_selatan_2023_2026.csv"
    fieldnames = [
        "tahun", "kode_kab", "kabupaten_id", "kabupaten", "luas_km2",
        "populasi", "kepadatan_jiwa_km2", "piksel_berpenghuni", "max_per_piksel"
    ]
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in all_rows:
            writer.writerow({k: r[k] for k in fieldnames})

    # Simpan JSON & JS module untuk WebGIS
    payload = {
        "source": "WorldPop Constrained 100m (idn_pop CN_100m_R2025A_v1)",
        "bounds": raster_bounds,
        "imagesByYear": images_by_year,
        "years": years_dict,
    }
    with open("data/populasi_papua_selatan_2023_2026.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    with open("js/worldpop-data.js", "w", encoding="utf-8") as f:
        f.write("// Generated from WorldPop idn_pop_2023..2026 & AOI_PapuaSelatan.shp\n")
        f.write("window.WORLDPOP_DATA = ")
        f.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
        f.write(";\n")

    # Cetak ringkasan tabel ke stdout
    print("\n=== JUMLAH POPULASI PAPUA SELATAN PER KABUPATEN (WORLDPOP 100m) ===")
    print(f"Bounds overlay: {raster_bounds}")
    for yr in YEARS:
        yd = years_dict[yr]
        print(f"\nTahun {yr} | Total Provinsi: {yd['total_populasi']:,} jiwa")
        for kid in ["merauke", "asmat", "mappi", "boven_digoel"]:
            k = yd["kabupaten"][kid]
            print(
                f"  - {k['kabupaten']:24s} ({k['kode_kab']}): "
                f"{k['populasi']:>9,} jiwa | {k['kepadatan_jiwa_km2']:>5.2f} jiwa/km2 | "
                f"piksel={k['piksel_berpenghuni']:,}"
            )


if __name__ == "__main__":
    main()
