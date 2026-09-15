/* store.js — AudioRec
 *
 * Upravljanje spremnikom zadržanih snimaka.
 *
 * Model:
 *   - Sve snimke UVIJEK leže na disku u RECORD_DIR (bira korisnik u postavkama;
 *     default ~/Zvuk/AudioRec). To vrijedi i za snimke koje NE idu u spremnik —
 *     one su samo sirovina za druge namjene i ne ulaze u indeks.
 *   - Spremnik je kuracija: JSON indeks (index.json u data dir) s pokazivačima
 *     na fajlove koje je korisnik svjesno zadržao kao podsjetnike.
 *   - Indeks NE drži kopiju zvuka, samo metapodatke: naziv, putanja, trajanje, datum.
 *
 * Sav I/O je async (Gio ...async) — ne blokira gnome-shell i prolazi EGO review.
 * Radi na GNOME Shell 45–50.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DECODER = new TextDecoder('utf-8');
const ENCODER = new TextEncoder();

/**
 * Učitaj cijeli fajl kao string, async. Vraća null ako fajl ne postoji.
 */
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
                // Nema fajla => tretiraj kao prazno, ne kao grešku.
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

/**
 * Zapiši string u fajl atomarno (replace), async.
 */
function saveTextAsync(file, text) {
    return new Promise((resolve, reject) => {
        const bytes = ENCODER.encode(text);
        file.replace_contents_bytes_async(
            new GLib.Bytes(bytes),
            null,                       // etag
            false,                      // make_backup
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,                       // cancellable
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

/**
 * Obriši fajl, async. Ne baca ako fajl već ne postoji.
 */
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

/**
 * Store — jedan indeks spremnika. Instancira ga extension.js i drži živ
 * dok je ekstenzija omogućena. Sve javne metode su async.
 *
 * Oblik stavke u indeksu:
 *   {
 *     id:       string,   // stabilan id (timestamp-based)
 *     name:     string,   // prikazni naziv koji je korisnik dao
 *     path:     string,   // apsolutna putanja do audio fajla na disku
 *     duration: number,   // trajanje u sekundama (0 ako nepoznato)
 *     date:     number,    // Unix vrijeme nastanka (sekunde)
 *     pinned:   boolean    // ostaje na vrhu, ne pada s limita
 *   }
 */
export class Store {
    /**
     * @param {string} dataDir  Direktorij za index.json (npr. ~/.local/share/audiorec).
     * @param {number} limit    Maks. broj nepinnanih stavki koje se drže (0 = bez limita).
     */
    constructor(dataDir, limit = 20) {
        this._dataDir = dataDir;
        this._limit = limit;
        this._indexFile = Gio.File.new_for_path(
            GLib.build_filenamev([dataDir, 'index.json']));
        this._items = [];
        this._loaded = false;
    }

    /**
     * Učitaj indeks s diska. Zove se jednom na enable().
     */
    async load() {
        // Osiguraj da data dir postoji (mkdir -p, sync je ovdje jeftin i jednokratan).
        GLib.mkdir_with_parents(this._dataDir, 0o755);

        const text = await loadTextAsync(this._indexFile);
        if (text === null || text.trim() === '') {
            this._items = [];
        } else {
            try {
                const parsed = JSON.parse(text);
                this._items = Array.isArray(parsed) ? parsed : [];
            } catch (_e) {
                // Pokvaren indeks — ne rušimo ekstenziju, krećemo od praznog.
                // (Fajl ostaje na disku za ručni pregled.)
                this._items = [];
            }
        }
        this._loaded = true;
        return this._items;
    }

    /**
     * Trenutne stavke (pinnane prve, pa po datumu silazno).
     */
    getItems() {
        const sorted = [...this._items];
        sorted.sort((a, b) => {
            if (!!b.pinned !== !!a.pinned)
                return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
            return b.date - a.date;
        });
        return sorted;
    }

    /**
     * Dodaj snimku u spremnik. Fajl je već na disku; ovdje samo indeksiramo.
     *
     * @returns {object} novododana stavka
     */
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

    /**
     * Preimenuj prikazni naziv stavke. Ne dira fajl na disku.
     */
    async rename(id, newName) {
        const item = this._items.find(i => i.id === id);
        if (!item)
            return;
        item.name = newName && newName.trim() ? newName.trim() : item.name;
        await this._persist();
    }

    /**
     * Fiksiraj / otpusti (pin) stavku.
     */
    async setPinned(id, pinned) {
        const item = this._items.find(i => i.id === id);
        if (!item)
            return;
        item.pinned = !!pinned;
        await this._persist();
    }

    /**
     * Makni iz spremnika, ali OSTAVI fajl na disku (snimka i dalje postoji
     * za druge namjene — samo je uklonjena iz kuracije podsjetnika).
     */
    async removeFromStore(id) {
        this._items = this._items.filter(i => i.id !== id);
        await this._persist();
    }

    /**
     * Obriši i iz spremnika i fajl s diska. Nepovratno.
     */
    async deleteFile(id) {
        const item = this._items.find(i => i.id === id);
        this._items = this._items.filter(i => i.id !== id);
        await this._persist();
        if (item && item.path) {
            const f = Gio.File.new_for_path(item.path);
            await deleteFileAsync(f);
        }
    }

    // --- interno ---

    _defaultName(now) {
        const dt = GLib.DateTime.new_from_unix_local(now);
        return dt.format('%Y-%m-%d %H:%M:%S');
    }

    _enforceLimit() {
        if (!this._limit || this._limit <= 0)
            return;
        // Pinnane ne brojimo u limit; višak najstarijih nepinnanih ispada iz indeksa.
        // (Ispadanje iz indeksa NE briše fajl — snimka ostaje na disku.)
        const unpinned = this._items
            .filter(i => !i.pinned)
            .sort((a, b) => a.date - b.date); // najstarije prve
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
