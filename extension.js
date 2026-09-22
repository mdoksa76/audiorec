import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const RECORD_EXT = 'opus';
const STORE_VISIBLE_ROWS = 6;

/* Helpers */

function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

function timestampSlug() {
    return GLib.DateTime.new_now_local().format('%Y-%m-%d_%H-%M-%S');
}

function sanitizeFilename(name) {
    const trimmed = (name || '').trim();
    if (!trimmed)
        return timestampSlug();
    return trimmed.replace(/[\/\\:*?"<>|]/g, '_');
}

/* Dialogs */

const StopDialog = GObject.registerClass(
class StopDialog extends ModalDialog.ModalDialog {
    _init(defaultName, onConfirm) {
        super._init({styleClass: 'audiorec-stop-dialog'});
        this._onConfirm = onConfirm;

        const content = new St.BoxLayout({
            vertical: true, style_class: 'audiorec-dialog-content', x_expand: true,
        });
        this.contentLayout.add_child(content);

        content.add_child(new St.Label({
            text: _('Save recording'), style_class: 'audiorec-dialog-title',
        }));
        content.add_child(new St.Label({text: _('Name:')}));

        this._entry = new St.Entry({
            text: defaultName, can_focus: true, x_expand: true,
            style_class: 'audiorec-name-entry',
        });
        content.add_child(this._entry);

        const toggleRow = new St.BoxLayout({
            style_class: 'audiorec-toggle-row', x_expand: true,
        });
        this._toggle = new PopupMenu.Switch(false);
        const toggleLabel = new St.Label({
            text: _('Add to store (reminder)'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        toggleRow.add_child(this._toggle);
        toggleRow.add_child(toggleLabel);
        content.add_child(toggleRow);

        toggleLabel.reactive = true;
        toggleLabel.connect('button-press-event', () => {
            this._toggle.toggle();
            return Clutter.EVENT_STOP;
        });

        this.setButtons([
            {label: _('Cancel'), action: () => this._finish(null), key: Clutter.KEY_Escape},
            {label: _('Save'), action: () => this._finish(true), default: true},
        ]);

        this.connect('opened', () => {
            this._entry.grab_key_focus();
            const ct = this._entry.clutter_text;
            ct.set_selection(0, ct.get_text().length);
        });
    }

    _finish(confirmed) {
        const result = confirmed
            ? {name: this._entry.get_text(), keep: this._toggle.state}
            : null;
        this.close(global.get_current_time());
        if (this._onConfirm)
            this._onConfirm(result);
    }

    destroy() {
        this._entry?.destroy();
        this._entry = null;
        this._toggle?.destroy();
        this._toggle = null;
        super.destroy();
    }
});

const RenameDialog = GObject.registerClass(
class RenameDialog extends ModalDialog.ModalDialog {
    _init(currentName, onConfirm) {
        super._init({styleClass: 'audiorec-rename-dialog'});
        this._onConfirm = onConfirm;

        const content = new St.BoxLayout({
            vertical: true, x_expand: true, style_class: 'audiorec-dialog-content',
        });
        this.contentLayout.add_child(content);

        content.add_child(new St.Label({
            text: _('Rename recording'), style_class: 'audiorec-dialog-title',
        }));

        this._entry = new St.Entry({
            text: currentName, can_focus: true, x_expand: true,
            style_class: 'audiorec-name-entry',
        });
        content.add_child(this._entry);

        this.setButtons([
            {label: _('Cancel'), action: () => this._finish(false), key: Clutter.KEY_Escape},
            {label: _('Save'), action: () => this._finish(true), default: true},
        ]);

        this.connect('opened', () => {
            this._entry.grab_key_focus();
            const ct = this._entry.clutter_text;
            ct.set_selection(0, ct.get_text().length);
        });
    }

    _finish(confirmed) {
        const name = confirmed ? this._entry.get_text() : null;
        this.close(global.get_current_time());
        if (this._onConfirm)
            this._onConfirm(name);
    }

    destroy() {
        this._entry?.destroy();
        this._entry = null;
        super.destroy();
    }
});

/* Panel stop button */

const RecordingButton = GObject.registerClass(
class RecordingButton extends St.Button {
    _init(onStop) {
        super._init({
            style_class: 'panel-button',
            reactive: true, can_focus: true, track_hover: true,
        });
        this._onStop = onStop;

        const box = new St.BoxLayout({style_class: 'audiorec-stop-box'});
        this.set_child(box);

        this._dot = new St.Icon({
            icon_name: 'media-record-symbolic',
            style_class: 'system-status-icon audiorec-recording',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._dot);

        this._label = new St.Label({
            text: '0:00', y_align: Clutter.ActorAlign.CENTER,
            style_class: 'audiorec-timer',
        });
        box.add_child(this._label);

        this.connect('clicked', () => {
            if (this._onStop)
                this._onStop();
        });
    }

    setTime(text) {
        this._label.text = text;
    }
});

/* Quick Settings toggle */

const AudioRecToggle = GObject.registerClass(
class AudioRecToggle extends QuickSettings.QuickMenuToggle {
    _init(controller) {
        super._init({
            title: _('AudioRec'),
            iconName: 'audio-input-microphone-symbolic',
            toggleMode: false,
        });
        this._controller = controller;

        this.connect('clicked', () => this._controller.toggleRecording());

        this.menu.setHeader('audio-input-microphone-symbolic', _('Recordings store'));

        this._listSection = new PopupMenu.PopupMenuSection();

        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true, y_expand: true,
        });
        this._scroll.add_child(this._listSection.actor);

        const scrollItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false,
            style_class: 'audiorec-store-scroll-item',
        });
        scrollItem.add_child(this._scroll);
        this.menu.addMenuItem(scrollItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const openDir = new PopupMenu.PopupMenuItem(_('Open recordings folder'));
        openDir.connect('activate', () => this._controller.openRecordDir());
        this.menu.addMenuItem(openDir);

        this.rebuildList();
    }

    rebuildList() {
        this._listSection.removeAll();
        this._playButtons = new Map();
        this._controller.setPlayButtons(this._playButtons);

        const items = this._controller.store.getItems();
        if (items.length === 0) {
            this._listSection.addMenuItem(
                new PopupMenu.PopupMenuItem(_('Store is empty'), {reactive: false}));
        } else {
            for (const item of items)
                this._listSection.addMenuItem(this._buildRow(item));
        }

        const rowH = 34;
        this._scroll.style = `max-height: ${rowH * STORE_VISIBLE_ROWS}px;`;
    }

    _buildRow(item) {
        const row = new PopupMenu.PopupBaseMenuItem({activate: false});

        const pin = item.pinned ? '📌 ' : '';
        const dur = item.duration ? `  (${formatDuration(item.duration)})` : '';
        row.add_child(new St.Label({
            text: `${pin}${item.name}${dur}`,
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        }));

        const playBtn = this._iconBtn('media-playback-start-symbolic',
            _('Play'), () => this._controller.togglePlay(item.path, playBtn));
        this._playButtons.set(item.path, playBtn);
        row.add_child(playBtn);

        row.add_child(this._iconBtn('document-edit-symbolic', _('Rename'), () => {
            const d = new RenameDialog(item.name, async (newName) => {
                if (newName !== null) {
                    await this._controller.store.rename(item.id, newName);
                    this.rebuildList();
                }
            });
            d.open(global.get_current_time());
        }));

        row.add_child(this._iconBtn(
            item.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
            item.pinned ? _('Unpin') : _('Pin'),
            async () => {
                await this._controller.store.setPinned(item.id, !item.pinned);
                this.rebuildList();
            }));

        row.add_child(this._iconBtn('list-remove-symbolic',
            _('Remove from store (keep file)'), async () => {
                await this._controller.store.removeFromStore(item.id);
                this.rebuildList();
            }));

        row.add_child(this._iconBtn('user-trash-symbolic',
            _('Delete file from disk'), async () => {
                await this._controller.store.deleteFile(item.id);
                this.rebuildList();
            }));

        return row;
    }

    _iconBtn(iconName, tooltip, onClick) {
        const icon = new St.Icon({icon_name: iconName, style_class: 'popup-menu-icon'});
        const btn = new St.Button({
            style_class: 'audiorec-row-button',
            child: icon,
        });
        btn.accessible_name = tooltip;
        btn.connect('clicked', () => {
            onClick();
            return Clutter.EVENT_STOP;
        });
        btn.setPlaying = (playing) => {
            icon.icon_name = playing
                ? 'media-playback-stop-symbolic'
                : 'media-playback-start-symbolic';
            if (playing)
                icon.add_style_class_name('audiorec-recording');
            else
                icon.remove_style_class_name('audiorec-recording');
        };
        return btn;
    }

    setRecording(active) {
        this.checked = active;
        this.subtitle = active ? _('Recording…') : null;
    }
});

const AudioRecIndicator = GObject.registerClass(
class AudioRecIndicator extends QuickSettings.SystemIndicator {
    _init(controller) {
        super._init();
        this.quickSettingsItems.push(new AudioRecToggle(controller));
    }

    get toggle() {
        return this.quickSettingsItems[0];
    }
});

/* Controller */

class AudioRecController {
    constructor(extension) {
        this._extension = extension;
        this.store = extension.store;
        this._settings = extension.getSettings();

        this._recording = false;
        this._proc = null;
        this._playProc = null;
        this._playingPath = null;
        this._playButtons = null;
        this._currentPath = null;
        this._startTime = 0;
        this._timerId = 0;
        this._recordButton = null;

        this._indicator = new AudioRecIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    get _toggle() {
        return this._indicator.toggle;
    }

    toggleRecording() {
        if (this._recording)
            this._stopRecording();
        else
            this._startRecording();
    }

    _recordDir() {
        let dir = this._settings.get_string('record-dir');
        if (!dir || dir.trim() === '')
            dir = GLib.build_filenamev([GLib.get_home_dir(), 'AudioRec']);
        GLib.mkdir_with_parents(dir, 0o755);
        return dir;
    }

    _bitrate() {
        const b = this._settings.get_int('bitrate');
        return [24, 48, 96].includes(b) ? b : 96;
    }

    _startRecording() {
        const dir = this._recordDir();
        const tmpName = `audiorec_${timestampSlug()}.${RECORD_EXT}`;
        this._currentPath = GLib.build_filenamev([dir, tmpName]);

        const rate = this._bitrate();
        const argv = [
            'ffmpeg',
            '-hide_banner', '-loglevel', 'error',
            '-f', 'pulse', '-i', 'default',
            '-c:a', 'libopus',
            '-b:a', `${rate}k`,
            '-application', 'audio',
            '-y', this._currentPath,
        ];

        try {
            this._proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (_e) {
            Main.notifyError(_('AudioRec'),
                _('Cannot start ffmpeg. Is it installed (with libopus)?'));
            this._currentPath = null;
            return;
        }

        this._recording = true;
        this._startTime = GLib.get_monotonic_time();
        this._toggle.setRecording(true);
        this._showRecordButton();
    }

    _stopRecording() {
        if (!this._recording)
            return;
        this._recording = false;
        this._stopTimer();

        if (this._proc) {
            try { this._proc.send_signal(2); } catch (_e) {}
            this._proc = null;
        }

        const elapsed = (GLib.get_monotonic_time() - this._startTime) / 1e6;
        this._toggle.setRecording(false);
        this._hideRecordButton();

        const recordedPath = this._currentPath;
        this._currentPath = null;

        const dialog = new StopDialog(timestampSlug(), (result) => {
            if (!result) {
                this._discard(recordedPath);
                return;
            }
            this._finalizeRecording(recordedPath, result, elapsed);
        });
        dialog.open(global.get_current_time());
    }

    async _finalizeRecording(tmpPath, result, duration) {
        const dir = this._recordDir();
        const safe = sanitizeFilename(result.name);
        let finalPath = this._uniquePath(
            GLib.build_filenamev([dir, `${safe}.${RECORD_EXT}`]));

        try {
            const src = Gio.File.new_for_path(tmpPath);
            const dst = Gio.File.new_for_path(finalPath);
            await new Promise((resolve, reject) => {
                src.move_async(dst, Gio.FileCopyFlags.NONE,
                    GLib.PRIORITY_DEFAULT, null, null,
                    (source, res) => {
                        try { source.move_finish(res); resolve(); }
                        catch (e) { reject(e); }
                    });
            });
        } catch (_e) {
            Main.notifyError(_('AudioRec'), _('Cannot save the recording.'));
            return;
        }

        if (result.keep) {
            await this.store.add({name: result.name, path: finalPath, duration});
            this._toggle.rebuildList();
        }
    }

    _uniquePath(path) {
        if (!Gio.File.new_for_path(path).query_exists(null))
            return path;
        const dir = GLib.path_get_dirname(path);
        const base = GLib.path_get_basename(path);
        const dot = base.lastIndexOf('.');
        const stem = dot > 0 ? base.substring(0, dot) : base;
        const ext = dot > 0 ? base.substring(dot) : '';
        let n = 2, cand;
        do {
            cand = GLib.build_filenamev([dir, `${stem}_${n}${ext}`]);
            n++;
        } while (Gio.File.new_for_path(cand).query_exists(null));
        return cand;
    }

    async _discard(path) {
        if (!path) return;
        try {
            const f = Gio.File.new_for_path(path);
            await new Promise((resolve) => {
                f.delete_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
                    try { source.delete_finish(res); } catch (_e) {}
                    resolve();
                });
            });
        } catch (_e) {}
    }

    _showRecordButton() {
        if (this._recordButton)
            return;
        this._recordButton = new RecordingButton(() => this._stopRecording());
        this._recordButton.setTime('0:00');
        Main.panel.addToStatusArea('audiorec-recording', this._recordButton, 999, 'right');

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            const elapsed = (GLib.get_monotonic_time() - this._startTime) / 1e6;
            this._recordButton.setTime(formatDuration(elapsed));
            return GLib.SOURCE_CONTINUE;
        });
    }

    _hideRecordButton() {
        this._stopTimer();
        if (this._recordButton) {
            this._recordButton.destroy();
            this._recordButton = null;
        }
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    setPlayButtons(map) {
        this._playButtons = map;
        if (this._playingPath && map.has(this._playingPath))
            map.get(this._playingPath).setPlaying(true);
    }

    togglePlay(path, btn) {
        if (this._playingPath === path) {
            this._stopPlayback();
            return;
        }
        this._stopPlayback();

        try {
            this._playProc = Gio.Subprocess.new(
                ['ffplay', '-nodisp', '-autoexit', '-loglevel', 'error', path],
                Gio.SubprocessFlags.NONE);
        } catch (_e) {
            Main.notifyError(_('AudioRec'), _('Cannot play back (ffplay).'));
            return;
        }

        this._playingPath = path;
        if (btn)
            btn.setPlaying(true);

        this._playProc.wait_async(null, (proc, res) => {
            try { proc.wait_finish(res); } catch (_e) {}
            this._clearPlayingVisual();
            this._playProc = null;
            this._playingPath = null;
        });
    }

    _clearPlayingVisual() {
        if (this._playingPath && this._playButtons &&
            this._playButtons.has(this._playingPath)) {
            this._playButtons.get(this._playingPath).setPlaying(false);
        }
    }

    _stopPlayback() {
        this._clearPlayingVisual();
        if (this._playProc) {
            try { this._playProc.send_signal(2); } catch (_e) {}
            this._playProc = null;
        }
        this._playingPath = null;
    }

    openRecordDir() {
        const dir = this._recordDir();
        Gio.AppInfo.launch_default_for_uri(
            Gio.File.new_for_path(dir).get_uri(), null);
    }

    destroy() {
        this._stopTimer();
        if (this._proc) {
            try { this._proc.send_signal(2); } catch (_e) {}
            this._proc = null;
        }
        this._stopPlayback();
        this._hideRecordButton();
        if (this._indicator) {
            this._indicator.quickSettingsItems.forEach(i => i.destroy());
            this._indicator.destroy();
            this._indicator = null;
        }
        this._playButtons = null;
        this._settings = null;
        this.store = null;
    }
}

/* Entry point */

export default class AudioRecExtension extends Extension {
    async enable() {
        const dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'audiorec']);

        const {Store} = await import('./store.js');
        this.store = new Store(dataDir, 20);
        await this.store.load();

        this._controller = new AudioRecController(this);
    }

    disable() {
        if (this._controller) {
            this._controller.destroy();
            this._controller = null;
        }
        this.store = null;
    }
}
