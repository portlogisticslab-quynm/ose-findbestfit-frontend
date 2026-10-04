"use strict";

// ============================================================
// GLOBAL STATE
// ============================================================

const state = {
  workbook: null,
  fileName: "",
  currentRows: [],
  fitState: null,
  genState: null
};

const charts = {
  results: null,
  cdf: null,
  qq: null,
  residual: null,
  genPdf: null,
  genCdf: null
};

// ============================================================
// DOM REFERENCES
// ============================================================

const fileInput = document.getElementById("fileInput");
const selectFileButton = document.getElementById("selectFileButton");
const fileNameBox = document.getElementById("fileName");
const sheetSelect = document.getElementById("sheetSelect");
const columnSelect = document.getElementById("columnSelect");
const inputMode = document.getElementById("inputMode");
const histCol2Type = document.getElementById("histCol2Type");
const binMethod = document.getElementById("binMethod");
const directMode = document.getElementById("directMode");
const nSimInput = document.getElementById("nSim");
const logBox = document.getElementById("log");
const statusBox = document.getElementById("status");
const summaryBox = document.getElementById("summary");

const runFitButton = document.getElementById("runFitButton");
const generateButton = document.getElementById("generateButton");
const exportFitButton = document.getElementById("exportFitButton");
const exportGenButton = document.getElementById("exportGenButton");
const demoButton = document.getElementById("demoButton");
const templateButton = document.getElementById("templateButton");

// ============================================================
// LOGGING / STATUS
// ============================================================

function appendLog(message) {
  const timestamp = new Date().toLocaleString();
  logBox.textContent += `${timestamp}  ${message}\n`;
  logBox.scrollTop = logBox.scrollHeight;
}

function setStatus(message = "") {
  statusBox.textContent = message;
}

function setBusy(isBusy) {
  runFitButton.disabled = isBusy;
  generateButton.disabled = isBusy;
  exportFitButton.disabled = isBusy;
  exportGenButton.disabled = isBusy;
  demoButton.disabled = isBusy;
  templateButton.disabled = isBusy;
  selectFileButton.disabled = isBusy;
}

// ============================================================
// API
// ============================================================

async function apiRequest(path, options = {}) {
  const opts = {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  };

  let response;

  try {
    // window.oseFetch (config.js): home server first, Render fallback.
    response = window.oseFetch
      ? await window.oseFetch(path, opts)
      : await fetch(`${window.OSE_API_BASE || ""}${path}`, opts);
  } catch (error) {
    throw new Error(
      `Cannot connect to backend: ${window.OSE_API_BASE || "(unknown)"}`
    );
  }

  if (!response.ok) {
    let message = `Backend error ${response.status}`;

    try {
      const body = await response.json();
      message = body.detail || message;

      if (Array.isArray(message)) {
        message = message
          .map(item => item.msg || JSON.stringify(item))
          .join("; ");
      }
    } catch {
      // Keep the status-based message.
    }

    throw new Error(String(message));
  }

  return response.json();
}

function backendName(base) {
  const value = String(base || "");

  if (value.includes("onrender.com")) {
    return "Render";
  }

  if (/127\.0\.0\.1|localhost/.test(value)) {
    return "Local";
  }

  return "Home server";
}

async function backendWaitNote() {
  const base = await window.OSE_API_READY;

  return String(base || "").includes("onrender.com")
    ? " (Render: first call may take 30-60 s while it wakes up)"
    : "";
}

async function checkBackend() {
  const select = document.getElementById("backendSelect");
  const dot = document.getElementById("backendDot");
  const text = document.getElementById("backendText");
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);

  if (select) {
    if (local) {
      select.hidden = true;
    }

    let pinned = new URLSearchParams(location.search).get("api");

    try {
      pinned = pinned || localStorage.getItem("ose_api");
    } catch (error) {
      // Storage may be blocked.
    }

    select.value = ["home", "render"].includes(pinned) ? pinned : "auto";

    // config.js reads ?api= (home/render pins, auto unpins): reload the page.
    select.onchange = () => {
      const url = new URL(location.href);
      url.searchParams.set("api", select.value);
      location.href = url.toString();
    };
  }

  const base = await window.OSE_API_READY;
  const name = backendName(base);
  const started = performance.now();

  try {
    const health = await apiRequest("/api/health");
    const ms = Math.round(performance.now() - started);

    if (dot) dot.className = "dot ok";
    if (text) text.textContent = `${name} \u00b7 v${health.version || "?"} \u00b7 ${ms} ms`;

    appendLog(`Backend online: ${name} ${base} (v${health.version}, ${ms} ms)`);
  } catch (error) {
    if (dot) dot.className = "dot bad";
    if (text) text.textContent = `${name} \u00b7 offline`;

    appendLog(`Backend unavailable: ${error.message}`);
  }
}

