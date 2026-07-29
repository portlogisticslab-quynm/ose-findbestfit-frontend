# OSE Distribution Fitting Frontend

Frontend for **Distribution Fitting Tool v3.3c Web**.

## Features

- Reads `.xlsx` and `.xls` files in the browser.
- Supports one-column raw data and two-column histogram input.
- Calls the FastAPI backend for fitting and generated-sample comparison.
- Displays ranking, PDF/CDF, Q-Q, residual, and generated-data diagnostics.
- Exports fitting and generated-data results to Excel.

## Local run

1. Start the backend at `http://127.0.0.1:8000`.
2. From this repository root, run:

```powershell
py -m http.server 5500 --bind 127.0.0.1 --directory .\public
```

3. Open:

```text
http://127.0.0.1:5500
```

The local frontend automatically uses `http://127.0.0.1:8000`.

To test a remote backend from the local frontend:

```text
http://127.0.0.1:5500/?api=https://YOUR-BACKEND.onrender.com
```

## Configure the online backend

Edit `public/config.js`:

```javascript
const ONLINE_API_URL =
  "https://YOUR-BACKEND.onrender.com";
```

## Cloudflare Pages

- Framework preset: `None`
- Build command: `exit 0`
- Build output directory: `public`
- Root directory: blank

After deployment, add the Pages and custom-domain origins to the backend `ALLOWED_ORIGINS`.
