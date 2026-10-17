# ExpenseDesk

A local browser application for personnel records and expense claims. It uses JavaScript on the server and in the browser, with SQLite for persistent storage. No package installation is needed; the server uses Node.js built-in modules.

## Start

1. Install Node.js 22.5 or newer.
2. In this folder, run `npm start`. Node watch mode restarts the server after server-code changes, and the open browser refreshes after UI file changes.
3. Open [http://127.0.0.1:3000](http://127.0.0.1:3000).
4. On first launch, create the administrator account. Usernames must be 3–40 letters, numbers, dots, underscores, or hyphens. Passwords have no length limit.

The database is created at `data/personnel-expenses.sqlite` on first launch. Set `DATA_DIR` to store it elsewhere, or set `PORT` to use another port. The server listens on `0.0.0.0` so it can accept connections on available network interfaces.

## Features

- Administrator and user accounts with salted scrypt password hashes and eight-hour, HTTP-only sign-in sessions persisted in SQLite so server restarts do not sign users out.
- Administrators can change an account password; the new password can be shown or hidden while entering it. Saved passwords remain hashed and cannot be viewed.
- First-run setup creates one administrator; only administrators can create additional accounts.
- Every account created by an administrator creates its linked personnel profile automatically from the username. The administrator account list combines account and personnel details.
- Expense records with categories, dates, amounts, descriptions, and pending/approved/rejected/paid workflow.
- Monthly dashboard, search and status filters, and CSV export.

The app is intended for a single organization on a trusted local machine. Sessions are held in server memory and are cleared when the server restarts. Protect the database file with normal operating-system account permissions and back it up regularly.
