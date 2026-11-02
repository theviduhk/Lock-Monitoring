// ==UserScript==
// @name         Team Monitor Dashboard v8.1
// @namespace    http://tampermonkey.net/
// @version      8.1
// @description  Team monitor with project management, SLA alerts (validation & stitching only), redesigned clean UI
// @author       Thevidu
// @match        https://smart-prod.trax-cloud.com/leader-dashboard/dashboard
// @grant        GM_notification
// @require      https://code.jquery.com/jquery-3.7.1.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// ==/UserScript==

(function () {
    'use strict';

    const FIREBASE_DB_URL = 'https://locks-d2916-default-rtdb.firebaseio.com';
    const FIREBASE_LIVE_PATH = '/team_monitor_logs/current_snapshot';
    const FIREBASE_HISTORY_PATH = '/team_monitor_logs/history';

    const HISTORY_ALLOWED_TASK_TYPES = ['validation', 'stitching', 'Scene_Recognition'];
    const ALLOWED_TASK_TYPES = ['voting_engine', 'stitching', 'validation', 'voting'];

    // SLA tracking only for validation and stitching
    const SLA_TRACKED_TASK_TYPES = ['validation', 'stitching'];

    const TASK_TIME_LIMITS = {
        'voting': 9000, 'pricing_voting': 9000, 'offline_pricing': 18000,
        'stitching': 900, 'validation': 900, 'voting_engine': 1800000, 'default': 27000
    };

    const DEFAULT_PROJECTS = [
        { name: 'cbcdairyil',        sla: 15 },
        { name: 'inbevci',           sla: 15 },
        { name: 'inbevnl',           sla: 15 },
        { name: 'marsbh',            sla: 15 },
        { name: 'marskw',            sla: 15 },
        { name: 'marsom',            sla: 15 },
        { name: 'marsqa',            sla: 15 },
        { name: 'marsuae',           sla: 15 },
        { name: 'risparkwinede',     sla: 15 },
        { name: 'straussdryil',      sla: 15 },
        { name: 'straussil',         sla: 15 },
        { name: 'straussfritolayil', sla: 60 },
        { name: 'tevade',            sla: 20 },
        { name: 'tevapl',            sla: 20 },
        { name: 'tevaru',            sla: 20 },
        { name: 'tevaua',            sla: 20 },
    ];

    function loadProjectConfig() {
        try {
            const saved = localStorage.getItem('tm_projects_v8');
            return saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(DEFAULT_PROJECTS));
        } catch (e) { return JSON.parse(JSON.stringify(DEFAULT_PROJECTS)); }
    }
    function saveProjectConfig(cfg) {
        localStorage.setItem('tm_projects_v8', JSON.stringify(cfg));
    }

    let projectConfig = loadProjectConfig();
    function getProjects() { return projectConfig.map(p => p.name); }
    function getSLA(projectName) {
        const found = projectConfig.find(p => p.name === projectName);
        return found ? found.sla : 15;
    }

    // Parse SLA input: accepts "90", "1:30", "01:30", "1h30m", "1h", "30m" → returns total minutes (integer) or null if invalid
    function parseSlaInput(raw) {
        if (!raw) return null;
        const s = raw.trim();

        // HH:MM or H:MM  e.g. "1:30", "01:30", "2:05"
        const colonMatch = s.match(/^(\d{1,3}):(\d{2})$/);
        if (colonMatch) {
            const h = parseInt(colonMatch[1]), m = parseInt(colonMatch[2]);
            if (m > 59) return null;
            const total = h * 60 + m;
            return total >= 1 ? total : null;
        }

        // "1h30m", "1h", "30m" patterns (case-insensitive)
        const hm = s.match(/^(?:(\d+)h)?(?:(\d+)m)?$/i);
        if (hm && (hm[1] || hm[2])) {
            const h = parseInt(hm[1] || 0), m = parseInt(hm[2] || 0);
            const total = h * 60 + m;
            return total >= 1 ? total : null;
        }

        // Plain number = minutes
        const n = parseInt(s);
        if (!isNaN(n) && n >= 1 && n <= 5999) return n;
        return null;
    }

    // Display SLA minutes as "Xh Ym" when >= 60, else "Xm"
    function slaDisplay(mins) {
        if (mins >= 60) {
            const h = Math.floor(mins / 60), m = mins % 60;
            return m > 0 ? `${h}h ${m}m` : `${h}h`;
        }
        return `${mins}m`;
    }

    const taskTypes = ['stitching', 'validation', 'voting', 'voting_engine'];
    const MY_TASK_TYPES = ['stitching', 'validation', 'voting', 'voting_engine', 'offline_voting', 'offline_validation'];

    let showProjectSummary = true;
    let isFullscreen = false;
    const beepedTasks = new Set();
    const slaWarningNotified = new Set();
    let completedTasks = new Map(JSON.parse(localStorage.getItem('completedTasks') || '[]'));
    let totalDurations = new Map(JSON.parse(localStorage.getItem('totalDurations') || '[]'));
    let allTasksHistory = new Map(JSON.parse(localStorage.getItem('allTasksHistory') || '[]'));
    let votingTasksHistory = new Map(JSON.parse(localStorage.getItem('votingTasksHistory') || '[]'));
    let longTasksHistory = new Map(JSON.parse(localStorage.getItem('longTasksHistory') || '[]'));
    let dailyTaskLog = JSON.parse(localStorage.getItem('dailyTaskLog') || '[]');

    const notifiedTasks = new Set();
    let sortColumn = 'Duration';
    let sortDirection = 'desc';
    const allEmails = new Set();
    const taskStartTimes = new Map();
    const lastSeen = new Map();
    const lastDurations = new Map();
    const lastTaskKeys = new Map();
    const activeTaskKeys = new Set();
    let activeFilters = { project: 'all', taskType: 'all' };
    let currentProcessedData = [];
    const projectStatus = new Map();
    let firebaseStatusElement = null;
    let worker = null;
    let oldSnapshotCleaned = false;
    let xOffset = 0, yOffset = 0;

    // ---- HELPERS ----
    function toSriLankaTime(date) {
        if (!date) return 'N/A';
        try {
            const d = new Date(new Date(date).getTime() + 5.5 * 3600000);
            const pad = n => String(n).padStart(2, '0');
            return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
        } catch (e) { return 'N/A'; }
    }

    function playBeepSound(urgent = false) {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const beep = (f, d, vol = 0.3) => {
                const o = ctx.createOscillator(), g = ctx.createGain();
                o.connect(g); g.connect(ctx.destination);
                o.frequency.value = f; o.type = 'sine';
                g.gain.setValueAtTime(vol, ctx.currentTime);
                g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + d);
                o.start(ctx.currentTime); o.stop(ctx.currentTime + d);
            };
            if (urgent) {
                beep(1000, 0.3, 0.5);
                setTimeout(() => beep(1200, 0.3, 0.5), 350);
                setTimeout(() => beep(1400, 0.4, 0.5), 700);
            } else {
                beep(800, 0.2); setTimeout(() => beep(800, 0.2), 300);
            }
        } catch (e) { }
    }

    function showNotification(title, message) {
        try {
            if (window.Notification && Notification.permission === "granted") {
                new Notification(title, { body: message, icon: 'https://cdn-icons-png.flaticon.com/512/183/183678.png' });
            } else if (window.Notification && Notification.permission !== "denied") {
                Notification.requestPermission().then(p => { if (p === "granted") new Notification(title, { body: message }); });
            }
        } catch (e) { }
    }

    function formatDuration(s) {
        return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
    }

    function getSriLankaTime() { return Date.now() + (5.5 * 3600000); }

    // ---- PROJECT COLORS - clean, distinct palette ----
    const PROJ_COLORS = {
        'marsuae':           '#E85D75',
        'pepsicopl':         '#3B9EE8',
        'diageouk':          '#22C9A0',
        'marsbh':            '#F0A830',
        'marsqa':            '#9B72D8',
        'marskw':            '#29B8D4',
        'marsom':            '#E8844A',
        'cbcdairyil':        '#D95F8E',
        'inbevci':           '#3FA8DA',
        'inbevnl':           '#24B890',
        'risparkwinede':     '#D4A820',
        'straussdryil':      '#8B60C8',
        'straussil':         '#1FAEC4',
        'straussfritolayil': '#E04060',
        'tevade':            '#3898C8',
        'tevapl':            '#20A880',
        'tevaru':            '#C89820',
        'tevaua':            '#7850B8'
    };
    function pc(p) {
        if (PROJ_COLORS[p]) return PROJ_COLORS[p];
        let hash = 0;
        for (let i = 0; i < p.length; i++) hash = p.charCodeAt(i) + ((hash << 5) - hash);
        const hue = Math.abs(hash) % 360;
        return `hsl(${hue}, 60%, 55%)`;
    }

    function getTaskTypeColor(t) {
        const m = {
            'stitching':    '#E85D75',
            'validation':   '#9B72D8',
            'voting':       '#E8844A',
            'voting_engine':'#3B9EE8',
            'offline_pricing':'#22C9A0',
            'pricing_voting':'#E8844A',
            'masking_engine':'#F0A830',
            'Scene_Recognition':'#29B8D4'
        };
        return m[t] || '#3B9EE8';
    }

    function hex2rgba(hex, alpha) {
        const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    // ---- FIREBASE ----
    function updateFirebaseStatus(ok, msg = '') {
        if (firebaseStatusElement) {
            firebaseStatusElement.html(ok
                ? '<span class="tm-stat-ok">● Online</span>'
                : `<span class="tm-stat-err">● ${msg || 'Offline'}</span>`);
        }
    }

    async function putToFirebase(path, data) {
        const url = `${FIREBASE_DB_URL}${path}.json`;
        try {
            const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            updateFirebaseStatus(true);
            return await r.json();
        } catch (err) { updateFirebaseStatus(false, err.message); throw err; }
    }

    async function deleteFirebaseNode(path) {
        try {
            const r = await fetch(`${FIREBASE_DB_URL}${path}.json`, { method: 'DELETE' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
        } catch (err) { updateFirebaseStatus(false, err.message); }
    }

    async function updateLiveSnapshot(activeData) {
        const projects = getProjects();
        if (!activeData || !activeData.length) {
            for (const p of projects) await deleteFirebaseNode(`${FIREBASE_LIVE_PATH}/${p}`);
            return;
        }
        const byProj = new Map();
        activeData.forEach(t => {
            if (!ALLOWED_TASK_TYPES.includes(t["Task Type"])) return;
            const p = t["Project Name"]; if (!p) return;
            if (!byProj.has(p)) byProj.set(p, []);
            byProj.get(p).push({ email: t.Email, taskType: t["Task Type"], project: p, objectId: t["Object ID"], duration: t.Duration, remaining: t["Remaining Time"], created: t["Creation Date"] });
        });
        const ups = [];
        for (const [p, tasks] of byProj) ups.push(putToFirebase(`${FIREBASE_LIVE_PATH}/${p}`, { timestamp: new Date().toISOString(), totalTasks: tasks.length, tasks }));
        for (const p of projects) if (!byProj.has(p)) ups.push(deleteFirebaseNode(`${FIREBASE_LIVE_PATH}/${p}`).catch(() => {}));
        await Promise.allSettled(ups);
    }

    async function cleanOldFlatSnapshot() {
        if (oldSnapshotCleaned) return;
        try { await deleteFirebaseNode(FIREBASE_LIVE_PATH); } catch (e) {}
        oldSnapshotCleaned = true;
    }

    async function appendTaskToHistory(rec) {
        if (!HISTORY_ALLOWED_TASK_TYPES.includes(rec["Task Type"])) return;
        const p = rec["Project Name"]; if (!p) return;
        const k = (rec.Email + '_' + rec["Object ID"] + '_' + rec["Task Type"]).replace(/[.#$[\]]/g, '_');
        await putToFirebase(`${FIREBASE_HISTORY_PATH}/${p}/${k}`, { ...rec, uploadedAt: new Date().toISOString() });
    }

    // ---- DATA ----
    const MAX_RECORDS = 1000, ARCHIVE_BATCH = 500, SAVE_THROTTLE = 30000;
    let lastSaveTime = 0, saveTimeout = null, isArchiving = false;

    function saveThrottled() {
        const now = Date.now();
        if (now - lastSaveTime > SAVE_THROTTLE) doSave();
        else { if (saveTimeout) clearTimeout(saveTimeout); saveTimeout = setTimeout(doSave, SAVE_THROTTLE - (now - lastSaveTime)); }
    }

    function doSave() {
        lastSaveTime = Date.now();
        localStorage.setItem('allTasksHistory', JSON.stringify([...allTasksHistory]));
        localStorage.setItem('dailyTaskLog', JSON.stringify(dailyTaskLog));
        localStorage.setItem('votingTasksHistory', JSON.stringify([...votingTasksHistory]));
        localStorage.setItem('longTasksHistory', JSON.stringify([...longTasksHistory]));
        localStorage.setItem('totalDurations', JSON.stringify([...totalDurations]));
    }

    function archiveOld() {
        if (isArchiving) return; isArchiving = true;
        try {
            const all = Array.from(allTasksHistory.entries());
            if (all.length > MAX_RECORDS) {
                const arc = all.slice(0, ARCHIVE_BATCH), keep = all.slice(ARCHIVE_BATCH);
                const hdrs = ['Email', 'Task Type', 'Project Name', 'Object ID', 'Duration', 'Creation Date', 'Recorded At'];
                const csv = [hdrs.join(','), ...arc.map(([_, t]) => [t.Email, t["Task Type"], t["Project Name"], t["Object ID"], t.Duration, t["Creation Date"], t.recordedAt].map(f => `"${f}"`).join(','))].join('\n');
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
                a.download = `team_monitor_archive_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
                a.style.visibility = 'hidden'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
                allTasksHistory = new Map(keep); doSave();
            }
        } catch (e) { console.error(e); } finally { isArchiving = false; }
    }

    function saveTaskToHistory(row, ts) {
        const k = `${row.Email}_${row["Object ID"]}`;
        const ex = allTasksHistory.get(k);
        const save = !ex || ex["Task Type"] !== row["Task Type"] || ex["Project Name"] !== row["Project Name"] || Math.abs((ex.durationSeconds || 0) - row.durationSeconds) > 60;
        if (save) {
            const rec = { ...row, recordedAt: toSriLankaTime(new Date()), sessionTimestamp: ts };
            allTasksHistory.set(k, rec); appendTaskToHistory(rec).catch(() => {});
            if (allTasksHistory.size > MAX_RECORDS) archiveOld();
            const today = new Date().toDateString();
            let dl = dailyTaskLog.find(l => l.date === today);
            if (dl) { const i = dl.tasks.findIndex(t => t.Email === row.Email && t["Object ID"] === row["Object ID"]); if (i !== -1) dl.tasks[i] = rec; else dl.tasks.push(rec); }
            else dailyTaskLog.push({ date: today, tasks: [rec] });
            if (dailyTaskLog.length > 30) dailyTaskLog = dailyTaskLog.slice(-30);
            saveThrottled();
        }
    }

    function trackTaskChanges(data) {
        const cur = new Set();
        data.forEach(r => { const k = `${r.Email}_${r["Object ID"]}`; cur.add(k); if (!activeTaskKeys.has(k)) saveTaskToHistory(r, Date.now()); });
        activeTaskKeys.clear(); cur.forEach(k => activeTaskKeys.add(k));
    }

    // ---- EXPORT ----
    function exportAllData() {
        const wb = XLSX.utils.book_new();
        const ct = Array.from(allTasksHistory.values());
        if (ct.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Email', 'Task Type', 'Project Name', 'Object ID', 'Duration', 'Remaining Time', 'Creation Date (Sri Lanka)', 'Recorded At (Sri Lanka)'], ...ct.map(t => [t.Email, t["Task Type"], t["Project Name"], t["Object ID"], t.Duration, t["Remaining Time"], t["Creation Date"], t.recordedAt])]), 'All Tasks History');
        const vt = Array.from(votingTasksHistory.values());
        if (vt.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Email', 'Task Type', 'Project Name', 'Object ID', 'Duration', 'Timestamp', 'Creation Date'], ...vt.map(t => [t.email, t.taskType, t.projectName, t.objectId, formatDuration(t.duration), t.timestamp, t.creationDate || 'N/A'])]), 'Voting Tasks');
        const lt = Array.from(longTasksHistory.values());
        if (lt.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Email', 'Task Type', 'Project Name', 'Object ID', 'Duration', 'Timestamp', 'Creation Date'], ...lt.map(t => [t.email, t.taskType, t.projectName, t.objectId, formatDuration(t.duration), t.timestamp, t.creationDate || 'N/A'])]), 'Long Tasks');
        const sd = [...allEmails].map(e => [e, formatDuration(totalDurations.get(e) || 0), (totalDurations.get(e) || 0)]);
        if (sd.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Email', 'Total Duration', 'Duration Seconds'], ...sd]), 'User Summary');
        XLSX.writeFile(wb, `team_monitor_complete_${toSriLankaTime(new Date()).replace(/[: ]/g, '-')}.xlsx`);
    }

    function exportCurrentData(data) {
        if (!data || !data.length) { alert('No current data!'); return; }
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Email', 'Task Type', 'Project Name', 'Object ID', 'Duration', 'Remaining Time', 'Creation Date'], ...data.map(r => [r.Email, r["Task Type"], r["Project Name"], r["Object ID"], r.Duration, r["Remaining Time"], r["Creation Date"]])]), 'Current Tasks');
        XLSX.writeFile(wb, `current_tasks_${toSriLankaTime(new Date()).replace(/[: ]/g, '-')}.xlsx`);
    }

    function exportVotingTasks() {
        const vt = Array.from(votingTasksHistory.values());
        if (!vt.length) { alert('No voting tasks!'); return; }
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Email', 'Task Type', 'Project Name', 'Object ID', 'Duration', 'Timestamp', 'Creation Date'], ...vt.map(t => [t.email, t.taskType, t.projectName, t.objectId, formatDuration(t.duration), t.timestamp, t.creationDate || 'N/A'])]), 'Voting Tasks');
        XLSX.writeFile(wb, `voting_tasks_${toSriLankaTime(new Date()).replace(/[: ]/g, '-')}.xlsx`);
    }

    // ---- PROCESS ROW ----
    function processDataRow(td, now, proj) {
        if (!ALLOWED_TASK_TYPES.includes(td.taskType)) return null;
        if (!td.lockedBy || td.lockedBy === 'undefined' || td.lockedBy === 'N/A') return null;
        allEmails.add(td.lockedBy);
        lastSeen.set(td.lockedBy, now);
        const tk = `${td.lockedBy}_${td.taskType}_${td.objectId}_${td.uuid}`;
        const ulk = `${td.lockedBy}_${td.objectId}`;
        const bk = `${td.objectId}`;
        if (!taskStartTimes.has(tk)) taskStartTimes.set(tk, td.pullDate ? new Date(td.pullDate).getTime() : now);
        const dur = Math.floor((now - taskStartTimes.get(tk)) / 1000);
        const ctime = td.insertDate ? new Date(td.insertDate).getTime() : now;
        const slc = ctime + 5.5 * 3600000;
        const cdate = toSriLankaTime(td.insertDate);
        const tt = td.taskType || 'default';

        // ---- SLA: only calculate for validation and stitching ----
        const isSlaTracked = SLA_TRACKED_TASK_TYPES.includes(tt);

        let remDisplay;
        let rem = null;

        if (isSlaTracked) {
            const slaMins = getSLA(proj);
            const slaSeconds = slaMins * 60;
            const slnow = getSriLankaTime();
            const elapsed = Math.floor((slnow - slc) / 1000);
            rem = slaSeconds - elapsed;

            // SLA warning alert: only for validation and stitching
            const slaWarnKey = `sla_warn_${tk}`;
            if (rem > 0 && rem <= 300 && !slaWarningNotified.has(slaWarnKey)) {
                slaWarningNotified.add(slaWarnKey);
                playBeepSound(true);
                showNotification('⚠ SLA Breach Warning!', `${td.lockedBy} — ${proj} [${tt}]\n${formatDuration(rem)} until SLA breach!`);
                showSLAToast(td.lockedBy, proj, tt, rem);
            }

            // SLA breached alert: only for validation and stitching
            if (rem <= 0 && !notifiedTasks.has(tk)) {
                notifiedTasks.add(tk);
                showNotification('🔴 SLA BREACHED!', `${td.lockedBy} — ${proj} [${tt}]\nTask exceeded ${slaMins}min SLA!`);
            }

            // Beep: only for validation and stitching
            if (rem > 0 && rem < 300 && !beepedTasks.has(bk)) { playBeepSound(false); beepedTasks.add(bk); }

            if (rem <= 0) remDisplay = `<span class="tm-overdue">Overdue (SLA ${slaDisplay(slaMins)})</span>`;
            else if (rem <= 300) remDisplay = `<span class="tm-critical">${formatDuration(rem)}</span>`;
            else if (rem <= 600) remDisplay = `<span class="tm-warning">${formatDuration(rem)}</span>`;
            else remDisplay = `<span class="tm-ok">${formatDuration(rem)}</span>`;
        } else {
            // For voting, voting_engine: no SLA tracking, show N/A
            rem = null;
            remDisplay = `<span style="color:#555570;font-size:11px;">N/A</span>`;
        }

        const slaMins = isSlaTracked ? getSLA(proj) : null;

        if (td.taskType === 'pricing_voting' || td.taskType === 'voting') {
            const vk = `${td.lockedBy}_${td.objectId}`;
            const ex = votingTasksHistory.get(vk);
            if (!ex || ex.duration < dur) { votingTasksHistory.set(vk, { email: td.lockedBy, taskType: td.taskType, projectName: proj, objectId: td.objectId, duration: dur, timestamp: toSriLankaTime(new Date()), creationDate: cdate }); localStorage.setItem('votingTasksHistory', JSON.stringify([...votingTasksHistory])); }
        }
        if (dur > 480) {
            const ex = longTasksHistory.get(ulk);
            if (!ex || ex.duration < dur) { longTasksHistory.set(ulk, { email: td.lockedBy, taskType: td.taskType, projectName: proj, objectId: td.objectId, duration: dur, timestamp: toSriLankaTime(new Date()), creationDate: cdate }); localStorage.setItem('longTasksHistory', JSON.stringify([...longTasksHistory])); }
        }
        if (dur <= 900) {
            const prev = lastDurations.get(tk) || 0; lastDurations.set(tk, dur);
            const diff = dur - prev;
            if (diff > 0) { const ct = totalDurations.get(td.lockedBy) || 0; totalDurations.set(td.lockedBy, ct + (diff > 900 ? ct - 900 : diff)); }
        }
        lastTaskKeys.set(td.lockedBy, tk);
        return {
            taskKey: tk, durationSeconds: dur,
            Email: td.lockedBy, "Task Type": td.taskType || 'Unknown',
            "Project Name": proj, "Object ID": td.objectId || 'N/A',
            "Creation Date": cdate, "Creation Time": slc,
            Duration: dur > 0 ? formatDuration(dur) : '0h 0m 0s',
            "Remaining Time": remDisplay, remainingSeconds: rem,
            isSlaTracked: isSlaTracked,
            slaMinutes: slaMins,
            TaskUUID: td.uuid, isBreak: false
        };
    }

    // ---- SLA TOAST ----
    function showSLAToast(email, proj, taskType, remSeconds) {
        const existing = shadow.querySelector('#tm-sla-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'tm-sla-toast';
        const col = pc(proj);
        toast.innerHTML = `
            <div style="
                position:fixed;top:24px;left:50%;transform:translateX(-50%);
                background:#1C1C2E;
                border:1px solid ${col};border-radius:14px;padding:20px 32px;
                box-shadow:0 8px 32px rgba(0,0,0,0.6);
                z-index:2147483647;pointer-events:all;min-width:360px;text-align:center;
                animation:tmSlideIn 0.3s ease;
                font-family:-apple-system,system-ui,sans-serif;
            ">
                <div style="font-size:13px;font-weight:700;color:#E85D75;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:10px;">SLA Breach Warning</div>
                <div style="color:#E8E8F0;font-size:14px;margin-bottom:6px;font-weight:500;">${email.split('@')[0]}</div>
                <div style="display:flex;gap:8px;justify-content:center;margin:10px 0;">
                    <span style="background:${col}22;color:${col};border:1px solid ${col}55;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:600;">${proj}</span>
                    <span style="background:#E85D7522;color:#E85D75;border:1px solid #E85D7555;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:600;">${taskType}</span>
                </div>
                <div style="color:#E85D75;font-size:26px;font-weight:700;margin-top:10px;">${formatDuration(remSeconds)}</div>
                <div style="color:#8888AA;font-size:11px;margin-top:6px;">remaining before SLA breach</div>
            </div>
        `;
        shadow.appendChild(toast);
        setTimeout(() => { if (shadow.contains(toast)) shadow.removeChild(toast); }, 8000);
    }

    // ---- FETCH ----
    async function fetchProject(p) {
        try {
            const r = await $.ajax({ url: `https://smart-prod.trax-cloud.com/api/team-leader/${p}/lockedTasks`, timeout: 10000, headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' } });
            projectStatus.set(p, { status: 'success', lastSuccess: Date.now() });
            return { project: p, data: Array.isArray(r) ? r : [], error: null };
        } catch (err) {
            projectStatus.set(p, { status: 'error', lastError: Date.now(), error: err.statusText || 'failed' });
            return { project: p, data: [], error: err.statusText || 'failed' };
        }
    }

    // ---- FILTERS ----
    function applyFilters(data) {
        const MY_PROJECTS = getProjects();
        let f = [...data];
        if (activeFilters.project === 'my_project') f = f.filter(r => MY_PROJECTS.includes(r["Project Name"]) && MY_TASK_TYPES.includes(r["Task Type"]));
        else if (activeFilters.project !== 'all') f = f.filter(r => r["Project Name"] === activeFilters.project);
        if (activeFilters.taskType === 'stitching_validation') f = f.filter(r => r["Task Type"] === 'stitching' || r["Task Type"] === 'validation');
        else if (activeFilters.taskType !== 'all') f = f.filter(r => r["Task Type"] === activeFilters.taskType);
        return f;
    }

    function sortData(data, col, dir) {
        return [...data].sort((a, b) => {
            let ca = a[col], cb = b[col];
            if (col === 'Duration') { ca = a.durationSeconds; cb = b.durationSeconds; }
            else if (col === 'Creation Date') { ca = a["Creation Time"]; cb = b["Creation Time"]; }
            else if (col === 'Remaining Time') {
                // Put N/A (null) at the bottom when sorting
                ca = a.remainingSeconds !== null ? a.remainingSeconds : (dir === 'asc' ? Infinity : -Infinity);
                cb = b.remainingSeconds !== null ? b.remainingSeconds : (dir === 'asc' ? Infinity : -Infinity);
            }
            if (typeof ca === 'number') return dir === 'asc' ? ca - cb : cb - ca;
            return dir === 'asc' ? String(ca).localeCompare(String(cb)) : String(cb).localeCompare(String(ca));
        });
    }

    // ---- PROJECT MANAGER ----
    function renderProjectManagerPanel() {
        return `
            <div id="tm-projmgr" style="padding:20px;overflow:auto;max-height:calc(85vh - 200px);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
                    <div>
                        <div style="font-size:14px;font-weight:600;color:#E8E8F0;">Project Manager</div>
                        <div style="font-size:12px;color:#8888AA;margin-top:3px;">Configure projects and SLA thresholds</div>
                    </div>
                    <button id="tm-reset-projects" class="tm-btn-ghost tm-btn-danger">Reset to Default</button>
                </div>

                <div style="background:#1A1A2E;border:1px solid #2A2A4A;border-radius:10px;padding:16px;margin-bottom:16px;">
                    <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:#22C9A010;border:1px solid #22C9A030;border-radius:8px;">
                        <span style="color:#22C9A0;font-size:14px;">ℹ</span>
                        <span style="color:#8888AA;font-size:11px;">SLA is tracked <strong style="color:#E8E8F0;">only for Validation and Stitching</strong> tasks. Voting and Voting Engine tasks show <strong style="color:#555570;">N/A</strong> for remaining time.</span>
                    </div>
                </div>

                <div style="background:#1A1A2E;border:1px solid #2A2A4A;border-radius:10px;padding:16px;margin-bottom:20px;">
                    <div style="font-size:11px;font-weight:600;color:#3B9EE8;letter-spacing:1px;text-transform:uppercase;margin-bottom:14px;">Add New Project</div>
                    <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">
                        <div style="flex:2;min-width:160px;">
                            <label style="font-size:11px;color:#8888AA;display:block;margin-bottom:6px;">Project Name</label>
                            <input id="tm-new-proj-name" type="text" placeholder="e.g. newproject123" class="tm-input">
                        </div>
                        <div style="flex:1;min-width:100px;">
                            <label style="font-size:11px;color:#8888AA;display:block;margin-bottom:6px;">SLA <span style="color:#555570;font-weight:400;">(min, 1:30, 2h, 1h30m)</span></label>
                            <input id="tm-new-proj-sla" type="text" placeholder="15 or 1:30 or 2h" value="15" class="tm-input">
                        </div>
                        <button id="tm-add-proj-btn" class="tm-btn-primary">Add Project</button>
                    </div>
                    <div id="tm-add-proj-msg" style="margin-top:8px;font-size:11px;color:#8888AA;"></div>
                </div>

                <div style="border:1px solid #2A2A4A;border-radius:10px;overflow:hidden;">
                    <div style="display:grid;grid-template-columns:1fr 100px 140px 70px;padding:10px 16px;background:#131324;border-bottom:1px solid #2A2A4A;">
                        <span style="font-size:10px;font-weight:600;color:#8888AA;text-transform:uppercase;letter-spacing:1px;">Project</span>
                        <span style="font-size:10px;font-weight:600;color:#8888AA;text-transform:uppercase;letter-spacing:1px;">SLA</span>
                        <span style="font-size:10px;font-weight:600;color:#8888AA;text-transform:uppercase;letter-spacing:1px;">Edit SLA</span>
                        <span style="font-size:10px;font-weight:600;color:#8888AA;text-transform:uppercase;letter-spacing:1px;">Remove</span>
                    </div>
                    <div id="tm-proj-list">
                        ${projectConfig.map((p, idx) => renderProjectRow(p, idx)).join('')}
                    </div>
                </div>

                <div style="margin-top:14px;padding:10px 14px;background:#1A1A2E;border:1px solid #2A2A4A;border-radius:8px;">
                    <span style="color:#8888AA;font-size:11px;">SLA alert fires <strong style="color:#F0A830;">5 minutes before</strong> the deadline (validation &amp; stitching only). Changes take effect on next refresh.</span>
                </div>
            </div>
        `;
    }

    function renderProjectRow(p, idx) {
        const col = pc(p.name);
        const bg = idx % 2 === 0 ? '#0E0E1E' : '#0A0A18';
        return `
            <div class="tm-proj-row" data-idx="${idx}" style="display:grid;grid-template-columns:1fr 100px 140px 70px;padding:11px 16px;border-bottom:1px solid #1A1A2E;background:${bg};align-items:center;">
                <div style="display:flex;align-items:center;gap:10px;">
                    <div style="width:8px;height:8px;border-radius:50%;background:${col};flex-shrink:0;"></div>
                    <span style="color:${col};font-weight:600;font-size:13px;">${p.name}</span>
                </div>
                <div>
                    <span style="color:#E8E8F0;font-weight:600;font-size:14px;">${slaDisplay(p.sla)}</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <input class="tm-sla-edit tm-input-sm" data-idx="${idx}" type="text" value="${slaDisplay(p.sla)}" placeholder="15 or 1:30" style="width:80px;">
                    <button class="tm-sla-save tm-btn-xs-ok" data-idx="${idx}">Save</button>
                </div>
                <div>
                    <button class="tm-proj-del tm-btn-xs-del" data-idx="${idx}">✕</button>
                </div>
            </div>
        `;
    }

    // ---- SUMMARY CARDS ----
    function makeSummaryCards(data) {
        if (!showProjectSummary) return '';
        const projects = getProjects();
        const stats = {};
        projects.forEach(p => stats[p] = { s: 0, v: 0, vt: 0, ve: 0, tot: 0 });
        data.forEach(r => {
            const p = r["Project Name"], t = r["Task Type"];
            if (stats[p]) { stats[p].tot++; if (t === 'stitching') stats[p].s++; else if (t === 'validation') stats[p].v++; else if (t === 'voting') stats[p].vt++; else if (t === 'voting_engine') stats[p].ve++; }
        });
        const active = Object.keys(stats).filter(p => stats[p].tot > 0);
        if (!active.length) return '<div style="color:#8888AA;font-size:13px;padding:12px 0;">No active projects</div>';

        // Overdue only counts SLA-tracked tasks (validation + stitching)
        const overdue = data.filter(r => r.isSlaTracked && r.remainingSeconds !== null && r.remainingSeconds <= 0).length;
        const statsBar = `<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:#2A2A4A;border-radius:10px;overflow:hidden;margin-bottom:16px;">
            ${[
                ['Tasks', data.length, '#3B9EE8'],
                ['Projects', active.length, '#22C9A0'],
                ['Stitching', data.filter(r => r["Task Type"]==='stitching').length, '#E85D75'],
                ['Validation', data.filter(r => r["Task Type"]==='validation').length, '#9B72D8'],
                ['Voting', data.filter(r => r["Task Type"]==='voting').length, '#E8844A'],
                ['Overdue', overdue, overdue > 0 ? '#E85D75' : '#8888AA'],
            ].map(([label, val, col]) => `
            <div style="text-align:center;padding:12px 6px;background:#0E0E1E;${label==='Overdue'&&val>0?'background:#1C0A10;':''}">
                <div style="font-size:20px;color:${col};font-weight:700;line-height:1;">${val}</div>
                <div style="font-size:9px;color:#8888AA;letter-spacing:1px;text-transform:uppercase;font-weight:600;margin-top:4px;">${label}</div>
            </div>`).join('')}
        </div>`;

        const cards = active.map(p => {
            const s = stats[p], col = pc(p), sel = activeFilters.project === p;
            const sla = getSLA(p);
            const projTasks = data.filter(r => r["Project Name"] === p);
            // hasOverdue and hasCritical only for SLA-tracked tasks
            const hasOverdue = projTasks.some(r => r.isSlaTracked && r.remainingSeconds !== null && r.remainingSeconds <= 0);
            const hasCritical = projTasks.some(r => r.isSlaTracked && r.remainingSeconds !== null && r.remainingSeconds > 0 && r.remainingSeconds <= 300);
            const borderCol = sel ? col : hasOverdue ? '#E85D75' : '#2A2A4A';
            const bgCol = sel ? col + '18' : hasOverdue ? '#1C0A1088' : '#0E0E1E';
            const typeChips = [
                s.s ? `<span style="background:#E85D7520;color:#E85D75;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:600;">S:${s.s}</span>` : '',
                s.v ? `<span style="background:#9B72D820;color:#9B72D8;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:600;">V:${s.v}</span>` : '',
                s.vt ? `<span style="background:#E8844A20;color:#E8844A;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:600;">RV:${s.vt}</span>` : '',
                s.ve ? `<span style="background:#3B9EE820;color:#3B9EE8;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:600;">EV:${s.ve}</span>` : ''
            ].filter(Boolean).join('');
            return `<div class="tm-pcard" data-project="${p}" style="display:inline-flex;align-items:center;gap:8px;background:${bgCol};border:1px solid ${borderCol};border-radius:10px;padding:7px 12px;cursor:pointer;margin:3px;transition:all 0.15s;">
                ${hasOverdue ? '<span style="font-size:9px;background:#E85D75;color:#fff;padding:1px 6px;border-radius:10px;font-weight:700;font-size:10px;">!</span>' : hasCritical ? '<span style="font-size:9px;background:#F0A830;color:#1C1C2E;padding:1px 6px;border-radius:10px;font-weight:700;font-size:10px;">!</span>' : ''}
                <span style="color:${col};font-weight:600;font-size:12px;">${p}</span>
                <span style="background:${col};color:#0A0A18;font-weight:700;font-size:10px;padding:1px 8px;border-radius:10px;">${s.tot}</span>
                <span style="color:#8888AA;font-size:10px;">SLA:${slaDisplay(sla)}</span>
                ${typeChips}
                ${sel ? `<span style="color:${col};font-size:11px;margin-left:2px;">✕</span>` : ''}
            </div>`;
        }).join('');

        return `<div style="margin-bottom:16px;">
            ${statsBar}
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
                <span style="color:#8888AA;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Active Projects — click to filter</span>
                ${activeFilters.project !== 'all' && activeFilters.project !== 'my_project' ? `<span class="tm-clrproj" style="color:#E85D75;font-size:11px;cursor:pointer;border:1px solid #E85D7555;padding:2px 10px;border-radius:10px;background:#E85D7510;">✕ clear filter</span>` : ''}
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:2px;">${cards}</div>
        </div>`;
    }

    // ---- LONG TASKS PANEL ----
    function makeLongPanel(data) {
        const long = data.filter(r => r.durationSeconds > 480);
        if (!long.length) return '';
        const rows = long.sort((a, b) => b.durationSeconds - a.durationSeconds).map(r => {
            const col = pc(r["Project Name"]), pct = Math.min((r.durationSeconds / 900) * 100, 100);
            const bc = pct > 80 ? '#E85D75' : pct > 50 ? '#F0A830' : '#22C9A0';
            return `<div style="display:flex;gap:12px;padding:10px 16px;border-bottom:1px solid #1A1A2E;align-items:center;" onmouseover="this.style.background='#1A1A2E'" onmouseout="this.style.background='transparent'">
                <span style="color:#C8C8E0;flex:2;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.Email}</span>
                <span style="color:${getTaskTypeColor(r['Task Type'])};flex:1;font-size:12px;font-weight:600;">${r["Task Type"]}</span>
                <span style="color:${col};flex:1.5;font-weight:600;font-size:12px;">${r["Project Name"]}</span>
                <div style="flex:2;display:flex;align-items:center;gap:10px;">
                    <div style="flex:1;height:4px;background:#2A2A4A;border-radius:2px;overflow:hidden;">
                        <div style="width:${pct}%;height:100%;background:${bc};border-radius:2px;transition:width 0.5s;"></div>
                    </div>
                    <span style="color:${bc};font-weight:600;font-size:12px;white-space:nowrap;">${r.Duration}</span>
                </div>
            </div>`;
        }).join('');
        return `<div style="margin-top:16px;border:1px solid #E85D7530;border-radius:10px;overflow:hidden;background:#0E0E1E;">
            <div class="tm-longhead" style="padding:10px 16px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #E85D7518;">
                <span style="color:#E85D75;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Long Tasks &gt;8min <span style="background:#E85D7520;color:#E85D75;padding:1px 9px;border-radius:10px;margin-left:6px;">${long.length}</span></span>
                <span class="tm-longarrow" style="color:#E85D75;font-size:12px;">▼</span>
            </div>
            <div class="tm-longbody" style="display:none;">${rows}</div>
        </div>`;
    }

    // ---- INJECT UI ----
    const host = document.createElement('div');
    host.id = 'tm-shadow-host';
    host.style.cssText = 'position:fixed;bottom:0;right:0;z-index:2147483647;pointer-events:none;';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
        <style>
            * { box-sizing:border-box; margin:0; padding:0; }

            @keyframes tmPulse { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
            @keyframes tmBlink { 50%{opacity:0.25;} }
            @keyframes tmSlideIn { from{opacity:0;transform:translateX(-50%) translateY(-12px);} to{opacity:1;transform:translateX(-50%) translateY(0);} }
            @keyframes tmFadeIn { from{opacity:0;transform:translateY(6px);} to{opacity:1;transform:translateY(0);} }
            @keyframes tmSpin { from{transform:rotate(0deg);} to{transform:rotate(360deg);} }

            .tm-overdue { color:#E85D75;font-weight:700;animation:tmBlink 0.7s infinite; }
            .tm-critical { color:#F0A830;font-weight:600;animation:tmBlink 1s infinite; }
            .tm-warning  { color:#F0A830;font-weight:600; }
            .tm-ok       { color:#8888AA;font-weight:500; }

            .tm-stat-ok  { color:#22C9A0;font-size:11px; }
            .tm-stat-err { color:#E85D75;font-size:11px; }

            .tm-pcard:hover { transform:translateY(-2px);filter:brightness(1.15); }

            .tm-tab {
                padding:6px 14px;border:none;border-radius:7px;cursor:pointer;
                font-size:12px;font-weight:500;transition:all 0.15s;
                color:#8888AA;background:transparent;
                font-family:-apple-system,system-ui,sans-serif;
            }
            .tm-tab-on { background:#1A2840;color:#3B9EE8; }
            .tm-tab:hover:not(.tm-tab-on) { background:#1A1A2E;color:#C8C8E0; }

            .tm-qbtn {
                padding:5px 12px;border-radius:8px;cursor:pointer;
                border:1px solid #2A2A4A;font-size:11px;font-weight:500;
                transition:all 0.15s;background:#0E0E1E;color:#8888AA;
                font-family:-apple-system,system-ui,sans-serif;
            }
            .tm-qbtn:hover { background:#1A1A2E;color:#C8C8E0;border-color:#3A3A5A; }
            .tm-qbtn-on { border-color:#3B9EE8;color:#3B9EE8;background:#1A2840; }

            .tm-abtn {
                padding:5px 12px;border:1px solid #2A2A4A;border-radius:8px;cursor:pointer;
                font-size:11px;font-weight:500;transition:all 0.15s;background:#0E0E1E;
                font-family:-apple-system,system-ui,sans-serif;
            }
            .tm-abtn:hover { filter:brightness(1.3);transform:translateY(-1px); }
            .tm-abtn-loading { opacity:0.4;cursor:not-allowed; }

            .tm-btn-primary {
                padding:8px 18px;background:#3B9EE8;color:#fff;border:none;border-radius:8px;
                cursor:pointer;font-size:12px;font-weight:600;transition:all 0.15s;white-space:nowrap;
                font-family:-apple-system,system-ui,sans-serif;
            }
            .tm-btn-primary:hover { background:#2A8ED8;transform:translateY(-1px); }

            .tm-btn-ghost {
                padding:6px 14px;background:transparent;border-radius:8px;
                cursor:pointer;font-size:11px;font-weight:500;transition:all 0.15s;
                font-family:-apple-system,system-ui,sans-serif;
            }
            .tm-btn-danger { color:#E85D75;border:1px solid #E85D7540; }
            .tm-btn-danger:hover { background:#E85D7515; }

            .tm-btn-xs-ok {
                padding:4px 8px;background:#22C9A018;color:#22C9A0;border:1px solid #22C9A040;
                border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;
                font-family:-apple-system,system-ui,sans-serif;transition:all 0.15s;
            }
            .tm-btn-xs-ok:hover { background:#22C9A030; }
            .tm-btn-xs-del {
                padding:4px 10px;background:#E85D7518;color:#E85D75;border:1px solid #E85D7540;
                border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;
                font-family:-apple-system,system-ui,sans-serif;transition:all 0.15s;
            }
            .tm-btn-xs-del:hover { background:#E85D7530; }

            .tm-input {
                width:100%;padding:8px 12px;background:#0A0A18;border:1px solid #2A2A4A;
                border-radius:8px;color:#E8E8F0;font-size:13px;outline:none;transition:border 0.15s;
                caret-color:#3B9EE8;font-family:-apple-system,system-ui,sans-serif;
            }
            .tm-input::placeholder { color:#555570; }
            .tm-input:focus { border-color:#3B9EE855;box-shadow:0 0 0 2px #3B9EE815; }

            .tm-input-sm {
                width:65px;padding:4px 8px;background:#0A0A18;border:1px solid #2A2A4A;
                border-radius:6px;color:#E8E8F0;font-size:12px;outline:none;transition:border 0.15s;
                font-family:-apple-system,system-ui,sans-serif;
            }
            .tm-input-sm:focus { border-color:#22C9A055; }

            .tm-searchbox {
                width:100%;padding:9px 14px 9px 38px;
                border:1px solid #2A2A4A;border-radius:9px;
                background:#0A0A18;color:#E8E8F0;font-size:13px;
                outline:none;transition:all 0.15s;caret-color:#3B9EE8;
                font-family:-apple-system,system-ui,sans-serif;
            }
            .tm-searchbox::placeholder { color:#555570; }
            .tm-searchbox:focus { border-color:#3B9EE855;box-shadow:0 0 0 3px #3B9EE810; }

            .tm-sel {
                padding:7px 28px 7px 10px;border-radius:8px;
                background:#0A0A18;color:#E8E8F0;border:1px solid #2A2A4A;
                font-size:11px;font-weight:500;cursor:pointer;outline:none;
                -webkit-appearance:none;appearance:none;
                background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%233B9EE8' stroke-width='1.5' stroke-linecap='round' fill='none'/%3E%3C/svg%3E");
                background-repeat:no-repeat;background-position:right 9px center;
                transition:border 0.15s;font-family:-apple-system,system-ui,sans-serif;
            }
            .tm-sel:focus { border-color:#3B9EE855; }
            .tm-sel option { background:#0E0E1E;color:#E8E8F0; }

            .tm-content::-webkit-scrollbar { width:4px; }
            .tm-content::-webkit-scrollbar-track { background:transparent; }
            .tm-content::-webkit-scrollbar-thumb { background:#2A2A4A;border-radius:2px; }
            .tm-content::-webkit-scrollbar-thumb:hover { background:#3A3A5A; }

            .tm-monitor {
                position:fixed;bottom:10px;right:15px;
                width:1350px;max-height:85vh;
                background:#0A0A18;
                color:#E8E8F0;
                border:1px solid #2A2A4A;
                border-radius:14px;
                box-shadow:0 24px 64px rgba(0,0,0,0.8),0 0 0 1px rgba(255,255,255,0.04);
                font-family:-apple-system,system-ui,BlinkMacSystemFont,'Segoe UI',sans-serif;
                pointer-events:all;overflow:hidden;
                animation:tmFadeIn 0.25s ease;
            }

            .tm-header {
                padding:12px 18px;display:flex;justify-content:space-between;align-items:center;
                cursor:move;background:#0E0E1E;border-bottom:1px solid #1E1E38;flex-wrap:wrap;gap:8px;
                position:relative;
            }
            .tm-header-bar {
                position:absolute;top:0;left:0;right:0;height:2px;
                background:linear-gradient(90deg,#E85D75,#9B72D8,#3B9EE8,#22C9A0,#F0A830,#E85D75);
                background-size:300% 100%;animation:tmSlide 6s linear infinite;
            }
            @keyframes tmSlide { 0%{background-position:0% 50%} 100%{background-position:300% 50%} }

            .tm-toolbar {
                display:flex;align-items:center;justify-content:space-between;
                padding:10px 18px;gap:10px;background:#0E0E1E;
                border-bottom:1px solid #1E1E38;flex-wrap:wrap;
            }

            .tm-searchrow {
                padding:10px 18px 0;background:#0A0A18;position:relative;
            }
            .tm-searchrow .icon {
                position:absolute;left:31px;top:50%;transform:translateY(-50%);
                color:#555570;font-size:13px;pointer-events:none;
            }

            .tm-droprow {
                display:flex;gap:8px;align-items:center;
                padding:8px 18px 10px;background:#0A0A18;
                border-bottom:1px solid #1E1E38;
            }

            .tm-proj-row:hover { background:#161626 !important; }

            th[data-sort]:hover { color:#3B9EE8 !important; }

            .tm-tr-hover:hover { background:rgba(59,158,232,0.04) !important; }
        </style>

        <div class="tm-monitor">
            <div class="tm-header" id="tm-header">
                <div class="tm-header-bar"></div>
                <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                    <div style="display:flex;align-items:center;gap:9px;">
                        <div style="width:8px;height:8px;border-radius:50%;background:#22C9A0;animation:tmPulse 2.5s infinite;"></div>
                        <span style="font-size:13px;font-weight:700;color:#E8E8F0;letter-spacing:0.5px;">TEAM MONITOR</span>
                        <span style="font-size:10px;background:#1A2840;border:1px solid #3B9EE840;padding:2px 9px;border-radius:6px;color:#3B9EE8;letter-spacing:1px;font-weight:600;">v8.1</span>
                    </div>
                    <span class="tm-ts" style="color:#555570;font-size:11px;font-family:'Courier New',monospace;"></span>
                    <span id="tm-fbstat" style="font-size:11px;color:#F0A830;">Connecting...</span>
                    <span class="tm-projstat" style="font-size:11px;"></span>
                    <span style="font-size:10px;background:#9B72D820;border:1px solid #9B72D840;padding:2px 8px;border-radius:5px;color:#9B72D8;letter-spacing:0.5px;">SLA: Validation &amp; Stitching only</span>
                </div>
                <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;">
                    <button class="tm-abtn tm-btn-refresh" style="color:#3B9EE8;border-color:#3B9EE840;">↻ Refresh</button>
                    <button class="tm-abtn tm-btn-reset" style="color:#E85D75;border-color:#E85D7540;">Reset</button>
                    <div style="width:1px;height:16px;background:#2A2A4A;margin:0 2px;"></div>
                    <button class="tm-abtn tm-btn-exall" style="color:#22C9A0;border-color:#22C9A040;">↓ All</button>
                    <button class="tm-abtn tm-btn-excur" style="color:#F0A830;border-color:#F0A83040;">↓ Current</button>
                    <button class="tm-abtn tm-btn-exvot" style="color:#9B72D8;border-color:#9B72D840;">↓ Voting</button>
                    <div style="width:1px;height:16px;background:#2A2A4A;margin:0 2px;"></div>
                    <button class="tm-abtn tm-btn-fs" style="color:#3B9EE8;border-color:#3B9EE840;">⛶ Full</button>
                    <button class="tm-abtn tm-btn-close" style="color:#E85D75;border-color:#E85D7540;font-size:15px;padding:4px 10px;">×</button>
                </div>
            </div>

            <div class="tm-toolbar">
                <div style="display:flex;gap:2px;background:#0A0A18;padding:3px;border-radius:9px;border:1px solid #1E1E38;">
                    <button class="tm-tab tm-tab-on" data-tab="team">Team Status</button>
                    <button class="tm-tab" data-tab="history">History</button>
                    <button class="tm-tab" data-tab="projects" style="color:#F0A830;">⚙ Projects</button>
                </div>
                <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;">
                    <button class="tm-qbtn tm-qbtn-on" data-qf="all">All</button>
                    <button class="tm-qbtn" data-qf="my_project">My Projects</button>
                    <button class="tm-qbtn" data-qf="sv" style="color:#E8844A;border-color:#E8844A40;">S + V</button>
                    <button class="tm-qbtn" data-qf="stitch" style="color:#E85D75;border-color:#E85D7540;">Stitching</button>
                    <button class="tm-qbtn" data-qf="valid" style="color:#9B72D8;border-color:#9B72D840;">Validation</button>
                    <div style="width:1px;height:16px;background:#2A2A4A;margin:0 2px;"></div>
                    <button class="tm-abtn tm-btn-togsumm" style="color:#22C9A0;border-color:#22C9A040;font-size:11px;">Hide Summary</button>
                </div>
            </div>

            <div class="tm-searchrow">
                <span class="icon">⌕</span>
                <input type="text" id="tm-search" class="tm-searchbox" placeholder="Search email, project, task type, object ID...">
            </div>

            <div class="tm-droprow">
                <select id="tm-proj-sel" class="tm-sel" style="min-width:150px;">
                    <option value="all">All Projects</option>
                    <option value="my_project">My Projects</option>
                    ${projectConfig.map(p => `<option value="${p.name}">${p.name}</option>`).join('')}
                </select>
                <select id="tm-type-sel" class="tm-sel" style="min-width:150px;">
                    <option value="all">All Task Types</option>
                    <option value="stitching_validation">Stitch + Validation</option>
                    ${taskTypes.map(t => `<option value="${t}">${t}</option>`).join('')}
                </select>
                <span style="color:#555570;font-size:11px;margin-left:4px;">Use dropdowns or quick filters above</span>
            </div>

            <div class="tm-content" style="padding:16px 18px;overflow:auto;max-height:calc(85vh - 220px);"></div>
        </div>
    `;

    const S = sel => shadow.querySelector(sel);
    const SA = sel => shadow.querySelectorAll(sel);

    firebaseStatusElement = { html: html => { const el = S('#tm-fbstat'); if (el) el.innerHTML = html; } };

    function rebuildProjectDropdown() {
        const sel = S('#tm-proj-sel');
        if (!sel) return;
        sel.innerHTML = `<option value="all">All Projects</option><option value="my_project">My Projects</option>${projectConfig.map(p => `<option value="${p.name}">${p.name}</option>`).join('')}`;
        sel.value = activeFilters.project;
    }

    // ---- DRAG ----
    let dragActive = false, initialX, initialY;
    S('#tm-header').addEventListener('mousedown', e => {
        if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
        if (isFullscreen) return;
        initialX = e.clientX - xOffset; initialY = e.clientY - yOffset; dragActive = true;
    });
    document.addEventListener('mousemove', e => {
        if (!dragActive) return;
        e.preventDefault();
        xOffset = e.clientX - initialX; yOffset = e.clientY - initialY;
        S('.tm-monitor').style.transform = `translate(${xOffset}px,${yOffset}px)`;
    });
    document.addEventListener('mouseup', () => dragActive = false);

    // ---- RENDER ----
    function renderTeamTableInner(data) {
        const q = S('#tm-search').value.toLowerCase();
        let f = applyFilters(data);
        if (q) f = f.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(q)));
        const sorted = sortData(f, sortColumn, sortDirection);
        const si = col => sortColumn === col ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : '';

        const TH = `padding:10px 16px;text-align:left;font-size:10px;font-weight:600;color:#8888AA;letter-spacing:0.8px;text-transform:uppercase;border-bottom:1px solid #1E1E38;cursor:pointer;user-select:none;white-space:nowrap;background:#0C0C1C;`;

        const rows = sorted.map((r, i) => {
            const col = pc(r["Project Name"]);
            const ttcol = getTaskTypeColor(r["Task Type"]);
            const isLong = r.durationSeconds > 480;
            // isOverdue and isCritical only meaningful for SLA-tracked tasks
            const isOverdue = r.isSlaTracked && r.remainingSeconds !== null && r.remainingSeconds <= 0;
            const isCritical = r.isSlaTracked && r.remainingSeconds !== null && r.remainingSeconds > 0 && r.remainingSeconds <= 300;
            const dc = r.durationSeconds > 480 ? '#E85D75' : r.durationSeconds > 240 ? '#F0A830' : '#22C9A0';
            const rb = isOverdue ? '#140810' : i % 2 === 0 ? '#0C0C1A' : '#0A0A18';
            const emailL = r.Email.split('@')[0];
            const emailD = r.Email.includes('@') ? '@' + r.Email.split('@')[1] : '';
            const statusBadge = isOverdue
                ? `<span style="color:#E85D75;font-size:10px;font-weight:600;background:#E85D7518;padding:3px 10px;border-radius:6px;border:1px solid #E85D7540;animation:tmBlink 0.7s infinite;">Overdue</span>`
                : isCritical
                    ? `<span style="color:#F0A830;font-size:10px;font-weight:600;background:#F0A83018;padding:3px 10px;border-radius:6px;border:1px solid #F0A83040;animation:tmBlink 1s infinite;">Critical</span>`
                    : isLong
                        ? `<span style="color:#E8844A;font-size:10px;font-weight:600;background:#E8844A18;padding:3px 10px;border-radius:6px;border:1px solid #E8844A40;">High</span>`
                        : `<span style="color:#22C9A0;font-size:10px;font-weight:600;background:#22C9A018;padding:3px 10px;border-radius:6px;border:1px solid #22C9A040;">OK</span>`;

            return `<tr class="tm-tr-hover" style="background:${rb};transition:background 0.1s;">
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <div style="width:6px;height:6px;border-radius:50%;background:${dc};flex-shrink:0;"></div>
                        <span style="color:#E8E8F0;font-size:12px;">${emailL}</span><span style="color:#555570;font-size:12px;">${emailD}</span>
                    </div>
                </td>
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;">
                    <span style="color:${ttcol};font-weight:600;padding:2px 10px;background:${ttcol}18;border-radius:6px;font-size:11px;border:1px solid ${ttcol}30;">${r["Task Type"]}</span>
                </td>
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;">
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span style="background:${col}18;color:${col};padding:2px 10px;border-radius:6px;font-weight:600;font-size:11px;border:1px solid ${col}30;">${r["Project Name"]}</span>
                        ${r.isSlaTracked ? `<span style="color:#555570;font-size:9px;">SLA:${slaDisplay(r.slaMinutes)}</span>` : ''}
                    </div>
                </td>
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;color:#8888AA;font-family:'Courier New',monospace;font-size:11px;">${r["Object ID"]}</td>
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;">
                    <span style="color:${dc};font-weight:600;font-size:12px;">${r.Duration}</span>${isLong ? ' <span style="color:#E85D75;font-size:10px;">▲</span>' : ''}
                </td>
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;font-size:12px;">${r["Remaining Time"]}</td>
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;color:#666688;font-family:'Courier New',monospace;font-size:11px;">${r["Creation Date"]}</td>
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;">${statusBadge}</td>
            </tr>`;
        }).join('');

        const empty = !sorted.length ? `<tr><td colspan="8" style="text-align:center;padding:60px;color:#555570;font-size:13px;"><div style="font-size:32px;opacity:0.15;margin-bottom:12px;">⊘</div>No tasks match current filters</td></tr>` : '';

        S('.tm-content').innerHTML = `
            ${makeSummaryCards(data)}
            <div style="margin-bottom:10px;display:flex;align-items:center;gap:8px;">
                <span style="color:#8888AA;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Showing</span>
                <span style="color:#3B9EE8;font-weight:700;font-size:15px;">${sorted.length}</span>
                <span style="color:#8888AA;font-size:11px;">tasks</span>
                ${f.length !== data.length ? `<span style="color:#F0A830;font-size:11px;background:#F0A83010;padding:2px 8px;border-radius:6px;border:1px solid #F0A83030;">filtered from ${data.length}</span>` : ''}
            </div>
            <div style="overflow-x:auto;border-radius:10px;border:1px solid #1E1E38;">
            <table style="width:100%;border-collapse:collapse;min-width:900px;">
                <thead>
                    <tr>
                        <th style="${TH}" data-sort="Email">Email${si('Email')}</th>
                        <th style="${TH}" data-sort="Task Type">Task Type${si('Task Type')}</th>
                        <th style="${TH}" data-sort="Project Name">Project${si('Project Name')}</th>
                        <th style="${TH}" data-sort="Object ID">Object ID</th>
                        <th style="${TH}" data-sort="Duration">Duration${si('Duration')}</th>
                        <th style="${TH}" data-sort="Remaining Time">Remaining (S+V only)${si('Remaining Time')}</th>
                        <th style="${TH}" data-sort="Creation Date">Created${si('Creation Date')}</th>
                        <th style="${TH}">Status</th>
                    </tr>
                </thead>
                <tbody>${rows || empty}</tbody>
            </table>
            </div>
            ${makeLongPanel(data)}
        `;
    }

    function renderHistoryTableInner() {
        const q = S('#tm-search').value.toLowerCase();
        let all = Array.from(allTasksHistory.values());
        if (q) all = all.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(q)));
        const TH = `padding:10px 16px;text-align:left;font-size:10px;font-weight:600;color:#8888AA;letter-spacing:0.8px;text-transform:uppercase;border-bottom:1px solid #1E1E38;background:#0C0C1C;`;
        const rows = all.slice(-100).reverse().map((r, i) => {
            const rb = i % 2 === 0 ? '#0C0C1A' : '#0A0A18';
            const ttcol = getTaskTypeColor(r["Task Type"]);
            return `<tr class="tm-tr-hover" style="background:${rb};transition:background 0.1s;">
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;color:#E8E8F0;font-size:12px;">${r.Email}</td>
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;"><span style="color:${ttcol};font-weight:600;padding:2px 9px;border-radius:6px;font-size:11px;background:${ttcol}18;border:1px solid ${ttcol}30;">${r["Task Type"]}</span></td>
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;color:${pc(r["Project Name"])};font-weight:600;font-size:12px;">${r["Project Name"]}</td>
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;color:#8888AA;font-family:'Courier New',monospace;font-size:11px;">${r["Object ID"]}</td>
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;color:#22C9A0;font-weight:600;font-size:12px;">${r.Duration}</td>
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;color:#666688;font-family:'Courier New',monospace;font-size:11px;">${r["Creation Date"]}</td>
                <td style="padding:9px 16px;border-bottom:1px solid #1A1A2E;color:#555570;font-size:11px;">${r.recordedAt}</td>
            </tr>`;
        }).join('');
        S('.tm-content').innerHTML = `
            <div style="margin-bottom:12px;display:flex;align-items:center;gap:10px;">
                <span style="color:#8888AA;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Last 100 records</span>
                <span style="background:#1A2840;color:#3B9EE8;font-size:12px;font-weight:600;padding:2px 10px;border-radius:6px;border:1px solid #3B9EE840;">Total: ${all.length}</span>
            </div>
            <div style="overflow-x:auto;border-radius:10px;border:1px solid #1E1E38;">
            <table style="width:100%;border-collapse:collapse;">
                <thead><tr>
                    <th style="${TH}">Email</th><th style="${TH}">Task Type</th><th style="${TH}">Project</th>
                    <th style="${TH}">Object ID</th><th style="${TH}">Duration</th><th style="${TH}">Created (SL)</th><th style="${TH}">Recorded (SL)</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table></div>`;
    }

    function renderProjectsTab() {
        S('.tm-content').style.padding = '0';
        S('.tm-content').innerHTML = renderProjectManagerPanel();
        attachProjectManagerEvents();
    }

    function attachProjectManagerEvents() {
        const addBtn = S('#tm-add-proj-btn');
        const msgEl = S('#tm-add-proj-msg');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                const nameInput = S('#tm-new-proj-name');
                const slaInput = S('#tm-new-proj-sla');
                const name = nameInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
                const sla = parseSlaInput(slaInput.value);
                if (!name) { msgEl.style.color = '#E85D75'; msgEl.textContent = 'Please enter a valid project name.'; return; }
                if (projectConfig.find(p => p.name === name)) { msgEl.style.color = '#F0A830'; msgEl.textContent = `Project "${name}" already exists.`; return; }
                if (!sla) { msgEl.style.color = '#E85D75'; msgEl.textContent = 'Invalid SLA. Use minutes (15), HH:MM (1:30), or 1h30m format.'; return; }
                projectConfig.push({ name, sla });
                saveProjectConfig(projectConfig);
                rebuildProjectDropdown();
                msgEl.style.color = '#22C9A0'; msgEl.textContent = `Project "${name}" added with SLA: ${slaDisplay(sla)}.`;
                nameInput.value = ''; slaInput.value = '15';
                const listEl = S('#tm-proj-list');
                if (listEl) listEl.innerHTML = projectConfig.map((p, idx) => renderProjectRow(p, idx)).join('');
                attachProjectRowEvents();
            });
        }
        const resetBtn = S('#tm-reset-projects');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                if (confirm('Reset to default project list? This will remove any custom projects.')) {
                    projectConfig = JSON.parse(JSON.stringify(DEFAULT_PROJECTS));
                    saveProjectConfig(projectConfig);
                    rebuildProjectDropdown();
                    renderProjectsTab();
                }
            });
        }
        attachProjectRowEvents();
    }

    function attachProjectRowEvents() {
        SA('.tm-sla-save').forEach(btn => {
            btn.addEventListener('click', function () {
                const idx = parseInt(this.dataset.idx);
                const input = shadow.querySelector(`.tm-sla-edit[data-idx="${idx}"]`);
                const newSla = parseSlaInput(input.value);
                if (!newSla) { alert('Invalid SLA. Use minutes (15), HH:MM (1:30), or 1h30m format.'); return; }
                projectConfig[idx].sla = newSla;
                saveProjectConfig(projectConfig);
                input.value = slaDisplay(newSla);
                this.style.background = '#22C9A030'; this.textContent = '✓';
                setTimeout(() => { this.style.background = '#22C9A018'; this.textContent = 'Save'; }, 1400);
            });
        });
        SA('.tm-proj-del').forEach(btn => {
            btn.addEventListener('click', function () {
                const idx = parseInt(this.dataset.idx);
                const name = projectConfig[idx].name;
                if (confirm(`Remove project "${name}"?`)) {
                    projectConfig.splice(idx, 1);
                    saveProjectConfig(projectConfig);
                    rebuildProjectDropdown();
                    if (activeFilters.project === name) activeFilters.project = 'all';
                    const listEl = S('#tm-proj-list');
                    if (listEl) listEl.innerHTML = projectConfig.map((p, idx2) => renderProjectRow(p, idx2)).join('');
                    attachProjectRowEvents();
                }
            });
        });
    }

    function updateProjStatus() {
        const projects = getProjects();
        let ok = 0, err = 0;
        projects.forEach(p => { const s = projectStatus.get(p); if (s) s.status === 'success' ? ok++ : err++; });
        const col = ok === projects.length ? '#22C9A0' : err === projects.length ? '#E85D75' : '#F0A830';
        SA('.tm-projstat').forEach(el => el.innerHTML = `<span style="color:${col};font-size:11px;">${ok}/${projects.length} ok</span>`);
    }

    function renderTab() {
        const t = shadow.querySelector('.tm-tab.tm-tab-on').dataset.tab;
        S('.tm-content').style.padding = '16px 18px';
        if (t === 'team') renderTeamTableInner(currentProcessedData);
        else if (t === 'history') renderHistoryTableInner();
        else if (t === 'projects') renderProjectsTab();
    }

    function setFilter(p, t) {
        activeFilters.project = p; activeFilters.taskType = t;
        S('#tm-proj-sel').value = p; S('#tm-type-sel').value = t;
        SA('.tm-qbtn').forEach(b => b.classList.remove('tm-qbtn-on'));
        if (p === 'all' && t === 'all') shadow.querySelector('.tm-qbtn[data-qf="all"]').classList.add('tm-qbtn-on');
        else if (p === 'my_project') shadow.querySelector('.tm-qbtn[data-qf="my_project"]').classList.add('tm-qbtn-on');
        else if (t === 'stitching_validation') shadow.querySelector('.tm-qbtn[data-qf="sv"]').classList.add('tm-qbtn-on');
        else if (t === 'stitching') shadow.querySelector('.tm-qbtn[data-qf="stitch"]').classList.add('tm-qbtn-on');
        else if (t === 'validation') shadow.querySelector('.tm-qbtn[data-qf="valid"]').classList.add('tm-qbtn-on');
        renderTab();
    }

    function toggleFullscreen() {
        isFullscreen = !isFullscreen;
        const m = S('.tm-monitor'), c = S('.tm-content');
        if (isFullscreen) {
            m.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;max-height:100vh;border-radius:0;transform:none;background:#0A0A18;color:#E8E8F0;border:1px solid #2A2A4A;font-family:-apple-system,system-ui,sans-serif;pointer-events:all;overflow:hidden;';
            c.style.maxHeight = 'calc(100vh - 220px)';
            S('.tm-btn-fs').textContent = '⊡ Exit';
            xOffset = 0; yOffset = 0;
        } else {
            m.style.cssText = `position:fixed;bottom:10px;right:15px;width:1350px;max-height:85vh;background:#0A0A18;color:#E8E8F0;border:1px solid #2A2A4A;border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,0.8),0 0 0 1px rgba(255,255,255,0.04);font-family:-apple-system,system-ui,sans-serif;pointer-events:all;overflow:hidden;transform:translate(${xOffset}px,${yOffset}px);`;
            c.style.maxHeight = 'calc(85vh - 220px)';
            S('.tm-btn-fs').textContent = '⛶ Full';
        }
    }

    async function monitorData() {
        const projects = getProjects();
        const now = Date.now(), data = [];
        try {
            const btn = S('.tm-btn-refresh');
            btn.classList.add('tm-abtn-loading'); btn.textContent = '↻ Loading...';
            const res = await Promise.allSettled(projects.map(p => fetchProject(p)));
            res.forEach(r => {
                if (r.status === 'fulfilled' && !r.value.error && Array.isArray(r.value.data)) {
                    r.value.data.forEach(td => { const row = processDataRow(td, now, r.value.project); if (row) data.push(row); });
                }
            });
            updateProjStatus(); trackTaskChanges(data);
            currentProcessedData = data;
            const activeTab = shadow.querySelector('.tm-tab.tm-tab-on');
            if (activeTab && activeTab.dataset.tab !== 'projects') renderTab();
            const ts = S('.tm-ts'); if (ts) ts.textContent = new Date().toLocaleTimeString();
        } catch (e) {
            console.error(e);
            if (S('.tm-content')) S('.tm-content').innerHTML = `<div style="color:#E85D75;padding:60px;text-align:center;">${e.message}</div>`;
        } finally {
            const btn = S('.tm-btn-refresh');
            btn.classList.remove('tm-abtn-loading'); btn.textContent = '↻ Refresh';
        }
    }

    // ---- EVENTS ----
    SA('.tm-tab').forEach(btn => btn.addEventListener('click', function () {
        SA('.tm-tab').forEach(b => b.classList.remove('tm-tab-on'));
        this.classList.add('tm-tab-on'); renderTab();
    }));

    S('#tm-proj-sel').addEventListener('change', function () { activeFilters.project = this.value; SA('.tm-qbtn').forEach(b => b.classList.remove('tm-qbtn-on')); renderTab(); });
    S('#tm-type-sel').addEventListener('change', function () { activeFilters.taskType = this.value; SA('.tm-qbtn').forEach(b => b.classList.remove('tm-qbtn-on')); renderTab(); });

    SA('.tm-qbtn').forEach(btn => btn.addEventListener('click', function () {
        const q = this.dataset.qf;
        if (q === 'all') setFilter('all', 'all');
        else if (q === 'my_project') setFilter('my_project', 'all');
        else if (q === 'sv') setFilter('all', 'stitching_validation');
        else if (q === 'stitch') setFilter('all', 'stitching');
        else if (q === 'valid') setFilter('all', 'validation');
    }));

    shadow.addEventListener('click', e => {
        if (e.target.classList.contains('tm-pcard') || e.target.closest('.tm-pcard')) {
            const card = e.target.classList.contains('tm-pcard') ? e.target : e.target.closest('.tm-pcard');
            const p = card.dataset.project;
            if (activeFilters.project === p) setFilter('all', activeFilters.taskType);
            else { activeFilters.project = p; S('#tm-proj-sel').value = p; SA('.tm-qbtn').forEach(b => b.classList.remove('tm-qbtn-on')); renderTab(); }
        }
        if (e.target.classList.contains('tm-clrproj')) setFilter('all', activeFilters.taskType);
        if (e.target.hasAttribute('data-sort')) {
            const col = e.target.dataset.sort;
            if (sortColumn === col) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
            else { sortColumn = col; sortDirection = 'desc'; }
            renderTab();
        }
        if (e.target.classList.contains('tm-longhead') || e.target.closest('.tm-longhead')) {
            const body = shadow.querySelector('.tm-longbody');
            const arrow = shadow.querySelector('.tm-longarrow');
            if (body) { body.style.display = body.style.display === 'none' ? 'block' : 'none'; if (arrow) arrow.textContent = body.style.display === 'none' ? '▼' : '▲'; }
        }
    });

    S('#tm-search').addEventListener('input', () => renderTab());
    S('.tm-btn-fs').addEventListener('click', () => toggleFullscreen());
    S('.tm-btn-close').addEventListener('click', () => { S('.tm-monitor').style.display = 'none'; });
    S('.tm-btn-refresh').addEventListener('click', function () { if (!this.classList.contains('tm-abtn-loading')) monitorData(); });
    S('.tm-btn-reset').addEventListener('click', () => {
        if (confirm('Reset all monitoring data?')) {
            totalDurations.clear(); completedTasks.clear(); longTasksHistory.clear();
            votingTasksHistory.clear(); allTasksHistory.clear(); dailyTaskLog.length = 0;
            notifiedTasks.clear(); beepedTasks.clear(); slaWarningNotified.clear();
            ['totalDurations', 'completedTasks', 'longTasksHistory', 'votingTasksHistory', 'allTasksHistory', 'dailyTaskLog'].forEach(k => localStorage.removeItem(k));
            monitorData();
        }
    });
    S('.tm-btn-exall').addEventListener('click', () => exportAllData());
    S('.tm-btn-excur').addEventListener('click', () => exportCurrentData(currentProcessedData));
    S('.tm-btn-exvot').addEventListener('click', () => exportVotingTasks());
    S('.tm-btn-togsumm').addEventListener('click', function () {
        showProjectSummary = !showProjectSummary;
        this.textContent = showProjectSummary ? 'Hide Summary' : 'Show Summary';
        renderTab();
    });

    document.addEventListener('keydown', e => {
        if (e.altKey && (e.key === 'm' || e.key === 'M')) {
            e.preventDefault();
            const m = S('.tm-monitor');
            if (m.style.display === 'none') { m.style.display = ''; monitorData(); }
            else m.style.display = 'none';
        }
    });

    // ---- WORKER ----
    function initWorker() {
        const code = `let id=null;function start(i){if(id)clearInterval(id);id=setInterval(()=>self.postMessage({type:'poll'}),i||5000);self.postMessage({type:'poll'});}start(5000);self.addEventListener('message',e=>{if(e.data.type==='stop'){if(id)clearInterval(id);id=null;}else if(e.data.type==='start')start(e.data.interval);else if(e.data.type==='ping')self.postMessage({type:'pong'});});`;
        const blob = new Blob([code], { type: 'application/javascript' });
        worker = new Worker(URL.createObjectURL(blob));
        worker.onmessage = e => { if (e.data.type === 'poll') monitorData(); };
        worker.onerror = err => { console.error(err); setTimeout(initWorker, 2000); };
        document.addEventListener('visibilitychange', () => { if (!document.hidden) monitorData(); });
    }

    function startAutoRefresh() {
        initWorker();
        setInterval(async () => await updateLiveSnapshot(currentProcessedData), 30000);
    }

    (async function init() {
        await cleanOldFlatSnapshot();
        monitorData();
        startAutoRefresh();
        setTimeout(() => updateLiveSnapshot(currentProcessedData), 10000);
    })();

})();
