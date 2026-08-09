// =============================================================================
// Owen's Spending Tracker - data storage
// =============================================================================
//
// All data lives in ONE JSON document, held in localStorage under a single key
// ("owens_tracker_data"). There is no server and no database. Think of that key
// as a single JSON file on disk:
//
//   read()             - parse the file and hand back the whole document
//   write(doc)         - serialise the whole document back over the file
//   clear()            - delete the file outright
//   toJSON()           - the exact text that Export downloads
//
// Every operation goes through the whole document. Nothing writes a partial
// record, so the file on disk is always a complete, valid document.
//
// The document:
//
//   {
//     "schema_version": 2,
//     "last_updated": "2026-08-09T06:15:00.000Z",
//     "settings": {
//       "spending_percentage": 35,     // 1-100, share of income to spend
//       "weekly_grocery_limit": 75,    // > 0, the grocery chart's limit line
//       "currency": "USD"              // USD | EUR | GBP
//     },
//     "income_entries":  [ { "id": "...", "date": "2026-08-01",
//                            "amount": 467.75, "notes": "Week 1" } ],
//     "spend_entries":   [ ...same shape... ],
//     "grocery_entries": [ ...same shape... ]
//   }
//
// Entry rules, enforced on every write and on import:
//   id      - stable and unique, so duplicate rows stay distinguishable
//   date    - "YYYY-MM-DD", must be a real calendar date
//   amount  - a number greater than zero, rounded to cents
//   notes   - a string, may be empty
//
// Reading is forgiving and writing is strict: anything that fails those rules
// is dropped on the way in and reported, rather than being stored as $0.00.
//
// Import is a two-step operation, so the page can ask before destroying
// anything:
//   parseBackup(text) - validate a file WITHOUT storing it
//   replaceWith(doc)  - wipe: discard everything stored, keep only the backup
//   mergeWith(doc)    - keep: add the backup's entries, leaving existing
//                       entries and existing settings alone
//
// Clear removes the key; nothing is left behind. Export writes the document out
// verbatim, so an export re-imported with replaceWith gives back identical data.
// =============================================================================

