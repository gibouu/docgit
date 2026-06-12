import { useCallback, useEffect, useState } from 'react';
import type { DocumentSummary, LinkableOccurrence, ValueFormat } from '@docgit/core';
import { formatValue } from '@docgit/core/format';
import type { LinkInfo } from '../../../preload/api';
import { Modal } from '../components/Modal.js';

/**
 * Live linked values: numbers in this document bound to workbook cells.
 * When a linked workbook gets a new version, values here update on their own
 * and the update is itself a version.
 */
export function LinksSection({ documentId }: { documentId: string }) {
  const [links, setLinks] = useState<LinkInfo[]>([]);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLinks(await window.docgit.listLinks(documentId));
  }, [documentId]);

  useEffect(() => {
    void load();
    return window.docgit.onChanged((id) => {
      if (id === documentId) void load();
    });
  }, [documentId, load]);

  const anyStale = links.some((l) => l.stale);

  return (
    <div className="links-section">
      <div className="links-head">
        <h2>Linked values</h2>
        <span className="links-tools">
          {anyStale && (
            <button type="button" className="btn btn-mini" onClick={() => void window.docgit.refreshLinks(documentId)}>
              Refresh now
            </button>
          )}
          <button type="button" className="btn btn-mini" onClick={() => setShowAdd(true)}>
            + Link a value
          </button>
        </span>
      </div>

      {links.length === 0 ? (
        <p className="links-empty">
          Bind a number in this document to an Excel cell — when the workbook changes, the document follows, and every
          update is a version.
        </p>
      ) : (
        <ul className="links-list">
          {links.map(({ link, sourceName, stale }) => (
            <li key={link.id}>
              <span className="links-ref">
                {link.sheet}!{link.cellRef}
              </span>
              <span className="links-value">{link.lastValue}</span>
              <span className="links-source">← {sourceName}</span>
              {stale && <span className="links-stale">needs refresh</span>}
              <button
                type="button"
                className="btn btn-mini"
                title="Stop tracking this value — the text stays in the document"
                onClick={() => void window.docgit.deleteLink(documentId, link.id)}
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}

      {showAdd && <AddLinkDialog documentId={documentId} onClose={() => setShowAdd(false)} />}
    </div>
  );
}

const LOCALES = [
  { id: 'en-US', label: 'English (1,200,000.50)' },
  { id: 'fr-FR', label: 'Français (1 200 000,50)' },
];
const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'];

function AddLinkDialog({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const [workbooks, setWorkbooks] = useState<DocumentSummary[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState('');
  const [cellRef, setCellRef] = useState('');
  const [cell, setCell] = useState<{ value: string; formula?: string } | null>(null);
  const [style, setStyle] = useState<ValueFormat['style']>('raw');
  const [locale, setLocale] = useState('fr-FR');
  const [currency, setCurrency] = useState('EUR');
  const [compact, setCompact] = useState(false);
  const [search, setSearch] = useState('');
  const [occurrences, setOccurrences] = useState<LinkableOccurrence[] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void window.docgit.listWorkbooks().then((list) => {
      setWorkbooks(list);
      if (list.length === 1) setSourceId(list[0]!.id);
    });
  }, []);

  useEffect(() => {
    if (!sourceId) return;
    void window.docgit.workbookSheets(sourceId).then((names) => {
      setSheets(names);
      setSheet((prev) => (names.includes(prev) ? prev : (names[0] ?? '')));
    });
  }, [sourceId]);

  useEffect(() => {
    setCell(null);
    if (!sourceId || !sheet || !/^[A-Za-z]+\d+$/.test(cellRef)) return;
    const handle = setTimeout(() => {
      void window.docgit.workbookCell(sourceId, sheet, cellRef).then(setCell);
    }, 250);
    return () => clearTimeout(handle);
  }, [sourceId, sheet, cellRef]);

  const format: ValueFormat = {
    style,
    ...(style !== 'raw' ? { locale } : {}),
    ...(style === 'currency' ? { currency } : {}),
    ...(compact && style !== 'raw' ? { compact: true } : {}),
  };
  const preview = cell ? formatValue(cell.value, format) : '';

  const find = async () => {
    setError('');
    setPicked(null);
    setOccurrences(await window.docgit.findOccurrences(documentId, search));
  };

  const create = async () => {
    if (picked === null) return;
    setError('');
    try {
      await window.docgit.createLink(documentId, {
        sourceDocumentId: sourceId,
        sheet,
        cellRef: cellRef.toUpperCase(),
        format,
        search,
        occurrence: picked,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^.*Error[^:]*:\s*/, '') : String(err));
    }
  };

  return (
    <Modal title="Link a value to a workbook cell" onClose={onClose}>
      {workbooks.length === 0 ? (
        <p className="modal-hint">No workbooks tracked yet — add an .xlsx to DocGit first.</p>
      ) : (
        <div className="linkwizard">
          <label className="linkwizard-row">
            <span>Workbook</span>
            <select className="input" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="" disabled>
                Choose…
              </option>
              {workbooks.map((wb) => (
                <option key={wb.id} value={wb.id}>
                  {wb.name}
                </option>
              ))}
            </select>
          </label>

          <div className="linkwizard-pair">
            <label className="linkwizard-row">
              <span>Sheet</span>
              <select className="input" value={sheet} onChange={(e) => setSheet(e.target.value)} disabled={!sourceId}>
                {sheets.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="linkwizard-row">
              <span>Cell</span>
              <input
                className="input"
                placeholder="B14"
                value={cellRef}
                onChange={(e) => setCellRef(e.target.value.trim())}
              />
            </label>
          </div>

          {cell && (
            <p className="linkwizard-cell">
              Current value: <strong>{cell.value}</strong>
              {cell.formula && <code> {cell.formula}</code>}
            </p>
          )}

          <div className="linkwizard-pair">
            <label className="linkwizard-row">
              <span>Show as</span>
              <select className="input" value={style} onChange={(e) => setStyle(e.target.value as ValueFormat['style'])}>
                <option value="raw">As-is</option>
                <option value="number">Number</option>
                <option value="currency">Currency</option>
                <option value="percent">Percentage</option>
              </select>
            </label>
            {style !== 'raw' && (
              <label className="linkwizard-row">
                <span>Locale</span>
                <select className="input" value={locale} onChange={(e) => setLocale(e.target.value)}>
                  {LOCALES.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {style === 'currency' && (
            <div className="linkwizard-pair">
              <label className="linkwizard-row">
                <span>Currency</span>
                <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {CURRENCIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="linkwizard-check">
                <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} />
                Compact (1.2M)
              </label>
            </div>
          )}

          {cell && (
            <p className="linkwizard-preview">
              Will appear as: <strong>{preview}</strong>
            </p>
          )}

          <label className="linkwizard-row">
            <span>Text to replace in the document</span>
            <span className="linkwizard-find">
              <input
                className="input"
                placeholder="e.g. 1200000 — the exact text currently in the document"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && search) void find();
                }}
              />
              <button type="button" className="btn" disabled={!search} onClick={() => void find()}>
                Find
              </button>
            </span>
          </label>

          {occurrences !== null &&
            (occurrences.length === 0 ? (
              <p className="modal-hint">Not found. The text must sit in a single run — try the exact number only.</p>
            ) : (
              <ul className="linkwizard-occurrences">
                {occurrences.map((occ) => (
                  <li key={occ.occurrence}>
                    <label>
                      <input
                        type="radio"
                        name="occurrence"
                        checked={picked === occ.occurrence}
                        onChange={() => setPicked(occ.occurrence)}
                      />
                      <span>…{occ.context}…</span>
                    </label>
                  </li>
                ))}
              </ul>
            ))}

          {error && <p className="linkwizard-error">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={picked === null || !cell}
              onClick={() => void create()}
            >
              Link it
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
