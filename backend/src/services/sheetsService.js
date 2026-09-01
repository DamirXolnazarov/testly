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

const SHEET_TAB = "Completed Tests"; // the tab name rows get appended to
const HEADER_ROW = [
  "student_name", "exam_id", "exam_title", "date",
  "reading_raw", "reading_band", "listening_raw", "listening_band",
  "writing_task1_band", "writing_task2_band", "speaking_band", "overall_band", "status",
];

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
async function ensureHeader(sheets, spreadsheetId) {
  const range = `${SHEET_TAB}!A1:M1`;
  
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
                    title: SHEET_TAB,
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
          requestBody: { values: [HEADER_ROW] },
        });
        return; // success
      } catch (createErr) {
        throw new Error(
          `Could not create or read the "${SHEET_TAB}" tab in your spreadsheet. Make sure the spreadsheet ID is correct and the service account has editor access. ${createErr.message}`
        );
      }
    }
    throw new Error(
      `Could not read the "${SHEET_TAB}" tab — make sure it exists in the spreadsheet (exact name, case-sensitive). ${readErr.message}`
    );
  }

  // Tab exists. Check if it has a header row.
  const hasHeader = existing.data.values && existing.data.values.length > 0;
  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER_ROW] },
    });
  }
}

/**
 * Appends one completed-test row.
 * @param {Object} params
 * @param {string} params.spreadsheetId - from the exam's `sheetId` field (docs/exam-json-schema.md)
 * @param {Object} params.row - matches HEADER_ROW's field order (object keys, any order — mapped below)
 * @returns {{ range: string }} the A1 range the row landed in — store this on
 *   the session so the admin dashboard's "Open in Sheet" button can deep-link
 *   straight to it instead of just opening the spreadsheet.
 */
async function appendCompletedTestRow({ spreadsheetId, row }) {
  if (!spreadsheetId) {
    throw new Error("This exam has no sheetId set — add one via PATCH /api/exams/:id before test day.");
  }
  const sheets = getSheetsClient();
  await ensureHeader(sheets, spreadsheetId);

  const values = [HEADER_ROW.map((key) => row[key] ?? "")];
  const result = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  return { range: result.data.updates?.updatedRange || null };
}

module.exports = { appendCompletedTestRow };