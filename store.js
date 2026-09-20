import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DECODER = new TextDecoder('utf-8');
const ENCODER = new TextEncoder();

function loadTextAsync(file) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (source, res) => {
            try {
                const [ok, bytes] = source.load_contents_finish(res);
                if (!ok) {
                    resolve(null);
                    return;
                }
                resolve(DECODER.decode(bytes));
            } catch (e) {
                if (e instanceof GLib.Error &&
                    e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND)) {
                    resolve(null);
                    return;
                }
                reject(e);
            }
        });
    });
}

function saveTextAsync(file, text) {
    return new Promise((resolve, reject) => {
        const bytes = ENCODER.encode(text);
        file.replace_contents_bytes_async(
            new GLib.Bytes(bytes),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
            (source, res) => {
                try {
                    source.replace_contents_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

function deleteFileAsync(file) {
    return new Promise((resolve, reject) => {
        file.delete_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
            try {
                source.delete_finish(res);
                resolve();
            } catch (e) {
                if (e instanceof GLib.Error &&
                    e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND)) {
                    resolve();
                    return;
                }
                reject(e);
            }
        });
    });
}

export class Store {
    constructor(dataDir, limit = 20) {
        this._dataDir = dataDir;
        this._limit = limit;
        this._indexFile = Gio.File.new_for_path(
            GLib.build_filenamev([dataDir, 'index.json']));
        this._items = [];
        this._loaded = false;
    }

    async load() {
        GLib.mkdir_with_parents(this._dataDir, 0o755);

        const text = await loadTextAsync(this._indexFile);
        if (text === null || text.trim() === '') {
            this._items = [];
        } else {
            try {
                const parsed = JSON.parse(text);
                this._items = Array.isArray(parsed) ? parsed : [];
            } catch (_e) {
                this._items = [];
            }
        }
        this._loaded = true;
        return this._items;
    }

    getItems() {
        const sorted = [...this._items];
        sorted.sort((a, b) => {
            if (!!b.pinned !== !!a.pinned)
                return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
            return b.date - a.date;
        });
        return sorted;
    }

    async add({ name, path, duration = 0 }) {
        const now = Math.floor(Date.now() / 1000);
        const item = {
            id: `${now}-${Math.floor(Math.random() * 1e6)}`,
            name: name && name.trim() ? name.trim() : this._defaultName(now),
            path,
            duration,
            date: now,
            pinned: false,
        };
        this._items.push(item);
        this._enforceLimit();
        await this._persist();
        return item;
    }

    async rename(id, newName) {
        const item = this._items.find(i => i.id === id);
        if (!item)
            return;
        item.name = newName && newName.trim() ? newName.trim() : item.name;
        await this._persist();
    }

    async setPinned(id, pinned) {
        const item = this._items.find(i => i.id === id);
        if (!item)
            return;
        item.pinned = !!pinned;
        await this._persist();
    }

    async removeFromStore(id) {
        this._items = this._items.filter(i => i.id !== id);
        await this._persist();
    }

    async deleteFile(id) {
        const item = this._items.find(i => i.id === id);
        this._items = this._items.filter(i => i.id !== id);
        await this._persist();
        if (item && item.path) {
            const f = Gio.File.new_for_path(item.path);
            await deleteFileAsync(f);
        }
    }

    _defaultName(now) {
        const dt = GLib.DateTime.new_from_unix_local(now);
        return dt.format('%Y-%m-%d %H:%M:%S');
    }

    _enforceLimit() {
        if (!this._limit || this._limit <= 0)
            return;
        const unpinned = this._items
            .filter(i => !i.pinned)
            .sort((a, b) => a.date - b.date);
        const overflow = unpinned.length - this._limit;
        if (overflow > 0) {
            const toDrop = new Set(unpinned.slice(0, overflow).map(i => i.id));
            this._items = this._items.filter(i => !toDrop.has(i.id));
        }
    }

    async _persist() {
        const text = JSON.stringify(this._items, null, 2);
        await saveTextAsync(this._indexFile, text);
    }
}