// ============================================================
// TABS
// ============================================================

document.querySelectorAll(".tab-button").forEach(button => {
  button.addEventListener("click", () => {
    openTab(button.dataset.tab);
  });
});

function openTab(tabId) {
  document.querySelectorAll(".tab-button").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.tab === tabId
    );
  });

  document.querySelectorAll(".tab-content").forEach(content => {
    content.classList.toggle(
      "active",
      content.id === tabId
    );
  });
}

// ============================================================
// FILE READING
// ============================================================

selectFileButton.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", async event => {
  const file = event.target.files[0];

  if (!file) {
    return;
  }

  try {
    setStatus("");
    appendLog(`Reading Excel file: ${file.name}`);

    const buffer = await file.arrayBuffer();

    const workbook = XLSX.read(buffer, {
      type: "array",
      cellDates: true
    });

    loadWorkbook(workbook, file.name);
    appendLog("Excel file loaded successfully.");
  } catch (error) {
    setStatus(error.message);
    appendLog(`ERROR: ${error.message}`);
  } finally {
    // Allow selecting the same file again after editing it.
    fileInput.value = "";
  }
});

sheetSelect.addEventListener("change", () => {
  loadSelectedSheet();
  autoDetectMode();
});

function loadWorkbook(workbook, fileName, preferredSheet = "") {
  state.workbook = workbook;
  state.fileName = fileName;
  fileNameBox.textContent = fileName;
  fileNameBox.title = fileName;

  sheetSelect.innerHTML = "";

  for (const sheetName of workbook.SheetNames) {
    const option = document.createElement("option");
    option.value = sheetName;
    option.textContent = sheetName;
    sheetSelect.appendChild(option);
  }

  if (preferredSheet && workbook.SheetNames.includes(preferredSheet)) {
    sheetSelect.value = preferredSheet;
  }

  loadSelectedSheet();
  autoDetectMode();
}

function loadSelectedSheet() {
  if (!state.workbook) {
    return;
  }

  const sheetName = sheetSelect.value;
  const worksheet = state.workbook.Sheets[sheetName];

  const rows = XLSX.utils.sheet_to_json(
    worksheet,
    {
      defval: null,
      raw: true
    }
  );

  state.currentRows = rows;
  columnSelect.innerHTML = "";

  if (rows.length === 0) {
    columnSelect.innerHTML =
      `<option value="">No rows found</option>`;

    appendLog(`Sheet "${sheetName}" is empty.`);
    return;
  }

  const columnNames = collectColumnNames(rows);

  for (const name of columnNames) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    columnSelect.appendChild(option);
  }

  appendLog(
    `Sheet="${sheetName}", rows=${rows.length}, columns=${columnNames.length}`
  );
}

function collectColumnNames(rows) {
  const names = [];
  const seen = new Set();

  for (const row of rows) {
    for (const name of Object.keys(row)) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }

  return names;
}

// ============================================================
// INPUT MODE
// ============================================================

inputMode.addEventListener("change", () => {
  applyInputMode(inputMode.value);
});

function applyInputMode(mode, reason = "") {
  inputMode.value = mode;

  const histogramMode = mode === "Hist2Col";

  histCol2Type.disabled = !histogramMode;
  columnSelect.disabled = histogramMode;
  // Bin method only applies when the histogram is built from raw data.
  binMethod.disabled = histogramMode;

  appendLog(
    (histogramMode
      ? "Mode = Histogram (first two numeric columns)"
      : "Mode = Raw data") +
    (reason ? ` [${reason}]` : "")
  );
}

/**
 * Suggest the input mode from the selected sheet:
 * - sheet name contains "hist" and has >= 2 numeric columns -> Hist2Col
 *   (column 2 type guessed from its header: Count/Freq -> Count, else Percent)
 * - exactly one numeric column -> RawData
 * Otherwise the user's current choice is kept.
 */
