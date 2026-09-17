/**
 * sheetsService.js
 * Writes a completed-test row to the educational center's Google Sheet,
 * using a Google service account (see backend/docs/google-sheets-setup.md
 * for how to get the credentials — no OAuth login flow needed, since this
 * is a server-to-server integration).
 *
 * Row shape matches docs/exam-json-schema.md's "Google Sheet row shape" table.
 */

const { google } = require("googleapis");

// IELTS and SAT results have incompatible shapes (bands + manually-graded
// Writing/Speaking vs fully auto-graded scaled scores), so they get separate
// tabs with their own columns rather than one tab where half the columns are
// always blank and the header lies about what the numbers mean.
const IELTS_TAB = "Completed Tests";
const IELTS_HEADER = [
  "student_name", "exam_id", "exam_title", "date",
  "reading_raw", "reading_band", "listening_raw", "listening_band",
  "writing_task1_band", "writing_task2_band", "speaking_band", "overall_band", "status",
];
const SAT_TAB = "Completed Tests (SAT)";
const SAT_HEADER = [
  "student_name", "exam_id", "exam_title", "date",
  "rw_raw", "rw_scaled", "math_raw", "math_scaled", "total_scaled", "status",
];

function layoutFor(testType) {
  return testType === "sat"
    ? { tab: SAT_TAB, header: SAT_HEADER }
    : { tab: IELTS_TAB, header: IELTS_HEADER };
}

/** A1 column letter for a header of length n (10 -> "J", 13 -> "M"). */
function lastColumn(n) {
  return String.fromCharCode(64 + n);
}

let cachedClient = null;

/** Builds (and caches) an authenticated Sheets API client from the service
 * account JSON in GOOGLE_SERVICE_ACCOUNT_JSON (see .env.example). */
function getSheetsClient() {
  if (cachedClient) return cachedClient;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not set — see backend/docs/google-sheets-setup.md"
    );
  }

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON — check it was pasted as one line.");
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  cachedClient = google.sheets({ version: "v4", auth });
  return cachedClient;
}

/** Ensures the "Completed Tests" sheet tab exists, creating it if needed.
 * If the read fails because the tab doesn't exist, creates it and adds the header.
 * If the tab exists but has no header row, adds one. */
async function ensureHeader(sheets, spreadsheetId, tab, header) {
  const range = `${tab}!A1:${lastColumn(header.length)}1`;
  
  let existing;
  try {
    existing = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  } catch (readErr) {
    // Tab likely doesn't exist. Try to create it.
    if (readErr.message?.includes("not found") || readErr.code === 404) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: tab,
                  },
                },
              },
            ],
          },
        });
        // Tab created. Now add the header row.
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range,
          valueInputOption: "RAW",
          requestBody: { values: [header] },
        });
        return; // success
      } catch (createErr) {
        throw new Error(
          `Could not create or read the "${tab}" tab in your spreadsheet. Make sure the spreadsheet ID is correct and the service account has editor access. ${createErr.message}`
        );
      }
    }
    throw new Error(
      `Could not read the "${tab}" tab — make sure it exists in the spreadsheet (exact name, case-sensitive). ${readErr.message}`
    );
  }

  // Tab exists. Check if it has a header row.
  const hasHeader = existing.data.values && existing.data.values.length > 0;
  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [header] },
    });
  }
}

/**
 * Appends one completed-test row.
 * @param {Object} params
 * @param {string} params.spreadsheetId - from the exam's `sheetId` field (docs/exam-json-schema.md)
 * @param {Object} params.row - object keyed by the relevant header's field names (any order)
 * @param {string} [params.testType] - "sat" or "ielts" (default); picks the tab and columns
 * @returns {{ range: string }} the A1 range the row landed in — store this on
 *   the session so the admin dashboard's "Open in Sheet" button can deep-link
 *   straight to it instead of just opening the spreadsheet.
 */
async function appendCompletedTestRow({ spreadsheetId, row, testType }) {
  if (!spreadsheetId) {
    throw new Error("This exam has no sheetId set — add one via PATCH /api/exams/:id before test day.");
  }
  const { tab, header } = layoutFor(testType);
  const sheets = getSheetsClient();
  await ensureHeader(sheets, spreadsheetId, tab, header);

  const values = [header.map((key) => row[key] ?? "")];
  const result = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  return { range: result.data.updates?.updatedRange || null };
}

module.exports = { appendCompletedTestRow };