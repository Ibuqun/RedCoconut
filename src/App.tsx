import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import * as XLSX from 'xlsx'
import { toast } from 'sonner'

type SqlDialect = 'mysql' | 'postgresql' | 'sqlite' | 'sqlserver'

type ColumnConfig = {
  sourceIndex: number
  sourceName: string
  targetName: string
  include: boolean
}

type ExtraColumnMode = 'text' | 'number' | 'boolean' | 'null' | 'sql'

type ExtraColumnConfig = {
  id: string
  targetName: string
  include: boolean
  mode: ExtraColumnMode
  value: string
}

type ParsedWorkbook = {
  fileName: string
  sheets: Record<string, unknown[][]>
}

type GeneratorOptions = {
  dialect: SqlDialect
  tableName: string
  schemaName: string
  rowsPerInsert: number
  includeColumnList: boolean
  trimStrings: boolean
  emptyStringAsNull: boolean
  nullTokens: string[]
}

const DIALECTS: Array<{ value: SqlDialect; label: string }> = [
  { value: 'mysql', label: 'MySQL / MariaDB' },
  { value: 'postgresql', label: 'PostgreSQL' },
  { value: 'sqlite', label: 'SQLite' },
  { value: 'sqlserver', label: 'SQL Server' },
]

const defaultOptions: GeneratorOptions = {
  dialect: 'mysql',
  tableName: 'my_table',
  schemaName: '',
  rowsPerInsert: 250,
  includeColumnList: true,
  trimStrings: true,
  emptyStringAsNull: true,
  nullTokens: ['null', 'nil', 'n/a'],
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

function normalizeIdentifier(value: string): string {
  return value.trim().replace(/\s+/g, '_')
}

function quoteIdentifier(identifier: string, dialect: SqlDialect): string {
  const value = normalizeIdentifier(identifier)
  if (!value) {
    return ''
  }

  if (dialect === 'mysql' || dialect === 'sqlite') {
    return `\`${value.replaceAll('`', '``')}\``
  }
  if (dialect === 'sqlserver') {
    return `[${value.replaceAll(']', ']]')}]`
  }
  return `"${value.replaceAll('"', '""')}"`
}

function defaultTimestampExpression(dialect: SqlDialect): string {
  if (dialect === 'mysql') {
    return 'NOW()'
  }
  if (dialect === 'postgresql') {
    return 'NOW()'
  }
  if (dialect === 'sqlite') {
    return 'CURRENT_TIMESTAMP'
  }
  return 'SYSDATETIME()'
}

function toSqlLiteral(value: unknown, options: GeneratorOptions): string {
  if (value === null || value === undefined) {
    return 'NULL'
  }

  if (value instanceof Date) {
    return `'${value.toISOString().replace('T', ' ').slice(0, 19)}'`
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL'
  }

  if (typeof value === 'boolean') {
    if (options.dialect === 'postgresql') {
      return value ? 'TRUE' : 'FALSE'
    }
    return value ? '1' : '0'
  }

  let stringValue = String(value)

  if (options.trimStrings) {
    stringValue = stringValue.trim()
  }

  if (options.emptyStringAsNull && stringValue.length === 0) {
    return 'NULL'
  }

  const lower = stringValue.toLowerCase()
  if (options.nullTokens.some((token) => token === lower)) {
    return 'NULL'
  }

  return `'${stringValue.replaceAll("'", "''")}'`
}

function extraValueToSql(column: ExtraColumnConfig, options: GeneratorOptions): string {
  if (column.mode === 'null') {
    return 'NULL'
  }

  if (column.mode === 'sql') {
    const expression = column.value.trim()
    return expression.length > 0 ? expression : 'NULL'
  }

  if (column.mode === 'number') {
    const numeric = Number(column.value)
    return Number.isFinite(numeric) ? String(numeric) : 'NULL'
  }

  if (column.mode === 'boolean') {
    const truthy = ['true', '1', 'yes', 'y', 'on']
    const value = column.value.trim().toLowerCase()
    const boolValue = truthy.includes(value)
    if (options.dialect === 'postgresql') {
      return boolValue ? 'TRUE' : 'FALSE'
    }
    return boolValue ? '1' : '0'
  }

  return toSqlLiteral(column.value, options)
}

function buildInsertScript(
  rows: unknown[][],
  columns: ColumnConfig[],
  extraColumns: ExtraColumnConfig[],
  options: GeneratorOptions,
): string {
  const cleanTable = normalizeIdentifier(options.tableName)
  if (!cleanTable) {
    return ''
  }

  const includedColumns = columns.filter(
    (column) => column.include && normalizeIdentifier(column.targetName).length > 0,
  )

  const includedExtraColumns = extraColumns.filter(
    (column) => column.include && normalizeIdentifier(column.targetName).length > 0,
  )
  if (includedColumns.length === 0 && includedExtraColumns.length === 0) {
    return ''
  }

  const filteredRows = rows.filter((row) => row.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== ''))
  if (filteredRows.length === 0) {
    return ''
  }

  const schema = normalizeIdentifier(options.schemaName)
  const tableRef = schema
    ? `${quoteIdentifier(schema, options.dialect)}.${quoteIdentifier(cleanTable, options.dialect)}`
    : quoteIdentifier(cleanTable, options.dialect)

  const mappedColumns = includedColumns.map((column) => quoteIdentifier(column.targetName, options.dialect))
  const customColumns = includedExtraColumns.map((column) => quoteIdentifier(column.targetName, options.dialect))
  const columnList = [...mappedColumns, ...customColumns].join(', ')
  const rowValues = filteredRows.map((row) => {
    const sourceValues = includedColumns.map((column) => toSqlLiteral(row[column.sourceIndex], options))
    const extraValues = includedExtraColumns.map((column) => extraValueToSql(column, options))
    const values = [...sourceValues, ...extraValues]
    return `(${values.join(', ')})`
  })

  const chunks = chunkArray(rowValues, Math.max(1, options.rowsPerInsert))

  const statements = chunks.map((chunk) => {
    const useColumnList = options.includeColumnList || includedExtraColumns.length > 0
    if (useColumnList) {
      return `INSERT INTO ${tableRef} (${columnList})\nVALUES\n${chunk.join(',\n')};`
    }
    return `INSERT INTO ${tableRef}\nVALUES\n${chunk.join(',\n')};`
  })

  return [
    `-- Generated by RedCoconut SQL Builder`,
    `-- Dialect: ${options.dialect}`,
    `-- Rows: ${filteredRows.length}`,
    '',
    statements.join('\n\n'),
  ].join('\n')
}

