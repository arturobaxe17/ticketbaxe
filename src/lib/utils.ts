export function dateTime(value: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function dateOnly(value: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es-ES', { dateStyle: 'long' }).format(new Date(value));
}

export function toLocalInput(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
}

export function toIso(value: string): string {
  return new Date(value).toISOString();
}

export function downloadCsv(filename: string, rows: Array<Record<string, unknown>>): void {
  const columns = Object.keys(rows[0] ?? { Evento: '', Grupo: '', Nombre: '', Tipo_documento: '', Documento: '', Estado: '' });
  const escape = (value: unknown) => {
    let text = String(value ?? '');
    // Prevent spreadsheet formula injection when CSV is opened in Excel/Sheets.
    if (/^[\s]*[=+@\-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = [columns.map(escape).join(';'), ...rows.map(row => columns.map(column => escape(row[column])).join(';'))].join('\r\n');
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function maskDocument(value: string): string {
  if (!value || value.length < 5) return value || '—';
  return `${value.slice(0, 3)}••••${value.slice(-2)}`;
}
