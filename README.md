# OSE Distribution Fitting Tool v3.3c Web (FindBestFit)

Static web app — **all calculations run in the browser** (`public/fit-engine.js`).
No backend server is needed any more; the former FastAPI backend on Render
(`ose-findbestfit-backend`) and the home-server API (`api-findbestfit.ose.vn`)
can be removed.

## Features

- Reads `.xlsx` and `.xls` files in the browser (data never leaves the computer).
- One-column raw data and two-column histogram input.
- Distributions: Normal, Lognormal, Gamma, Weibull, Exponential, Beta (0<x<1).
- Raw data: MLE fit (AIC, BIC, KS p-value) + DirectHistFit; histogram: DirectHistFit.
- Ranking, PDF/CDF, Q-Q, residual and generated-data diagnostics.
- Generate & Compare (1 000 – 200 000 samples) and Excel export.
- **Load Demo Input** / **Export Excel Template** (sheets RawData, Histogram, ReadMe).

## Calculation engine (`public/fit-engine.js`)

Same rules as the former Python backend (NumPy / SciPy):

| Item | Rule |
|------|------|
| Bins (raw data) | `numpy.histogram_bin_edges`: fd, sturges, scott, sqrt, auto |
| Bins (histogram input) | edges at midpoints between centres, half spacing at both ends |
| MLE | SciPy fit with loc = 0 (Weibull and Beta solved exactly) |
| KS p-value | `scipy.stats.kstest` two-sided, exact distribution (`kstwo.sf`) |
| DirectHistFit | minimise Σ (Pbin − P̂)² / max(Pbin, 1e-6) (Weighted) or Σ (Pbin − P̂)² (Unweighted); P̂ = model bin probabilities normalised to 1 |
| Scores | SSE_PDF (PDF at bin centres), SSE_PDF_Norm = SSE_PDF / ΣPDF, SSE_Pbin |
| Ranking | MLE by SSE_PDF_Norm, DirectHistFit by SSE_Pbin |
| Generate | sampling from the best DirectHistFit model |

Checked against the backend export `fit_results_v33c_backend_20260729_065153.xlsx`
(12 896 observations): identical bins and ranking, parameters equal to 7–8
significant digits, LogLikelihood / AIC / BIC equal to 1e-14.
Special functions and the KS p-value agree with SciPy to about 1e-10 (relative).

## Local run

```powershell
py -m http.server 5500 --bind 127.0.0.1 --directory .\public
```

Open `http://127.0.0.1:5500` — no backend needs to be started.

## Cloudflare Pages

- Framework preset: `None`
- Build command: `exit 0`
- Build output directory: `public`
- Root directory: blank

© 2026 Nguyen Minh Quy – portlogistics.vn
