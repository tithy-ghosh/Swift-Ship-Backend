/**
 * Minimal RFC 4180 CSV serialisation for the admin data-export endpoints.
 *
 * Two behaviours here exist for Excel rather than for the spec:
 *
 * 1. Formula-injection guard. Excel happily evaluates a cell that opens with
 *    `=`, `+`, `-`, `@`, tab or CR, so an exported user named
 *    `=HYPERLINK(...)` would execute in the admin's spreadsheet. String values
 *    that start with one of those characters get an apostrophe prefix, which
 *    Excel renders as literal text. Numbers and dates never need it.
 *
 * 2. UTF-8 BOM, added by the caller via `csvBody`. Bengali names and addresses
 *    are the norm here, and without the BOM Excel on Windows reads the file as
 *    the local ANSI codepage and mangles them.
 */

/** Characters Excel treats as the start of a formula or a control sequence. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/

/**
 * Escapes one CSV cell.
 *
 * `null`/`undefined` become an empty cell; Dates become ISO strings (a stable,
 * locale-independent format the importer can parse back). Cells containing a
 * quote, comma or newline are wrapped in double quotes with inner quotes
 * doubled, per RFC 4180.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const escapeCsvValue = (value) => {
  if (value === null || value === undefined) return ''

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString()
  }

  let text
  if (typeof value === 'string') {
    text = value
    // Guard strings only: a numeric `-5` is a number to Excel, not a formula.
    if (FORMULA_PREFIX.test(text)) text = `'${text}`
  } else {
    text = String(value)
  }

  if (/[",\r\n]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`
  }

  return text
}

/**
 * Serialises rows to a CSV document.
 *
 * Line endings are CRLF, which RFC 4180 mandates and every spreadsheet app
 * accepts.
 *
 * @param {Array<{key: string, label: string}>} columns
 * @param {Array<Record<string, unknown>>} rows
 * @returns {string}
 */
export const toCsv = (columns, rows) => {
  const lines = [columns.map((column) => escapeCsvValue(column.label)).join(',')]

  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvValue(row[column.key])).join(','))
  }

  return lines.join('\r\n')
}

/**
 * The download body: a BOM so Excel reads the file as UTF-8, then CSV.
 *
 * @param {Array<{key: string, label: string}>} columns
 * @param {Array<Record<string, unknown>>} rows
 * @returns {string}
 */
export const csvBody = (columns, rows) => `\uFEFF${toCsv(columns, rows)}`

/**
 * A stable download filename, dated in Dhaka time so the admin's "today"
 * matches the data they just exported.
 *
 * @param {string} resource e.g. 'users'
 * @param {Date} [now]
 * @returns {string} e.g. 'swift-ship-users-2026-10-17.csv'
 */
export const csvFilename = (resource, now = new Date()) => {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)

  return `swift-ship-${resource}-${date}.csv`
}