function autoDetectMode() {
  const rows = state.currentRows;

  if (!rows || rows.length === 0) {
    return;
  }

  const numeric = numericColumns(rows);
  const sheetName = sheetSelect.value || "";

  if (/hist/i.test(sheetName) && numeric.length >= 2) {
    const header = String(numeric[1]);

    histCol2Type.value =
      /count|freq|tần\s*suất|tan\s*suat|số\s*lượng/i.test(header)
        ? "Count"
        : "Percent";

    if (inputMode.value !== "Hist2Col") {
      applyInputMode("Hist2Col", `auto: sheet "${sheetName}"`);
    }

    appendLog(`Histogram column 2 = ${histCol2Type.value} (header "${header}")`);
  } else if (numeric.length === 1 && inputMode.value !== "RawData") {
    applyInputMode("RawData", `auto: sheet "${sheetName}" has 1 numeric column`);
  }

  if (inputMode.value === "RawData" && numeric.length >= 1) {
    if (!numeric.includes(columnSelect.value)) {
      columnSelect.value = numeric[0];
    }
  }
}

// ============================================================
// DEMO INPUT / EXCEL TEMPLATE
// ============================================================

demoButton.addEventListener("click", loadDemoInput);
templateButton.addEventListener("click", exportTemplateExcel);

/**
 * Build a workbook with the demo data.
 * Sheets: RawData (1 column), Histogram (BinCenter, Percent)
 * and, for the downloadable template, a ReadMe sheet placed last
 * so that the first sheet is still a data sheet.
 */
function buildDemoWorkbook(includeReadme = false) {
  const demo = window.FINDBESTFIT_DEMO;

  if (!demo) {
    throw new Error("Demo data (demo-data.js) is not loaded.");
  }

  const workbook = XLSX.utils.book_new();

  const rawSheet = XLSX.utils.aoa_to_sheet([
    [demo.rawData.column],
    ...demo.rawData.values.map(value => [value])
  ]);
  rawSheet["!cols"] = [{ wch: 16 }];

  XLSX.utils.book_append_sheet(
    workbook,
    rawSheet,
    demo.rawData.sheetName
  );

  const histSheet = XLSX.utils.aoa_to_sheet([
    [...demo.histogram.columns],
    ...demo.histogram.rows.map(row => [...row])
  ]);
  histSheet["!cols"] = [{ wch: 12 }, { wch: 12 }];

  XLSX.utils.book_append_sheet(
    workbook,
    histSheet,
    demo.histogram.sheetName
  );

  if (includeReadme) {
    const readme = XLSX.utils.aoa_to_sheet([
      ["Distribution Fitting Tool v3.3c Web - Input template / Mẫu nhập liệu"],
      [""],
      ["Sheet", "Purpose / Mục đích", "Rules / Quy tắc"],
      [
        "RawData",
        "Raw-data mode (Input mode = Raw data) / Chế độ dữ liệu thô",
        "Row 1 = header. One numeric column, at least 10 values. Blank / text cells are ignored. / Dòng 1 là tiêu đề; 1 cột số, tối thiểu 10 giá trị."
      ],
      [
        "Histogram",
        "Histogram mode (Input mode = Histogram) / Chế độ histogram 2 cột",
        "Column A = bin center (strictly increasing, evenly or unevenly spaced). Column B = Percent (%) or Count. At least 5 bins. / Cột A = tâm bin tăng dần; cột B = % hoặc tần số; tối thiểu 5 bin."
      ],
      [""],
      ["Steps / Các bước"],
      ["1", "Replace the demo numbers with your data (keep the header row). / Thay số liệu demo bằng dữ liệu của bạn (giữ dòng tiêu đề)."],
      ["2", "Select Excel -> choose sheet. Sheet named 'Histogram...' switches to Histogram mode automatically. / Chọn file, chọn sheet; sheet tên 'Histogram' tự chuyển sang chế độ Histogram."],
      ["3", "Histogram column 2: header 'Count'/'Frequency' -> Count, otherwise Percent. Check the selector before running. / Kiểm tra lại ô 'Histogram column 2'."],
      ["4", "Tick distributions -> Run Fit -> Generate & Compare -> Export. / Chọn phân phối -> Run Fit -> Generate & Compare -> Export."],
      [""],
      ["Notes / Ghi chú"],
      ["-", "Lognormal, Gamma, Weibull, Exponential require all values > 0; Beta requires 0 < x < 1. / Các phân phối dương yêu cầu x > 0; Beta yêu cầu 0 < x < 1."],
      ["-", `Demo data: ${demo.rawData.values.length} observations (RawData), ${demo.histogram.rows.length} bins (Histogram).`],
      ["", "© 2026 Nguyen Minh Quy – portlogistics.vn"]
    ]);
    readme["!cols"] = [{ wch: 12 }, { wch: 70 }, { wch: 110 }];

    XLSX.utils.book_append_sheet(workbook, readme, "ReadMe");
  }

  return workbook;
}

