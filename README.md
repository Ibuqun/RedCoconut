# RedCoconut

RedCoconut is a local-first web app that converts Excel sheets into configurable SQL `INSERT` scripts in your browser.

## Features

- Upload `.xlsx`, `.xls`, or `.csv`
- Choose SQL dialect: MySQL, PostgreSQL, SQLite, SQL Server
- Configure table and schema names
- Rename/map source columns
- Add extra table columns not present in file data
- Set extra column values as text, number, boolean, `NULL`, or raw SQL expressions (for example `NOW()`)
- Apply timestamp defaults for `created_at` and `updated_at` with configurable SQL expression
- Copy generated SQL or download `.sql`

## Local Development

```bash
npm install
npm run dev
```
