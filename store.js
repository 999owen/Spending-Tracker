// Shared data layer for Owen's Spending Tracker.
// Everything lives in the browser's localStorage - no server or database required.
(function (global) {
    const STORAGE_KEY = 'owens_tracker_data';
    const SCHEMA_VERSION = 1;

    const emptyData = () => ({
        schema_version: SCHEMA_VERSION,
        last_updated: null,
        settings: {
            spending_percentage: 35,
            weekly_grocery_limit: 75,
            currency: 'USD'
        },
        income_entries: [],
        spend_entries: [],
        grocery_entries: []
    });

    // Fill in anything a hand-edited or older backup is missing.
    function normalize(raw) {
        const base = emptyData();
        if (!raw || typeof raw !== 'object') return base;

        const settings = Object.assign(base.settings, raw.settings || {});
        settings.spending_percentage = Number(settings.spending_percentage) || base.settings.spending_percentage;
        settings.weekly_grocery_limit = Number(settings.weekly_grocery_limit) || base.settings.weekly_grocery_limit;

        const entries = key => (Array.isArray(raw[key]) ? raw[key] : [])
            .filter(e => e && e.date !== undefined && e.amount !== undefined)
            .map(e => ({
                date: String(e.date),
                amount: parseFloat(e.amount) || 0,
                notes: e.notes === undefined ? '' : String(e.notes)
            }));

        return {
            schema_version: SCHEMA_VERSION,
            last_updated: raw.last_updated || null,
            settings: settings,
            income_entries: entries('income_entries'),
            spend_entries: entries('spend_entries'),
            grocery_entries: entries('grocery_entries')
        };
    }

    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? normalize(JSON.parse(raw)) : emptyData();
        } catch (err) {
            console.error('Could not read saved data, starting empty:', err);
            return emptyData();
        }
    }

    function save(db) {
        db.last_updated = new Date().toISOString();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
        return db;
    }

    function addEntry(db, type, entry) {
        db[type + '_entries'].push({
            date: entry.date,
            amount: parseFloat(entry.amount) || 0,
            notes: entry.notes || ''
        });
        return save(db);
    }

    // Entries have no ids, so delete by exact date+amount+notes match.
    function deleteEntry(db, type, entry) {
        const list = db[type + '_entries'];
        const i = list.findIndex(e =>
            e.date === entry.date &&
            parseFloat(e.amount) === parseFloat(entry.amount) &&
            (e.notes || '') === (entry.notes || ''));
        if (i > -1) {
            list.splice(i, 1);
            save(db);
        }
        return db;
    }

    function clear() {
        localStorage.removeItem(STORAGE_KEY);
        return emptyData();
    }

    function exportToFile() {
        const db = load();
        const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'owens_tracker_backup_' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Throws if the JSON text isn't a usable backup.
    function importFromJSON(text) {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') throw new Error('Backup is not an object');
        const hasAnyList = ['income_entries', 'spend_entries', 'grocery_entries']
            .some(k => Array.isArray(parsed[k]));
        if (!hasAnyList) throw new Error('Backup contains no entry lists');
        const db = normalize(parsed);
        save(db);
        return db;
    }

    function formatter(db) {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: (db.settings && db.settings.currency) || 'USD'
        });
    }

    global.TrackerStore = {
        STORAGE_KEY: STORAGE_KEY,
        emptyData: emptyData,
        load: load,
        save: save,
        addEntry: addEntry,
        deleteEntry: deleteEntry,
        clear: clear,
        exportToFile: exportToFile,
        importFromJSON: importFromJSON,
        formatter: formatter
    };
})(window);