function loadDemoInput() {
  try {
    setStatus("");

    const demo = window.FINDBESTFIT_DEMO;
    const workbook = buildDemoWorkbook(false);

    loadWorkbook(
      workbook,
      `[DEMO] ${demo.fileName}`,
      demo.rawData.sheetName
    );

    appendLog(
      `Demo input loaded: sheet "${demo.rawData.sheetName}" ` +
      `(${demo.rawData.values.length} values) and sheet ` +
      `"${demo.histogram.sheetName}" (${demo.histogram.rows.length} bins). ` +
      "Click Run Fit, or switch Sheet to Histogram for histogram mode."
    );
  } catch (error) {
    setStatus(error.message);
    appendLog(`ERROR: ${error.message}`);
  }
}

function exportTemplateExcel() {
  try {
    setStatus("");

    const workbook = buildDemoWorkbook(true);

    XLSX.writeFile(
      workbook,
      "FindBestFit_input_template_demo.xlsx"
    );

    appendLog(
      "Excel template exported: FindBestFit_input_template_demo.xlsx " +
      "(sheets RawData, Histogram, ReadMe)."
    );
  } catch (error) {
    setStatus(error.message);
    appendLog(`ERROR: ${error.message}`);
  }
}

// ============================================================
// NUMERIC HELPERS
// ============================================================

function finiteValues(values) {
  return values
    .map(Number)
    .filter(Number.isFinite);
}

function mean(values) {
  if (values.length === 0) {
    return NaN;
  }

  return values.reduce((sum, value) => sum + value, 0) /
    values.length;
}

function variance(values, sample = false) {
  if (values.length === 0) {
    return NaN;
  }

  const avg = mean(values);
  const sum = values.reduce(
    (acc, value) => acc + (value - avg) ** 2,
    0
  );

  return sum / (
    sample
      ? Math.max(values.length - 1, 1)
      : values.length
  );
}

function standardDeviation(values, sample = false) {
  return Math.sqrt(variance(values, sample));
}

function quantileSorted(sorted, probability) {
  if (sorted.length === 0) {
    return NaN;
  }

  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  if (lower === upper) {
    return sorted[lower];
  }

  const weight = position - lower;

  return sorted[lower] * (1 - weight) +
    sorted[upper] * weight;
}

function sse(valuesA, valuesB) {
  return valuesA.reduce(
    (sum, value, index) =>
      sum + (value - valuesB[index]) ** 2,
    0
  );
}

function selectedDistributions() {
  return Array.from(
    document.querySelectorAll(
      '.dist-grid input[type="checkbox"]:checked'
    )
  ).map(item => item.value);
}

function numericColumns(rows) {
  return collectColumnNames(rows).filter(name =>
    rows.some(row => Number.isFinite(Number(row[name])))
  );
}

// ============================================================
// FIT
// ============================================================

runFitButton.addEventListener("click", runFit);