(function (global) {
    const STORAGE_KEY = 'owens_tracker_data';
    const SCHEMA_VERSION = 2;
    const TYPES = ['income', 'spend', 'grocery'];
    const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP'];

    const DEFAULT_SETTINGS = {
        spending_percentage: 35,
        weekly_grocery_limit: 75,
        currency: 'USD'
    };

    // ---------------------------------------------------------------- document

    function emptyDocument() {
        return {
            schema_version: SCHEMA_VERSION,
            last_updated: null,
            settings: Object.assign({}, DEFAULT_SETTINGS),
            income_entries: [],
            spend_entries: [],
            grocery_entries: []
        };
    }

    function newId() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            return global.crypto.randomUUID();
        }
        return 'e-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
    }

    // ------------------------------------------------------------------- dates

    // "YYYY-MM-DD" as a LOCAL date. new Date('2026-08-03') parses as UTC, which
    // lands on the previous day west of Greenwich and shifts week grouping.
    function parseDate(value) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
        if (!m) return null;
        const year = Number(m[1]), month = Number(m[2]) - 1, day = Number(m[3]);
        const d = new Date(year, month, day);
        // Rejects impossible dates like 2026-02-31, which Date would roll over.
        if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return null;
        return d;
    }

    function isValidDate(value) {
        return parseDate(value) !== null;
    }

    function toDateString(date) {
        return date.getFullYear() + '-' +
            String(date.getMonth() + 1).padStart(2, '0') + '-' +
            String(date.getDate()).padStart(2, '0');
    }

    // Monday-start week, returned as the week's first day at local midnight.
    function weekStart(date) {
        const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Sunday(0) -> 6, Monday(1) -> 0
        return d;
    }

    function weekKey(value) {
        const d = typeof value === 'string' ? parseDate(value) : value;
        return d ? toDateString(weekStart(d)) : null;
    }

    // -------------------------------------------------------------- validation

    // A blank or unusable value keeps `fallback`. Number('') is 0, which would
    // otherwise clamp an emptied input down to the minimum (1% / $0.01) and
    // silently rewrite the setting.
    function clampNumber(value, fallback, min, max) {
        if (value === null || value === undefined || String(value).trim() === '') return fallback;
        const n = Number(value);
        if (!isFinite(n)) return fallback;
        return Math.min(Math.max(n, min), max);
    }

    // `base` supplies the fallbacks. Editing settings passes the current ones, so
    // clearing a field keeps what was there; importing passes nothing, so a file
    // missing a setting gets the default.
    function validateSettings(raw, base) {
        const fallbacks = Object.assign({}, DEFAULT_SETTINGS, base && typeof base === 'object' ? base : {});
        const s = Object.assign({}, fallbacks, raw && typeof raw === 'object' ? raw : {});
        return {
            spending_percentage: clampNumber(s.spending_percentage, fallbacks.spending_percentage, 1, 100),
            weekly_grocery_limit: clampNumber(s.weekly_grocery_limit, fallbacks.weekly_grocery_limit, 0.01, 1e9),
            // An unrecognised currency makes Intl.NumberFormat throw and blanks every page.
            currency: SUPPORTED_CURRENCIES.indexOf(s.currency) > -1 ? s.currency : fallbacks.currency
        };
    }

    // Returns {entry, error}. The single gate every entry passes through,
    // whether it was typed into a form or read out of an imported file.
    function validateEntry(raw) {
        if (!raw || typeof raw !== 'object') {
            return { entry: null, error: 'Entry is not a record.' };
        }
        if (!isValidDate(raw.date)) {
            return { entry: null, error: 'Please enter a valid date.' };
        }
        const amount = parseFloat(raw.amount);
        if (!isFinite(amount) || amount <= 0) {
            return { entry: null, error: 'Please enter an amount greater than zero.' };
        }
        return {
            entry: {
                id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
                date: String(raw.date),
                amount: Math.round(amount * 100) / 100,
                notes: raw.notes === undefined || raw.notes === null ? '' : String(raw.notes)
            },
            error: null
        };
    }

    // Turns anything at all into a valid document. Reports how many entries had
    // to be dropped, and whether anything needed rewriting (missing ids, a
    // repeated id, an older schema).
    function validateDocument(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return { doc: emptyDocument(), skipped: 0, upgraded: false };
        }

        const doc = emptyDocument();
        doc.settings = validateSettings(raw.settings);
        doc.last_updated = typeof raw.last_updated === 'string' ? raw.last_updated : null;

        let skipped = 0;
        let upgraded = raw.schema_version !== SCHEMA_VERSION;

        // Ids must be unique across the whole document. A hand-written or
        // duplicated backup can repeat one, and delete works by id - two rows
        // sharing an id means deleting either removes the first.
        const usedIds = new Set();

        TYPES.forEach(type => {
            const key = type + '_entries';
            const list = Array.isArray(raw[key]) ? raw[key] : [];
            list.forEach(item => {
                const result = validateEntry(item);
                if (result.error) { skipped++; return; }

                if (!item || !item.id) upgraded = true; // pre-id record
                if (usedIds.has(result.entry.id)) {
                    result.entry.id = newId(); // repeated id, give this row its own
                    upgraded = true;
                }
                usedIds.add(result.entry.id);
                doc[key].push(result.entry);
            });
        });

        return { doc: doc, skipped: skipped, upgraded: upgraded };
    }

    // ------------------------------------------------------------ file-level IO

    // Parse the whole document. Anything unreadable falls back to an empty one
    // rather than leaving the page broken.
    function read() {
        let text;
        try {
            text = localStorage.getItem(STORAGE_KEY);
        } catch (err) {
            console.error('localStorage is unavailable:', err);
            return emptyDocument();
        }
        if (!text) return emptyDocument();

        let result;
        try {
            result = validateDocument(JSON.parse(text));
        } catch (err) {
            console.error('Saved data is corrupt and was ignored:', err);
            return emptyDocument();
        }

        // Records from an older version are upgraded once, in place. Entries that
        // failed validation are ignored but deliberately NOT written away here -
        // loading a page should never silently destroy data on disk. They go only
        // when something else writes the document.
        if (result.upgraded) {
            try { writeRaw(result.doc); } catch (err) { /* still readable */ }
        }
        if (result.skipped > 0) {
            console.warn('Ignored ' + result.skipped + ' stored ' +
                (result.skipped === 1 ? 'entry' : 'entries') +
                ' with a missing or invalid date or amount.');
        }
        return result.doc;
    }

    function writeRaw(doc) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
        return doc;
    }

    // Serialise the whole document back over the file.
    function write(doc) {
        doc.schema_version = SCHEMA_VERSION;
        doc.last_updated = new Date().toISOString();
        try {
            writeRaw(doc);
        } catch (err) {
            console.error('Could not save data:', err);
            const quota = err && (err.name === 'QuotaExceededError' || err.code === 22);
            throw new Error(quota
                ? 'Storage is full. Export a backup and remove some entries.'
                : 'Could not save your data. Check that browser storage is enabled.');
        }
        return doc;
    }

    // Delete the file outright. Nothing is left behind, and read() will return a
    // fresh empty document without recreating the key.
    function clear() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (err) {
            console.error('Could not clear data:', err);
            throw new Error('Could not clear your data. Check that browser storage is enabled.');
        }
        return emptyDocument();
    }

    // ---------------------------------------------------------------- mutations

    function assertType(type) {
        if (TYPES.indexOf(type) === -1) throw new Error('Unknown entry type: ' + type);
    }

    // Read-modify-write against the file, never against a copy the page is
    // holding. A stale in-memory copy would otherwise write deleted entries back.
    function addEntry(type, raw) {
        assertType(type);
        const result = validateEntry(raw);
        if (result.error) throw new Error(result.error);

        const doc = read();
        doc[type + '_entries'].push(result.entry);
        return write(doc);
    }

    function removeEntry(type, id) {
        assertType(type);
        const doc = read();
        const list = doc[type + '_entries'];
        const i = list.findIndex(e => e.id === id);
        if (i === -1) return doc;
        list.splice(i, 1);
        return write(doc);
    }

    function updateSetting(key, value) {
        const doc = read();
        const next = Object.assign({}, doc.settings);
        next[key] = value;
        // Current settings are the fallbacks, so a cleared field keeps its value.
        doc.settings = validateSettings(next, doc.settings);
        return write(doc);
    }

    // ----------------------------------------------------------- import/export

    // The exact text Export writes out.
    function toJSON() {
        return JSON.stringify(read(), null, 2);
    }

    // Returns the counts written. Nothing is downloaded when there is nothing to
    // export, so the caller can say so instead of handing over an empty file.
    function exportToFile() {
        const doc = read();
        const n = counts(doc);
        if (n.total === 0) return n;

        const stamp = toDateString(new Date());
        const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'owens-tracker-backup-' + stamp + '.json';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Revoking immediately can cancel the download in some browsers.
        setTimeout(() => URL.revokeObjectURL(url), 10000);

        return n;
    }

    // Validates a backup WITHOUT storing it, so the page can show the user what
    // is in the file before asking how to apply it.
    // Returns {doc, entries, skipped}. Throws if the file is not usable.
    function parseBackup(text) {
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            throw new Error('That file is not valid JSON.');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('That backup is not in the expected format.');
        }
        if (!TYPES.some(t => Array.isArray(parsed[t + '_entries']))) {
            throw new Error('That file contains no paycheck, spend or grocery entries.');
        }

        const result = validateDocument(parsed);
        const entries = counts(result.doc).total;
        if (entries === 0 && result.skipped > 0) {
            throw new Error('Every entry in that file was invalid, so nothing was imported.');
        }
        return { doc: result.doc, entries: entries, skipped: result.skipped };
    }

    // WIPE: discard everything stored and keep only the backup - entries and
    // settings both. This is a restore.
    function replaceWith(backupDoc) {
        return write(backupDoc);
    }

    // KEEP: add the backup's entries to what is already stored. Existing entries
    // and existing settings are left alone. An entry already present (same id,
    // e.g. importing the same file twice) is counted as a duplicate and skipped
    // rather than added again.
    // Returns {doc, added, duplicates}.
    function mergeWith(backupDoc) {
        const doc = read();
        let added = 0;
        let duplicates = 0;

        TYPES.forEach(type => {
            const key = type + '_entries';
            const seen = new Set(doc[key].map(e => e.id));
            backupDoc[key].forEach(entry => {
                if (seen.has(entry.id)) { duplicates++; return; }
                seen.add(entry.id);
                doc[key].push(entry);
                added++;
            });
        });

        write(doc);
        return { doc: doc, added: added, duplicates: duplicates };
    }

    // ------------------------------------------------------------- derived data

    function counts(doc) {
        return {
            income: doc.income_entries.length,
            spend: doc.spend_entries.length,
            grocery: doc.grocery_entries.length,
            total: doc.income_entries.length + doc.spend_entries.length + doc.grocery_entries.length
        };
    }

    function sum(list) {
        return list.reduce((total, e) => total + e.amount, 0);
    }

    // Newest first. The one ordering every listing uses.
    function sortedEntries(doc, type) {
        return [...doc[type + '_entries']].sort((a, b) => parseDate(b.date) - parseDate(a.date));
    }

    // The current calendar week's grocery total - not "whichever entry is last
    // in the list", which made a back-dated bill count as this week's.
    function groceryThisWeek(doc) {
        const current = weekKey(new Date());
        return sum(doc.grocery_entries.filter(e => weekKey(e.date) === current));
    }

    // Every page derives its numbers from here, so they cannot disagree.
    function summary(doc) {
        const earned = sum(doc.income_entries);
        const spent = sum(doc.spend_entries);
        const grocery = sum(doc.grocery_entries);
        const totalSpent = spent + grocery;
        const allowance = earned * (doc.settings.spending_percentage / 100);
        const thisWeek = groceryThisWeek(doc);

        return {
            earned: earned,
            spent: spent,
            grocery: grocery,
            totalSpent: totalSpent,
            allowance: allowance,
            remaining: allowance - totalSpent,
            saved: earned - allowance,
            groceryThisWeek: thisWeek,
            groceryLeft: doc.settings.weekly_grocery_limit - thisWeek
        };
    }

    // Groups grocery entries into the last `count` calendar weeks, oldest first,
    // including weeks with no spending so the chart keeps a real time axis.
    function groceryByWeek(doc, count) {
        const totals = {};
        doc.grocery_entries.forEach(e => {
            const key = weekKey(e.date);
            if (key) totals[key] = (totals[key] || 0) + e.amount;
        });

        const weeks = [];
        const cursor = weekStart(new Date());
        for (let i = 0; i < count; i++) {
            const key = toDateString(cursor);
            weeks.unshift({
                key: key,
                label: i === 0 ? 'This Week' : (cursor.getMonth() + 1) + '/' + cursor.getDate(),
                total: totals[key] || 0
            });
            cursor.setDate(cursor.getDate() - 7);
        }
        return weeks;
    }

    // ------------------------------------------------------------------ helpers

    function formatter(doc) {
        const currency = (doc.settings && doc.settings.currency) || 'USD';
        try {
            return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency });
        } catch (err) {
            return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
        }
    }

    // Fires when another tab writes, clears or imports, so open pages re-render.
    function subscribe(callback) {
        global.addEventListener('storage', function (e) {
            // e.key is null when the whole store is wiped via localStorage.clear()
            if (e.key === STORAGE_KEY || e.key === null) callback(read());
        });
    }

    function markActiveNav() {
        const here = location.pathname.split('/').pop() || 'dashboard.html';
        document.querySelectorAll('.sidebar-menu-item').forEach(link => {
            link.classList.toggle('active', link.getAttribute('href') === here);
        });
    }

    global.TrackerStore = {
        STORAGE_KEY: STORAGE_KEY,
        SCHEMA_VERSION: SCHEMA_VERSION,
        SUPPORTED_CURRENCIES: SUPPORTED_CURRENCIES,

        // whole-document operations
        emptyDocument: emptyDocument,
        read: read,
        write: write,
        clear: clear,
        toJSON: toJSON,
        exportToFile: exportToFile,
        parseBackup: parseBackup,
        replaceWith: replaceWith,
        mergeWith: mergeWith,

        // entry operations
        addEntry: addEntry,
        removeEntry: removeEntry,
        updateSetting: updateSetting,

        // derived
        counts: counts,
        summary: summary,
        sortedEntries: sortedEntries,
        groceryByWeek: groceryByWeek,

        // helpers
        parseDate: parseDate,
        weekKey: weekKey,
        formatter: formatter,
        subscribe: subscribe,
        markActiveNav: markActiveNav
    };
})(window);