function inferColumns(rows: unknown[][], hasHeaderRow: boolean): ColumnConfig[] {
  const header = hasHeaderRow ? rows[0] ?? [] : []
  const maxColumns = rows.reduce((max, row) => Math.max(max, row.length), header.length)

  return Array.from({ length: maxColumns }, (_, index) => {
    const raw = hasHeaderRow ? header[index] : undefined
    const sourceName = raw !== undefined && raw !== null && String(raw).trim() !== ''
      ? String(raw).trim()
      : `column_${index + 1}`

    return {
      sourceIndex: index,
      sourceName,
      targetName: normalizeIdentifier(sourceName),
      include: true,
    }
  })
}

function App() {
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null)
  const [selectedSheet, setSelectedSheet] = useState<string>('')
  const [hasHeaderRow, setHasHeaderRow] = useState<boolean>(true)
  const [columns, setColumns] = useState<ColumnConfig[]>([])
  const [extraColumns, setExtraColumns] = useState<ExtraColumnConfig[]>([])
  const [options, setOptions] = useState<GeneratorOptions>(defaultOptions)
  const [timestampExpression, setTimestampExpression] = useState<string>(
    defaultTimestampExpression(defaultOptions.dialect),
  )
  const [timestampColumnNames, setTimestampColumnNames] = useState<string>('created_at, updated_at')

  const activeRows = useMemo(() => {
    if (!workbook || !selectedSheet) {
      return []
    }
    return workbook.sheets[selectedSheet] ?? []
  }, [workbook, selectedSheet])

  const dataRows = useMemo(() => {
    if (activeRows.length === 0) {
      return []
    }
    return hasHeaderRow ? activeRows.slice(1) : activeRows
  }, [activeRows, hasHeaderRow])

  const generatedSql = useMemo(
    () => buildInsertScript(dataRows, columns, extraColumns, options),
    [dataRows, columns, extraColumns, options],
  )

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const arrayBuffer = await file.arrayBuffer()
      const parsed = XLSX.read(arrayBuffer, { type: 'array', cellDates: true })

      const sheets: Record<string, unknown[][]> = {}
      for (const sheetName of parsed.SheetNames) {
        const worksheet = parsed.Sheets[sheetName]
        const rows = XLSX.utils.sheet_to_json(worksheet, {
          header: 1,
          defval: null,
          raw: true,
          blankrows: false,
        }) as unknown[][]
        sheets[sheetName] = rows
      }

      const firstSheet = parsed.SheetNames[0] ?? ''
      setWorkbook({ fileName: file.name, sheets })
      setSelectedSheet(firstSheet)

      const firstRows = sheets[firstSheet] ?? []
      setColumns(inferColumns(firstRows, hasHeaderRow))

      const defaultTableName = normalizeIdentifier(file.name.replace(/\.[^.]+$/, '')) || 'my_table'
      setOptions((prev) => ({ ...prev, tableName: defaultTableName }))

      toast.success('Workbook loaded in-browser')
    } catch {
      toast.error('Unable to read that file. Try .xlsx, .xls, or .csv.')
    }
  }

  const handleSheetChange = (sheetName: string) => {
    setSelectedSheet(sheetName)
    const rows = workbook?.sheets[sheetName] ?? []
    setColumns(inferColumns(rows, hasHeaderRow))
  }

  const handleHeaderToggle = (enabled: boolean) => {
    setHasHeaderRow(enabled)
    setColumns(inferColumns(activeRows, enabled))
  }

  const handleDialectChange = (dialect: SqlDialect) => {
    const oldDefault = defaultTimestampExpression(options.dialect)
    const nextDefault = defaultTimestampExpression(dialect)
    if (timestampExpression.trim() === '' || timestampExpression === oldDefault) {
      setTimestampExpression(nextDefault)
    }
    setOptions((prev) => ({ ...prev, dialect }))
  }

  const updateColumn = (index: number, patch: Partial<ColumnConfig>) => {
    setColumns((prev) => prev.map((column, idx) => (idx === index ? { ...column, ...patch } : column)))
  }

  const addExtraColumn = () => {
    setExtraColumns((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        targetName: `extra_column_${prev.length + 1}`,
        include: true,
        mode: 'text',
        value: '',
      },
    ])
  }

  const updateExtraColumn = (id: string, patch: Partial<ExtraColumnConfig>) => {
    setExtraColumns((prev) => prev.map((column) => (column.id === id ? { ...column, ...patch } : column)))
  }

  const removeExtraColumn = (id: string) => {
    setExtraColumns((prev) => prev.filter((column) => column.id !== id))
  }

  const upsertExtraColumn = (targetName: string, mode: ExtraColumnMode, value: string) => {
    setExtraColumns((prev) => {
      const normalized = normalizeIdentifier(targetName).toLowerCase()
      const existingIndex = prev.findIndex(
        (column) => normalizeIdentifier(column.targetName).toLowerCase() === normalized,
      )

      const nextColumn: ExtraColumnConfig = {
        id: existingIndex >= 0 ? prev[existingIndex].id : crypto.randomUUID(),
        targetName,
        include: true,
        mode,
        value,
      }

      if (existingIndex >= 0) {
        return prev.map((column, index) => (index === existingIndex ? nextColumn : column))
      }
      return [...prev, nextColumn]
    })
  }

  const applyTimestampDefaults = () => {
    const columnNames = timestampColumnNames
      .split(',')
      .map((column) => column.trim())
      .filter(Boolean)

    if (columnNames.length === 0) {
      toast.error('Add at least one timestamp column name')
      return
    }

    const expression = timestampExpression.trim() || defaultTimestampExpression(options.dialect)
    for (const columnName of columnNames) {
      upsertExtraColumn(columnName, 'sql', expression)
    }

    toast.success('Timestamp defaults applied to ' + columnNames.length + ' column' + (columnNames.length === 1 ? '' : 's'))
  }

  const handleCopy = async () => {
    if (!generatedSql) {
      toast.error('No SQL generated yet')
      return
    }

    try {
      await navigator.clipboard.writeText(generatedSql)
      toast.success('SQL copied to clipboard')
    } catch {
      toast.error('Clipboard blocked. Use download instead.')
    }
  }

  const handleDownload = () => {
    if (!generatedSql) {
      toast.error('No SQL generated yet')
      return
    }

    const blob = new Blob([generatedSql], { type: 'text/sql;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${normalizeIdentifier(options.tableName) || 'insert_script'}.sql`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    toast.success('SQL file downloaded')
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_12%_8%,_#6a1e23,_transparent_38%),radial-gradient(circle_at_88%_12%,_#3d1418,_transparent_30%),linear-gradient(180deg,_#12090a_0%,_#090506_56%,_#070405_100%)] text-[var(--text-primary)]">
      <div className="mx-auto w-full max-w-7xl px-5 py-10 md:px-8">
        <header className="mb-8 animate-slide-reveal">
          <p className="mb-2 text-xs uppercase tracking-[0.2em] text-[var(--accent)]">RedCoconut • Local-Only SQL Builder</p>
          <h1 className="font-[var(--font-display)] text-4xl leading-tight md:text-6xl">Excel to INSERT Scripts, Browser Native</h1>
          <p className="mt-4 max-w-3xl text-sm text-[var(--text-secondary)] md:text-base">
            Upload a spreadsheet, map columns, choose your SQL dialect, and generate INSERT statements. Data stays in your browser;
            no uploads, no storage, no tracking.
          </p>
        </header>

        <section className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
          <div className="space-y-5">
            <article className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
              <label className="mb-2 block text-sm font-medium">Excel File</label>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileUpload}
                className="block w-full rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-elevated)] px-4 py-3 text-sm"
              />
              <p className="mt-2 text-xs text-[var(--text-tertiary)]">Supported: .xlsx, .xls, .csv. Processing is local-only.</p>
              {workbook ? (
                <p className="mt-3 text-sm text-[var(--accent-green)]">Loaded: {workbook.fileName}</p>
              ) : null}
            </article>

            <article className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5">
              <h2 className="mb-4 text-lg font-semibold">Mapping & Options</h2>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block text-[var(--text-secondary)]">SQL Dialect</span>
                  <select
                    value={options.dialect}
                    onChange={(event) => handleDialectChange(event.target.value as SqlDialect)}
                    className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2"
                  >
                    {DIALECTS.map((dialect) => (
                      <option key={dialect.value} value={dialect.value}>{dialect.label}</option>
                    ))}
                  </select>
                </label>

                <label className="text-sm">
                  <span className="mb-1 block text-[var(--text-secondary)]">Sheet</span>
                  <select
                    value={selectedSheet}
                    onChange={(event) => handleSheetChange(event.target.value)}
                    disabled={!workbook}
                    className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 disabled:opacity-60"
                  >
                    {Object.keys(workbook?.sheets ?? {}).map((sheet) => (
                      <option key={sheet} value={sheet}>{sheet}</option>
                    ))}
                  </select>
                </label>

                <label className="text-sm">
                  <span className="mb-1 block text-[var(--text-secondary)]">Schema (optional)</span>
                  <input
                    value={options.schemaName}
                    onChange={(event) => setOptions((prev) => ({ ...prev, schemaName: event.target.value }))}
                    className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2"
                    placeholder="public"
                  />
                </label>

                <label className="text-sm">
                  <span className="mb-1 block text-[var(--text-secondary)]">Table Name</span>
                  <input
                    value={options.tableName}
                    onChange={(event) => setOptions((prev) => ({ ...prev, tableName: event.target.value }))}
                    className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2"
                    placeholder="my_table"
                  />
                </label>

                <label className="text-sm">
                  <span className="mb-1 block text-[var(--text-secondary)]">Rows Per INSERT</span>
                  <input
                    type="number"
                    min={1}
                    value={options.rowsPerInsert}
                    onChange={(event) => setOptions((prev) => ({ ...prev, rowsPerInsert: Number(event.target.value) || 1 }))}
                    className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2"
                  />
                </label>

                <label className="text-sm">
                  <span className="mb-1 block text-[var(--text-secondary)]">NULL tokens (comma-separated)</span>
                  <input
                    value={options.nullTokens.join(', ')}
                    onChange={(event) => {
                      const tokens = event.target.value
                        .split(',')
                        .map((token) => token.trim().toLowerCase())
                        .filter(Boolean)
                      setOptions((prev) => ({ ...prev, nullTokens: tokens }))
                    }}
                    className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2"
                  />
                </label>
              </div>

              <div className="mt-4 flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={hasHeaderRow}
                    onChange={(event) => handleHeaderToggle(event.target.checked)}
                  />
                  First row is header
                </label>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={options.includeColumnList}
                    onChange={(event) => setOptions((prev) => ({ ...prev, includeColumnList: event.target.checked }))}
                  />
                  Include column list
                </label>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={options.trimStrings}
                    onChange={(event) => setOptions((prev) => ({ ...prev, trimStrings: event.target.checked }))}
                  />
                  Trim strings
                </label>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={options.emptyStringAsNull}
                    onChange={(event) => setOptions((prev) => ({ ...prev, emptyStringAsNull: event.target.checked }))}
                  />
                  Empty string -&gt; NULL
                </label>
              </div>
            </article>

            <article className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5">
              <h2 className="mb-4 text-lg font-semibold">Timestamp Defaults</h2>
              <p className="mb-3 text-xs text-[var(--text-tertiary)]">
                Quickly apply SQL expressions for time columns like created_at and updated_at.
              </p>
              <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                <label className="text-sm">
                  <span className="mb-1 block text-[var(--text-secondary)]">Timestamp SQL Expression</span>
                  <input
                    value={timestampExpression}
                    onChange={(event) => setTimestampExpression(event.target.value)}
                    className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2"
                    placeholder={defaultTimestampExpression(options.dialect)}
                  />
                </label>

                <button
                  type="button"
                  onClick={applyTimestampDefaults}
                  className="rounded-lg border border-[var(--accent)] bg-[var(--accent-dim)] px-4 py-2 text-sm text-[var(--accent)] hover:bg-[var(--accent-glow)]"
                >
                  Apply to columns
                </button>
              </div>

              <label className="mt-3 block text-sm">
                <span className="mb-1 block text-[var(--text-secondary)]">Timestamp Column Names (comma-separated)</span>
                <input
                  value={timestampColumnNames}
                  onChange={(event) => setTimestampColumnNames(event.target.value)}
                  className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2"
                  placeholder="created_at, updated_at"
                />
              </label>
            </article>

            <article className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5">
              <h2 className="mb-4 text-lg font-semibold">Column Mapping</h2>
              <div className="max-h-80 overflow-auto rounded-lg border border-[var(--border-subtle)]">
                <table className="w-full border-collapse text-sm">
                  <thead className="sticky top-0 bg-[var(--bg-elevated)] text-left">
                    <tr>
                      <th className="px-3 py-2">Use</th>
                      <th className="px-3 py-2">Source</th>
                      <th className="px-3 py-2">Target Column</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((column, index) => (
                      <tr key={`${column.sourceName}-${index}`} className="border-t border-[var(--border-subtle)]">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={column.include}
                            onChange={(event) => updateColumn(index, { include: event.target.checked })}
                          />
                        </td>
                        <td className="px-3 py-2 text-[var(--text-secondary)]">{column.sourceName}</td>
                        <td className="px-3 py-2">
                          <input
                            value={column.targetName}
                            onChange={(event) => updateColumn(index, { targetName: event.target.value })}
                            className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1"
                          />
                        </td>
                      </tr>
                    ))}
                    {columns.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="px-3 py-6 text-center text-[var(--text-tertiary)]">Upload a file to configure mappings.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Additional Table Columns</h2>
                <button
                  type="button"
                  onClick={addExtraColumn}
                  className="rounded-lg border border-[var(--accent)] bg-[var(--accent-dim)] px-3 py-1.5 text-xs text-[var(--accent)] hover:bg-[var(--accent-glow)]"
                >
                  Add column
                </button>
              </div>

              <p className="mb-3 text-xs text-[var(--text-tertiary)]">
                Use this for table columns not present in your file. Values apply to every generated row.
              </p>

              <div className="space-y-3">
                {extraColumns.map((column) => (
                  <div
                    key={column.id}
                    className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-3"
                  >
                    <div className="grid gap-2 md:grid-cols-[auto_1fr_160px_1fr_auto] md:items-center">
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={column.include}
                          onChange={(event) => updateExtraColumn(column.id, { include: event.target.checked })}
                        />
                        Use
                      </label>

                      <input
                        value={column.targetName}
                        onChange={(event) => updateExtraColumn(column.id, { targetName: event.target.value })}
                        className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-sm"
                        placeholder="target_column_name"
                      />

                      <select
                        value={column.mode}
                        onChange={(event) => updateExtraColumn(column.id, { mode: event.target.value as ExtraColumnMode })}
                        className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-sm"
                      >
                        <option value="text">Text</option>
                        <option value="number">Number</option>
                        <option value="boolean">Boolean</option>
                        <option value="null">NULL</option>
                        <option value="sql">SQL Expr</option>
                      </select>

                      <input
                        value={column.value}
                        onChange={(event) => updateExtraColumn(column.id, { value: event.target.value })}
                        disabled={column.mode === 'null'}
                        className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-sm disabled:opacity-60"
                        placeholder={column.mode === 'sql' ? 'NOW()' : column.mode === 'boolean' ? 'true' : 'value'}
                      />

                      <button
                        type="button"
                        onClick={() => removeExtraColumn(column.id)}
                        className="rounded-md border border-[var(--border-default)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}

                {extraColumns.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-[var(--border-subtle)] px-3 py-4 text-center text-xs text-[var(--text-tertiary)]">
                    No additional columns yet. Click Add column.
                  </p>
                ) : null}
              </div>
            </article>
          </div>

          <aside className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 shadow-[0_20px_55px_rgba(0,0,0,0.28)]">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Generated SQL</h2>
              <span className="text-xs text-[var(--text-tertiary)]">Rows: {dataRows.length}</span>
            </div>

            <div className="mb-4 flex gap-2">
              <button
                onClick={handleCopy}
                className="rounded-lg border border-[var(--accent)] bg-[var(--accent-dim)] px-3 py-2 text-sm text-[var(--accent)] hover:bg-[var(--accent-glow)]"
              >
                Copy
              </button>
              <button
                onClick={handleDownload}
                className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm hover:bg-[var(--bg-hover)]"
              >
                Download .sql
              </button>
            </div>

            <textarea
              readOnly
              value={generatedSql || '-- Your INSERT script will appear here.'}
              className="min-h-[560px] w-full resize-y rounded-xl border border-[var(--border-default)] bg-[#0a0405] p-3 text-xs leading-relaxed text-[#ffded0]"
            />
          </aside>
        </section>
      </div>
    </main>
  )
}

export default App
