# K-Means++ Validation Experiment

Script untuk membandingkan inisialisasi centroid K-Means (quantile) vs K-Means++ pada MaiinSight.

## Cara menjalankan

```bash
node docs/validation/kmeans-comparison.mjs
```

## Output

- Tabel perbandingan Silhouette Score, Inertia, Iterations, Stability
- Segmentasi bisnis (High-Value, Regular, Occasional, Lapsed)
- Label agreement dengan ground truth
- Evidence table untuk skripsi