async function runFit() {
  try {
    setStatus("");

    if (!state.workbook) {
      throw new Error("Please select an Excel file first.");
    }

    const selected = selectedDistributions();

    if (selected.length === 0) {
      throw new Error(
        "Please select at least one distribution."
      );
    }

    setBusy(true);
    appendLog(
      `Sending fit request to backend. Mode=${inputMode.value}` +
      (await backendWaitNote())
    );

    let result;

    if (inputMode.value === "RawData") {
      const column = columnSelect.value;

      if (!column) {
        throw new Error("Please select a data column.");
      }

      const values = finiteValues(
        state.currentRows.map(row => row[column])
      );

      if (values.length < 10) {
        throw new Error(
          "At least 10 valid numeric observations are required."
        );
      }

      result = await apiRequest(
        "/api/fit/raw",
        {
          method: "POST",
          body: JSON.stringify({
            values,
            binMethod: binMethod.value,
            directMode: directMode.value,
            distributions: selected
          })
        }
      );

      result.sourceColumn = column;
    } else {
      const names = numericColumns(state.currentRows);

      if (names.length < 2) {
        throw new Error(
          "Histogram mode requires at least two numeric columns."
        );
      }

      const centers = [];
      const values = [];

      for (const row of state.currentRows) {
        const x = Number(row[names[0]]);
        const y = Number(row[names[1]]);

        if (Number.isFinite(x) && Number.isFinite(y)) {
          centers.push(x);
          values.push(y);
        }
      }

      result = await apiRequest(
        "/api/fit/histogram",
        {
          method: "POST",
          body: JSON.stringify({
            centers,
            values,
            histCol2Type: histCol2Type.value,
            directMode: directMode.value,
            distributions: selected
          })
        }
      );

      result.histogram.sourceColumns = names.slice(0, 2);
    }

    result.directModeUsed = directMode.value;
    state.fitState = result;
    state.genState = null;

    for (const warning of result.warnings || []) {
      appendLog(warning);
    }

    updateFitUI();
    appendLog("Fit completed on backend.");
    openTab("resultsTab");
  } catch (error) {
    setStatus(error.message);
    appendLog(`ERROR: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

// ============================================================
// UI UPDATE
// ============================================================

function destroyChart(name) {
  if (charts[name]) {
    charts[name].destroy();
    charts[name] = null;
  }
}

function updateFitUI() {
  updateRankingTable();
  updateSummary();
  updateResultsChart();
  updateDiagnostics();
  clearGenerateUI();
}

function updateRankingTable() {
  const body =
    document.querySelector("#rankingTable tbody");

  body.innerHTML = "";

  for (const result of state.fitState.results) {
    const row = document.createElement("tr");

    const score1 =
      result.FitType === "MLE"
        ? result.SSE_PDF_Norm
        : result.SSE_Pbin;

    const score2 =
      result.FitType === "MLE"
        ? result.AIC
        : result.SSE_PDF_Norm;

    row.innerHTML = `
      <td>${escapeHtml(result.Distribution)}</td>
      <td>${escapeHtml(result.FitType)}</td>
      <td>${formatNumber(score1)}</td>
      <td>${formatNumber(score2)}</td>
      <td>${escapeHtml(result.ParamString)}</td>
      <td>${result.Rank ?? ""}</td>
    `;

    body.appendChild(row);
  }
}

function formatNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "";
  }

  return number.toPrecision(6);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function updateSummary() {
  const fit = state.fitState;

  if (fit.mode === "RawData") {
    summaryBox.textContent =
`BEST MODELS (RAW DATA)

Best MLE
- Distribution: ${fit.bestMLE.Distribution}
- SSE_PDF_Norm: ${formatNumber(fit.bestMLE.SSE_PDF_Norm)}
- AIC: ${formatNumber(fit.bestMLE.AIC)}
- BIC: ${formatNumber(fit.bestMLE.BIC)}
- KS p-value: ${formatNumber(fit.bestMLE.KS_pValue)}
- Parameters: ${fit.bestMLE.ParamString}

Best DirectHistFit (${fit.directModeUsed || directMode.value})
- Distribution: ${fit.bestDirect.Distribution}
- SSE_Pbin: ${formatNumber(fit.bestDirect.SSE_Pbin)}
- Parameters: ${fit.bestDirect.ParamString}

Observations: ${fit.values.length}
Source column: ${fit.sourceColumn}`;
  } else {
    summaryBox.textContent =
`BEST FIT (HISTOGRAM TWO-COLUMN INPUT)

- Distribution: ${fit.bestDirect.Distribution}
- SSE_Pbin: ${formatNumber(fit.bestDirect.SSE_Pbin)}
- SSE_PDF_Norm: ${formatNumber(fit.bestDirect.SSE_PDF_Norm)}
- Parameters: ${fit.bestDirect.ParamString}

Source columns:
${(fit.histogram.sourceColumns || []).join(" / ")}`;
  }
}

function resultCurve(result) {
  return result.curve || {
    pdf: [],
    cdf: []
  };
}

function updateResultsChart() {
  destroyChart("results");

  const fit = state.fitState;
  const histogram = fit.histogram;

  const datasets = [
    {
      type: "bar",
      label:
        fit.mode === "RawData"
          ? "Empirical histogram PDF"
          : "Empirical PDF",
      data: histogram.centers.map(
        (x, index) => ({
          x,
          y: histogram.pdf[index]
        })
      ),
      borderWidth: 1
    }
  ];

  if (fit.mode === "RawData") {
    datasets.push(
      createPdfLineDataset(
        `Best MLE: ${fit.bestMLE.Distribution}`,
        fit.bestMLE
      ),
      createPdfLineDataset(
        `Best Direct: ${fit.bestDirect.Distribution}`,
        fit.bestDirect
      )
    );
  } else {
    datasets.push(
      createPdfLineDataset(
        `Best fit: ${fit.bestDirect.Distribution}`,
        fit.bestDirect
      )
    );
  }

  charts.results = new Chart(
    document.getElementById("resultsChart"),
    {
      type: "scatter",
      data: { datasets },
      options: chartOptions("Value", "Density / PDF")
    }
  );
}

function createPdfLineDataset(label, result) {
  const curve = resultCurve(result);

  return {
    type: "line",
    label,
    data: state.fitState.xplot.map(
      (x, index) => ({
        x,
        y: curve.pdf[index]
      })
    ),
    pointRadius: 0,
    borderWidth: 2.5,
    tension: 0.1
  };
}

function updateDiagnostics() {
  updateCdfChart();
  updateQqChart();
  updateResidualChart();
}

function empiricalCdfFromRaw(values) {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted.map((value, index) => ({
    x: value,
    y: (index + 1) / sorted.length
  }));
}

function updateCdfChart() {
  destroyChart("cdf");

  const fit = state.fitState;
  const datasets = [];

  if (fit.mode === "RawData") {
    datasets.push({
      type: "line",
      label: "Empirical CDF",
      data: empiricalCdfFromRaw(fit.values),
      pointRadius: 0,
      stepped: true,
      borderWidth: 1.8
    });

    datasets.push(
      createCdfLineDataset(
        `Best MLE: ${fit.bestMLE.Distribution}`,
        fit.bestMLE
      ),
      createCdfLineDataset(
        `Best Direct: ${fit.bestDirect.Distribution}`,
        fit.bestDirect
      )
    );
  } else {
    let cumulative = 0;

    datasets.push({
      type: "line",
      label: "Empirical cumulative probability",
      data: fit.histogram.centers.map(
        (x, index) => {
          cumulative += fit.histogram.pbin[index];

          return {
            x,
            y: cumulative
          };
        }
      ),
      pointRadius: 2,
      stepped: true,
      borderWidth: 1.8
    });

    datasets.push(
      createCdfLineDataset(
        `Best fit: ${fit.bestDirect.Distribution}`,
        fit.bestDirect
      )
    );
  }

  charts.cdf = createXYChart(
    "cdfChart",
    datasets,
    "Value",
    "CDF"
  );
}

function createCdfLineDataset(label, result) {
  const curve = resultCurve(result);

  return {
    type: "line",
    label,
    data: state.fitState.xplot.map(
      (x, index) => ({
        x,
        y: curve.cdf[index]
      })
    ),
    pointRadius: 0,
    borderWidth: 2,
    tension: 0.1
  };
}

function updateQqChart() {
  destroyChart("qq");

  const fit = state.fitState;
  const probabilities = fit.qqProbabilities;
  let empiricalQuantiles;

  if (fit.mode === "RawData") {
    const sorted = [...fit.values].sort((a, b) => a - b);

    empiricalQuantiles = probabilities.map(
      probability =>
        quantileSorted(sorted, probability)
    );
  } else {
    const cumulative = [];
    let total = 0;

    for (const probability of fit.histogram.pbin) {
      total += probability;
      cumulative.push(total);
    }

    empiricalQuantiles = probabilities.map(probability => {
      let index = cumulative.findIndex(
        value => value >= probability
      );

      if (index < 0) {
        index = cumulative.length - 1;
      }

      return fit.histogram.centers[index];
    });
  }

  const finitePairs = fit.qqModel.map(
    (value, index) => ({
      x: value,
      y: empiricalQuantiles[index]
    })
  ).filter(
    point =>
      Number.isFinite(point.x) &&
      Number.isFinite(point.y)
  );

  if (finitePairs.length === 0) {
    appendLog("Q-Q diagnostic skipped: no finite quantiles.");
    return;
  }

  const allValues = finitePairs.flatMap(
    point => [point.x, point.y]
  );

  const minimum = Math.min(...allValues);
  const maximum = Math.max(...allValues);

  charts.qq = createXYChart(
    "qqChart",
    [
      {
        type: "scatter",
        label: "Quantiles",
        data: finitePairs,
        pointRadius: 3
      },
      {
        type: "line",
        label: "45-degree line",
        data: [
          { x: minimum, y: minimum },
          { x: maximum, y: maximum }
        ],
        pointRadius: 0,
        borderDash: [7, 5],
        borderWidth: 1.5
      }
    ],
    "Model quantiles",
    "Empirical quantiles"
  );
}

function updateResidualChart() {
  destroyChart("residual");

  const fit = state.fitState;
  const histogram = fit.histogram;
  const datasets = [];

  const selectedResults =
    fit.mode === "RawData"
      ? [fit.bestMLE, fit.bestDirect]
      : [fit.bestDirect];

  for (const result of selectedResults) {
    datasets.push({
      type: "line",
      label:
        result.FitType === "MLE"
          ? "Residual vs MLE"
          : fit.mode === "RawData"
            ? "Residual vs Direct"
            : "Residual",
      data: histogram.centers.map(
        (x, index) => ({
          x,
          y:
            histogram.pdf[index] -
            result.modelPdfAtBins[index]
        })
      ),
      pointRadius: 3,
      borderWidth: 1.7
    });
  }

  datasets.push({
    type: "line",
    label: "Zero",
    data: [
      {
        x: histogram.centers[0],
        y: 0
      },
      {
        x:
          histogram.centers[
            histogram.centers.length - 1
          ],
        y: 0
      }
    ],
    pointRadius: 0,
    borderDash: [6, 5],
    borderWidth: 1
  });

  charts.residual = createXYChart(
    "residualChart",
    datasets,
    "Bin center",
    "Empirical PDF - fitted PDF"
  );
}

function chartOptions(xLabel, yLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      x: {
        type: "linear",
        title: {
          display: true,
          text: xLabel
        }
      },
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: yLabel
        }
      }
    }
  };
}

function createXYChart(
  canvasId,
  datasets,
  xLabel,
  yLabel
) {
  return new Chart(
    document.getElementById(canvasId),
    {
      type: "scatter",
      data: { datasets },
      options: chartOptions(xLabel, yLabel)
    }
  );
}

// ============================================================
// GENERATE & COMPARE
// ============================================================

generateButton.addEventListener(
  "click",
  generateAndCompare
);

async function generateAndCompare() {
  try {
    setStatus("");

    if (!state.fitState) {
      throw new Error("Please run a fit first.");
    }

    setBusy(true);
    appendLog("Sending generation request to backend...");

    const fit = state.fitState;
    const sampleSize = Math.max(
      1000,
      Math.min(
        200000,
        Math.round(Number(nSimInput.value) || 50000)
      )
    );

    state.genState = await apiRequest(
      "/api/generate",
      {
        method: "POST",
        body: JSON.stringify({
          mode: fit.mode,
          bestFit: fit.bestGenerateFit,
          histogram: fit.histogram,
          originalValues:
            fit.mode === "RawData"
              ? fit.values
              : [],
          sampleSize
        })
      }
    );

    updateGenerateUI();
    openTab("generateTab");
    appendLog("Generate & Compare completed on backend.");
  } catch (error) {
    setStatus(error.message);
    appendLog(`ERROR: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

function clearGenerateUI() {
  state.genState = null;

  destroyChart("genPdf");
  destroyChart("genCdf");

  document.querySelector(
    "#metricsTable tbody"
  ).innerHTML = "";
}

function updateGenerateUI() {
  updateMetricsTable();
  updateGeneratePdfChart();
  updateGenerateCdfChart();
}

function updateMetricsTable() {
  const body =
    document.querySelector("#metricsTable tbody");

  body.innerHTML = "";

  for (const [name, value] of state.genState.metrics) {
    const row = document.createElement("tr");

    row.innerHTML = `
      <td>${escapeHtml(name)}</td>
      <td>${formatNumber(value)}</td>
    `;

    body.appendChild(row);
  }
}

function updateGeneratePdfChart() {
  destroyChart("genPdf");

  const fit = state.fitState;
  const generated = state.genState.histogramGenerated;

  charts.genPdf = createXYChart(
    "generatePdfChart",
    [
      {
        type: "bar",
        label: "Original / empirical PDF",
        data: fit.histogram.centers.map(
          (x, index) => ({
            x,
            y: fit.histogram.pdf[index]
          })
        ),
        borderWidth: 1
      },
      {
        type: "line",
        label: "Generated PDF",
        data: generated.centers.map(
          (x, index) => ({
            x,
            y: generated.pdf[index]
          })
        ),
        pointRadius: 3,
        borderWidth: 1.8
      }
    ],
    "Value",
    "PDF"
  );
}

function updateGenerateCdfChart() {
  destroyChart("genCdf");

  const fit = state.fitState;
  const generated = state.genState.histogramGenerated;

  let empiricalCumulative = 0;
  let generatedCumulative = 0;

  charts.genCdf = createXYChart(
    "generateCdfChart",
    [
      {
        type: "line",
        label:
          fit.mode === "RawData"
            ? "Original cumulative"
            : "Empirical P(bin) cumulative",
        data: fit.histogram.centers.map(
          (x, index) => {
            empiricalCumulative +=
              fit.histogram.pbin[index];

            return {
              x,
              y: empiricalCumulative
            };
          }
        ),
        stepped: true,
        pointRadius: 2,
        borderWidth: 1.8
      },
      {
        type: "line",
        label: "Generated cumulative",
        data: generated.centers.map(
          (x, index) => {
            generatedCumulative +=
              generated.pbin[index];

            return {
              x,
              y: generatedCumulative
            };
          }
        ),
        stepped: true,
        pointRadius: 2,
        borderWidth: 1.8
      }
    ],
    "Value",
    "Cumulative probability"
  );
}

// ============================================================
// EXCEL EXPORT
// ============================================================

exportFitButton.addEventListener(
  "click",
  exportFitExcel
);

exportGenButton.addEventListener(
  "click",
  exportGeneratedExcel
);

function exportFitExcel() {
  try {
    if (!state.fitState) {
      throw new Error("Please run a fit first.");
    }

    const workbook = XLSX.utils.book_new();
    const fit = state.fitState;

    const resultRows = fit.results.map(result => ({
      Distribution: result.Distribution,
      FitType: result.FitType,
      ParamString: result.ParamString,
      SSE_PDF: result.SSE_PDF,
      SSE_PDF_Norm: result.SSE_PDF_Norm,
      SSE_Pbin: result.SSE_Pbin,
      LogLikelihood: result.LogLikelihood,
      AIC: result.AIC,
      BIC: result.BIC,
      KS_pValue: result.KS_pValue,
      Rank: result.Rank
    }));

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(resultRows),
      "Results"
    );

    const histogramRows =
      fit.histogram.centers.map((center, index) => ({
        BinCenter: center,
        EdgeLeft: fit.histogram.edges[index],
        EdgeRight: fit.histogram.edges[index + 1],
        BinWidth: fit.histogram.widths[index],
        EmpiricalPbin: fit.histogram.pbin[index],
        EmpiricalPDF: fit.histogram.pdf[index]
      }));

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(histogramRows),
      "HistogramBins"
    );

    if (fit.mode === "RawData") {
      const rawRows = fit.values.map(
        (value, index) => ({
          Index: index + 1,
          RawData: value
        })
      );

      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet(rawRows),
        "RawData"
      );
    }

    const summaryRows = [
      {
        Indicator: "Mode",
        Value: fit.mode
      },
      {
        Indicator: "Best_MLE",
        Value:
          fit.mode === "RawData"
            ? fit.bestMLE.Distribution
            : ""
      },
      {
        Indicator: "Best_Direct",
        Value: fit.bestDirect.Distribution
      },
      {
        Indicator: "Best_Direct_Parameters",
        Value: fit.bestDirect.ParamString
      }
    ];

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(summaryRows),
      "Summary"
    );

    XLSX.writeFile(
      workbook,
      `fit_results_v33c_backend_${timestamp()}.xlsx`
    );

    appendLog("Fit results exported to Excel.");
  } catch (error) {
    setStatus(error.message);
    appendLog(`ERROR: ${error.message}`);
  }
}

