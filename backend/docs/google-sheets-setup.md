# Google Sheets setup (for sheetsService.js)

This gets you the `GOOGLE_SERVICE_ACCOUNT_JSON` value for your `.env` file.
It's a one-time setup, roughly 5 minutes.

## 1. Create a Google Cloud project (or use an existing one)
- Go to https://console.cloud.google.com
- Top-left project dropdown → "New Project" → name it (e.g. "testly") → Create

## 2. Enable the Google Sheets API
- With your project selected, go to https://console.cloud.google.com/apis/library/sheets.googleapis.com
- Click **Enable**

## 3. Create a service account
- Go to https://console.cloud.google.com/iam-admin/serviceaccounts
- Click **Create Service Account**
- Name it anything (e.g. "testly-sheets-writer") → Create and Continue
- Skip the optional "grant access" steps → Done

## 4. Generate its key (this is the secret)
- Click on the service account you just created
- Go to the **Keys** tab → **Add Key** → **Create new key** → choose **JSON** → Create
- A `.json` file downloads automatically — this is the credential. Keep it safe, never commit it to git.

## 5. Put it in your `.env`
Open the downloaded JSON file, and paste its *entire contents as one line* into your `.env`:

```
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"testly-sheets-writer@your-project.iam.gserviceaccount.com",...}
```

The whole JSON object goes on that one line (most editors will let you paste it as-is even though it's long — that's fine).

## 6. Share your Google Sheet with the service account
This is the step people usually miss. The service account is its own "user" —
your spreadsheet needs to be shared with it, exactly like sharing with a
coworker:
- Open the Google Sheet you want results written to
- Click **Share**
- Paste in the service account's email — it's the `client_email` field from
  the JSON, looks like `testly-sheets-writer@your-project.iam.gserviceaccount.com`
- Give it **Editor** access
- Send / Share

## 7. Create the "Completed Tests" tab
`sheetsService.js` writes to a tab literally named **Completed Tests**
(case-sensitive) — add a tab with that exact name at the bottom of your
spreadsheet. The header row (`student_name`, `exam_id`, etc.) is created
automatically on the first write if it's missing.

## 8. Get the spreadsheet ID
This isn't an env var — it's set **per exam**, since different exams might
write to different sheets. It's the long string in the sheet's URL:

```
https://docs.google.com/spreadsheets/d/THIS_LONG_STRING_HERE/edit
```

Set it on an exam via:
```
PATCH /api/exams/:id
{ "sheetId": "THIS_LONG_STRING_HERE" }
```

## Testing it worked
Once `.env` has `GOOGLE_SERVICE_ACCOUNT_JSON` set and an exam has a `sheetId`,
complete a test session end to end — `POST /api/sessions/:id/submit` should
result in a new row appearing in the "Completed Tests" tab. Check your
backend's console output if it doesn't; `sheetsService.js` errors are logged
there (submission still succeeds even if the Sheets write fails, by design —
see routes/sessions.js).