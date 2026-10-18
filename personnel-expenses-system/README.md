# ExpenseDesk

A browser application for personnel records and expense claims. It uses JavaScript on the server and in the browser. SQLite remains the local account/session store and cache; when Google Sheets is configured, personnel and expense records are synchronized with a Google spreadsheet.

## Start

1. Install Node.js 22.5 or newer.
2. In this folder, run `npm start`. Node watch mode restarts the server after server-code changes, and the open browser refreshes after UI file changes.
3. Open [http://127.0.0.1:3000](http://127.0.0.1:3000).
4. On first launch, create the administrator account. Usernames must be 3–40 letters, numbers, dots, underscores, or hyphens. Passwords have no length limit.

The database is created at `data/personnel-expenses.sqlite` on first launch. It is not deleted or replaced when Google Sheets is connected. Set `DATA_DIR` to store it elsewhere, or set `PORT` to use another port. The server listens on `0.0.0.0` so it can accept connections on available network interfaces.

## Google Sheets setup (optional)

1. Create a Google Cloud project, enable the Google Sheets API, and create a service account with a JSON key.
2. Create a Google spreadsheet and share it with the service account's `client_email`, granting Editor access.
3. Copy `.env.example` to `.env` and set `GOOGLE_SHEETS_ID` to the ID between `/d/` and `/edit` in the spreadsheet URL.
4. Save the service-account JSON key as `data/google-service-account.json` (or set `GOOGLE_SERVICE_ACCOUNT_FILE` in `.env` to its path). Keep this private key secret.
5. Restart ExpenseDesk. It creates `Personnel` and `Expenses` tabs if needed. On first connection, existing SQLite personnel and expense records are merged with the spreadsheet by record ID and copied to both stores. Later startup syncs load the spreadsheet into SQLite; changes made through ExpenseDesk are written back to Sheets.

User accounts, password hashes, and login sessions remain in SQLite. The service account needs Editor access to the spreadsheet. The integration replaces sheet tab contents during synchronization; do not edit these tabs manually while ExpenseDesk is running. Keep backups of both the SQLite file and spreadsheet. Without `GOOGLE_SHEETS_ID`, ExpenseDesk continues to use SQLite only. See `.env.example` for the configuration names.

## Features

- Administrator and user accounts with salted scrypt password hashes and eight-hour, HTTP-only sign-in sessions persisted in SQLite so server restarts do not sign users out.
- Administrators can change an account password; the new password can be shown or hidden while entering it. Saved passwords remain hashed and cannot be viewed.
- First-run setup creates one administrator; only administrators can create additional accounts.
- Every account created by an administrator creates its linked personnel profile automatically from the username. The administrator account list combines account and personnel details.
- Expense records with categories, dates, amounts, descriptions, and pending/approved/rejected/paid workflow.
- Monthly dashboard, search, and CSV export.

The app is intended for a single organization on a trusted server. Protect the local database and service-account key with normal operating-system account permissions and back them up regularly.