function exportGeneratedExcel() {
  try {
    if (!state.genState) {
      throw new Error(
        "Please run Generate & Compare first."
      );
    }

    const workbook = XLSX.utils.book_new();

    const metricsRows =
      state.genState.metrics.map(
        ([Metric, Value]) => ({
          Metric,
          Value
        })
      );

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(metricsRows),
      "Metrics"
    );

    const generatedRows =
      state.genState.generated.map(
        (value, index) => ({
          Index: index + 1,
          Generated: value,
          Original:
            state.fitState.mode === "RawData"
              ? state.fitState.values[index] ?? ""
              : ""
        })
      );

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(generatedRows),
      "GeneratedSeries"
    );

    const histogramRows =
      state.fitState.histogram.centers.map(
        (center, index) => ({
          BinCenter: center,
          EdgeLeft:
            state.fitState.histogram.edges[index],
          EdgeRight:
            state.fitState.histogram.edges[index + 1],
          BinWidth:
            state.fitState.histogram.widths[index],
          EmpPbin:
            state.fitState.histogram.pbin[index],
          GenPbin:
            state.genState.histogramGenerated.pbin[index],
          EmpPDF:
            state.fitState.histogram.pdf[index],
          GenPDF:
            state.genState.histogramGenerated.pdf[index]
        })
      );

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(histogramRows),
      "ComparisonBins"
    );

    XLSX.writeFile(
      workbook,
      `generated_vs_original_backend_${timestamp()}.xlsx`
    );

    appendLog("Generated comparison exported to Excel.");
  } catch (error) {
    setStatus(error.message);
    appendLog(`ERROR: ${error.message}`);
  }
}

function timestamp() {
  const date = new Date();

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "_",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join("");
}

// ============================================================
// INITIALIZATION
// ============================================================

appendLog(
  "Ready. Select an Excel file (or click Load Demo Input), " +
  "choose mode, then click Run Fit."
);
window.OSE_API_READY.then(base => {
  appendLog(`API base: ${base}`);
});
checkBackend();
