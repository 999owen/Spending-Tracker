# How data storage works

There is no server and no database. All of the tracker's data lives in **one JSON
document**, stored in the browser's `localStorage` under a single key:

```
owens_tracker_data
```

Treat that key as a single JSON file on disk. Every operation reads or writes the
whole document — nothing ever writes a partial record, so what is stored is always
a complete, valid document.

## The document

```json
{
  "schema_version": 2,
  "last_updated": "2026-08-09T06:15:00.000Z",
  "settings": {
    "spending_percentage": 35,
    "weekly_grocery_limit": 75,
    "currency": "USD"
  },
  "income_entries": [
    { "id": "3f2b…", "date": "2026-08-01", "amount": 467.75, "notes": "Week 1" }
  ],
  "spend_entries":   [],
  "grocery_entries": []
}
```

| Field | Meaning |
| --- | --- |
| `schema_version` | Format version. Older documents are upgraded once, on load. |
| `last_updated` | ISO timestamp, rewritten on every save. |
| `settings.spending_percentage` | Share of income treated as spending money. 1–100. |
| `settings.weekly_grocery_limit` | The grocery chart's limit line. Must be positive. |
| `settings.currency` | `USD`, `EUR` or `GBP`. Anything else falls back to `USD`. |
| `*_entries` | The three lists. Same shape in each. |

### Entry rules

| Field | Rule |
| --- | --- |
| `id` | Stable and unique. Generated on creation, preserved through export/import. |
| `date` | `YYYY-MM-DD`, and a real calendar date. `2026-02-31` is rejected. |
| `amount` | A number greater than zero, rounded to cents. |
| `notes` | A string. May be empty. |

Reading is forgiving, writing is strict. Anything failing these rules is dropped
on the way in and counted, rather than being stored as `$0.00`.

## Operations

All of these are on `TrackerStore`, defined in [`store.js`](store.js).

| Call | What it does |
| --- | --- |
| `read()` | Parse the document and return it. Unreadable or corrupt data returns an empty document instead of breaking the page. |
| `write(doc)` | Serialise the whole document back over the key. |
| `clear()` | **Delete the key outright.** Nothing is left behind. |
| `replaceFromJSON(text)` | **Replace** the document with an imported one. |
| `exportToFile()` | Download the document verbatim as `owens-tracker-backup-YYYY-MM-DD.json`. |
| `addEntry(type, entry)` | Validate, then read → append → write. |
| `removeEntry(type, id)` | Read → remove by id → write. |
| `updateSetting(key, value)` | Read → validate → write. |
| `summary(doc)` | Every total the dashboard shows. The single source for them. |
| `sortedEntries(doc, type)` | Newest first. The ordering all three listings use. |
| `subscribe(fn)` | Fires when another tab writes, clears or imports. |

`type` is `income`, `spend` or `grocery`.

### The three destructive operations

- **Clear** removes the key. A later `read()` returns a fresh empty document
  *without* recreating the key, so cleared really means cleared.
- **Import replaces.** Everything previously stored — entries *and* settings — is
  discarded in favour of the file. It is a restore, not a merge.
- **Export** writes the document out verbatim, so exporting and re-importing
  returns identical data, ids included.

### Why every write re-reads first

`addEntry`, `removeEntry` and `updateSetting` re-read the document immediately
before changing it, rather than writing back a copy the page has been holding.

Without that, a page left open while another tab cleared or imported would still
be holding the old data, and its next write would put all of it back —
resurrecting entries that had just been deleted. Pages also call `subscribe()` so
they re-render as soon as another tab changes the document.

## Totals

`summary(doc)` computes every figure the dashboard shows, so no page can
disagree with another:

| Figure | Definition |
| --- | --- |
| `earned` | Sum of `income_entries`. |
| `spent` | Sum of `spend_entries`. |
| `grocery` | Sum of `grocery_entries`. |
| `totalSpent` | `spent + grocery`. |
| `allowance` | `earned × spending_percentage / 100`. |
| `remaining` | `allowance − totalSpent`. |
| `saved` | `earned − allowance`. |
| `groceryThisWeek` | Groceries dated in the **current Monday-start calendar week**. |
| `groceryLeft` | `weekly_grocery_limit − groceryThisWeek`. |

Dates are parsed at local midnight. `new Date('2026-08-03')` would parse as UTC
and land on the previous day west of Greenwich, which shifts week grouping.

## Where data is edited

| Page | Role |
| --- | --- |
| `dashboard.html` | **Read-only.** Totals, charts, and listings of paychecks and spending. |
| `entries.html` | Add and remove paycheck and spend entries. |
| `grocery.html` | Add and remove grocery entries. |
| `settings.html` | Preferences, plus export / import / clear. |

The dashboard listings mirror the Entries page — same ordering, same columns —
but carry no controls. Everything is edited in one place.

## Notes and limits

- `localStorage` is per-browser and per-origin. Data does not follow you to
  another browser, another machine, or the same site served from a different
  port. Export first if any of those change.
- Clearing browser site data deletes the document. There is no other copy.
- Storage is limited (a few MB). A failed write surfaces a readable message
  rather than failing silently.
