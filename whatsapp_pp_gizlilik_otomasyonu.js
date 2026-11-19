/**
 * WhatsApp Web Privacy Suite (v24 Final Studio Edition)
 *
 * WhatsApp Web (web.whatsapp.com) için tam otomatik gizlilik ve kişi yönetim aracı.
 * - Mutlak Fotoğraf Kalkanı (Photo-Guard): Profil fotoğrafı olan kişileri asla işaretlemez.
 * - Çoklu Bölüm Senkronizasyonu: Son görülme, Profil resmi, Hakkımda, Durum ve Gruplar.
 * - 7 Akıllı Gizleme Kriteri, VIP Beyaz / Kara Liste, Katı Hesap Pop-up Kalkanı.
 * - Cihaz İçi Test Merkezi, Zamanlayıcı ve CSV / HTML / TXT / JSON dışa aktarım.
 *
 * Lisans: MIT
 */

(function () {
    if (document.getElementById('wa-pp-privacy-tool')) {
        document.getElementById('wa-pp-privacy-tool').remove();
    }

    const STORAGE_KEYS = {
        WHITELIST: 'wa_ult_whitelist_v15',
        BLACKLIST: 'wa_ult_blacklist_v15',
        KEYWORDS: 'wa_ult_keywords_v15',
        SETTINGS: 'wa_ult_settings_v15',
        SNAPSHOT: 'wa_ult_snapshot_v15',
        LOGS: 'wa_ult_logs_v15'
    };

    function loadJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function saveJSON(key, val) {
        try {
            localStorage.setItem(key, JSON.stringify(val));
        } catch (e) {}
    }

    const legacyWhitelist = localStorage.getItem('wa_ult_whitelist_v14') || localStorage.getItem('wa_ult_whitelist_v13') || '';
    const legacyBlacklist = localStorage.getItem('wa_ult_blacklist_v14') || localStorage.getItem('wa_ult_blacklist_v13') || '';
    const legacyKeywords = localStorage.getItem('wa_ult_keywords_v14') || localStorage.getItem('wa_ult_keywords_v13') || '';

    const savedSettings = loadJSON(STORAGE_KEYS.SETTINGS, {
        speed: 'normal',
        humanJitter: true,
        privacyBlur: false,
        sound: true,
        photoGuardStrict: true,
        desktopNotify: false,
        soundEnabled: true,
        theme: 'whatsapp',
        autoScheduleMin: 0,
        critNoPhoto: true,
        critNoAbout: false,
        critDefaultAbout: false,
        critBusiness: false,
        critRawNumbers: false,
        critForeignNumbers: false,
        critShortOrEmoji: false,
        syncMode: 'unified'
    });

    const state = {
        running: false,
        paused: false,
        minimized: false,
        masterLocked: false,
        masterContactsMap: new Map(),
        masterExcludedKeys: new Set(),
        masterWithPhotoKeys: new Set(),
        duplicateNamesSet: new Set(),
        currentSectionName: '-',
        currentScanned: new Set(),
        currentWithPhoto: new Set(),
        currentSelected: new Set(),
        currentWhitelisted: new Set(),
        currentExtraCriteriaCount: new Set(),
        strictPopupDismissedCount: 0,
        sectionResults: {},
        startTimeMs: 0,
        logs: loadJSON(STORAGE_KEYS.LOGS, []),
        previousSnapshot: loadJSON(STORAGE_KEYS.SNAPSHOT, {})
    };

    // ASLA TIKLANMAMASI GEREKEN YASAKLI SATIR METİNLERİ (Katı hesap pop-up'ını tetikleyen veya alakasız ayarlar)
    const FORBIDDEN_ROW_KEYWORDS = [
        'katı hesap',
        'strict account',
        'gelişmiş',
        'advanced',
        'uygulama kilidi',
        'app lock',
        'engellenen',
        'blocked',
        'canlı konum',
        'live location',
        'aramalar',
        'calls',
        'varsayılan mesaj',
        'disappearing',
        'okundu bilgisi',
        'read receipts',
        'çevrimiçi olduğumu kimler',
        'who can see when i\'m online',
        'son görülme bilginisi ile aynı',
        'same as last seen',
        'daha fazla bilgi',
        'learn more',
        'kapat',
        'birincil cihazınızda'
    ];

    // Ana "Gizlilik" menüsündeki 5 hedef bölüm (Sadece %100 TAM METİN eşleşmesi kullanılır!)
    const PRIVACY_SECTIONS = [
        {
            id: 'last_seen',
            label: 'Son görülme ve çevrimiçi',
            checkedByDefault: true,
            exactTitles: ['son görülme ve çevrimiçi', 'son görülme', 'last seen and online', 'last seen']
        },
        {
            id: 'profile_photo',
            label: 'Profil resmi',
            checkedByDefault: true,
            exactTitles: ['profil resmi', 'profil fotoğrafı', 'profile photo', 'profile picture']
        },
        {
            id: 'about',
            label: 'Hakkımda',
            checkedByDefault: true,
            exactTitles: ['hakkımda', 'about']
        },
        {
            id: 'status',
            label: 'Durum',
            checkedByDefault: true,
            exactTitles: ['durum', 'status', 'durum gizliliği']
        },
        {
            id: 'groups',
            label: 'Gruplar',
            checkedByDefault: false,
            exactTitles: ['gruplar', 'groups']
        }
    ];

    const DEFAULT_ABOUT_PHRASES = [
        'merhaba! whatsapp kullanıyorum',
        'hey there! i am using whatsapp',
        'müsait',
        'available',
        'meşgul',
        'busy',
        'okulda',
        'at school',
        'sinemada',
        'at the movies',
        'işte',
        'at work',
        'pil bitmek üzere',
        'battery about to die',
        'konuşamam, sadece whatsapp',
        'toplantıda',
        'spor salonunda',
        'uyuyor',
        'sadece acil çağrılar'
    ];

    const sleep = (ms) => {
        let finalMs = ms;
        if (savedSettings.humanJitter && ms > 100) {
            const jitter = Math.floor(Math.random() * 60) - 20;
            finalMs = Math.max(60, ms + jitter);
        }
        return new Promise(r => setTimeout(r, finalMs));
    };

    async function waitWhilePaused() {
        while (state.running && state.paused) {
            await sleep(250);
        }
    }

    function normTR(str) {
        return (str || '')
            .toLocaleLowerCase('tr-TR')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Bir metnin yasaklı (tıklanmaması gereken) kelimelerden birini içerip içermediğini kontrol eder
    function isForbiddenText(txt) {
        const n = normTR(txt);
        if (!n) return false;
        return FORBIDDEN_ROW_KEYWORDS.some(bad => n.includes(bad));
    }

    // Tıklanacak elemanı kısa süre yeşil çerçeve ile vurgular (Kullanıcı nereye tıklandığını net görür)
    function highlightElement(el, color = '#00a884') {
        if (!el || !el.style) return;
        const origOutline = el.style.outline;
        el.style.outline = `2px solid ${color}`;
        setTimeout(() => {
            try { el.style.outline = origOutline; } catch (e) {}
        }, 450);
    }

    function sendDesktopNotification(title, body) {
        if (!optNotifyEl || !optNotifyEl.checked) return;
        if ('Notification' in window && Notification.permission === 'granted') {
            try { new Notification(title, { body }); } catch (_) {}
        }
    }

    function playNotificationBeep(type = 'success') {
        if (typeof optSoundEl !== 'undefined' && optSoundEl && !optSoundEl.checked) return;
        if (!savedSettings.sound) return;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            const now = ctx.currentTime;
            if (type === 'success') {
                osc.frequency.setValueAtTime(587.33, now);
                osc.frequency.setValueAtTime(880, now + 0.12);
                gain.gain.setValueAtTime(0.12, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
                osc.start(now);
                osc.stop(now + 0.35);
            } else {
                osc.frequency.setValueAtTime(440, now);
                gain.gain.setValueAtTime(0.1, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
                osc.start(now);
                osc.stop(now + 0.2);
            }
        } catch (e) {}
    }

    function addLog(msg) {
        const timeStr = new Date().toLocaleTimeString('tr-TR');
        state.logs.unshift(`[${timeStr}] ${msg}`);
        if (state.logs.length > 180) state.logs.pop();
        saveJSON(STORAGE_KEYS.LOGS, state.logs);
        renderLogs();
    }

    const styleEl = document.createElement('style');
    styleEl.id = 'wa-ult-style-v24';
    styleEl.textContent = `
        #wa-pp-privacy-tool * { box-sizing: border-box; }
        #wa-pp-privacy-tool ::-webkit-scrollbar { width: 5px; height: 5px; }
        #wa-pp-privacy-tool ::-webkit-scrollbar-thumb { background: rgba(134,150,160,0.35); border-radius: 4px; }
        #wa-pp-privacy-tool ::-webkit-scrollbar-thumb:hover { background: rgba(0,168,132,0.65); }
        @keyframes waPulseDot {
            0%, 100% { box-shadow: 0 0 0 0 rgba(0, 168, 132, 0.7); }
            50% { box-shadow: 0 0 0 6px rgba(0, 168, 132, 0); }
        }
        .wa-pulse-dot { animation: waPulseDot 2s infinite; }
        .wa-ult-tab-btn {
            flex: 1; background: rgba(24, 34, 41, 0.85); color: #8696a0; border: none; border-bottom: 2px solid transparent;
            padding: 9px 3px; font-size: 10.5px; font-weight: 600; cursor: pointer; transition: all 0.2s ease; letter-spacing: 0.1px;
        }
        .wa-ult-tab-btn:hover { color: #d1d7db; background: rgba(32, 44, 51, 0.7); }
        .wa-ult-tab-btn.active { color: #00d9a6; border-bottom-color: #00d9a6; background: rgba(0, 168, 132, 0.12); }
        .wa-ult-badge {
            display: inline-block; padding: 2px 6px; border-radius: 999px; font-size: 9.5px; font-weight: 700;
        }
        .wa-kpi-card {
            background: rgba(17, 27, 33, 0.85); border: 1px solid rgba(42, 57, 66, 0.85); border-radius: 8px;
            padding: 6px 8px; display: flex; flex-direction: column; gap: 2px;
        }
        .wa-kpi-label { font-size: 9.5px; color: #8696a0; letter-spacing: 0.2px; }
        .wa-kpi-val { font-size: 14px; font-weight: 800; line-height: 1.15; }
        .wa-ult-btn {
            border: none; border-radius: 8px; font-weight: 700; cursor: pointer;
            transition: transform 0.12s ease, filter 0.15s ease, box-shadow 0.15s ease;
        }
        .wa-ult-btn:hover { filter: brightness(1.08); transform: translateY(-0.5px); }
        .wa-ult-btn:active { transform: scale(0.98); }
        .wa-hdr-icon-btn {
            background: rgba(24, 34, 41, 0.9); border: 1px solid rgba(42, 57, 66, 0.9); color: #8696a0;
            border-radius: 6px; cursor: pointer; font-size: 11px; padding: 3px 7px; transition: all 0.15s ease;
        }
        .wa-hdr-icon-btn:hover { border-color: #00a884; color: #e9edef; }
        .wa-preset-chip {
            background: #202c33; color: #53bdeb; border: 1px solid #2a3942; border-radius: 12px;
            padding: 3px 8px; font-size: 10px; cursor: pointer; font-weight: 600;
        }
        .wa-preset-chip:hover { background: #2a3942; color: #fff; }
        body.wa-privacy-blur-active [role="dialog"] span[dir="auto"],
        body.wa-privacy-blur-active #pane-side span[dir="auto"],
        body.wa-privacy-blur-active [role="dialog"] img,
        body.wa-privacy-blur-active #pane-side img {
            filter: blur(6px) !important;
            transition: filter 0.2s !important;
        }
        #wa-pp-privacy-tool.wa-ghost-mode {
            opacity: 0.42;
            transition: opacity 0.2s ease;
        }
        #wa-pp-privacy-tool.wa-ghost-mode:hover {
            opacity: 0.98;
        }
    `;
    document.head.appendChild(styleEl);

    if (savedSettings.privacyBlur) {
        document.body.classList.add('wa-privacy-blur-active');
    }

    const panel = document.createElement('div');
    panel.id = 'wa-pp-privacy-tool';
    panel.style.cssText = `
        position: fixed;
        top: 14px;
        right: 14px;
        width: 472px;
        background: rgba(17, 27, 33, 0.96);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        color: #e9edef;
        border: 1px solid rgba(0, 168, 132, 0.38);
        border-radius: 14px;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        box-shadow: 0 18px 48px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.04) inset;
        overflow: hidden;
    `;

    const sectionCheckboxesHtml = PRIVACY_SECTIONS.map(sec => `
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:11.5px; color:#d1d7db;">
            <input type="checkbox" class="wa-sec-cb" value="${sec.id}" ${sec.checkedByDefault ? 'checked' : ''} style="accent-color:#00a884; cursor:pointer;" />
            ${sec.label}
        </label>
    `).join('');

    panel.innerHTML = `
        <div id="wa-ult-header" style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#202c33; border-bottom:1px solid #2a3942; cursor:move; user-select:none;">
            <div style="display:flex; align-items:center; gap:8px;">
                <span class="wa-pulse-dot" style="width:9px; height:9px; border-radius:50%; background:#00d9a6; display:inline-block;"></span>
                <strong style="color:#00a884; font-size:13.5px;">WA Gizlilik Süiti (v24 Final Studio)</strong>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <span id="wa-mini-badge" style="display:none; font-size:10px; color:#ffd279; background:#111b21; padding:2px 6px; border-radius:10px;">0%</span>
                <button id="wa-btn-ghost-toggle" title="Şeffaf İzleme Modu (Arka planı net gör)" style="background:#182229; border:1px solid #2a3942; color:#8696a0; border-radius:5px; cursor:pointer; font-size:11px; padding:2px 6px;">👻</button>
                <button id="wa-btn-theme-toggle" title="Tema Değiştir (Koyu / AMOLED / Zümrüt)" style="background:#182229; border:1px solid #2a3942; color:#8696a0; border-radius:5px; cursor:pointer; font-size:11px; padding:2px 6px;">🎨</button>
                <button id="wa-btn-blur-toggle" title="Gizlilik Maskesi (Blur - Alt+B)" style="background:#182229; border:1px solid #2a3942; color:${savedSettings.privacyBlur ? '#00a884' : '#8696a0'}; border-radius:5px; cursor:pointer; font-size:11px; padding:2px 6px;">🕵️ Blur</button>
                <button id="wa-tool-min" title="Küçült / Büyüt (Alt+M)" style="background:none; border:none; color:#8696a0; cursor:pointer; font-size:14px; padding:2px 5px;">—</button>
                <button id="wa-tool-close" title="Kapat" style="background:none; border:none; color:#8696a0; cursor:pointer; font-size:15px; padding:2px 5px;">✕</button>
            </div>
        </div>

        <div id="wa-ult-body">
            <div style="display:flex; border-bottom:1px solid #2a3942;">
                <button class="wa-ult-tab-btn active" data-tab="tab-auto">⚡ Otomasyon</button>
                <button class="wa-ult-tab-btn" data-tab="tab-criteria">🎯 Kriterler</button>
                <button class="wa-ult-tab-btn" data-tab="tab-explorer">👥 Kişiler (<span id="wa-tab-count">0</span>)</button>
                <button class="wa-ult-tab-btn" data-tab="tab-selftest">🧪 Cihaz İçi Test</button>
                <button class="wa-ult-tab-btn" data-tab="tab-logs">📊 Rapor &amp; Log</button>
            </div>

            <div style="padding:12px; max-height:83vh; overflow-y:auto;">
                <!-- SEKME 1: OTOMASYON -->
                <div id="tab-auto" class="wa-ult-tab-pane" style="display:block;">
                    <div style="background:#182229; border:1px solid #2a3942; padding:8px 10px; border-radius:8px; margin-bottom:8px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                            <span style="font-size:11px; color:#00a884; font-weight:bold;">Sırayla Uygulanacak Gizlilik Bölümleri:</span>
                            <span id="wa-SelectAllSecs" style="font-size:10.5px; color:#53bdeb; cursor:pointer;">Tümünü Seç / Kaldır</span>
                        </div>
                        <div style="display:grid; grid-template-columns:1fr 1fr; gap:5px;">
                            ${sectionCheckboxesHtml}
                        </div>
                    </div>

                    <div style="background:#202c33; padding:10px; border-radius:8px; margin-bottom:8px; font-size:12px; border:1px solid #2a3942;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                            <span style="color:#ffd279; font-size:11.5px; font-weight:bold;">
                                Aktif Bölüm: <span id="wa-active-sec" style="color:#ffffff;">-</span>
                            </span>
                            <span id="wa-timer-text" style="font-size:11px; color:#8696a0;">00:00 | ETA: --:--</span>
                        </div>

                        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:6px; margin-bottom:8px;">
                            <div class="wa-kpi-card">
                                <span class="wa-kpi-label">İncelenen</span>
                                <strong id="wa-scanned-count" class="wa-kpi-val" style="color:#f1f5f9;">0</strong>
                            </div>
                            <div class="wa-kpi-card">
                                <span class="wa-kpi-label">Açık (Fotoğraflı)</span>
                                <strong id="wa-photo-count" class="wa-kpi-val" style="color:#94a3b8;">0</strong>
                            </div>
                            <div class="wa-kpi-card" style="border-color:rgba(0,168,132,0.45);">
                                <span class="wa-kpi-label">Gizlenen</span>
                                <strong id="wa-nophoto-count" class="wa-kpi-val" style="color:#00d9a6;">0</strong>
                            </div>
                            <div class="wa-kpi-card">
                                <span class="wa-kpi-label">Ek Kriter</span>
                                <strong id="wa-extra-count" class="wa-kpi-val" style="color:#fbbf24;">0</strong>
                            </div>
                            <div class="wa-kpi-card">
                                <span class="wa-kpi-label">VIP Korunan</span>
                                <strong id="wa-rule-count" class="wa-kpi-val" style="color:#38bdf8;">0</strong>
                            </div>
                            <div class="wa-kpi-card">
                                <span class="wa-kpi-label">Pop-up Kalkan</span>
                                <strong id="wa-popup-count" class="wa-kpi-val" style="color:#c084fc;">0</strong>
                            </div>
                        </div>

                        <div style="width:100%; background:#111b21; height:7px; border-radius:4px; overflow:hidden; margin-bottom:5px;">
                            <div id="wa-progress-bar" style="width:0%; height:100%; background:linear-gradient(90deg, #00a884, #53bdeb); transition:width 0.25s;"></div>
                        </div>
                        <div title="Canlı Oran Çubuğu: Yeşil=Gizlenen | Gri=Fotoğraflı (Açık) | Mavi=VIP" style="display:flex; width:100%; height:5px; border-radius:3px; overflow:hidden; background:#111b21;">
                            <div id="wa-ratio-hidden" style="width:0%; background:#00a884; transition:width 0.25s;"></div>
                            <div id="wa-ratio-open" style="width:0%; background:#64748b; transition:width 0.25s;"></div>
                            <div id="wa-ratio-vip" style="width:0%; background:#53bdeb; transition:width 0.25s;"></div>
                        </div>
                        <div id="wa-status-text" style="margin-top:6px; font-size:11px; color:#ffd279; line-height:1.35;">Hazır. Katı hesap satırlarına dokunmama koruması (Zero-Misclick) aktif.</div>
                    </div>

                    <div id="wa-diff-banner" style="display:none; background:#1e293b; border:1px solid #38bdf8; color:#bae6fd; padding:6px 9px; border-radius:7px; margin-bottom:7px; font-size:11px; cursor:pointer;" title="Değişen kişileri görmek için tıklayın"></div>
                    <div id="wa-summary-box" style="display:none; background:#182229; border:1px solid #2a3942; padding:8px 10px; border-radius:8px; margin-bottom:8px; font-size:11px;">
                        <div style="color:#00a884; font-weight:bold; margin-bottom:4px;">Bölüm Bazlı Sonuç Özeti:</div>
                        <div id="wa-summary-content" style="color:#d1d7db; line-height:1.5;"></div>
                    </div>

                    <div style="display:flex; flex-direction:column; gap:6px;">
                        <div style="display:flex; gap:6px;">
                            <button id="wa-btn-auto" class="wa-ult-btn" style="flex:1; background:linear-gradient(135deg, #00a884, #00d9a6); color:#0b141a; padding:11px; font-size:12.5px; box-shadow:0 4px 14px rgba(0,168,132,0.35);">
                                ▶ Tam Otomatik Başlat &amp; Eşitle
                            </button>
                            <button id="wa-btn-pause" class="wa-ult-btn" style="display:none; width:95px; background:#f59e0b; color:#111b21; padding:10px; font-size:12px;">
                                ⏸ Duraklat
                            </button>
                        </div>

                        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
                            <button id="wa-btn-only-modal" class="wa-ult-btn" style="background:#2a3942; color:#e9edef; padding:8px; font-size:11.5px;">
                                Açık Pencerede Uygula
                            </button>
                            <button id="wa-btn-dryrun" class="wa-ult-btn" style="background:#1e3a5f; color:#93c5fd; border:1px solid #2563eb; padding:8px; font-size:11.5px;">
                                🔍 Sadece Analiz Et (Seçme)
                            </button>
                        </div>

                        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:5px;">
                            <button id="wa-btn-uncheck-all" class="wa-ult-btn" style="background:#3b2025; color:#ff8a80; border:1px solid #5c2b33; padding:7px 4px; font-size:10.5px;">
                                🗑️ Seçimleri Temizle
                            </button>
                            <button id="wa-btn-invert" class="wa-ult-btn" style="background:#2a2438; color:#c4b5fd; border:1px solid #4c1d95; padding:7px 4px; font-size:10.5px;">
                                🔄 Seçimi Ters Çevir
                            </button>
                            <button id="wa-btn-export-csv" class="wa-ult-btn" style="background:transparent; color:#00a884; border:1px solid #00a884; padding:7px 4px; font-size:10.5px;">
                                📥 Excel (.csv)
                            </button>
                        </div>
                    </div>
                </div>

                <!-- SEKME 2: 7 FARKLI GİZLEME KRİTERİ -->
                <div id="tab-criteria" class="wa-ult-tab-pane" style="display:none;">
                    <div style="background:#182229; border:1px solid #2a3942; padding:8px 9px; border-radius:8px; margin-bottom:8px;">
                        <div style="font-size:10.5px; color:#8696a0; margin-bottom:5px;">⚡ Hazır Kriter Profilleri (Tek Tıkla Yükle):</div>
                        <div style="display:flex; flex-wrap:wrap; gap:5px;">
                            <span class="wa-preset-chip" data-preset="only_nophoto">Sadece Fotoğrafsızlar</span>
                            <span class="wa-preset-chip" data-preset="ghost_hunters">Hayalet Avcısı (Fotoğrafsız + Yazısız)</span>
                            <span class="wa-preset-chip" data-preset="max_privacy">Maksimum Gizlilik (Tümü)</span>
                        </div>
                    </div>

                    <div style="background:#182229; border:1px solid #2a3942; padding:9px; border-radius:8px; margin-bottom:8px; font-size:11.3px;">
                        <div style="color:#00a884; font-weight:bold; margin-bottom:6px;">🎯 Kimler Gizlensin? (7 Akıllı Kriter Motoru):</div>
                        <div style="display:flex; flex-direction:column; gap:5.5px;">
                            <label style="display:flex; align-items:center; gap:7px; cursor:pointer; background:#0d2b24; border:1px solid #00a884; padding:5px 7px; border-radius:6px;">
                                <input type="checkbox" id="wa-opt-photoguard" ${savedSettings.photoGuardStrict !== false ? 'checked' : ''} style="accent-color:#00a884;" />
                                <span style="color:#a7f3d0;">🛡️ <strong>Mutlak Fotoğraf Kalkanı:</strong> Profil fotoğrafı olanı ASLA işaretleme!</span>
                            </label>
                            <label style="display:flex; align-items:center; gap:7px; cursor:pointer;">
                                <input type="checkbox" id="wa-crit-nophoto" ${savedSettings.critNoPhoto ? 'checked' : ''} style="accent-color:#00a884;" />
                                <span>📷 <strong>Profil Fotoğrafı Olmayanları</strong> Gizle</span>
                            </label>
                            <label style="display:flex; align-items:center; gap:7px; cursor:pointer;">
                                <input type="checkbox" id="wa-crit-noabout" ${savedSettings.critNoAbout ? 'checked' : ''} style="accent-color:#00a884;" />
                                <span>📝 <strong>"Hakkımda" Yazısı Boş/Gizli Olanları</strong> Gizle (Fotoğraflı olsa bile)</span>
                            </label>
                            <label style="display:flex; align-items:center; gap:7px; cursor:pointer;">
                                <input type="checkbox" id="wa-crit-defabout" ${savedSettings.critDefaultAbout ? 'checked' : ''} style="accent-color:#00a884;" />
                                <span>💬 <strong>Varsayılan Hakkımda Yazısı</strong> ("Müsait", "Hey there!") Olanları Gizle</span>
                            </label>
                            <label style="display:flex; align-items:center; gap:7px; cursor:pointer;">
                                <input type="checkbox" id="wa-crit-business" ${savedSettings.critBusiness ? 'checked' : ''} style="accent-color:#00a884;" />
                                <span>🏢 <strong>İşletme / Kurumsal Hesapları</strong> Gizle</span>
                            </label>
                            <label style="display:flex; align-items:center; gap:7px; cursor:pointer;">
                                <input type="checkbox" id="wa-crit-rawnum" ${savedSettings.critRawNumbers ? 'checked' : ''} style="accent-color:#00a884;" />
                                <span>📞 <strong>Rehberde Kayıtsız Numaraları (+90...)</strong> Gizle</span>
                            </label>
                            <label style="display:flex; align-items:center; gap:7px; cursor:pointer;">
                                <input type="checkbox" id="wa-crit-foreign" ${savedSettings.critForeignNumbers ? 'checked' : ''} style="accent-color:#00a884;" />
                                <span>🌍 <strong>Yabancı Ülke Kodlu Numaraları (+90 Dışı)</strong> Gizle</span>
                            </label>
                            <label style="display:flex; align-items:center; gap:7px; cursor:pointer;">
                                <input type="checkbox" id="wa-crit-short" ${savedSettings.critShortOrEmoji ? 'checked' : ''} style="accent-color:#00a884;" />
                                <span>🔤 <strong>Tek Harf / Nokta / Sembol İsimlileri</strong> (".", "A", "?") Gizle</span>
                            </label>
                        </div>

                        <div style="margin-top:8px; padding-top:7px; border-top:1px solid #2a3942;">
                            <div style="font-size:11px; color:#f59e0b; font-weight:bold; margin-bottom:4px;">🏷️ İsimde / Etikette Şu Kelimeler Geçenleri Gizle:</div>
                            <input id="wa-keywords-input" type="text" placeholder="Örn: Kurye, Emlak, Staj, 2021, Müşteri (virgülle ayırın)" style="width:100%; background:#202c33; color:#e9edef; border:1px solid #2a3942; border-radius:5px; padding:5px 6px; font-size:11px;" />
                        </div>

                        <div style="margin-top:7px; padding-top:7px; border-top:1px solid #2a3942;">
                            <div style="font-size:11px; color:#53bdeb; font-weight:bold; margin-bottom:4px;">🔄 Bölümler Arası Çalışma Modu:</div>
                            <select id="wa-syncmode-select" style="width:100%; background:#202c33; color:#e9edef; border:1px solid #2a3942; border-radius:5px; padding:5px; font-size:11px;">
                                <option value="unified" ${savedSettings.syncMode === 'unified' ? 'selected' : ''}>Tüm Bölümleri %100 Aynı Listede Eşitle (Önerilen)</option>
                                <option value="per_section" ${savedSettings.syncMode === 'per_section' ? 'selected' : ''}>Bölüme Göre Ayrı Gizle (Profilde Fotoğrafsızları, Hakkımda'da Yazısızları Gizle)</option>
                            </select>
                        </div>
                    </div>

                    <div style="background:#182229; border:1px solid #2a3942; padding:8px 9px; border-radius:8px; margin-bottom:8px;">
                        <div style="font-size:11px; color:#00a884; font-weight:bold; margin-bottom:3px;">🛡️ Beyaz Liste (VIP - Hiçbir Kriterde ASLA Gizleme):</div>
                        <input id="wa-whitelist-input" type="text" placeholder="Virgülle ayırın: Annem, Babam, Eşim" style="width:100%; background:#202c33; color:#e9edef; border:1px solid #2a3942; border-radius:5px; padding:5px 6px; font-size:11px; margin-bottom:6px;" />

                        <div style="font-size:11px; color:#ff8a80; font-weight:bold; margin-bottom:3px;">🚫 Kara Liste (Her Durumda Zorunlu Gizle):</div>
                        <input id="wa-blacklist-input" type="text" placeholder="Virgülle ayırın: Patron, Eski İş" style="width:100%; background:#202c33; color:#e9edef; border:1px solid #2a3942; border-radius:5px; padding:5px 6px; font-size:11px;" />
                    </div>

                    <div style="background:#182229; border:1px solid #2a3942; padding:8px 9px; border-radius:8px; font-size:11px; display:flex; flex-direction:column; gap:6px;">
                        <label style="display:flex; align-items:center; justify-content:space-between; cursor:pointer;">
                            <span>🤖 <strong>Anti-Ban İnsan Davranışı Simülasyonu (Jitter)</strong>:</span>
                            <input type="checkbox" id="wa-opt-jitter" ${savedSettings.humanJitter ? 'checked' : ''} style="accent-color:#00a884;" />
                        </label>
                        <div style="display:flex; align-items:center; justify-content:space-between;">
                            <span>⚡ Kaydırma Hızı:</span>
                            <select id="wa-speed-select" style="background:#202c33; color:#e9edef; border:1px solid #2a3942; border-radius:5px; padding:3px 6px; font-size:11px;">
                                <option value="slow" ${savedSettings.speed === 'slow' ? 'selected' : ''}>Yavaş (Çok Güvenli)</option>
                                <option value="normal" ${savedSettings.speed === 'normal' ? 'selected' : ''}>Normal (Önerilen)</option>
                                <option value="fast" ${savedSettings.speed === 'fast' ? 'selected' : ''}>Hızlı</option>
                                <option value="turbo" ${savedSettings.speed === 'turbo' ? 'selected' : ''}>⚡ Turbo (Çok Hızlı)</option>
                            </select>
                        </div>
                        <div style="display:flex; align-items:center; justify-content:space-between;">
                            <span>⏰ Otomatik Tekrar (Zamanlayıcı):</span>
                            <select id="wa-schedule-select" style="background:#202c33; color:#e9edef; border:1px solid #2a3942; border-radius:5px; padding:3px 6px; font-size:11px;">
                                <option value="0" ${!savedSettings.autoScheduleMin ? 'selected' : ''}>Kapalı</option>
                                <option value="30" ${savedSettings.autoScheduleMin === 30 ? 'selected' : ''}>Her 30 Dakikada</option>
                                <option value="60" ${savedSettings.autoScheduleMin === 60 ? 'selected' : ''}>Her 1 Saatte</option>
                                <option value="180" ${savedSettings.autoScheduleMin === 180 ? 'selected' : ''}>Her 3 Saatte</option>
                            </select>
                        </div>
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                            <label style="display:flex; align-items:center; gap:5px; cursor:pointer;">
                                <input type="checkbox" id="wa-opt-sound" ${savedSettings.soundEnabled !== false ? 'checked' : ''} style="accent-color:#00a884;" />
                                <span>🔊 Sesli Bildirim</span>
                            </label>
                            <label style="display:flex; align-items:center; gap:5px; cursor:pointer;">
                                <input type="checkbox" id="wa-opt-notify" ${savedSettings.desktopNotify ? 'checked' : ''} style="accent-color:#00a884;" />
                                <span>🔔 Masaüstü Bildirimi</span>
                            </label>
                        </div>
                        <div style="font-size:9.8px; color:#8696a0; border-top:1px solid #2a3942; padding-top:4px;">
                            ⌨️ Kısayollar: <strong>Alt+S</strong> Başlat/Durdur • <strong>Alt+P</strong> Duraklat • <strong>Alt+M</strong> Küçült • <strong>Alt+B</strong> Blur
                        </div>
                    </div>
                </div>

                <!-- SEKME 3: KİŞİ GEZGİNİ -->
                <div id="tab-explorer" class="wa-ult-tab-pane" style="display:none;">
                    <div style="display:flex; gap:6px; margin-bottom:6px;">
                        <input id="wa-exp-search" type="text" placeholder="İsim veya Hakkımda yazısı ara..." style="flex:1; background:#202c33; color:#e9edef; border:1px solid #2a3942; border-radius:6px; padding:6px 8px; font-size:11.5px; outline:none;" />
                        <select id="wa-exp-filter" style="background:#202c33; color:#e9edef; border:1px solid #2a3942; border-radius:6px; padding:5px; font-size:11px;">
                            <option value="all">Tümü</option>
                            <option value="excluded">Gizlenenler</option>
                            <option value="hasphoto">🖼️ Fotoğraflılar (Korunan)</option>
                            <option value="nophoto">👤 Fotoğrafsızlar</option>
                            <option value="noabout">📝 Hakkımda Boş</option>
                            <option value="defabout">💬 Varsayılan Hakkımda</option>
                            <option value="business">🏢 İşletme Hesapları</option>
                            <option value="duplicates">👯 Çift Kayıtlar (Aynı İsim)</option>
                            <option value="diff">⚡ Fotoğrafı Değişenler</option>
                        </select>
                    </div>
                    <div style="display:flex; gap:5px; margin-bottom:6px;">
                        <button id="wa-exp-bulk-vip" class="wa-ult-btn" style="flex:1; background:#182229; color:#53bdeb; border:1px solid #2a3942; padding:4px 6px; font-size:10px;">🛡️ Filtrelenenleri VIP Yap</button>
                        <button id="wa-exp-bulk-blk" class="wa-ult-btn" style="flex:1; background:#182229; color:#ff8a80; border:1px solid #2a3942; padding:4px 6px; font-size:10px;">🚫 Filtrelenenleri Kara Listeye Ekle</button>
                    </div>
                    <div id="wa-exp-list" style="max-height:285px; overflow-y:auto; background:#182229; border:1px solid #2a3942; border-radius:8px; padding:6px; font-size:11.5px;">
                        <div style="color:#8696a0; text-align:center; padding:20px;">Henüz tarama yapılmadı.</div>
                    </div>
                </div>

                <!-- SEKME 4: CİHAZ İÇİ TEST & TANI MERKEZİ -->
                <div id="tab-selftest" class="wa-ult-tab-pane" style="display:none;">
                    <div style="background:#182229; border:1px solid #2a3942; padding:10px; border-radius:8px; margin-bottom:8px; font-size:11.5px;">
                        <div style="color:#00a884; font-weight:bold; margin-bottom:4px;">🧪 Cihaz İçi Otomatik Test &amp; Doğrulama Merkezi</div>
                        <div style="color:#8696a0; font-size:11px; line-height:1.4; margin-bottom:8px;">
                            Gerçek WhatsApp ayarlarınıza dokunmadan <strong>12 kritik bileşeni</strong> ve <strong>Yasaklı Satır (Katı Hesap) Filtresini</strong> sanal ortamda test eder.
                        </div>
                        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
                            <button id="wa-btn-run-selftest" class="wa-ult-btn" style="background:#00a884; color:#111b21; padding:9px; font-size:11.5px;">
                                🧪 12 Kapsamlı Cihaz Testini Çalıştır
                            </button>
                            <button id="wa-btn-run-navtest" class="wa-ult-btn" style="background:#2a3942; color:#53bdeb; border:1px solid #53bdeb; padding:9px; font-size:11.5px;">
                                🧭 Canlı Sekme Haritasını Denetle
                            </button>
                        </div>
                    </div>

                    <div id="wa-selftest-summary" style="display:none; background:#202c33; padding:8px 10px; border-radius:8px; margin-bottom:8px; font-size:12px; font-weight:bold; text-align:center;"></div>

                    <div id="wa-selftest-results" style="max-height:245px; overflow-y:auto; background:#182229; border:1px solid #2a3942; border-radius:8px; padding:8px; font-size:11px; line-height:1.5;">
                        <div style="color:#8696a0; text-align:center; padding:16px;">Testleri başlatmak için yukarıdaki butona tıklayın.</div>
                    </div>
                </div>

                <!-- SEKME 5: ANALİZ, YEDEKLEME & LOGLAR -->
                <div id="tab-logs" class="wa-ult-tab-pane" style="display:none;">
                    <div style="background:#182229; border:1px solid #2a3942; padding:9px; border-radius:8px; margin-bottom:8px; font-size:11.5px;">
                        <div style="color:#00a884; font-weight:bold; margin-bottom:4px;">🔄 Rehber Hijyen &amp; Kriter Dağılım Analizi:</div>
                        <div id="wa-diff-summary" style="color:#d1d7db; line-height:1.45;">
                            İlk tarama tamamlandığında detaylı kriter ve rehber hijyen kırılımı burada gösterilir.
                        </div>
                    </div>

                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:5px; margin-bottom:8px;">
                        <button id="wa-btn-export-html" class="wa-ult-btn" style="background:#1e3a5f; color:#93c5fd; padding:7px 4px; font-size:10.5px;">
                            🌐 Görsel Rapor (.html)
                        </button>
                        <button id="wa-btn-export-txt" class="wa-ult-btn" style="background:#202c33; color:#ffd279; border:1px solid #2a3942; padding:7px 4px; font-size:10.5px;">
                            📄 Gizlenenler (.txt)
                        </button>
                        <button id="wa-btn-copy-summary" class="wa-ult-btn" style="background:#0d3b2e; color:#6ee7b7; border:1px solid #00a884; padding:7px 4px; font-size:10.5px;">
                            📋 Özeti Panoya Kopyala
                        </button>
                        <button id="wa-btn-backup-json" class="wa-ult-btn" style="background:#2a3942; color:#e9edef; padding:7px 4px; font-size:10.5px;">
                            💾 Yedekle (.json)
                        </button>
                        <button id="wa-btn-restore-json" class="wa-ult-btn" style="background:#2a3942; color:#53bdeb; padding:7px 4px; font-size:10.5px;">
                            📂 Yedek Yükle
                        </button>
                        <input type="file" id="wa-file-restore" accept=".json" style="display:none;" />
                    </div>

                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="font-size:11px; color:#8696a0; font-weight:bold;">İşlem Geçmişi (Log):</span>
                        <div style="display:flex; gap:8px;">
                            <button id="wa-btn-factory-reset" title="Tüm kayıtlı ayarları varsayılana sıfırla" style="background:none; border:none; color:#ffd279; font-size:10.5px; cursor:pointer;">♻️ Sıfırla</button>
                            <button id="wa-btn-clear-logs" style="background:none; border:none; color:#ff8a80; font-size:10.5px; cursor:pointer;">Temizle</button>
                        </div>
                    </div>
                    <div id="wa-log-box" style="height:175px; overflow-y:auto; background:#182229; border:1px solid #2a3942; border-radius:6px; padding:7px; font-family:monospace; font-size:10.5px; color:#d1d7db; line-height:1.4;"></div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(panel);

    // Sürükle-Bırak
    (function makeDraggable() {
        const header = document.getElementById('wa-ult-header');
        let isDown = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDown = true;
            const rect = panel.getBoundingClientRect();
            origLeft = rect.left;
            origTop = rect.top;
            startX = e.clientX;
            startY = e.clientY;
            panel.style.right = 'auto';
            panel.style.left = `${origLeft}px`;
            panel.style.top = `${origTop}px`;
        });
        window.addEventListener('mousemove', (e) => {
            if (!isDown) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 120, origLeft + dx))}px`;
            panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 60, origTop + dy))}px`;
        });
        window.addEventListener('mouseup', () => { isDown = false; });
    })();

    const tabBtns = panel.querySelectorAll('.wa-ult-tab-btn');
    const tabPanes = panel.querySelectorAll('.wa-ult-tab-pane');
    tabBtns.forEach(btn => {
        btn.onclick = () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => p.style.display = 'none');
            btn.classList.add('active');
            const targetId = btn.getAttribute('data-tab');
            document.getElementById(targetId).style.display = 'block';
            if (targetId === 'tab-explorer') renderContactExplorer();
            if (targetId === 'tab-logs') renderLogs();
        };
    });

    const bodyEl = document.getElementById('wa-ult-body');
    const activeSecEl = document.getElementById('wa-active-sec');
    const timerTextEl = document.getElementById('wa-timer-text');
    const scannedCountEl = document.getElementById('wa-scanned-count');
    const photoCountEl = document.getElementById('wa-photo-count');
    const noPhotoCountEl = document.getElementById('wa-nophoto-count');
    const extraCountEl = document.getElementById('wa-extra-count');
    const ruleCountEl = document.getElementById('wa-rule-count');
    const popupCountEl = document.getElementById('wa-popup-count');
    const progressBarEl = document.getElementById('wa-progress-bar');
    const statusTextEl = document.getElementById('wa-status-text');
    const summaryBoxEl = document.getElementById('wa-summary-box');
    const summaryContentEl = document.getElementById('wa-summary-content');
    const tabCountEl = document.getElementById('wa-tab-count');

    const optPhotoGuardEl = document.getElementById('wa-opt-photoguard');
    const critNoPhotoEl = document.getElementById('wa-crit-nophoto');
    const critNoAboutEl = document.getElementById('wa-crit-noabout');
    const critDefAboutEl = document.getElementById('wa-crit-defabout');
    const critBusinessEl = document.getElementById('wa-crit-business');
    const critRawNumEl = document.getElementById('wa-crit-rawnum');
    const critForeignEl = document.getElementById('wa-crit-foreign');
    const critShortEl = document.getElementById('wa-crit-short');
    const keywordsInputEl = document.getElementById('wa-keywords-input');
    const syncModeSelectEl = document.getElementById('wa-syncmode-select');
    const whitelistInputEl = document.getElementById('wa-whitelist-input');
    const blacklistInputEl = document.getElementById('wa-blacklist-input');
    const optJitterEl = document.getElementById('wa-opt-jitter');
    const speedSelectEl = document.getElementById('wa-speed-select');
    const scheduleSelectEl = document.getElementById('wa-schedule-select');
    const optSoundEl = document.getElementById('wa-opt-sound');
    const optNotifyEl = document.getElementById('wa-opt-notify');
    const miniBadgeEl = document.getElementById('wa-mini-badge');
    const ratioHiddenEl = document.getElementById('wa-ratio-hidden');
    const ratioOpenEl = document.getElementById('wa-ratio-open');
    const ratioVipEl = document.getElementById('wa-ratio-vip');
    let autoScheduleTimer = null;

    const btnAuto = document.getElementById('wa-btn-auto');
    const btnPause = document.getElementById('wa-btn-pause');
    const btnOnlyModal = document.getElementById('wa-btn-only-modal');
    const btnDryRun = document.getElementById('wa-btn-dryrun');
    const btnUncheckAll = document.getElementById('wa-btn-uncheck-all');
    const btnInvert = document.getElementById('wa-btn-invert');
    const btnExportCsv = document.getElementById('wa-btn-export-csv');
    const btnBlurToggle = document.getElementById('wa-btn-blur-toggle');

    whitelistInputEl.value = localStorage.getItem(STORAGE_KEYS.WHITELIST) || legacyWhitelist;
    blacklistInputEl.value = localStorage.getItem(STORAGE_KEYS.BLACKLIST) || legacyBlacklist;
    keywordsInputEl.value = localStorage.getItem(STORAGE_KEYS.KEYWORDS) || legacyKeywords;

    function saveAllRules() {
        localStorage.setItem(STORAGE_KEYS.WHITELIST, whitelistInputEl.value);
        localStorage.setItem(STORAGE_KEYS.BLACKLIST, blacklistInputEl.value);
        localStorage.setItem(STORAGE_KEYS.KEYWORDS, keywordsInputEl.value);
        savedSettings.photoGuardStrict = optPhotoGuardEl.checked;
        savedSettings.critNoPhoto = critNoPhotoEl.checked;
        savedSettings.critNoAbout = critNoAboutEl.checked;
        savedSettings.critDefaultAbout = critDefAboutEl.checked;
        savedSettings.critBusiness = critBusinessEl.checked;
        savedSettings.critRawNumbers = critRawNumEl.checked;
        savedSettings.critForeignNumbers = critForeignEl.checked;
        savedSettings.critShortOrEmoji = critShortEl.checked;
        savedSettings.syncMode = syncModeSelectEl.value;
        savedSettings.humanJitter = optJitterEl.checked;
        savedSettings.speed = speedSelectEl.value;
        savedSettings.soundEnabled = optSoundEl ? optSoundEl.checked : true;
        savedSettings.desktopNotify = optNotifyEl ? optNotifyEl.checked : false;
        savedSettings.autoScheduleMin = scheduleSelectEl ? parseInt(scheduleSelectEl.value, 10) || 0 : 0;
        saveJSON(STORAGE_KEYS.SETTINGS, savedSettings);
        setupAutoScheduler();
    }

    function setupAutoScheduler() {
        if (autoScheduleTimer) {
            clearInterval(autoScheduleTimer);
            autoScheduleTimer = null;
        }
        const mins = savedSettings.autoScheduleMin || 0;
        if (mins > 0) {
            autoScheduleTimer = setInterval(() => {
                if (!state.running && document.getElementById('wa-pp-privacy-tool')) {
                    addLog(`⏰ Zamanlayıcı tetiklendi (${mins} dk), otomatik tarama başlatılıyor...`);
                    runAllSelectedSections('exclude_nophoto');
                }
            }, mins * 60 * 1000);
        }
    }
    setupAutoScheduler();

    [optPhotoGuardEl, critNoPhotoEl, critDefAboutEl, critBusinessEl, critRawNumEl, critForeignEl, critShortEl, keywordsInputEl, syncModeSelectEl, whitelistInputEl, blacklistInputEl, optJitterEl, speedSelectEl, scheduleSelectEl, optSoundEl, optNotifyEl].filter(Boolean).forEach(el => {
        el.addEventListener('change', saveAllRules);
    });

    if (optNotifyEl) {
        optNotifyEl.addEventListener('change', () => {
            if (optNotifyEl.checked && 'Notification' in window && Notification.permission === 'default') {
                Notification.requestPermission();
            }
        });
    }

    const THEMES = {
        whatsapp: { bg: '#111b21', header: '#202c33', border: '#2a3942' },
        amoled: { bg: '#000000', header: '#0d1117', border: '#1f2937' },
        emerald: { bg: '#071a16', header: '#0c2922', border: '#134e4a' }
    };
    const THEME_ORDER = ['whatsapp', 'amoled', 'emerald'];
    function applyTheme(tName) {
        const t = THEMES[tName] || THEMES.whatsapp;
        panel.style.background = t.bg;
        panel.style.borderColor = t.border;
        const hdr = document.getElementById('wa-ult-header');
        if (hdr) hdr.style.background = t.header;
    }
    applyTheme(savedSettings.theme || 'whatsapp');
    const btnGhostToggle = document.getElementById('wa-btn-ghost-toggle');
    if (btnGhostToggle) {
        btnGhostToggle.onclick = () => {
            const active = panel.classList.toggle('wa-ghost-mode');
            btnGhostToggle.style.color = active ? '#00a884' : '#8696a0';
        };
    }

    const diffBannerEl = document.getElementById('wa-diff-banner');
    if (diffBannerEl) {
        diffBannerEl.onclick = () => {
            const expTabBtn = panel.querySelector('.wa-ult-tab-btn[data-tab="tab-explorer"]');
            const expFilter = document.getElementById('wa-exp-filter');
            if (expFilter) expFilter.value = 'diff';
            if (expTabBtn) expTabBtn.click();
        };
    }

    const factoryResetBtn = document.getElementById('wa-btn-factory-reset');
    if (factoryResetBtn) {
        factoryResetBtn.onclick = () => {
            if (!confirm('Tüm kayıtlı kriterler, VIP/Kara liste ve önbellek fabrika ayarlarına sıfırlansın mı?')) return;
            Object.values(STORAGE_KEYS).forEach(k => localStorage.removeItem(k));
            updateUI('♻️ Tüm ayarlar sıfırlandı! Kodu yeniden çalıştırabilirsiniz.');
            addLog('♻️ Fabrika ayarlarına sıfırlandı.');
        };
    }

    const btnThemeToggle = document.getElementById('wa-btn-theme-toggle');
    if (btnThemeToggle) {
        btnThemeToggle.onclick = () => {
            const idx = THEME_ORDER.indexOf(savedSettings.theme || 'whatsapp');
            savedSettings.theme = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
            applyTheme(savedSettings.theme);
            saveJSON(STORAGE_KEYS.SETTINGS, savedSettings);
        };
    }

    btnBlurToggle.onclick = () => {
        savedSettings.privacyBlur = !savedSettings.privacyBlur;
        document.body.classList.toggle('wa-privacy-blur-active', savedSettings.privacyBlur);
        btnBlurToggle.style.color = savedSettings.privacyBlur ? '#00a884' : '#8696a0';
        saveJSON(STORAGE_KEYS.SETTINGS, savedSettings);
    };

    panel.querySelectorAll('.wa-preset-chip').forEach(chip => {
        chip.onclick = () => {
            const p = chip.getAttribute('data-preset');
            if (p === 'only_nophoto') {
                critNoPhotoEl.checked = true;
                critNoAboutEl.checked = false;
                critDefAboutEl.checked = false;
                critBusinessEl.checked = false;
                critRawNumEl.checked = false;
                critForeignEl.checked = false;
                critShortEl.checked = false;
            } else if (p === 'ghost_hunters') {
                critNoPhotoEl.checked = true;
                critNoAboutEl.checked = true;
                critDefAboutEl.checked = false;
                critBusinessEl.checked = false;
                critRawNumEl.checked = true;
                critForeignEl.checked = false;
                critShortEl.checked = true;
            } else if (p === 'max_privacy') {
                critNoPhotoEl.checked = true;
                critNoAboutEl.checked = true;
                critDefAboutEl.checked = true;
                critBusinessEl.checked = true;
                critRawNumEl.checked = true;
                critForeignEl.checked = true;
                critShortEl.checked = true;
            }
            saveAllRules();
            updateUI(`Hazır profil yüklendi: ${chip.textContent}`);
        };
    });

    document.getElementById('wa-SelectAllSecs').onclick = () => {
        const cbs = panel.querySelectorAll('.wa-sec-cb');
        const allChecked = Array.from(cbs).every(c => c.checked);
        cbs.forEach(c => { c.checked = !allChecked; });
    };

    document.getElementById('wa-tool-min').onclick = () => {
        state.minimized = !state.minimized;
        bodyEl.style.display = state.minimized ? 'none' : 'block';
        if (miniBadgeEl) miniBadgeEl.style.display = state.minimized ? 'inline-block' : 'none';
    };

    document.getElementById('wa-tool-close').onclick = () => {
        state.running = false;
        document.body.classList.remove('wa-privacy-blur-active');
        panel.remove();
    };

    btnPause.onclick = () => {
        if (!state.running) return;
        state.paused = !state.paused;
        btnPause.textContent = state.paused ? '▶ Devam' : '⏸ Duraklat';
        btnPause.style.background = state.paused ? '#10b981' : '#f59e0b';
        updateUI(state.paused ? '⏸ İşlem duraklatıldı.' : '▶ İşlem devam ediyor...');
    };

    window.addEventListener('keydown', (e) => {
        if (!document.getElementById('wa-pp-privacy-tool')) return;
        if (e.altKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            btnAuto.click();
        } else if (e.altKey && e.key.toLowerCase() === 'p') {
            e.preventDefault();
            if (state.running) btnPause.click();
        } else if (e.altKey && e.key.toLowerCase() === 'm') {
            e.preventDefault();
            document.getElementById('wa-tool-min').click();
        } else if (e.altKey && e.key.toLowerCase() === 'b') {
            e.preventDefault();
            btnBlurToggle.click();
        }
    });

    setInterval(() => {
        if (!state.running || state.paused || !state.startTimeMs) return;
        const sec = Math.floor((Date.now() - state.startTimeMs) / 1000);
        const mm = String(Math.floor(sec / 60)).padStart(2, '0');
        const ss = String(sec % 60).padStart(2, '0');
        const pctNum = parseFloat((progressBarEl && progressBarEl.style.width) || '0') || 0;
        let etaStr = '--:--';
        if (pctNum >= 5 && pctNum < 100 && sec > 3) {
            const rem = Math.max(0, Math.round((sec / (pctNum / 100)) - sec));
            etaStr = `${String(Math.floor(rem / 60)).padStart(2, '0')}:${String(rem % 60).padStart(2, '0')}`;
        }
        timerTextEl.textContent = `${mm}:${ss} | ETA: ${etaStr}`;
    }, 1000);

    function getSpeedWaitMs() {
        const val = speedSelectEl.value;
        if (val === 'slow') return 420;
        if (val === 'fast') return 150;
        if (val === 'turbo') return 95;
        return 240;
    }

    function parseListKeywords(inputEl) {
        return (inputEl.value || '')
            .split(',')
            .map(s => normTR(s))
            .filter(Boolean);
    }

    function isNameInList(name, keywords) {
        if (!keywords || keywords.length === 0) return false;
        const n = normTR(name);
        return keywords.some(kw => n === kw || n.includes(kw));
    }

    function isRawPhoneNumber(name) {
        const cleaned = (name || '').replace(/[\s\-\(\)\+]/g, '');
        return /^\d{7,15}$/.test(cleaned);
    }

    function isForeignPhoneNumber(name) {
        const trimmed = (name || '').trim();
        if (!trimmed.startsWith('+')) return false;
        return !trimmed.startsWith('+90');
    }

    function isShortOrSymbolName(name) {
        const trimmed = (name || '').trim();
        const alphaNum = trimmed.replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ]/g, '');
        return alphaNum.length <= 1;
    }

    function isDefaultAboutText(secondaryText) {
        if (!secondaryText) return false;
        const s = normTR(secondaryText);
        return DEFAULT_ABOUT_PHRASES.some(p => s === p || s.includes(p));
    }

    function resetSectionCounters(sectionLabel) {
        state.currentSectionName = sectionLabel || '-';
        state.currentScanned.clear();
        state.currentWithPhoto.clear();
        state.currentSelected.clear();
        state.currentWhitelisted.clear();
        state.currentExtraCriteriaCount.clear();
        if (progressBarEl) progressBarEl.style.width = '0%';
        updateUI(`[${state.currentSectionName}] Sayaçlar sıfırlandı (0'dan sayılıyor)...`, 0);
    }

    function updateUI(statusMsg, progressPct = null) {
        activeSecEl.textContent = state.currentSectionName;
        scannedCountEl.textContent = state.currentScanned.size;
        photoCountEl.textContent = state.currentWithPhoto.size;
        noPhotoCountEl.textContent = state.currentSelected.size;
        extraCountEl.textContent = state.currentExtraCriteriaCount.size;
        ruleCountEl.textContent = state.currentWhitelisted.size;
        popupCountEl.textContent = state.strictPopupDismissedCount;
        tabCountEl.textContent = state.masterContactsMap.size || state.currentScanned.size;

        const tot = Math.max(1, state.currentScanned.size);
        if (ratioHiddenEl) ratioHiddenEl.style.width = `${Math.round((state.currentSelected.size / tot) * 100)}%`;
        if (ratioOpenEl) ratioOpenEl.style.width = `${Math.round((state.currentWithPhoto.size / tot) * 100)}%`;
        if (ratioVipEl) ratioVipEl.style.width = `${Math.round((state.currentWhitelisted.size / tot) * 100)}%`;

        if (progressPct !== null) {
            const clamped = Math.max(0, Math.min(100, Math.round(progressPct)));
            progressBarEl.style.width = `${clamped}%`;
            if (miniBadgeEl) miniBadgeEl.textContent = `${clamped}% • ${state.currentSelected.size}`;
        }
        if (statusMsg) statusTextEl.textContent = statusMsg;
    }

    function renderSummaryBox() {
        const entries = Object.entries(state.sectionResults);
        if (entries.length === 0) {
            summaryBoxEl.style.display = 'none';
            return;
        }
        summaryBoxEl.style.display = 'block';
        summaryContentEl.innerHTML = entries
            .map(([sec, res]) => {
                if (res.lockedByStrict) {
                    return `<div>• <strong>${sec}:</strong> <span style="color:#ff8a80;">Katı hesap ayarı nedeniyle kilitli (Atlandı)</span></div>`;
                }
                return `<div>• <strong>${sec}:</strong> <span style="color:#00a884; font-weight:bold;">${res.selected}</span> gizlendi (Toplam: ${res.scanned}, Açık: ${res.photo})</div>`;
            })
            .join('');
    }

    function renderLogs() {
        const box = document.getElementById('wa-log-box');
        if (!box) return;
        box.innerHTML = state.logs.length
            ? state.logs.map(l => `<div style="margin-bottom:3px;">${l}</div>`).join('')
            : '<div style="color:#8696a0;">Henüz kayıt yok.</div>';
    }

    document.getElementById('wa-btn-clear-logs').onclick = () => {
        state.logs = [];
        saveJSON(STORAGE_KEYS.LOGS, []);
        renderLogs();
    };

    function isVisible(el) {
        if (!el || panel.contains(el)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    function isElementTopmost(el) {
        if (!isVisible(el)) return false;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + Math.min(rect.width / 2, 40);
        const cy = rect.top + rect.height / 2;
        if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
        if (typeof document.elementsFromPoint === 'function') {
            const stack = document.elementsFromPoint(cx, cy).filter(e => !panel.contains(e));
            if (stack.length === 0) return false;
            const topEl = stack[0];
            return el === topEl || el.contains(topEl) || topEl.contains(el) || stack.slice(0, 3).some(s => el === s || el.contains(s));
        }
        const topEl = document.elementFromPoint(cx, cy);
        if (!topEl) return false;
        return el === topEl || el.contains(topEl) || topEl.contains(el);
    }

    function isInChatList(el) {
        const paneSide = document.getElementById('pane-side');
        return Boolean(paneSide && paneSide.contains(el));
    }

    function triggerSingleClick(el) {
        if (!el) return false;
        highlightElement(el);
        const rect = el.getBoundingClientRect();
        const clientX = rect.left + Math.min(rect.width / 2, 60);
        const clientY = rect.top + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0, buttons: 1 };
        try {
            el.dispatchEvent(new PointerEvent('pointerdown', opts));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new PointerEvent('pointerup', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
        } catch (_) {}
        if (typeof el.click === 'function') {
            el.click();
            return true;
        }
        el.dispatchEvent(new MouseEvent('click', opts));
        return true;
    }

    /**
     * KATI HESAP AYARI POP-UP KALKANI:
     * Ekranda "Katı hesap ayarları açık" uyarısı varsa "Tamam" butonuna basıp kapatır.
     */
    async function checkAndDismissStrictPopup() {
        const dialogs = document.querySelectorAll('[role="dialog"], [data-animate-modal-popup="true"], [data-animate-modal-body="true"]');
        for (const d of dialogs) {
            if (!isVisible(d) || panel.contains(d) || isInChatList(d)) continue;

            const checkboxes = d.querySelectorAll('input[type="checkbox"], [role="checkbox"], [data-icon*="checkbox"]');
            const listItems = d.querySelectorAll('[role="listitem"], [role="row"], [data-testid="cell-frame-container"]');
            const dialogText = normTR(d.textContent);

            const isContactPicker =
                checkboxes.length >= 2 ||
                listItems.length >= 4 ||
                dialogText.includes('kişi hariç bırakıldı') ||
                dialogText.includes('kişi hariç tutuldu') ||
                dialogText.includes('şu kişilerden gizle');

            if (isContactPicker) continue;

            const isStrictLock =
                dialogText.includes('katı hesap ayarları') ||
                dialogText.includes('birincil cihazınızda') ||
                dialogText.includes('strict account');

            const dismissKeywords = ['tamam', 'anladım', 'kapat', 'ok', 'got it', 'close', 'dismiss'];
            const buttons = Array.from(d.querySelectorAll('button, [role="button"], div[tabindex="0"]'));

            for (const b of buttons) {
                if (!isVisible(b)) continue;
                const bTxt = normTR(b.textContent || b.getAttribute('aria-label') || b.getAttribute('title'));
                if (bTxt.includes('daha fazla bilgi') || bTxt.includes('learn more')) continue;

                if (dismissKeywords.some(kw => bTxt === kw || bTxt.includes(kw))) {
                    triggerSingleClick(b);
                    state.strictPopupDismissedCount++;
                    addLog(`"Katı hesap ayarları açık" uyarısı kapatıldı ("${bTxt}").`);
                    await sleep(650);
                    return { dismissed: true, isStrictLock: true };
                }
            }

            const safeButtons = buttons.filter(b => {
                const t = normTR(b.textContent);
                return isVisible(b) && !t.includes('daha fazla') && !t.includes('learn more') && b.tagName !== 'A';
            });
            if (safeButtons.length > 0) {
                triggerSingleClick(safeButtons[safeButtons.length - 1]);
                state.strictPopupDismissedCount++;
                await sleep(650);
                return { dismissed: true, isStrictLock };
            }
        }
        return { dismissed: false, isStrictLock: false };
    }

    /**
     * ÖNEMLİ (v15): Sol çekmecenin hangi ekranda olduğunu %100 kesin olarak tespit eder.
     * - Ana "Gizlilik" menüsünde miyiz? Yoksa "Son görülme / Profil resmi / Hakkımda / Durum" alt ekranında mıyız?
     */
    function getActiveLeftDrawerInfo() {
        let headerTitle = '';
        let hasPersonalWhoCanSeeHeader = false;
        let hasRadioButtonsInDrawer = false;
        let visibleSectionTitlesCount = 0;
        let visibleSettingsItemsCount = 0;

        // 1. Görünür radyo butonu var mı kontrol et ("Herkes / Kişilerim / Şunlar hariç kişilerim..." sadece alt ekranlarda vardır!)
        const radios = document.querySelectorAll('[role="radio"], input[type="radio"]');
        for (const rad of radios) {
            if (isVisible(rad) && !isInChatList(rad) && rad.getBoundingClientRect().left < 540) {
                if (isElementTopmost(rad)) {
                    hasRadioButtonsInDrawer = true;
                }
            }
        }

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
            const txt = normTR(node.nodeValue);
            if (!txt || txt.length > 65) continue;
            const p = node.parentElement;
            if (!p || !isVisible(p) || isInChatList(p) || panel.contains(p)) continue;
            const r = p.getBoundingClientRect();
            if (r.left < 30 || r.left > Math.max(680, window.innerWidth * 0.55)) continue;

            if (!isElementTopmost(p)) continue;

            // Çekmece üst başlık bölgesi (y: 0..105px, x: 55..440px — "Ayarlar" veya "Gizlilik" başlığı x≈70px'de başlar!)
            if (r.top >= 0 && r.top <= 105 && r.left >= 55 && r.left <= 440) {
                if (!headerTitle) headerTitle = txt;
            }

            if (txt.includes('kişisel bilgilerimi kimler görebilir')) {
                hasPersonalWhoCanSeeHeader = true;
            }

            if (
                txt === 'son görülme ve çevrimiçi' ||
                txt === 'profil resmi' ||
                txt === 'profil fotoğrafı' ||
                txt === 'hakkımda' ||
                txt === 'durum'
            ) {
                if (r.top > 75) visibleSectionTitlesCount++;
            }

            if (
                txt === 'hesap' ||
                txt === 'gizlilik' ||
                txt === 'bildirimler' ||
                txt === 'yardım ve geri bildirim' ||
                txt === 'account' ||
                txt === 'privacy' ||
                txt === 'notifications'
            ) {
                if (r.top > 75) visibleSettingsItemsCount++;
            }

            if (txt === 'şunlar hariç kişilerim...' || txt === 'şunlar hariç kişilerim' || txt === 'my contacts except...') {
                hasRadioButtonsInDrawer = true;
            }
        }

        const subSectionHeaderKeywords = [
            'son görülme', 'profil resmi', 'profil fotoğrafı', 'hakkımda', 'durum', 'gruplar',
            'last seen', 'profile photo', 'about', 'status', 'groups'
        ];
        const isKnownSubHeader = Boolean(headerTitle && subSectionHeaderKeywords.some(k => headerTitle.includes(k)));

        // Alt bölüm: Yalnızca ekranda radyo butonları varsa VEYA başlık bilinen bir gizlilik alt bölümü ise!
        const isSubSection = hasRadioButtonsInDrawer || (isKnownSubHeader && !hasPersonalWhoCanSeeHeader);

        const isMainPrivacy =
            !isSubSection &&
            (headerTitle === 'gizlilik' || headerTitle === 'privacy' || hasPersonalWhoCanSeeHeader || visibleSectionTitlesCount >= 2);

        const isSettings =
            !isMainPrivacy &&
            !isSubSection &&
            (headerTitle === 'ayarlar' || headerTitle === 'settings' || visibleSettingsItemsCount >= 2);

        return {
            headerTitle,
            isMainPrivacy,
            isSubSection,
            isSettings
        };
    }

    /**
     * Çekmecenin üst kısmını (scrollTop = 0) en üste kaydırır.
     * Böylece "Katı hesap ayarları" gibi en alttaki tehlikeli satırlar yerine en üstteki
     * "Son görülme / Profil resmi / Hakkımda / Durum" satırları görünür olur!
     */
    function scrollLeftDrawerToTop() {
        const allDivs = document.querySelectorAll('div');
        for (const d of allDivs) {
            if (!isVisible(d) || isInChatList(d) || panel.contains(d)) continue;
            const r = d.getBoundingClientRect();
            if (r.left >= 50 && r.left <= 120 && r.width >= 250 && r.width <= 520) {
                const st = window.getComputedStyle(d);
                if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && d.scrollTop > 0) {
                    d.scrollTop = 0;
                }
            }
        }
    }

    async function clickDrawerBackButton() {
        // 1. AŞAMA (KESİN HEDEF): Doğrudan aria-label="Geri"/"Back" veya data-icon="back" ikonunu bul
        const explicitSelectors = [
            'button[aria-label="Geri"]',
            'button[aria-label="Back"]',
            '[role="button"][aria-label="Geri"]',
            '[role="button"][aria-label="Back"]',
            '[title="Geri"]',
            '[title="Back"]',
            '[data-icon="back"]',
            '[data-icon="arrow-back"]',
            '[data-icon="back-refreshed"]',
            '[data-testid="back"]'
        ];
        const explicitCandidates = [];
        for (const sel of explicitSelectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                if (!isVisible(el) || isInChatList(el) || panel.contains(el)) continue;
                const btn = el.closest('button, [role="button"], div[tabindex="0"]') || el;
                if (btn.getAttribute('role') === 'radio' || btn.closest('[role="radio"], [role="radiogroup"]')) continue;
                const r = btn.getBoundingClientRect();
                if (r.left >= 52 && r.left <= 170 && r.top >= 0 && r.top <= 95 && r.width <= 70 && r.height <= 70) {
                    if (isElementTopmost(btn)) {
                        explicitCandidates.push({ el: btn, top: r.top, left: r.left });
                    }
                }
            }
        }
        if (explicitCandidates.length > 0) {
            explicitCandidates.sort((a, b) => (a.top - b.top) || (a.left - b.left));
            triggerSingleClick(explicitCandidates[0].el);
            await sleep(750);
            return true;
        }

        // 2. AŞAMA (YEDEK - RADYO KALKANLI): Yalnızca üst başlık şeridindeki (y: 0..85px) küçük SVG ok ikonunu bul
        // ASLA radyo butonlarına ("Herkes", "Kişilerim" vb.) veya metin satırlarına tıklamaz!
        const fallbackCandidates = [];
        const allBtns = document.querySelectorAll('button, [role="button"], div[tabindex="0"]');
        for (const btn of allBtns) {
            if (!isVisible(btn) || isInChatList(btn) || panel.contains(btn)) continue;
            if (btn.getAttribute('role') === 'radio' || btn.closest('[role="radio"], [role="radiogroup"]')) continue;
            const txt = normTR(btn.textContent);
            if (txt && txt.length > 2) continue; // Geri ok butonunun içinde uzun metin olmaz!
            if (!btn.querySelector('svg')) continue;
            const r = btn.getBoundingClientRect();
            if (r.left >= 52 && r.left <= 155 && r.top >= 0 && r.top <= 85 && r.width >= 18 && r.width <= 64 && r.height >= 18 && r.height <= 64) {
                if (isElementTopmost(btn)) {
                    fallbackCandidates.push({ el: btn, top: r.top, left: r.left });
                }
            }
        }

        if (fallbackCandidates.length > 0) {
            fallbackCandidates.sort((a, b) => (a.top - b.top) || (a.left - b.left));
            triggerSingleClick(fallbackCandidates[0].el);
            await sleep(750);
            return true;
        }
        return false;
    }

    async function returnToMainPrivacyDrawer() {
        await checkAndDismissStrictPopup();

        // Kişi seçim modalı hala açıksa kapanmasını bekle
        for (let w = 0; w < 6; w++) {
            const openModal = findPrivacyModalAndScroller();
            if (!openModal) break;
            await clickGreenCheckmarkButton(openModal.modal);
            await sleep(600);
            await checkAndDismissStrictPopup();
        }

        for (let attempt = 0; attempt < 5; attempt++) {
            if (!state.running) return false;
            await checkAndDismissStrictPopup();

            const info = getActiveLeftDrawerInfo();
            if (info.isMainPrivacy) {
                scrollLeftDrawerToTop();
                await sleep(300);
                return true;
            }

            if (info.isSubSection) {
                updateUI(`Alt ekrandan (${info.headerTitle || 'Bölüm'}) ana Gizlilik menüsüne dönülüyor...`);
                await clickDrawerBackButton();
                await sleep(750);
                continue;
            }

            if (info.isSettings) {
                clickExactMainSectionRow(['gizlilik', 'privacy']);
                await sleep(850);
                continue;
            }

            // Durum belirsizse 1 kez Geri bas
            await clickDrawerBackButton();
            await sleep(650);
        }

        scrollLeftDrawerToTop();
        return getActiveLeftDrawerInfo().isMainPrivacy;
    }

    async function ensureSettingsDrawerOpen() {
        await checkAndDismissStrictPopup();
        let info = getActiveLeftDrawerInfo();
        if (info.isMainPrivacy || info.isSettings || info.isSubSection) return true;

        const allLeftEls = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex="0"], span[data-icon]')).filter(el => {
            if (!isVisible(el) || isInChatList(el)) return false;
            return el.getBoundingClientRect().left < 110;
        });

        for (const el of allLeftEls) {
            const aria = normTR(el.getAttribute('aria-label'));
            const title = normTR(el.getAttribute('title'));
            const icon = normTR(el.getAttribute('data-icon'));
            const testid = normTR(el.getAttribute('data-testid'));
            if (aria.includes('medya') || aria.includes('media') || title.includes('medya') || title.includes('media') || icon.includes('media')) continue;
            const hasSettingsAttr = aria === 'ayarlar' || aria === 'settings' || aria.includes('ayarlar') || title === 'ayarlar' || title === 'settings' || icon.includes('settings') || icon.includes('gear') || testid.includes('settings');
            if (hasSettingsAttr) {
                const clickable = el.closest('button, [role="button"], div[tabindex="0"]') || el;
                triggerSingleClick(clickable);
                await sleep(1000);
                info = getActiveLeftDrawerInfo();
                if (info.isSettings || info.isMainPrivacy) return true;
            }
        }

        const bottomRailBtns = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex="0"]')).filter(el => {
            if (!isVisible(el) || isInChatList(el)) return false;
            const r = el.getBoundingClientRect();
            return r.left >= 0 && r.left < 75 && r.width >= 24 && r.width <= 72 && r.top > window.innerHeight * 0.45;
        });

        const uniqueRailBtns = bottomRailBtns.filter(b => !bottomRailBtns.some(other => other !== b && other.contains(b)));
        uniqueRailBtns.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);

        for (const btn of uniqueRailBtns) {
            const aria = normTR(btn.getAttribute('aria-label') || btn.getAttribute('title'));
            if (aria.includes('medya') || aria.includes('media') || aria.includes('profil') || aria.includes('profile')) continue;
            triggerSingleClick(btn);
            await sleep(950);
            info = getActiveLeftDrawerInfo();
            if (info.isSettings || info.isMainPrivacy) return true;
        }

        return getActiveLeftDrawerInfo().isSettings;
    }

    /**
     * ÖNEMLİ (v15 - ZERO MISCLICK):
     * Ana "Gizlilik" menüsündeki bir bölüm satırına (Son görülme ve çevrimiçi, Profil resmi, Hakkımda, Durum, Gruplar)
     * YALNIZCA %100 TAM METİN EŞLEŞMESİYLE (`txt === exactTitle`) tıklar!
     * - Kısmi eşleşme (`includes`) KULLANMAZ!
     * - İçinde yasaklı kelime ("katı hesap", "gelişmiş", "okundu bilgisi" vb.) geçen hiçbir satıra ASLA dokunmaz!
     * - Bütün çekmeceyi kapsayan büyük bir `div` yerine yalnızca `height < 95px` olan gerçek satıra tıklar!
     */
    function clickExactMainSectionRow(exactTitles) {
        const normTargets = exactTitles.map(normTR);
        const maxDrawerX = Math.max(680, Math.floor(window.innerWidth * 0.55));

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        const candidates = [];
        let node;

        while ((node = walker.nextNode())) {
            const txt = normTR(node.nodeValue);
            if (!txt) continue;

            // Sadece %100 tam metin eşleşmesi!
            if (!normTargets.includes(txt)) continue;

            const spanEl = node.parentElement;
            if (!spanEl || !isVisible(spanEl) || isInChatList(spanEl) || panel.contains(spanEl)) continue;

            const r = spanEl.getBoundingClientRect();
            if (r.left < 30 || r.left > maxDrawerX || r.top < 65) continue;

            // Satır kapsayıcısını bul (yüksekliği maksimum 110px olmalı, genişlik esnek)
            let rowTarget = spanEl;
            let curr = spanEl.parentElement;
            while (curr && curr !== document.body) {
                const cr = curr.getBoundingClientRect();
                if (cr.height > 110 || cr.width > maxDrawerX) break;
                rowTarget = curr;
                if (curr.getAttribute('role') === 'button' || curr.getAttribute('role') === 'listitem' || curr.hasAttribute('tabindex')) {
                    break;
                }
                curr = curr.parentElement;
            }

            // Satırın tam metninde yasaklı kelime ("katı hesap", "okundu bilgisi" vb.) varsa kesinlikle atla!
            if (isForbiddenText(rowTarget.textContent)) continue;

            // Ekranın altındaysa (örn. Gruplar) görünür alana kaydır
            if (r.top > window.innerHeight - 30) {
                try { rowTarget.scrollIntoView({ block: 'center' }); } catch (_) {}
            }

            if (!isElementTopmost(spanEl) && !isElementTopmost(rowTarget)) continue;

            candidates.push({ el: rowTarget, top: rowTarget.getBoundingClientRect().top });
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => a.top - b.top);
            return triggerSingleClick(candidates[0].el);
        }
        return false;
    }

    /**
     * Alt bölüm içindeyken (örn. Son görülme, Profil resmi, Hakkımda, Durum ekranında):
     * 1. Önce ekranda halihazırda "X kişi hariç bırakıldı / tutuldu" satırı var mı diye bakar.
     *    Varsa radyo butonuna tekrar basıp "Katı hesap" pop-up'ı tetiklemek yerine DOĞRUDAN o satıra tıklar!
     * 2. Yoksa yalnızca İLK (en üstteki) "Şunlar hariç kişilerim..." radyo butonuna tıklar!
     */
    function clickSubSectionExceptMyContactsOrList(preferExistingCountRow = false) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        const countRowCandidates = [];
        const radioCandidates = [];
        let node;

        while ((node = walker.nextNode())) {
            const txt = normTR(node.nodeValue);
            if (!txt || txt.length > 55) continue;
            if (isForbiddenText(txt)) continue;

            const spanEl = node.parentElement;
            if (!spanEl || !isVisible(spanEl) || isInChatList(spanEl) || panel.contains(spanEl)) continue;
            const r = spanEl.getBoundingClientRect();
            if (r.left < 30 || r.left > Math.max(680, window.innerWidth * 0.55) || r.top < 65) continue;
            if (!isElementTopmost(spanEl)) continue;

            let rowTarget = spanEl;
            let curr = spanEl.parentElement;
            while (curr && curr !== document.body) {
                const cr = curr.getBoundingClientRect();
                if (cr.height > 105 || cr.width > Math.max(680, window.innerWidth * 0.55)) break;
                rowTarget = curr;
                if (curr.getAttribute('role') === 'radio' || curr.getAttribute('role') === 'button' || curr.hasAttribute('tabindex')) {
                    break;
                }
                curr = curr.parentElement;
            }

            if (isForbiddenText(rowTarget.textContent)) continue;

            // "245 kişi hariç bırakıldı" veya "kişi hariç tutuldu" satırı
            if (
                /\d+\s*kişi\s*hariç/i.test(txt) ||
                txt.includes('kişi hariç bırakıldı') ||
                txt.includes('kişi hariç tutuldu') ||
                txt.includes('contacts excluded')
            ) {
                countRowCandidates.push({ el: rowTarget, top: r.top });
            }

            // "Şunlar hariç kişilerim..." radyo butonu
            if (
                txt === 'şunlar hariç kişilerim...' ||
                txt === 'şunlar hariç kişilerim' ||
                txt === 'my contacts except...' ||
                txt === 'my contacts except'
            ) {
                radioCandidates.push({ el: rowTarget, top: r.top });
            }
        }

        if (preferExistingCountRow && countRowCandidates.length > 0) {
            countRowCandidates.sort((a, b) => a.top - b.top);
            return { clicked: triggerSingleClick(countRowCandidates[0].el), type: 'count_row' };
        }

        if (radioCandidates.length > 0) {
            radioCandidates.sort((a, b) => a.top - b.top);
            return { clicked: triggerSingleClick(radioCandidates[0].el), type: 'radio' };
        }

        if (countRowCandidates.length > 0) {
            countRowCandidates.sort((a, b) => a.top - b.top);
            return { clicked: triggerSingleClick(countRowCandidates[0].el), type: 'count_row' };
        }

        return { clicked: false, type: null };
    }

    function findPrivacyModalAndScroller() {
        const dialogs = document.querySelectorAll('[role="dialog"], [data-animate-modal-popup="true"], [data-animate-modal-body="true"]');
        for (const d of dialogs) {
            if (!isVisible(d) || isInChatList(d) || panel.contains(d)) continue;
            const scroller = findScrollerInside(d);
            if (!scroller) continue;
            const rows = getContactRows(scroller);
            if (rows.length >= 2) {
                return { modal: d, scroller };
            }
        }

        const allSpans = document.querySelectorAll('span, div, h1, h2');
        for (const s of allSpans) {
            if (!isVisible(s) || isInChatList(s)) continue;
            const t = normTR(s.textContent);
            if (
                t.includes('şu kişilerden gizle') ||
                t.includes('kişi hariç bırakıldı') ||
                t.includes('kişi hariç tutuldu') ||
                t.includes('hide profile photo from')
            ) {
                let parent = s.parentElement;
                while (parent && parent !== document.body) {
                    const scroller = findScrollerInside(parent);
                    if (scroller && getContactRows(scroller).length >= 2) {
                        return { modal: parent, scroller };
                    }
                    parent = parent.parentElement;
                }
            }
        }
        return null;
    }

    function findScrollerInside(rootEl) {
        const divs = rootEl.querySelectorAll('div');
        let best = null, maxScroll = 0;
        for (const d of divs) {
            if (panel.contains(d) || isInChatList(d)) continue;
            const style = window.getComputedStyle(d);
            const isScrollable = style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay';
            if (isScrollable && d.scrollHeight > d.clientHeight + 20 && d.clientWidth > 200) {
                if (d.scrollHeight > maxScroll) {
                    maxScroll = d.scrollHeight;
                    best = d;
                }
            }
        }
        return best;
    }

    function readModalFooterExcludedCount(modalEl) {
        const walker = document.createTreeWalker(modalEl || document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
            const txt = normTR(node.nodeValue);
            if (txt.includes('hariç bırakıldı') || txt.includes('hariç tutuldu') || txt.includes('excluded')) {
                const m = txt.match(/(\d+)/);
                if (m) return parseInt(m[1], 10);
                if (txt.includes('hiç') || txt.includes('no ')) return 0;
            }
        }
        return null;
    }

    async function clickGreenCheckmarkButton(modalEl) {
        updateUI('Yeşil onay (✓) butonuna basılıyor...');
        await sleep(500);
        const searchRoot = modalEl || document;
        const iconSelectors = [
            '[data-icon="checkmark-large"]', '[data-icon="checkmark"]', '[data-icon="check"]',
            '[data-testid="checkmark-large"]', '[aria-label="Tamam"]', '[aria-label="Onayla"]',
            '[aria-label="Kaydet"]', '[aria-label="Bitti"]', '[aria-label="OK"]', '[aria-label="Done"]'
        ];
        for (const sel of iconSelectors) {
            const el = searchRoot.querySelector(sel) || document.querySelector(sel);
            if (el && isVisible(el) && !isInChatList(el)) {
                const btn = el.closest('button, [role="button"], div[tabindex]') || el;
                triggerSingleClick(btn);
                await sleep(1100);
                return true;
            }
        }
        const modalRect = (modalEl || document.body).getBoundingClientRect();
        const candidates = Array.from((modalEl || document).querySelectorAll('button, [role="button"], div[tabindex="0"], span[data-icon]'));
        for (const c of candidates) {
            if (!isVisible(c) || panel.contains(c) || isInChatList(c)) continue;
            const r = c.getBoundingClientRect();
            if (r.top > modalRect.top + modalRect.height * 0.7 && r.width >= 32 && r.width <= 75) {
                if (c.querySelector('svg') || c.tagName.toLowerCase() === 'svg') {
                    triggerSingleClick(c);
                    await sleep(1100);
                    return true;
                }
            }
        }
        return false;
    }

    function isEmojiImage(img) {
        const cls = (typeof img.className === 'string' ? img.className : '') || '';
        if (cls.includes('emoji') || img.hasAttribute('data-plain-text')) return true;
        const src = (img.getAttribute('src') || img.currentSrc || '').toLowerCase();
        if (src.includes('/emoji') || src.includes('emoji.')) return true;
        const r = img.getBoundingClientRect();
        // Emojiler genellikle metin içi 16-22px karedir; profil fotoğrafları 36-56px civarındadır
        if (r.width > 0 && r.width <= 24 && r.height > 0 && r.height <= 24 && !src.includes('pps.whatsapp.net') && !src.startsWith('blob:')) {
            return true;
        }
        return false;
    }

    /**
     * 5 KATMANLI ULTRA HASSAS PROFİL FOTOĞRAFI TESPİTİ (v18):
     * - Gerçek <img> (src / currentSrc / srcset / blob / pps.whatsapp.net)
     * - <svg><image>
     * - Avatar bölgesindeki <canvas>
     * - Inline veya CSS computed background-image: url(...)
     * - Emoji img'lerini kesinlikle dışlar!
     */
    function checkRowHasPhoto(rowEl) {
        if (!rowEl) return false;
        const rowRect = rowEl.getBoundingClientRect();

        // 1. <img> etiketi kontrolü
        const imgs = rowEl.querySelectorAll('img');
        for (const img of imgs) {
            if (isEmojiImage(img)) continue;
            const src = (img.getAttribute('src') || img.currentSrc || img.getAttribute('srcset') || '').trim();
            if (src && src !== 'about:blank' && !src.startsWith('data:image/gif;base64,R0lGOD')) {
                return true;
            }
        }

        // 2. <svg><image> kontrolü
        if (rowEl.querySelector('svg image')) return true;

        // 3. Avatar <canvas> kontrolü
        const canvases = rowEl.querySelectorAll('canvas');
        for (const cv of canvases) {
            const cr = cv.getBoundingClientRect();
            if (cr.width >= 26 && cr.height >= 26 && (rowRect.width === 0 || (cr.left - rowRect.left) < 120)) {
                return true;
            }
        }

        // 4. Inline background-image kontrolü
        const styledEls = rowEl.querySelectorAll('[style*="background-image"]');
        for (const el of styledEls) {
            const bg = el.style.backgroundImage || '';
            if (bg && bg !== 'none' && bg.includes('url(')) return true;
        }

        // 5. CSS Computed background-image kontrolü (yalnızca satırda <svg> yoksa çalışır -> 20x hız artışı!)
        if (!rowEl.querySelector('svg')) {
            const avatarBoxes = rowEl.querySelectorAll('div, span');
            for (const box of avatarBoxes) {
                const br = box.getBoundingClientRect();
                if (br.width >= 28 && br.width <= 72 && br.height >= 28 && br.height <= 72) {
                    if (rowRect.width === 0 || (br.left - rowRect.left) < 120) {
                        const bg = window.getComputedStyle(box).backgroundImage;
                        if (bg && bg !== 'none' && bg.includes('url(')) return true;
                    }
                }
            }
        }

        return false;
    }

    /**
     * TOPLU KARE (FRAME) LAZY-LOAD BEKLEYİCİ (v19 TURBO):
     * Her kişi için ayrı ayrı 220ms beklemek yerine, ekrandaki tüm görünür satırlar için TEK SEFERDE
     * yüklenmekte olan <img> varsa yalnızca 120ms bekler (10x daha hızlı + %100 Fotoğraf Kalkanı!).
     */
    async function waitForFrameAvatarsToLoad(rows) {
        let needsWait = false;
        for (const row of rows) {
            const imgs = row.querySelectorAll('img');
            for (const img of imgs) {
                if (!isEmojiImage(img) && !img.complete) {
                    needsWait = true;
                    break;
                }
            }
            if (needsWait) break;
        }
        if (needsWait) {
            await sleep(130);
        }
    }

    function analyzeRowAttributes(rowEl, duplicateIndexInView = 0) {
        let primaryName = null;
        let secondaryText = '';

        const spans = Array.from(rowEl.querySelectorAll('span[title], span[dir="auto"]'));
        for (const sp of spans) {
            if (sp.classList && sp.classList.contains('emoji')) continue;
            const txt = (sp.getAttribute('title') || sp.textContent || '').trim();
            if (!txt || txt.length <= 1 || txt.includes('kişi hariç')) continue;
            if (!primaryName) {
                primaryName = txt;
            } else if (txt !== primaryName && !secondaryText) {
                secondaryText = txt;
            }
        }

        if (!primaryName) return null;

        const hasAboutText = Boolean(secondaryText && secondaryText.length >= 1);
        const isDefaultAbout = isDefaultAboutText(secondaryText);

        const hasBusinessBadge = Boolean(
            rowEl.querySelector('[data-icon*="business"], [data-icon*="verified"], [data-testid*="business"], [aria-label*="İşletme"], [aria-label*="Business"]')
        );
        const secNorm = normTR(secondaryText);
        const nameNorm = normTR(primaryName);
        const isBusinessAccount =
            hasBusinessBadge ||
            secNorm.includes('işletme hesabı') ||
            secNorm.includes('business account') ||
            secNorm.includes('resmi hesap') ||
            nameNorm.includes('kargo') ||
            nameNorm.includes('müşteri hizmetleri');

        const isRawNum = isRawPhoneNumber(primaryName);
        const isForeignNum = isForeignPhoneNumber(primaryName);
        const isShortName = isShortOrSymbolName(primaryName);

        let posElement = rowEl, posKey = '';
        for (let i = 0; i < 4 && posElement; i++) {
            const st = posElement.getAttribute('style') || '';
            const m = st.match(/translateY\(([^)]+)\)/i) || st.match(/top:\s*([^;]+)/i);
            if (m) { posKey = m[1].trim(); break; }
            posElement = posElement.parentElement;
        }
        if (!posKey) posKey = `dup_${duplicateIndexInView}`;
        const uniqueKey = `${primaryName} || ${secondaryText} || ${posKey}`;

        return {
            name: primaryName,
            secondary: secondaryText,
            uniqueKey,
            hasPhoto: checkRowHasPhoto(rowEl),
            hasAboutText,
            isDefaultAbout,
            isBusinessAccount,
            isRawNum,
            isForeignNum,
            isShortName
        };
    }

    function evaluateShouldExclude(attr, sectionId = 'all') {
        const wl = parseListKeywords(whitelistInputEl);
        if (isNameInList(attr.name, wl)) {
            return { exclude: false, isVip: true, reasons: [], extraReason: null };
        }

        // MUTLAK FOTOĞRAF KALKANI (v18): Fotoğrafı varsa ASLA işaretleme!
        // (Yalnızca kullanıcının elle Kara Listeye yazdığı kişiler hariç tutulabilir)
        const blCheck = parseListKeywords(blacklistInputEl);
        const isExplicitlyBlacklisted = isNameInList(attr.name, blCheck);
        if (optPhotoGuardEl && optPhotoGuardEl.checked && attr.hasPhoto && !isExplicitlyBlacklisted) {
            return { exclude: false, isVip: false, reasons: [], extraReason: null, photoProtected: true };
        }

        const reasons = [];
        const bl = parseListKeywords(blacklistInputEl);
        if (isNameInList(attr.name, bl)) reasons.push('Kara Liste');

        const kwList = parseListKeywords(keywordsInputEl);
        if (kwList.length > 0 && (isNameInList(attr.name, kwList) || isNameInList(attr.secondary, kwList))) {
            reasons.push('İsim/Etiket Kriteri');
        }

        if (critRawNumEl.checked && attr.isRawNum) reasons.push('Kayıtsız Numara');
        if (critForeignEl.checked && attr.isForeignNum) reasons.push('Yabancı Numara');
        if (critShortEl.checked && attr.isShortName) reasons.push('Tek Harf/Sembol');
        if (critBusinessEl.checked && attr.isBusinessAccount) reasons.push('İşletme Hesabı');
        if (critDefAboutEl.checked && attr.isDefaultAbout) reasons.push('Varsayılan Hakkımda');

        const isPerSection = syncModeSelectEl.value === 'per_section' && sectionId !== 'all';

        if (isPerSection) {
            if (sectionId === 'about') {
                if (critNoAboutEl.checked && !attr.hasAboutText) reasons.push('Hakkımda Yazısı Yok');
                if (critNoPhotoEl.checked && !attr.hasPhoto) reasons.push('Fotoğrafsız');
            } else {
                if (critNoPhotoEl.checked && !attr.hasPhoto) reasons.push('Fotoğrafsız');
            }
        } else {
            if (critNoPhotoEl.checked && !attr.hasPhoto) reasons.push('Fotoğrafsız');
            if (critNoAboutEl.checked && !attr.hasAboutText) reasons.push('Hakkımda Yazısı Yok');
        }

        const extraReason = reasons.find(r => r !== 'Fotoğrafsız') || null;
        return {
            exclude: reasons.length > 0,
            isVip: false,
            reasons,
            extraReason
        };
    }

    function isRowChecked(rowEl) {
        const inputCb = rowEl.querySelector('input[type="checkbox"]');
        if (inputCb && inputCb.checked) return true;
        if (rowEl.getAttribute('aria-checked') === 'true' || rowEl.getAttribute('aria-selected') === 'true') return true;
        if (rowEl.querySelector('[aria-checked="true"], [aria-selected="true"]')) return true;
        if (rowEl.querySelector('[data-icon*="checked"], [data-icon*="checkmark"], [data-testid*="checked"]')) return true;

        const rowRect = rowEl.getBoundingClientRect();
        const allDivs = rowEl.querySelectorAll('div, span');
        for (const d of allDivs) {
            const r = d.getBoundingClientRect();
            if (r.left - rowRect.left < 65 && r.width >= 14 && r.width <= 26 && Math.abs(r.width - r.height) <= 4) {
                const bg = window.getComputedStyle(d).backgroundColor;
                if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && bg !== 'rgb(255, 255, 255)' && bg !== 'rgb(17, 27, 33)') {
                    if (d.querySelector('svg')) return true;
                }
            }
        }
        return false;
    }

    async function setRowCheckedStateSafe(rowEl, wantChecked) {
        if (isRowChecked(rowEl) === wantChecked) return true;
        const primaryTarget =
            rowEl.querySelector('input[type="checkbox"]') ||
            rowEl.querySelector('[role="checkbox"]') ||
            rowEl.querySelector('[data-testid="cell-frame-container"]') ||
            rowEl;

        triggerSingleClick(primaryTarget);
        await sleep(95);
        if (isRowChecked(rowEl) === wantChecked) return true;

        const rowRect = rowEl.getBoundingClientRect();
        const leftBoxes = Array.from(rowEl.querySelectorAll('div, span')).filter(el => {
            const r = el.getBoundingClientRect();
            return (r.left - rowRect.left < 65) && r.width >= 14 && r.width <= 28 && Math.abs(r.width - r.height) <= 4;
        });
        if (leftBoxes.length > 0) {
            triggerSingleClick(leftBoxes[leftBoxes.length - 1]);
            await sleep(95);
        }
        return isRowChecked(rowEl) === wantChecked;
    }

    function getContactRows(scroller) {
        let rows = Array.from(scroller.querySelectorAll('[role="listitem"], [role="row"], [data-testid="cell-frame-container"]'));
        if (rows.length > 0) {
            return rows.filter(r => !rows.some(other => other !== r && other.contains(r)));
        }
        const nameSpans = scroller.querySelectorAll('span[dir="auto"]');
        const rowSet = new Set();
        for (const sp of nameSpans) {
            let curr = sp.parentElement;
            while (curr && curr !== scroller) {
                const rect = curr.getBoundingClientRect();
                if (rect.width > 240 && rect.height >= 48 && rect.height <= 95) {
                    rowSet.add(curr);
                    break;
                }
                curr = curr.parentElement;
            }
        }
        return Array.from(rowSet);
    }

    async function buildMasterListInOpenModal(scroller) {
        resetSectionCounters('Master Analiz & Çoklu Kriter Tarama');
        scroller.scrollTop = 0;
        await sleep(950);

        let lastTop = -1, stuckCount = 0;
        const waitMs = getSpeedWaitMs();
        let removedPhotoCount = 0, addedPhotoCount = 0;
        let noAboutTotal = 0, businessTotal = 0, rawNumTotal = 0;
        const newSnapshot = { ...state.previousSnapshot };
        const seenNamesCount = new Map();
        state.duplicateNamesSet.clear();

        while (state.running) {
            await waitWhilePaused();
            await sleep(waitMs);

            const rows = getContactRows(scroller);
            rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
            await waitForFrameAvatarsToLoad(rows);

            const nameCountsInView = new Map();
            for (const row of rows) {
                if (!state.running) break;
                const tempNameSpan = row.querySelector('span[title], span[dir="auto"]');
                const rawName = tempNameSpan ? (tempNameSpan.getAttribute('title') || tempNameSpan.textContent || '').trim() : '';
                const dupIdx = nameCountsInView.get(rawName) || 0;
                nameCountsInView.set(rawName, dupIdx + 1);

                const attr = analyzeRowAttributes(row, dupIdx);
                if (!attr) continue;

                const { uniqueKey, hasPhoto } = attr;
                const isNewUnique = !state.masterContactsMap.has(uniqueKey);
                state.currentScanned.add(uniqueKey);

                if (isNewUnique) {
                    const prevCount = seenNamesCount.get(attr.name) || 0;
                    seenNamesCount.set(attr.name, prevCount + 1);
                    if (prevCount + 1 > 1) {
                        state.duplicateNamesSet.add(attr.name);
                    }
                }

                let diffStatus = null;
                if (Object.prototype.hasOwnProperty.call(state.previousSnapshot, uniqueKey)) {
                    const prevPhoto = state.previousSnapshot[uniqueKey];
                    if (prevPhoto === true && !hasPhoto) {
                        diffStatus = 'removed_photo';
                        removedPhotoCount++;
                    } else if (prevPhoto === false && hasPhoto) {
                        diffStatus = 'added_photo';
                        addedPhotoCount++;
                    }
                }
                newSnapshot[uniqueKey] = hasPhoto;

                const decision = evaluateShouldExclude(attr, 'all');

                if (decision.isVip) {
                    state.currentWhitelisted.add(uniqueKey);
                    state.masterWithPhotoKeys.add(uniqueKey);
                    state.masterExcludedKeys.delete(uniqueKey);
                } else if (decision.exclude) {
                    if (hasPhoto && !decision.extraReason) {
                        state.currentWithPhoto.add(uniqueKey);
                        state.masterWithPhotoKeys.add(uniqueKey);
                        state.masterExcludedKeys.delete(uniqueKey);
                    } else {
                        state.currentSelected.add(uniqueKey);
                        state.masterExcludedKeys.add(uniqueKey);
                        if (decision.extraReason) {
                            state.currentExtraCriteriaCount.add(uniqueKey);
                        }
                    }
                } else {
                    state.currentWithPhoto.add(uniqueKey);
                    state.masterWithPhotoKeys.add(uniqueKey);
                    state.masterExcludedKeys.delete(uniqueKey);
                }

                state.masterContactsMap.set(uniqueKey, {
                    ...attr,
                    reasons: decision.reasons || [],
                    diffStatus
                });
            }

            const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
            const pct = (scroller.scrollTop / maxScroll) * 100;
            updateUI(`Master Analiz: ${state.currentScanned.size} kişi incelendi...`, pct);

            if (!document.body.contains(scroller)) {
                const refound = findPrivacyModalAndScroller();
                if (refound && refound.scroller) scroller = refound.scroller;
                else break;
            }
            const safeStep = Math.max(180, Math.min(265, Math.floor((scroller.clientHeight || 360) * 0.65)));
            lastTop = scroller.scrollTop;
            scroller.scrollTop += safeStep;
            await sleep(190);

            const isAtBottom = (scroller.scrollTop + scroller.clientHeight) >= (scroller.scrollHeight - 25);
            if (Math.abs(scroller.scrollTop - lastTop) < 4) {
                stuckCount++;
                if (isAtBottom && stuckCount >= 3) break;
                if (!isAtBottom) {
                    await sleep(320);
                    scroller.scrollTop += safeStep;
                    if (stuckCount >= 10) break;
                }
            } else {
                stuckCount = 0;
            }
        }

        for (const c of state.masterContactsMap.values()) {
            if (!c.hasAboutText) noAboutTotal++;
            if (c.isBusinessAccount) businessTotal++;
            if (c.isRawNum) rawNumTotal++;
        }

        state.previousSnapshot = newSnapshot;
        saveJSON(STORAGE_KEYS.SNAPSHOT, newSnapshot);
        state.masterLocked = true;

        const diffEl = document.getElementById('wa-diff-summary');
        if (diffEl) {
            diffEl.innerHTML = `
                <div>• 📷 Fotoğrafını yeni kaldıran: <strong style="color:#ff8a80;">${removedPhotoCount}</strong> | Yeni ekleyen: <strong style="color:#93c5fd;">${addedPhotoCount}</strong></div>
                <div>• 📝 "Hakkımda" yazısı olmayan: <strong style="color:#ffd279;">${noAboutTotal} kişi</strong></div>
                <div>• 🏢 İşletme hesabı: <strong>${businessTotal}</strong> | 📞 Kayıtsız numara: <strong>${rawNumTotal}</strong></div>
                <div>• 👯 Çift kayıtlı (aynı isimli) kişi: <strong style="color:#c4b5fd;">${state.duplicateNamesSet.size}</strong></div>
                <div>• 🎯 Toplam Gizlenecek Hedef: <strong style="color:#00a884;">${state.masterExcludedKeys.size} kişi</strong></div>
                <div>• 🛡️ Gizlilik Hijyen Puanı: <strong style="color:#53bdeb;">${Math.max(10, Math.min(100, Math.round((state.masterWithPhotoKeys.size / Math.max(1, state.masterContactsMap.size)) * 100)))} / 100</strong></div>
            `;
        }
        if (diffBannerEl && (removedPhotoCount > 0 || addedPhotoCount > 0)) {
            diffBannerEl.style.display = 'block';
            diffBannerEl.innerHTML = `⚡ <strong>Fotoğraf Değişimi Tespit Edildi:</strong> ${removedPhotoCount} kişi fotoğrafını kaldırdı, ${addedPhotoCount} kişi yeni fotoğraf ekledi! <u>(Görmek için tıkla)</u>`;
        }
        addLog(`Master Analiz bitti: ${state.currentScanned.size} kişi incelendi, ${state.masterExcludedKeys.size} kişi gizlenecek.`);
    }

    async function processModalForSection(sectionLabel = 'Açık Pencere', sectionId = 'all', mode = 'exclude_nophoto') {
        const prefix = `[${sectionLabel}] `;
        updateUI(`${prefix}Kişi seçim penceresi kontrol ediliyor...`, 0);

        let found = null;
        const startWait = Date.now();
        while (Date.now() - startWait < 4500) {
            const strictCheck = await checkAndDismissStrictPopup();
            if (strictCheck.isStrictLock) {
                state.sectionResults[sectionLabel] = { lockedByStrict: true };
                renderSummaryBox();
                return false;
            }
            found = findPrivacyModalAndScroller();
            if (found) break;
            await sleep(300);
        }

        if (!found) {
            updateUI(`${prefix}Seçim penceresi açılamadı, sonraki bölüme geçiliyor...`);
            return false;
        }

        let { modal, scroller } = found;

        if ((mode === 'exclude_nophoto' || mode === 'dry_run') && !state.masterLocked) {
            await buildMasterListInOpenModal(scroller);
        }

        if (mode === 'dry_run') {
            updateUI(`Analiz tamamlandı! ${state.masterExcludedKeys.size} kişi gizlenmeye uygun ("Kişiler" sekmesinden inceleyin).`, 100);
            playNotificationBeep('success');
            return true;
        }

        const waitMs = getSpeedWaitMs();
        const isPerSectionMode = syncModeSelectEl.value === 'per_section';
        const maxPasses = mode === 'invert' || mode === 'uncheck_all' ? 1 : 2;

        for (let pass = 1; pass <= maxPasses; pass++) {
            if (!state.running) break;

            resetSectionCounters(sectionLabel);
            scroller.scrollTop = 0;
            await sleep(850);

            let lastTop = -1, stuckCount = 0;
            const invertedInThisPass = new Set();

            while (state.running) {
                await waitWhilePaused();
                await sleep(waitMs);

                const rows = getContactRows(scroller);
                rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
                await waitForFrameAvatarsToLoad(rows);

                const nameCountsInView = new Map();

                for (const row of rows) {
                    if (!state.running) break;
                    await waitWhilePaused();

                    const tempNameSpan = row.querySelector('span[title], span[dir="auto"]');
                    const rawName = tempNameSpan ? (tempNameSpan.getAttribute('title') || tempNameSpan.textContent || '').trim() : '';
                    const dupIdx = nameCountsInView.get(rawName) || 0;
                    nameCountsInView.set(rawName, dupIdx + 1);

                    const attr = analyzeRowAttributes(row, dupIdx);
                    if (!attr) continue;

                    const { uniqueKey } = attr;
                    state.currentScanned.add(uniqueKey);

                    if (mode === 'uncheck_all') {
                        if (isRowChecked(row)) {
                            await setRowCheckedStateSafe(row, false);
                        }
                        continue;
                    }

                    if (mode === 'invert') {
                        if (!invertedInThisPass.has(uniqueKey)) {
                            invertedInThisPass.add(uniqueKey);
                            const nextState = !isRowChecked(row);
                            await setRowCheckedStateSafe(row, nextState);
                            if (nextState) state.currentSelected.add(uniqueKey);
                        }
                        continue;
                    }

                    let shouldBeChecked = false;
                    if (isPerSectionMode) {
                        const dec = evaluateShouldExclude(attr, sectionId);
                        if (dec.isVip) state.currentWhitelisted.add(uniqueKey);
                        if (dec.extraReason) state.currentExtraCriteriaCount.add(uniqueKey);
                        shouldBeChecked = dec.exclude;
                    } else {
                        shouldBeChecked = state.masterExcludedKeys.has(uniqueKey);
                        const savedContact = state.masterContactsMap.get(uniqueKey);
                        if (savedContact && savedContact.reasons.some(r => r !== 'Fotoğrafsız')) {
                            state.currentExtraCriteriaCount.add(uniqueKey);
                        }
                    }

                    // CANLI FOTOĞRAF KALKANI (v18): Master taramada geç yüklenen bir fotoğraf şu an görünüyorsa
                    // ASLA işaretleme (ve işaretliyse tikini kaldır, master listeden de çıkar)!
                    const blNow = parseListKeywords(blacklistInputEl);
                    const isExplicitBl = isNameInList(attr.name, blNow);
                    if (optPhotoGuardEl && optPhotoGuardEl.checked && attr.hasPhoto && !isExplicitBl) {
                        shouldBeChecked = false;
                        state.masterExcludedKeys.delete(uniqueKey);
                        state.masterWithPhotoKeys.add(uniqueKey);
                    }

                    if (shouldBeChecked) {
                        state.currentSelected.add(uniqueKey);
                    } else {
                        state.currentWithPhoto.add(uniqueKey);
                    }

                    const currentlyChecked = isRowChecked(row);
                    if (shouldBeChecked !== currentlyChecked) {
                        await setRowCheckedStateSafe(row, shouldBeChecked);
                    }
                }

                const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
                const pct = (scroller.scrollTop / maxScroll) * 100;
                updateUI(
                    `${prefix}Sayılıyor... İncelenen: ${state.currentScanned.size} | Seçilen: ${state.currentSelected.size}`,
                    pct
                );

                if (!document.body.contains(scroller)) {
                    const refound = findPrivacyModalAndScroller();
                    if (refound && refound.scroller) scroller = refound.scroller;
                    else break;
                }
                const safeStep = Math.max(180, Math.min(265, Math.floor((scroller.clientHeight || 360) * 0.65)));
                lastTop = scroller.scrollTop;
                scroller.scrollTop += safeStep;
                await sleep(180);

                const isAtBottom = (scroller.scrollTop + scroller.clientHeight) >= (scroller.scrollHeight - 25);
                if (Math.abs(scroller.scrollTop - lastTop) < 4) {
                    stuckCount++;
                    if (isAtBottom && stuckCount >= 3) break;
                    if (!isAtBottom) {
                        await sleep(320);
                        scroller.scrollTop += safeStep;
                        if (stuckCount >= 10) break;
                    }
                } else {
                    stuckCount = 0;
                }
            }

            if (mode === 'uncheck_all' || mode === 'invert') break;

            const footerCount = readModalFooterExcludedCount(modal);
            const expectedCount = state.currentSelected.size;
            if (footerCount === null || footerCount === expectedCount) {
                break;
            }
        }

        if (state.running) {
            state.sectionResults[sectionLabel] = {
                scanned: state.currentScanned.size,
                photo: state.currentWithPhoto.size,
                selected: mode === 'uncheck_all' ? 0 : state.currentSelected.size
            };
            renderSummaryBox();
            addLog(`${sectionLabel}: ${state.currentScanned.size} kişi sayıldı, ${state.currentSelected.size} kişi gizlendi.`);

            await clickGreenCheckmarkButton(modal);
            await sleep(850);
            await checkAndDismissStrictPopup();
            updateUI(`${prefix}Tamamlandı ve Onaylandı! (${state.currentSelected.size} kişi)`, 100);
        }

        return true;
    }

    /**
     * ÖNEMLİ (v15 - ZERO MISCLICK BÖLÜM İŞLEYİCİSİ):
     * 1. Önce ana "Gizlilik" menüsünde olduğumuzu doğrular ve çekmeceyi en üste kaydırır.
     * 2. Bölüm başlığına (Son görülme ve çevrimiçi / Profil resmi / Hakkımda / Durum) SADECE %100 TAM METİN eşleşmesiyle 1 kez tıklar.
     * 3. Alt ekran açıldığında ÖNCE halihazırda "X kişi hariç bırakıldı" satırı var mı diye bakar; varsa radyo butonuna
     *    dokunmadan doğrudan o satıra tıklar (böylece Katı Hesap pop-up'ı hiç tetiklenmez!).
     * 4. Eğer "X kişi hariç bırakıldı" satırı yoksa "Şunlar hariç kişilerim..." radyo butonuna 1 kez tıklar.
     *    Katı Hesap pop-up'ı çıkarsa "Tamam"a basıp kapatır ve o bölümü anında atlayıp ana menüye döner!
     */
    async function processOnePrivacySection(section, mode = 'exclude_nophoto') {
        if (!state.running) return;
        resetSectionCounters(section.label);

        await returnToMainPrivacyDrawer();

        updateUI(`[${section.label}] Bölüme giriliyor...`);
        let rowClicked = false;
        const startWait = Date.now();
        while (Date.now() - startWait < 4000) {
            if (!state.running) return;
            if (clickExactMainSectionRow(section.exactTitles)) {
                rowClicked = true;
                break;
            }
            await sleep(300);
        }

        if (!rowClicked) {
            addLog(`${section.label} satırı ana Gizlilik menüsünde bulunamadı, atlanıyor.`);
            return;
        }

        await sleep(850);
        const strictAfterRow = await checkAndDismissStrictPopup();
        if (strictAfterRow.isStrictLock) {
            state.sectionResults[section.label] = { lockedByStrict: true };
            renderSummaryBox();
            await returnToMainPrivacyDrawer();
            return;
        }

        // Eğer zaten kişi seçim penceresi açıldıysa:
        let modalOpened = Boolean(findPrivacyModalAndScroller());

        if (!modalOpened) {
            // Önce mevcut "X kişi hariç bırakıldı" satırına tıklamayı dene (Radyo butonuna basmaktan çok daha güvenlidir!)
            const subAction1 = clickSubSectionExceptMyContactsOrList(true);
            await sleep(850);

            const strictAfterSub1 = await checkAndDismissStrictPopup();
            modalOpened = Boolean(findPrivacyModalAndScroller());

            if (!modalOpened && !strictAfterSub1.isStrictLock && subAction1.type === 'radio') {
                // Radyo butonuna tıklandıysa ve modal hemen açılmadıysa, şimdi altında beliren "kişi hariç bırakıldı" satırına tıkla
                clickSubSectionExceptMyContactsOrList(true);
                await sleep(850);
                await checkAndDismissStrictPopup();
                modalOpened = Boolean(findPrivacyModalAndScroller());
            } else if (!modalOpened && strictAfterSub1.isStrictLock) {
                state.sectionResults[section.label] = { lockedByStrict: true };
                renderSummaryBox();
                updateUI(`[${section.label}] Katı hesap ayarı nedeniyle kilitli, sonraki bölüme geçiliyor...`);
                await returnToMainPrivacyDrawer();
                return;
            }
        }

        if (modalOpened) {
            await processModalForSection(section.label, section.id, mode);
        } else {
            addLog(`${section.label}: Kişi seçim penceresi açılamadı (veya kilitli), sonraki bölüme geçiliyor.`);
        }

        await returnToMainPrivacyDrawer();
    }

    async function runAllSelectedSections(mode = 'exclude_nophoto') {
        if (state.running) {
            state.running = false;
            state.paused = false;
            btnPause.style.display = 'none';
            btnAuto.textContent = '▶ Tam Otomatik Başlat & Eşitle';
            btnAuto.style.background = '#00a884';
            updateUI('İşlem durduruldu.');
            return;
        }

        saveAllRules();
        const checkedIds = Array.from(panel.querySelectorAll('.wa-sec-cb:checked')).map(cb => cb.value);
        const sectionsToRun = PRIVACY_SECTIONS.filter(s => checkedIds.includes(s.id));

        if (sectionsToRun.length === 0) {
            updateUI('Lütfen en az bir gizlilik bölümü seçin!');
            return;
        }

        state.running = true;
        state.paused = false;
        state.startTimeMs = Date.now();
        state.masterLocked = false;
        state.masterContactsMap.clear();
        state.masterExcludedKeys.clear();
        state.masterWithPhotoKeys.clear();
        state.sectionResults = {};
        renderSummaryBox();

        btnAuto.textContent = '⏹ Durdur';
        btnAuto.style.background = '#ea4335';
        btnPause.style.display = 'block';
        btnPause.textContent = '⏸ Duraklat';

        await checkAndDismissStrictPopup();

        let info = getActiveLeftDrawerInfo();
        if (!info.isMainPrivacy && !info.isSubSection) {
            updateUI('Ayarlar menüsü açılıyor...');
            const settingsOk = await ensureSettingsDrawerOpen();
            info = getActiveLeftDrawerInfo();
            if (!settingsOk && !info.isMainPrivacy && !info.isSettings) {
                updateUI('Hata: Ayarlar menüsü açılamadı. Lütfen sol alttan Ayarlar simgesine tıklayın.');
                state.running = false;
                btnPause.style.display = 'none';
                btnAuto.textContent = '▶ Tam Otomatik Başlat & Eşitle';
                btnAuto.style.background = '#00a884';
                return;
            }

            if (!getActiveLeftDrawerInfo().isMainPrivacy) {
                updateUI('Ayarlar açıldı, "Gizlilik" bölümüne giriliyor...');
                clickExactMainSectionRow(['gizlilik', 'privacy']);
                await sleep(950);
            }
        } else if (info.isSubSection) {
            await returnToMainPrivacyDrawer();
        }

        for (let i = 0; i < sectionsToRun.length; i++) {
            if (!state.running) break;
            const sec = sectionsToRun[i];
            await processOnePrivacySection(sec, mode);
            await sleep(750);
        }

        state.running = false;
        state.paused = false;
        btnPause.style.display = 'none';
        btnAuto.textContent = '▶ Tam Otomatik Başlat & Eşitle';
        btnAuto.style.background = '#00a884';
        playNotificationBeep('success');
        sendDesktopNotification('WA Gizlilik Süiti (v20)', `Tüm seçili bölümler tamamlandı! (${state.masterExcludedKeys.size} kişi gizlendi)`);
        updateUI(`Tüm bölümler tamamlandı! Kilitli olmayan tüm bölümler sıfırlanarak sayıldı ve onaylandı.`, 100);
    }

    function renderContactExplorer() {
        const listEl = document.getElementById('wa-exp-list');
        const q = normTR(document.getElementById('wa-exp-search').value);
        const filter = document.getElementById('wa-exp-filter').value;

        const items = Array.from(state.masterContactsMap.values());
        if (items.length === 0) {
            listEl.innerHTML = '<div style="color:#8696a0; text-align:center; padding:20px;">Kişileri görmek için önce tarama veya analiz başlatın.</div>';
            return;
        }

        const filtered = items.filter(item => {
            if (q && !normTR(item.name).includes(q) && !normTR(item.secondary).includes(q)) return false;
            if (filter === 'excluded') return state.masterExcludedKeys.has(item.uniqueKey);
            if (filter === 'hasphoto') return Boolean(item.hasPhoto);
            if (filter === 'nophoto') return !item.hasPhoto;
            if (filter === 'noabout') return !item.hasAboutText;
            if (filter === 'defabout') return item.isDefaultAbout;
            if (filter === 'business') return item.isBusinessAccount;
            if (filter === 'duplicates') return state.duplicateNamesSet.has(item.name);
            if (filter === 'diff') return Boolean(item.diffStatus);
            return true;
        });

        if (filtered.length === 0) {
            listEl.innerHTML = '<div style="color:#8696a0; text-align:center; padding:16px;">Filtreye uygun kişi bulunamadı.</div>';
            return;
        }

        listEl.innerHTML = filtered.slice(0, 260).map(item => {
            const isExcluded = state.masterExcludedKeys.has(item.uniqueKey);
            const badgeColor = isExcluded ? '#00a884' : '#3b4a54';
            const badgeText = isExcluded ? 'Gizlendi' : 'Açık';
            const reasonBadges = (item.reasons || []).map(r => `<span class="wa-ult-badge" style="background:#2a3942; color:#ffd279; margin-right:3px;">${r}</span>`).join('');
            const aboutInfo = item.hasAboutText ? `📝 "${item.secondary}"` : '📝 Hakkımda Boş';
            const safeName = item.name.replace(/"/g, '&quot;');

            return `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:6px; border-bottom:1px solid #202c33;">
                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:260px;">
                        <strong style="color:#e9edef;">${item.name}</strong>
                        <div style="font-size:10px; color:#8696a0; margin-top:2px;">
                            ${item.hasPhoto ? '📷 Fotoğraflı' : '👤 Fotoğrafsız'} | ${aboutInfo}
                        </div>
                        <div style="margin-top:2px;">${reasonBadges}</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:4px;">
                        <span class="wa-ult-badge" style="background:${badgeColor}; color:#fff;">${badgeText}</span>
                        <button class="wa-quick-vip" data-name="${safeName}" title="VIP Beyaz Listeye Ekle" style="background:#202c33; color:#53bdeb; border:1px solid #2a3942; border-radius:4px; font-size:9.5px; padding:2px 4px; cursor:pointer;">VIP</button>
                        <button class="wa-quick-blk" data-name="${safeName}" title="Kara Listeye Ekle" style="background:#202c33; color:#ff8a80; border:1px solid #2a3942; border-radius:4px; font-size:9.5px; padding:2px 4px; cursor:pointer;">Gizle</button>
                    </div>
                </div>
            `;
        }).join('');

        listEl.querySelectorAll('.wa-quick-vip').forEach(btn => {
            btn.onclick = () => {
                const n = btn.getAttribute('data-name');
                const curr = parseListKeywords(whitelistInputEl);
                if (!curr.includes(normTR(n))) {
                    whitelistInputEl.value = whitelistInputEl.value ? `${whitelistInputEl.value}, ${n}` : n;
                    saveAllRules();
                    addLog(`"${n}" Beyaz Listeye (VIP) eklendi.`);
                    renderContactExplorer();
                }
            };
        });

        listEl.querySelectorAll('.wa-quick-blk').forEach(btn => {
            btn.onclick = () => {
                const n = btn.getAttribute('data-name');
                const curr = parseListKeywords(blacklistInputEl);
                if (!curr.includes(normTR(n))) {
                    blacklistInputEl.value = blacklistInputEl.value ? `${blacklistInputEl.value}, ${n}` : n;
                    saveAllRules();
                    addLog(`"${n}" Kara Listeye eklendi.`);
                    renderContactExplorer();
                }
            };
        });
    }

    document.getElementById('wa-exp-search').addEventListener('input', renderContactExplorer);
    document.getElementById('wa-exp-filter').addEventListener('change', renderContactExplorer);

    // ==================== 🧪 CİHAZ İÇİ TANI & OTOMATİK TEST MERKEZİ ====================
    async function runComprehensiveInDeviceSelfTest() {
        const resBox = document.getElementById('wa-selftest-results');
        const sumBox = document.getElementById('wa-selftest-summary');
        resBox.innerHTML = '<div style="color:#ffd279;">⏳ Cihaz içi testler çalıştırılıyor...</div>';
        sumBox.style.display = 'none';

        const results = [];
        function recordTest(name, passed, detail) {
            results.push({ name, passed: Boolean(passed), detail });
        }

        const hasWaDom = Boolean(document.getElementById('pane-side') || document.querySelector('#app'));
        recordTest('1. WhatsApp Web DOM & Oturum Algılama', hasWaDom, 'Ana uygulama konteyneri aktif.');

        const leftRailBtns = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex="0"]')).filter(el => {
            if (!isVisible(el)) return false;
            const r = el.getBoundingClientRect();
            return r.left >= 0 && r.left < 115;
        });
        recordTest('2. Sol Yan Şerit (Ayarlar/Navigasyon) Tespiti', leftRailBtns.length > 0, `${leftRailBtns.length} adet sol şerit kontrol butonu bulundu.`);

        // Test 3: Yasaklı Satır ("Katı hesap ayarları" / "Çevrimiçi olduğumu") Koruma Filtresi Testi
        const blocksStrictRow = isForbiddenText('Katı hesap ayarları') && isForbiddenText('Çevrimiçi olduğumu kimler görebilir') && !isForbiddenText('Profil resmi');
        recordTest('3. Yasaklı Satır (Zero-Misclick) Filtresi', blocksStrictRow, '"Katı hesap ayarları" ve "Çevrimiçi" satırlarına tıklanması engellendi.');

        const sandbox = document.createElement('div');
        sandbox.style.cssText = 'position:fixed; left:-9999px; top:0; width:360px; height:400px;';
        sandbox.innerHTML = `
            <div id="mock-row-nophoto" role="listitem" style="transform: translateY(0px);">
                <input type="checkbox" />
                <svg><path d="M10 10"/></svg>
                <span dir="auto" title="Test Fotoğrafsız Kişi">Test Fotoğrafsız Kişi</span>
            </div>
            <div id="mock-row-withphoto" role="listitem" style="transform: translateY(72px);">
                <input type="checkbox" />
                <img src="https://pps.whatsapp.net/v/t61.24694-24/mock.jpg" width="40" height="40" />
                <span dir="auto" title="Test Fotoğraflı Kişi">Test Fotoğraflı Kişi</span>
                <span dir="auto">Merhaba! WhatsApp kullanıyorum.</span>
            </div>
            <div id="mock-row-business" role="listitem" style="transform: translateY(144px);">
                <input type="checkbox" />
                <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" width="40" height="40" />
                <span data-icon="business-verified"></span>
                <span dir="auto" title="Test Kargo İşletme">Test Kargo İşletme</span>
                <span dir="auto">İşletme hesabı</span>
            </div>
            <div id="mock-row-foreign" role="listitem" style="transform: translateY(216px);">
                <input type="checkbox" />
                <span dir="auto" title="+49 151 23456789">+49 151 23456789</span>
            </div>
        `;
        document.body.appendChild(sandbox);

        const rowNoPhoto = sandbox.querySelector('#mock-row-nophoto');
        const rowWithPhoto = sandbox.querySelector('#mock-row-withphoto');
        const rowBusiness = sandbox.querySelector('#mock-row-business');
        const rowForeign = sandbox.querySelector('#mock-row-foreign');

        const attrNoPhoto = analyzeRowAttributes(rowNoPhoto, 0);
        const attrWithPhoto = analyzeRowAttributes(rowWithPhoto, 0);
        const attrBusiness = analyzeRowAttributes(rowBusiness, 0);
        const attrForeign = analyzeRowAttributes(rowForeign, 0);

        recordTest('4. Fotoğrafsız Kişi (Varsayılan SVG) Tespiti', attrNoPhoto && attrNoPhoto.hasPhoto === false, 'Fotoğrafsız satır doğru algılandı.');
        recordTest('5. Fotoğraflı Kişi (IMG/Avatar) Tespiti', attrWithPhoto && attrWithPhoto.hasPhoto === true, 'Fotoğraflı satır doğru algılandı ve korundu.');
        recordTest('6. "Hakkımda" Boş ve Varsayılan Yazı Analizi', attrNoPhoto && !attrNoPhoto.hasAboutText && attrWithPhoto && attrWithPhoto.isDefaultAbout, 'Boş ve varsayılan biyografi ayrıştırıldı.');
        recordTest('7. İşletme Hesabı & Yabancı Numara (+49) Tespiti', attrBusiness && attrBusiness.isBusinessAccount && attrForeign && attrForeign.isForeignNum, 'İşletme rozeti ve yabancı numara doğrulandı.');

        await setRowCheckedStateSafe(rowNoPhoto, true);
        const checkedAfterTrue = isRowChecked(rowNoPhoto);
        await setRowCheckedStateSafe(rowNoPhoto, true);
        const stillChecked = isRowChecked(rowNoPhoto);
        await setRowCheckedStateSafe(rowNoPhoto, false);
        const uncheckedAfterFalse = !isRowChecked(rowNoPhoto);

        recordTest('8. Kutucuk İşaretleme & Çift Tıklama Koruması', checkedAfterTrue && stillChecked && uncheckedAfterFalse, 'Tek tıklama ve geri bozulmama doğrulandı.');

        const origWl = whitelistInputEl.value;
        whitelistInputEl.value = 'Test Fotoğrafsız Kişi';
        const vipDecision = evaluateShouldExclude(attrNoPhoto, 'all');
        whitelistInputEl.value = origWl;
        recordTest('9. VIP Beyaz Liste Koruma Önceliği', vipDecision.isVip === true && vipDecision.exclude === false, 'VIP kişi gizlenmekten korundu.');

        const mockStrictDialog = document.createElement('div');
        mockStrictDialog.setAttribute('role', 'dialog');
        mockStrictDialog.style.cssText = 'position:fixed; left:10px; bottom:10px; width:260px; height:120px; background:#202c33; z-index:999998; padding:10px;';
        let mockStrictClosed = false;
        mockStrictDialog.innerHTML = `
            <div>Katı hesap ayarları açık</div>
            <div>Bu ayarları değiştirmek için birincil cihazınızda katı hesap ayarlarını kapatın. <a href="#">Daha fazla bilgi</a></div>
            <button id="mock-strict-ok" type="button">Tamam</button>
        `;
        document.body.appendChild(mockStrictDialog);
        mockStrictDialog.querySelector('#mock-strict-ok').onclick = () => {
            mockStrictClosed = true;
            mockStrictDialog.remove();
        };

        const strictRes = await checkAndDismissStrictPopup();
        if (document.body.contains(mockStrictDialog)) mockStrictDialog.remove();
        recordTest('10. Katı Hesap Ayarı Pop-up Kalkanı Simülasyonu', strictRes.dismissed && strictRes.isStrictLock && mockStrictClosed, '"Tamam" ile otomatik kapatıldı.');

        recordTest('11. Üst Katman (Topmost Layer / z-index) Algılama', isElementTopmost(panel), 'elementFromPoint katman testi başarılı.');

        let storageOk = false;
        try {
            localStorage.setItem('__wa_self_test', 'ok');
            storageOk = localStorage.getItem('__wa_self_test') === 'ok';
            localStorage.removeItem('__wa_self_test');
        } catch (e) {}
        recordTest('12. Tarayıcı Hafıza (LocalStorage) & Yedekleme', storageOk, 'Kayıt alanı aktif.');

        sandbox.remove();

        const passedCount = results.filter(r => r.passed).length;
        const allPassed = passedCount === results.length;

        sumBox.style.display = 'block';
        sumBox.style.background = allPassed ? '#064e3b' : '#5c2b33';
        sumBox.style.color = allPassed ? '#6ee7b7' : '#fca5a5';
        sumBox.textContent = `Cihaz İçi Test Sonucu: ${passedCount} / ${results.length} Test Başarıyla Geçti!`;

        resBox.innerHTML = results.map(r => `
            <div style="padding:5px 6px; border-bottom:1px solid #202c33;">
                <strong style="color:${r.passed ? '#00a884' : '#ff8a80'};">${r.passed ? '✓ GEÇTİ' : '✕ HATA'}: ${r.name}</strong>
                <div style="font-size:10px; color:#8696a0;">${r.detail}</div>
            </div>
        `).join('');

        playNotificationBeep(allPassed ? 'success' : 'warn');
    }

    document.getElementById('wa-btn-run-selftest').onclick = runComprehensiveInDeviceSelfTest;

    // Canlı Sekme Haritası Denetimi (Hiçbir pop-up tetiklemeden sol menüdeki tüm gizlilik satırlarını bulup yeşil çerçeveyle gösterir!)
    document.getElementById('wa-btn-run-navtest').onclick = async () => {
        if (state.running) return;
        const resBox = document.getElementById('wa-selftest-results');
        resBox.innerHTML = '<div style="color:#ffd279;">🧭 Sol menüdeki gizlilik sekmeleri denetleniyor...</div>';

        const info = getActiveLeftDrawerInfo();
        const logs = [];
        logs.push(`<div>• Aktif Çekmece Başlığı: <strong style="color:#00a884;">${info.headerTitle || 'Belirsiz'}</strong> (Ana Gizlilik: ${info.isMainPrivacy ? 'Evet ✓' : 'Hayır'})</div>`);

        scrollLeftDrawerToTop();
        await sleep(300);

        for (const sec of PRIVACY_SECTIONS) {
            const normTargets = sec.exactTitles.map(normTR);
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
            let foundEl = null;
            let node;
            while ((node = walker.nextNode())) {
                const txt = normTR(node.nodeValue);
                if (!normTargets.includes(txt)) continue;
                const sp = node.parentElement;
                if (!sp || !isVisible(sp) || isInChatList(sp) || panel.contains(sp)) continue;
                const r = sp.getBoundingClientRect();
                if (r.left >= 62 && r.left <= 520 && r.top >= 110 && isElementTopmost(sp)) {
                    foundEl = sp;
                    break;
                }
            }
            if (foundEl) {
                highlightElement(foundEl, '#00a884');
                logs.push(`<div>• <strong style="color:#00a884;">✓ BULUNDU:</strong> "${sec.label}" satırı ekranda doğrulandı ve yeşil çerçeveyle işaretlendi.</div>`);
            } else {
                logs.push(`<div>• <span style="color:#ffd279;">⚠️ GÖRÜNMÜYOR:</span> "${sec.label}" (Lütfen sol menüden Ayarlar > Gizlilik ekranını açın).</div>`);
            }
        }

        resBox.innerHTML = logs.join('');
        playNotificationBeep('success');
    };

    btnAuto.onclick = () => runAllSelectedSections('exclude_nophoto');

    btnDryRun.onclick = async () => {
        if (state.running) return;
        saveAllRules();
        if (!findPrivacyModalAndScroller()) {
            updateUI('Analiz için lütfen herhangi bir "Şunlar hariç kişilerim..." penceresini açın.');
            return;
        }
        state.running = true;
        state.startTimeMs = Date.now();
        state.masterLocked = false;
        state.masterContactsMap.clear();
        state.masterExcludedKeys.clear();
        state.masterWithPhotoKeys.clear();
        await processModalForSection('Simülasyon (Analiz)', 'all', 'dry_run');
        state.running = false;
    };

    btnUncheckAll.onclick = () => {
        if (findPrivacyModalAndScroller()) {
            state.running = true;
            state.startTimeMs = Date.now();
            processModalForSection('Seçimleri Temizle', 'all', 'uncheck_all').then(() => {
                state.running = false;
                playNotificationBeep('success');
            });
        } else {
            runAllSelectedSections('uncheck_all');
        }
    };

    btnInvert.onclick = () => {
        if (!findPrivacyModalAndScroller()) {
            updateUI('Seçimi tersine çevirmek için lütfen önce bir kişi seçim penceresi açın.');
            return;
        }
        state.running = true;
        state.startTimeMs = Date.now();
        processModalForSection('Seçimi Ters Çevir', 'all', 'invert').then(() => {
            state.running = false;
            playNotificationBeep('success');
        });
    };

    btnOnlyModal.onclick = async () => {
        if (state.running) {
            state.running = false;
            btnPause.style.display = 'none';
            btnAuto.textContent = '▶ Tam Otomatik Başlat & Eşitle';
            btnAuto.style.background = '#00a884';
            updateUI('İşlem durduruldu.');
            return;
        }
        saveAllRules();
        state.running = true;
        state.startTimeMs = Date.now();
        btnAuto.textContent = '⏹ Durdur';
        btnAuto.style.background = '#ea4335';
        btnPause.style.display = 'block';
        await processModalForSection('Açık Pencere', 'all', 'exclude_nophoto');
        state.running = false;
        btnPause.style.display = 'none';
        btnAuto.textContent = '▶ Tam Otomatik Başlat & Eşitle';
        btnAuto.style.background = '#00a884';
        playNotificationBeep('success');
    };

    btnExportCsv.onclick = () => {
        const items = Array.from(state.masterContactsMap.values());
        if (items.length === 0) {
            updateUI('İndirilecek rapor verisi yok.');
            return;
        }
        const rows = ['"Kişi Adı","Hakkımda / Alt Bilgi","Fotoğraf Durumu","Hakkımda Yazısı","İşletme Hesabı","Gizlenme Sebepleri","Sonuç"'];
        for (const it of items) {
            const name = (it.name || '').replace(/"/g, '""');
            const sec = (it.secondary || '').replace(/"/g, '""');
            const photoStr = it.hasPhoto ? 'Fotoğraflı' : 'Fotoğrafsız';
            const aboutStr = it.hasAboutText ? 'Var' : 'Yok (Boş)';
            const bizStr = it.isBusinessAccount ? 'Evet' : 'Hayır';
            const reasonsStr = (it.reasons || []).join(', ') || '-';
            const isExcluded = state.masterExcludedKeys.has(it.uniqueKey);
            const actionStr = isExcluded ? 'Hariç Tutuldu (Gizlendi)' : 'Açık Bırakıldı';
            rows.push(`"${name}","${sec}","${photoStr}","${aboutStr}","${bizStr}","${reasonsStr}","${actionStr}"`);
        }
        const csvContent = '\uFEFF' + rows.join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'whatsapp_gizlilik_v15_rapor.csv';
        a.click();
        URL.revokeObjectURL(url);
        updateUI('Detaylı CSV raporu indirildi.');
    };

    const exportTxtBtn = document.getElementById('wa-btn-export-txt');
    if (exportTxtBtn) {
        exportTxtBtn.onclick = () => {
            const hiddenNames = Array.from(state.masterContactsMap.values())
                .filter(c => state.masterExcludedKeys.has(c.uniqueKey))
                .map((c, idx) => `${idx + 1}. ${c.name} (${(c.reasons || ['Fotoğrafsız']).join(', ')})`);
            if (hiddenNames.length === 0) {
                updateUI('Dışa aktarılacak gizlenen kişi bulunamadı (önce tarama yapın).');
                return;
            }
            const blob = new Blob([hiddenNames.join('\n')], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'whatsapp_gizlenen_kisiler_v22.txt';
            a.click();
            URL.revokeObjectURL(url);
            updateUI(`${hiddenNames.length} kişi .txt olarak indirildi!`);
        };
    }

    function applyBulkToFilteredExplorer(targetInputEl, labelName) {
        const q = normTR(document.getElementById('wa-exp-search').value);
        const filter = document.getElementById('wa-exp-filter').value;
        const items = Array.from(state.masterContactsMap.values()).filter(item => {
            if (q && !normTR(item.name).includes(q) && !normTR(item.secondary).includes(q)) return false;
            if (filter === 'excluded') return state.masterExcludedKeys.has(item.uniqueKey);
            if (filter === 'hasphoto') return Boolean(item.hasPhoto);
            if (filter === 'nophoto') return !item.hasPhoto;
            if (filter === 'noabout') return !item.hasAboutText;
            if (filter === 'defabout') return item.isDefaultAbout;
            if (filter === 'business') return item.isBusinessAccount;
            if (filter === 'duplicates') return state.duplicateNamesSet.has(item.name);
            if (filter === 'diff') return Boolean(item.diffStatus);
            return true;
        });
        if (items.length === 0) return;
        const existing = parseListKeywords(targetInputEl);
        const added = [];
        for (const it of items.slice(0, 100)) {
            if (!existing.includes(normTR(it.name))) {
                existing.push(normTR(it.name));
                added.push(it.name);
            }
        }
        if (added.length > 0) {
            targetInputEl.value = targetInputEl.value ? `${targetInputEl.value}, ${added.join(', ')}` : added.join(', ');
            saveAllRules();
            addLog(`${added.length} kişi topluca ${labelName} listesine eklendi.`);
            updateUI(`${added.length} kişi ${labelName} listesine eklendi.`);
        }
    }
    const bulkVipBtn = document.getElementById('wa-exp-bulk-vip');
    if (bulkVipBtn) bulkVipBtn.onclick = () => applyBulkToFilteredExplorer(whitelistInputEl, 'VIP Beyaz');
    const bulkBlkBtn = document.getElementById('wa-exp-bulk-blk');
    if (bulkBlkBtn) bulkBlkBtn.onclick = () => applyBulkToFilteredExplorer(blacklistInputEl, 'Kara');

    const copySummaryBtn = document.getElementById('wa-btn-copy-summary');
    if (copySummaryBtn) {
        copySummaryBtn.onclick = async () => {
            const lines = ['WhatsApp Gizlilik Otomasyonu (v18) Özeti:'];
            for (const [sec, res] of Object.entries(state.sectionResults)) {
                if (res.lockedByStrict) {
                    lines.push(`- ${sec}: Katı hesap ayarı nedeniyle kilitli`);
                } else {
                    lines.push(`- ${sec}: ${res.selected} gizlendi / ${res.photo} açık (Toplam: ${res.scanned})`);
                }
            }
            if (lines.length === 1) {
                lines.push(`- Master Analiz: ${state.masterContactsMap.size} kişi, ${state.masterExcludedKeys.size} gizlenecek hedef`);
            }
            try {
                await navigator.clipboard.writeText(lines.join('\n'));
                updateUI('Özet rapor panoya kopyalandı!');
            } catch (_) {
                updateUI('Panoya kopyalanamadı (tarayıcı izni gerekli).');
            }
        };
    }

    document.getElementById('wa-btn-export-html').onclick = () => {
        const items = Array.from(state.masterContactsMap.values());
        if (items.length === 0) {
            updateUI('Rapor oluşturmak için önce tarama yapın.');
            return;
        }
        const rowsHtml = items.map(it => {
            const isEx = state.masterExcludedKeys.has(it.uniqueKey);
            return `<tr>
                <td><strong>${it.name}</strong></td>
                <td>${it.secondary || '<em style="color:#999;">Boş</em>'}</td>
                <td>${it.hasPhoto ? '📷 Fotoğraflı' : '👤 Fotoğrafsız'}</td>
                <td>${(it.reasons || []).join(', ') || '-'}</td>
                <td style="color:${isEx ? '#00a884' : '#666'}; font-weight:bold;">${isEx ? 'Gizlendi' : 'Açık'}</td>
            </tr>`;
        }).join('');

        const htmlDoc = `<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><title>WhatsApp Gizlilik Raporu (v15)</title>
        <style>body{font-family:sans-serif;background:#0b141a;color:#e9edef;padding:24px;} table{width:100%;border-collapse:collapse;margin-top:16px;background:#111b21;} th,td{border:1px solid #2a3942;padding:8px 10px;text-align:left;font-size:13px;} th{background:#202c33;color:#00a884;}</style></head>
        <body><h2>WhatsApp Gizlilik & Kişi Analiz Raporu (v24 Final Studio)</h2>
        <p>Toplam İncelenen: <strong>${items.length}</strong> | Hariç Tutulan (Gizlenen): <strong>${state.masterExcludedKeys.size}</strong> | Çift Kayıtlı: <strong>${state.duplicateNamesSet.size}</strong> | Tarih: ${new Date().toLocaleString('tr-TR')}</p>
        <table><thead><tr><th>Kişi Adı</th><th>Hakkımda Yazısı</th><th>Fotoğraf</th><th>Gizlenme Sebepleri</th><th>Durum</th></tr></thead><tbody>${rowsHtml}</tbody></table></body></html>`;

        const blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'whatsapp_gizlilik_gorsel_rapor_v22.html';
        a.click();
        URL.revokeObjectURL(url);
        updateUI('Görsel HTML raporu indirildi.');
    };

    document.getElementById('wa-btn-backup-json').onclick = () => {
        const payload = {
            version: 'v15',
            timestamp: new Date().toISOString(),
            whitelist: whitelistInputEl.value,
            blacklist: blacklistInputEl.value,
            keywords: keywordsInputEl.value,
            settings: savedSettings,
            snapshot: state.previousSnapshot
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'wa_gizlilik_yedek_v20.json';
        a.click();
        URL.revokeObjectURL(url);
        updateUI('JSON yedeği indirildi.');
    };

    const fileRestoreEl = document.getElementById('wa-file-restore');
    document.getElementById('wa-btn-restore-json').onclick = () => fileRestoreEl.click();
    fileRestoreEl.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                if (typeof data.whitelist === 'string') whitelistInputEl.value = data.whitelist;
                if (typeof data.blacklist === 'string') blacklistInputEl.value = data.blacklist;
                if (typeof data.keywords === 'string') keywordsInputEl.value = data.keywords;
                if (data.snapshot) {
                    state.previousSnapshot = data.snapshot;
                    saveJSON(STORAGE_KEYS.SNAPSHOT, data.snapshot);
                }
                saveAllRules();
                updateUI('Yedek dosyası başarıyla yüklendi.');
            } catch (err) {
                updateUI('Hata: Geçersiz yedek dosyası!');
            }
        };
        reader.readAsText(file);
    };

    renderLogs();
})();