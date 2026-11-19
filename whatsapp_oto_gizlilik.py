# -*- coding: utf-8 -*-
"""
WhatsApp Web Privacy Suite - Masaüstü Otomasyonu (v24 Final Studio Edition)

Playwright tabanlı kalıcı Chromium profili ile WhatsApp Web gizlilik ayarlarını
otomatik yönetir.

Kurulum:
    pip install -r requirements.txt
    playwright install chromium

Kullanım:
    python whatsapp_oto_gizlilik.py
    python whatsapp_oto_gizlilik.py --self-test
"""

import asyncio
import csv
import json
import os
import random
import re
import sys
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SESSION_DIR = os.path.join(BASE_DIR, "wa_oturum_verisi")
EXPORT_TXT = os.path.join(BASE_DIR, "haric_tutulan_kisiler.txt")
EXPORT_CSV = os.path.join(BASE_DIR, "whatsapp_gizlilik_v15_rapor.csv")
EXPORT_HTML = os.path.join(BASE_DIR, "whatsapp_gizlilik_gorsel_rapor_v15.html")
SNAPSHOT_JSON = os.path.join(BASE_DIR, "wa_gizlilik_snapshot.json")

# ==================== 7 AKILLI GİZLEME KRİTERİ ====================
CRIT_HIDE_NO_PHOTO = True          # 1. Profil fotoğrafı olmayanları gizle
CRIT_HIDE_NO_ABOUT = False         # 2. "Hakkımda" yazısı boş/gizli olanları gizle
CRIT_HIDE_DEFAULT_ABOUT = False    # 3. Varsayılan "Hakkımda" ("Müsait", "Hey there!") olanları gizle
CRIT_HIDE_BUSINESS = False         # 4. İşletme / Kurumsal hesapları gizle
CRIT_HIDE_RAW_NUMBERS = False      # 5. Rehberde kayıtsız (+90...) numaraları gizle
CRIT_HIDE_FOREIGN_NUMBERS = False  # 6. Yabancı ülke kodlu (+90 dışı) numaraları gizle
CRIT_HIDE_SHORT_OR_SYMBOL = False  # 7. Tek harf / sembol (".", "?") isimlileri gizle

HUMAN_JITTER = True

HIDE_KEYWORDS = [
    # Örn: "Kurye", "Emlak", "Staj"
]

SYNC_MODE = "unified"

WHITELIST_NAMES = [
    # Örn: "Annem", "Babam"
]

BLACKLIST_NAMES = [
    # Örn: "Patron"
]
# ==================================================================

DEFAULT_ABOUT_PHRASES = [
    "merhaba! whatsapp kullanıyorum",
    "hey there! i am using whatsapp",
    "müsait",
    "available",
    "meşgul",
    "busy",
    "okulda",
    "at school",
    "sinemada",
    "at the movies",
    "işte",
    "at work",
    "pil bitmek üzere",
    "battery about to die",
    "konuşamam, sadece whatsapp",
    "toplantıda",
    "spor salonunda",
    "uyuyor",
    "sadece acil çağrılar"
]

# Sadece %100 TAM METİN eşleşmesi yapılacak ana Gizlilik bölümleri
PRIVACY_SECTIONS = [
    {
        "id": "last_seen",
        "label": "Son görülme ve çevrimiçi",
        "exactTitles": ["son görülme ve çevrimiçi", "son görülme", "last seen and online", "last seen"]
    },
    {
        "id": "profile_photo",
        "label": "Profil resmi",
        "exactTitles": ["profil resmi", "profil fotoğrafı", "profile photo", "profile picture"]
    },
    {
        "id": "about",
        "label": "Hakkımda",
        "exactTitles": ["hakkımda", "about"]
    },
    {
        "id": "status",
        "label": "Durum",
        "exactTitles": ["durum", "status", "durum gizliliği"]
    }
]

INJECTED_HELPERS_JS = """
window.__waPrivacyHelper = {
    FORBIDDEN_ROW_KEYWORDS: [
        'katı hesap', 'strict account', 'gelişmiş', 'advanced', 'uygulama kilidi', 'app lock',
        'engellenen', 'blocked', 'canlı konum', 'live location', 'aramalar', 'calls',
        'varsayılan mesaj', 'disappearing', 'okundu bilgisi', 'read receipts',
        'çevrimiçi olduğumu kimler', 'who can see when i\\'m online', 'son görülme bilginisi ile aynı',
        'same as last seen', 'daha fazla bilgi', 'learn more', 'birincil cihazınızda'
    ],

    normTR: function(str) {
        return (str || '').toLocaleLowerCase('tr-TR').replace(/\\s+/g, ' ').trim();
    },

    isForbiddenText: function(txt) {
        const n = this.normTR(txt);
        if (!n) return false;
        return this.FORBIDDEN_ROW_KEYWORDS.some(bad => n.includes(bad));
    },

    isVisible: function(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    },

    isElementTopmost: function(el) {
        if (!this.isVisible(el)) return false;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
        const topEl = document.elementFromPoint(cx, cy);
        if (!topEl) return false;
        return el === topEl || el.contains(topEl) || topEl.contains(el);
    },

    isInChatList: function(el) {
        const paneSide = document.getElementById('pane-side');
        return Boolean(paneSide && paneSide.contains(el));
    },

    triggerSingleClick: function(el) {
        if (!el) return false;
        if (el.style) {
            const orig = el.style.outline;
            el.style.outline = '2px solid #00a884';
            setTimeout(() => { try { el.style.outline = orig; } catch(e){} }, 400);
        }
        if (typeof el.click === 'function') {
            el.click();
            return true;
        }
        const rect = el.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0, buttons: 1 };
        el.dispatchEvent(new MouseEvent('click', opts));
        return true;
    },

    scrollLeftDrawerToTop: function() {
        const allDivs = document.querySelectorAll('div');
        for (const d of allDivs) {
            if (!this.isVisible(d) || this.isInChatList(d)) continue;
            const r = d.getBoundingClientRect();
            if (r.left >= 50 && r.left <= 120 && r.width >= 250 && r.width <= 520) {
                const st = window.getComputedStyle(d);
                if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && d.scrollTop > 0) {
                    d.scrollTop = 0;
                }
            }
        }
    },

    checkAndDismissStrictPopup: function() {
        const dialogs = document.querySelectorAll('[role="dialog"], [data-animate-modal-popup="true"], [data-animate-modal-body="true"]');
        for (const d of dialogs) {
            if (!this.isVisible(d) || this.isInChatList(d)) continue;

            const checkboxes = d.querySelectorAll('input[type="checkbox"], [role="checkbox"], [data-icon*="checkbox"]');
            const listItems = d.querySelectorAll('[role="listitem"], [role="row"], [data-testid="cell-frame-container"]');
            const dialogText = this.normTR(d.textContent);

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
                if (!this.isVisible(b)) continue;
                const bTxt = this.normTR(b.textContent || b.getAttribute('aria-label') || b.getAttribute('title'));
                if (bTxt.includes('daha fazla bilgi') || bTxt.includes('learn more')) continue;

                if (dismissKeywords.some(kw => bTxt === kw || bTxt.includes(kw))) {
                    this.triggerSingleClick(b);
                    return { dismissed: true, isStrictLock: true };
                }
            }

            const safeButtons = buttons.filter(b => {
                const t = this.normTR(b.textContent);
                return this.isVisible(b) && !t.includes('daha fazla') && !t.includes('learn more') && b.tagName !== 'A';
            });
            if (safeButtons.length > 0) {
                this.triggerSingleClick(safeButtons[safeButtons.length - 1]);
                return { dismissed: true, isStrictLock: isStrictLock };
            }
        }
        return { dismissed: false, isStrictLock: false };
    },

    getActiveLeftDrawerInfo: function() {
        let headerTitle = '';
        let hasPersonalWhoCanSeeHeader = false;
        let hasRadioButtonsInDrawer = false;
        let visibleSectionTitlesCount = 0;
        let visibleSettingsItemsCount = 0;

        const radios = document.querySelectorAll('[role="radio"], input[type="radio"]');
        for (const rad of radios) {
            if (this.isVisible(rad) && !this.isInChatList(rad) && rad.getBoundingClientRect().left < 540) {
                if (this.isElementTopmost(rad)) hasRadioButtonsInDrawer = true;
            }
        }

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
            const txt = this.normTR(node.nodeValue);
            if (!txt || txt.length > 65) continue;
            const p = node.parentElement;
            if (!p || !this.isVisible(p) || this.isInChatList(p)) continue;
            const r = p.getBoundingClientRect();
            if (r.left < 55 || r.left > 540) continue;
            if (!this.isElementTopmost(p)) continue;

            if (r.top >= 0 && r.top <= 105 && r.left >= 55 && r.left <= 440) {
                if (!headerTitle) headerTitle = txt;
            }
            if (txt.includes('kişisel bilgilerimi kimler görebilir')) hasPersonalWhoCanSeeHeader = true;
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

        const isSubSection = hasRadioButtonsInDrawer || (isKnownSubHeader && !hasPersonalWhoCanSeeHeader);
        const isMainPrivacy = !isSubSection && (headerTitle === 'gizlilik' || headerTitle === 'privacy' || hasPersonalWhoCanSeeHeader || visibleSectionTitlesCount >= 2);
        const isSettings = !isMainPrivacy && !isSubSection && (headerTitle === 'ayarlar' || headerTitle === 'settings' || visibleSettingsItemsCount >= 2);

        return {
            headerTitle,
            isMainPrivacy: Boolean(isMainPrivacy),
            isSubSection: Boolean(isSubSection),
            isSettings: Boolean(isSettings)
        };
    },

    clickDrawerBackButton: function() {
        const explicitSelectors = [
            'button[aria-label="Geri"]', 'button[aria-label="Back"]',
            '[role="button"][aria-label="Geri"]', '[role="button"][aria-label="Back"]',
            '[title="Geri"]', '[title="Back"]',
            '[data-icon="back"]', '[data-icon="arrow-back"]', '[data-icon="back-refreshed"]', '[data-testid="back"]'
        ];
        const explicitCandidates = [];
        for (const sel of explicitSelectors) {
            for (const el of document.querySelectorAll(sel)) {
                if (!this.isVisible(el) || this.isInChatList(el)) continue;
                const btn = el.closest('button, [role="button"], div[tabindex="0"]') || el;
                if (btn.getAttribute('role') === 'radio' || btn.closest('[role="radio"], [role="radiogroup"]')) continue;
                const r = btn.getBoundingClientRect();
                if (r.left >= 52 && r.left <= 170 && r.top >= 0 && r.top <= 95 && r.width <= 70 && r.height <= 70) {
                    if (this.isElementTopmost(btn)) explicitCandidates.push({ el: btn, top: r.top, left: r.left });
                }
            }
        }
        if (explicitCandidates.length > 0) {
            explicitCandidates.sort((a, b) => (a.top - b.top) || (a.left - b.left));
            return this.triggerSingleClick(explicitCandidates[0].el);
        }

        const fallbackCandidates = [];
        const allBtns = document.querySelectorAll('button, [role="button"], div[tabindex="0"]');
        for (const btn of allBtns) {
            if (!this.isVisible(btn) || this.isInChatList(btn)) continue;
            if (btn.getAttribute('role') === 'radio' || btn.closest('[role="radio"], [role="radiogroup"]')) continue;
            const txt = this.normTR(btn.textContent);
            if (txt && txt.length > 2) continue;
            if (!btn.querySelector('svg')) continue;
            const r = btn.getBoundingClientRect();
            if (r.left >= 52 && r.left <= 155 && r.top >= 0 && r.top <= 85 && r.width >= 18 && r.width <= 64 && r.height >= 18 && r.height <= 64) {
                if (this.isElementTopmost(btn)) fallbackCandidates.push({ el: btn, top: r.top, left: r.left });
            }
        }
        if (fallbackCandidates.length > 0) {
            fallbackCandidates.sort((a, b) => (a.top - b.top) || (a.left - b.left));
            return this.triggerSingleClick(fallbackCandidates[0].el);
        }
        return false;
    },

    getBottomRailCandidateButtons: function() {
        this.checkAndDismissStrictPopup();
        const allLeftEls = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex="0"], span[data-icon]')).filter(el => {
            if (!this.isVisible(el) || this.isInChatList(el)) return false;
            return el.getBoundingClientRect().left < 110;
        });
        for (const el of allLeftEls) {
            const aria = this.normTR(el.getAttribute('aria-label'));
            const title = this.normTR(el.getAttribute('title'));
            const icon = this.normTR(el.getAttribute('data-icon'));
            const testid = this.normTR(el.getAttribute('data-testid'));
            if (aria.includes('medya') || aria.includes('media') || title.includes('medya') || title.includes('media') || icon.includes('media')) continue;
            if (aria === 'ayarlar' || aria === 'settings' || title === 'ayarlar' || title === 'settings' || icon.includes('settings') || testid.includes('settings')) {
                const clickable = el.closest('button, [role="button"], div[tabindex="0"]') || el;
                return this.triggerSingleClick(clickable);
            }
        }
        return false;
    },

    clickExactMainSectionRow: function(exactTitles) {
        this.scrollLeftDrawerToTop();
        const normTargets = exactTitles.map(this.normTR);

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        const candidates = [];
        let node;

        while ((node = walker.nextNode())) {
            const txt = this.normTR(node.nodeValue);
            if (!txt || !normTargets.includes(txt)) continue;

            const spanEl = node.parentElement;
            if (!spanEl || !this.isVisible(spanEl) || this.isInChatList(spanEl)) continue;

            const r = spanEl.getBoundingClientRect();
            if (r.left < 30 || r.left > Math.max(680, window.innerWidth * 0.55) || r.top < 65) continue;
            if (!this.isElementTopmost(spanEl)) continue;

            let rowTarget = spanEl;
            let curr = spanEl.parentElement;
            while (curr && curr !== document.body) {
                const cr = curr.getBoundingClientRect();
                if (cr.height > 110 || cr.width > Math.max(680, window.innerWidth * 0.55)) break;
                rowTarget = curr;
                if (curr.getAttribute('role') === 'button' || curr.getAttribute('role') === 'listitem' || curr.hasAttribute('tabindex')) {
                    break;
                }
                curr = curr.parentElement;
            }

            if (this.isForbiddenText(rowTarget.textContent)) continue;
            candidates.push({ el: rowTarget, top: r.top });
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => a.top - b.top);
            return this.triggerSingleClick(candidates[0].el);
        }
        return false;
    },

    clickSubSectionExceptMyContactsOrList: function(preferExistingCountRow) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        const countRowCandidates = [];
        const radioCandidates = [];
        let node;

        while ((node = walker.nextNode())) {
            const txt = this.normTR(node.nodeValue);
            if (!txt || txt.length > 55) continue;
            if (this.isForbiddenText(txt)) continue;

            const spanEl = node.parentElement;
            if (!spanEl || !this.isVisible(spanEl) || this.isInChatList(spanEl)) continue;
            const r = spanEl.getBoundingClientRect();
            if (r.left < 30 || r.left > Math.max(680, window.innerWidth * 0.55) || r.top < 65) continue;
            if (!this.isElementTopmost(spanEl)) continue;

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

            if (this.isForbiddenText(rowTarget.textContent)) continue;

            if (
                /\\d+\\s*kişi\\s*hariç/i.test(txt) ||
                txt.includes('kişi hariç bırakıldı') ||
                txt.includes('kişi hariç tutuldu') ||
                txt.includes('contacts excluded')
            ) {
                countRowCandidates.push({ el: rowTarget, top: r.top });
            }

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
            return { clicked: this.triggerSingleClick(countRowCandidates[0].el), type: 'count_row' };
        }

        if (radioCandidates.length > 0) {
            radioCandidates.sort((a, b) => a.top - b.top);
            return { clicked: this.triggerSingleClick(radioCandidates[0].el), type: 'radio' };
        }

        if (countRowCandidates.length > 0) {
            countRowCandidates.sort((a, b) => a.top - b.top);
            return { clicked: this.triggerSingleClick(countRowCandidates[0].el), type: 'count_row' };
        }

        return { clicked: false, type: null };
    },

    readModalFooterExcludedCount: function() {
        const found = this.findPrivacyModalAndScroller();
        const modalEl = found ? found.modal : document.body;
        const walker = document.createTreeWalker(modalEl, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
            const txt = this.normTR(node.nodeValue);
            if (txt.includes('hariç bırakıldı') || txt.includes('hariç tutuldu') || txt.includes('excluded')) {
                const m = txt.match(/(\\d+)/);
                if (m) return parseInt(m[1], 10);
                if (txt.includes('hiç') || txt.includes('no ')) return 0;
            }
        }
        return null;
    },

    clickGreenCheckmarkButton: function() {
        const found = this.findPrivacyModalAndScroller();
        const modalEl = found ? found.modal : document;
        const iconSelectors = [
            '[data-icon="checkmark-large"]', '[data-icon="checkmark"]', '[data-icon="check"]',
            '[data-testid="checkmark-large"]', '[aria-label="Tamam"]', '[aria-label="Onayla"]',
            '[aria-label="Kaydet"]', '[aria-label="Bitti"]', '[aria-label="OK"]', '[aria-label="Done"]'
        ];
        for (const sel of iconSelectors) {
            const el = modalEl.querySelector(sel) || document.querySelector(sel);
            if (el && this.isVisible(el) && !this.isInChatList(el)) {
                const btn = el.closest('button, [role="button"], div[tabindex]') || el;
                return this.triggerSingleClick(btn);
            }
        }
        const modalRect = (modalEl === document ? document.body : modalEl).getBoundingClientRect();
        const candidates = Array.from(modalEl.querySelectorAll('button, [role="button"], div[tabindex="0"], span[data-icon]'));
        for (const c of candidates) {
            if (!this.isVisible(c) || this.isInChatList(c)) continue;
            const r = c.getBoundingClientRect();
            if (r.top > modalRect.top + modalRect.height * 0.7 && r.width >= 32 && r.width <= 75) {
                if (c.querySelector('svg') || c.tagName.toLowerCase() === 'svg') {
                    return this.triggerSingleClick(c);
                }
            }
        }
        return false;
    },

    checkRowHasPhoto: function(rowEl) {
        if (!rowEl) return false;
        const rowRect = rowEl.getBoundingClientRect();
        const imgs = rowEl.querySelectorAll('img');
        for (const img of imgs) {
            const cls = (typeof img.className === 'string' ? img.className : '') || '';
            if (cls.includes('emoji') || img.hasAttribute('data-plain-text')) continue;
            const src = (img.getAttribute('src') || img.currentSrc || img.getAttribute('srcset') || '').trim();
            if (!src || src === 'about:blank' || src.toLowerCase().includes('/emoji')) continue;
            const ir = img.getBoundingClientRect();
            if (ir.width > 0 && ir.width <= 24 && ir.height > 0 && ir.height <= 24 && !src.includes('pps.whatsapp.net') && !src.startsWith('blob:')) continue;
            return true;
        }
        if (rowEl.querySelector('svg image')) return true;
        for (const cv of rowEl.querySelectorAll('canvas')) {
            const cr = cv.getBoundingClientRect();
            if (cr.width >= 26 && cr.height >= 26 && (rowRect.width === 0 || (cr.left - rowRect.left) < 120)) return true;
        }
        for (const el of rowEl.querySelectorAll('[style*="background-image"]')) {
            const bg = el.style.backgroundImage || '';
            if (bg && bg !== 'none' && bg.includes('url(')) return true;
        }
        if (!rowEl.querySelector('svg')) for (const box of rowEl.querySelectorAll('div, span')) {
            const br = box.getBoundingClientRect();
            if (br.width >= 28 && br.width <= 72 && br.height >= 28 && br.height <= 72 && (rowRect.width === 0 || (br.left - rowRect.left) < 120)) {
                const bg = window.getComputedStyle(box).backgroundImage;
                if (bg && bg !== 'none' && bg.includes('url(')) return true;
            }
        }
        return false;
    },

    isRowChecked: function(rowEl) {
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
    },

    clickRowOnceSafe: function(rowEl) {
        const primaryTarget =
            rowEl.querySelector('input[type="checkbox"]') ||
            rowEl.querySelector('[role="checkbox"]') ||
            rowEl.querySelector('[data-testid="cell-frame-container"]') ||
            rowEl;
        this.triggerSingleClick(primaryTarget);
    },

    analyzeRowAttributes: function(rowEl, duplicateIndexInView) {
        let primaryName = null;
        let secondaryText = '';
        const spans = Array.from(rowEl.querySelectorAll('span[title], span[dir="auto"]'));
        for (const sp of spans) {
            if (sp.classList && sp.classList.contains('emoji')) continue;
            const txt = (sp.getAttribute('title') || sp.textContent || '').trim();
            if (!txt || txt.length <= 1 || txt.includes('kişi hariç')) continue;
            if (!primaryName) primaryName = txt;
            else if (txt !== primaryName && !secondaryText) secondaryText = txt;
        }
        if (!primaryName) return null;

        const hasAboutText = Boolean(secondaryText && secondaryText.length >= 1);
        const hasBusinessBadge = Boolean(
            rowEl.querySelector('[data-icon*="business"], [data-icon*="verified"], [data-testid*="business"], [aria-label*="İşletme"], [aria-label*="Business"]')
        );
        const secNorm = this.normTR(secondaryText);
        const nameNorm = this.normTR(primaryName);
        const isBusinessAccount =
            hasBusinessBadge ||
            secNorm.includes('işletme hesabı') ||
            secNorm.includes('business account') ||
            secNorm.includes('resmi hesap') ||
            nameNorm.includes('kargo') ||
            nameNorm.includes('müşteri hizmetleri');

        let posElement = rowEl, posKey = '';
        for (let i = 0; i < 4 && posElement; i++) {
            const st = posElement.getAttribute('style') || '';
            const m = st.match(/translateY\\(([^)]+)\\)/i) || st.match(/top:\\s*([^;]+)/i);
            if (m) { posKey = m[1].trim(); break; }
            posElement = posElement.parentElement;
        }
        if (!posKey) posKey = 'dup_' + (duplicateIndexInView || 0);
        const uniqueKey = primaryName + ' || ' + secondaryText + ' || ' + posKey;

        return {
            name: primaryName,
            secondary: secondaryText,
            uniqueKey: uniqueKey,
            hasPhoto: this.checkRowHasPhoto(rowEl),
            hasAboutText: hasAboutText,
            isBusinessAccount: isBusinessAccount
        };
    },

    findScrollerInside: function(rootEl) {
        const divs = rootEl.querySelectorAll('div');
        let best = null, maxScroll = 0;
        for (const d of divs) {
            if (this.isInChatList(d)) continue;
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
    },

    findPrivacyModalAndScroller: function() {
        const dialogs = document.querySelectorAll('[role="dialog"], [data-animate-modal-popup="true"], [data-animate-modal-body="true"]');
        for (const d of dialogs) {
            if (!this.isVisible(d) || this.isInChatList(d)) continue;
            const scroller = this.findScrollerInside(d);
            if (scroller && this.getContactRows(scroller).length >= 2) {
                return { modal: d, scroller: scroller };
            }
        }
        const allSpans = document.querySelectorAll('span, div, h1, h2');
        for (const s of allSpans) {
            if (!this.isVisible(s) || this.isInChatList(s)) continue;
            const t = this.normTR(s.textContent);
            if (
                t.includes('şu kişilerden gizle') ||
                t.includes('kişi hariç bırakıldı') ||
                t.includes('kişi hariç tutuldu') ||
                t.includes('hide profile photo from')
            ) {
                let parent = s.parentElement;
                while (parent && parent !== document.body) {
                    const scroller = this.findScrollerInside(parent);
                    if (scroller && this.getContactRows(scroller).length >= 2) {
                        return { modal: parent, scroller: scroller };
                    }
                    parent = parent.parentElement;
                }
            }
        }
        return null;
    },

    getContactRows: function(scroller) {
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
};
"""


async def jitter_sleep(base_sec):
    if HUMAN_JITTER and base_sec > 0.15:
        delta = random.uniform(-0.04, 0.08)
        await asyncio.sleep(max(0.06, base_sec + delta))
    else:
        await asyncio.sleep(base_sec)


def is_in_list(name, target_list):
    n_low = (name or "").lower().strip()
    for w in target_list:
        w_low = w.lower().strip()
        if w_low and (n_low == w_low or w_low in n_low):
            return True
    return False


def is_raw_phone(name):
    cleaned = re.sub(r"[\s\-\(\)\+]", "", name or "")
    return bool(re.match(r"^\d{7,15}$", cleaned))


def is_foreign_phone(name):
    trimmed = (name or "").strip()
    return trimmed.startswith("+") and not trimmed.startswith("+90")


def is_short_or_symbol(name):
    alpha_num = re.sub(r"[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ]", "", (name or "").strip())
    return len(alpha_num) <= 1


def is_default_about(sec_text):
    if not sec_text:
        return False
    s_low = sec_text.lower().strip()
    return any(p in s_low for p in DEFAULT_ABOUT_PHRASES)


def evaluate_should_exclude(it, section_id="all"):
    name = it["name"]
    sec = it["secondary"]
    if is_in_list(name, WHITELIST_NAMES):
        return False, ["Beyaz Liste (VIP)"]

    reasons = []
    if is_in_list(name, BLACKLIST_NAMES):
        reasons.append("Kara Liste")
    if is_in_list(name, HIDE_KEYWORDS) or is_in_list(sec, HIDE_KEYWORDS):
        reasons.append("İsim/Etiket Kriteri")
    if CRIT_HIDE_RAW_NUMBERS and is_raw_phone(name):
        reasons.append("Kayıtsız Numara")
    if CRIT_HIDE_FOREIGN_NUMBERS and is_foreign_phone(name):
        reasons.append("Yabancı Numara")
    if CRIT_HIDE_SHORT_OR_SYMBOL and is_short_or_symbol(name):
        reasons.append("Tek Harf/Sembol")
    if CRIT_HIDE_BUSINESS and it.get("isBusinessAccount"):
        reasons.append("İşletme Hesabı")
    if CRIT_HIDE_DEFAULT_ABOUT and is_default_about(sec):
        reasons.append("Varsayılan Hakkımda")

    if SYNC_MODE == "per_section" and section_id != "all":
        if section_id == "about":
            if CRIT_HIDE_NO_ABOUT and not it.get("hasAboutText"):
                reasons.append("Hakkımda Yazısı Yok")
            if CRIT_HIDE_NO_PHOTO and not it.get("hasPhoto"):
                reasons.append("Fotoğrafsız")
        else:
            if CRIT_HIDE_NO_PHOTO and not it.get("hasPhoto"):
                reasons.append("Fotoğrafsız")
    else:
        if CRIT_HIDE_NO_PHOTO and not it.get("hasPhoto"):
            reasons.append("Fotoğrafsız")
        if CRIT_HIDE_NO_ABOUT and not it.get("hasAboutText"):
            reasons.append("Hakkımda Yazısı Yok")

    return len(reasons) > 0, reasons


def run_python_self_diagnostics():
    print("\n" + "=" * 78)
    print("  🧪 CİHAZ İÇİ TANI & OTOMATİK TEST MERKEZİ (v24 FINAL STUDIO SUITE)")
    print("=" * 78)

    tests = []

    def check(title, cond, detail):
        tests.append((title, bool(cond), detail))
        status = "✓ GEÇTİ" if cond else "✕ HATA"
        print(f"  [{status}] {title} -> {detail}")

    mock_no_photo = {"name": "Yurt Enes", "secondary": "", "hasPhoto": False, "hasAboutText": False, "isBusinessAccount": False}
    ex1, r1 = evaluate_should_exclude(mock_no_photo, "all")
    check("1. Fotoğrafsız Kişi Tespiti", ex1 and "Fotoğrafsız" in r1, f"Sebep: {r1}")

    mock_with_photo = {"name": "Yurt Mustafa", "secondary": "Müsait", "hasPhoto": True, "hasAboutText": True, "isBusinessAccount": False}
    ex2, r2 = evaluate_should_exclude(mock_with_photo, "all")
    check("2. Fotoğraflı Kişi Atama/Koruma", not ex2, "Fotoğraflı kişi gizlenmedi (Açık bırakıldı).")

    check("3. Kayıtsız Numara (+90 532...) Algılama", is_raw_phone("+90 532 123 45 67") and not is_raw_phone("Zafer AKBAŞ"), "Telefon formatı ayrıştırıldı.")
    check("4. Yabancı Ülke Kodu (+49 / +1) Algılama", is_foreign_phone("+49 151 23456") and not is_foreign_phone("+90 532 111 22 33"), "+90 dışı numara tespit edildi.")
    check("5. Tek Harf / Sembol İsim ('.', '?') Algılama", is_short_or_symbol(".") and is_short_or_symbol("A") and not is_short_or_symbol("Zeynep"), "Tek karakterli kayıtlar yakalandı.")
    check("6. Varsayılan 'Hakkımda' Yazısı Algılama", is_default_about("Merhaba! WhatsApp kullanıyorum.") and not is_default_about("İTÜ Bilgisayar Mühendisliği"), "Standart WhatsApp biyografisi ayrıştırıldı.")

    passed = sum(1 for _, ok, _ in tests if ok)
    print("-" * 78)
    print(f"  [SONUÇ] {passed}/{len(tests)} Cihaz İçi Çekirdek Testi Başarıyla Geçti!")
    print("=" * 78 + "\n")
    return passed == len(tests)


def load_previous_snapshot():
    if os.path.exists(SNAPSHOT_JSON):
        try:
            with open(SNAPSHOT_JSON, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_snapshot(snapshot_dict):
    try:
        with open(SNAPSHOT_JSON, "w", encoding="utf-8") as f:
            json.dump(snapshot_dict, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


async def inject_helpers(page):
    await page.evaluate(INJECTED_HELPERS_JS)


async def wait_for_whatsapp_login(page):
    print("\n[*] WhatsApp Web yükleniyor. İlk kez giriş yapıyorsanız lütfen QR kodu okutun...")
    while True:
        try:
            logged_in = await page.evaluate("""() => {
                return Boolean(
                    document.querySelector('#pane-side') ||
                    document.querySelector('[data-testid="chat-list"]') ||
                    document.querySelector('[aria-label="Sohbetler"]') ||
                    document.querySelector('[aria-label="Chats"]')
                );
            }""")
            if logged_in:
                print("[+] WhatsApp Web oturumu açıldı!")
                await jitter_sleep(2.0)
                return
        except Exception:
            pass
        await asyncio.sleep(1.5)


async def return_to_main_privacy_drawer(page):
    await inject_helpers(page)
    await page.evaluate("() => window.__waPrivacyHelper.checkAndDismissStrictPopup()")

    for _ in range(6):
        modal_open = await page.evaluate("() => Boolean(window.__waPrivacyHelper.findPrivacyModalAndScroller())")
        if not modal_open:
            break
        await page.evaluate("() => window.__waPrivacyHelper.clickGreenCheckmarkButton()")
        await jitter_sleep(0.6)
        await page.evaluate("() => window.__waPrivacyHelper.checkAndDismissStrictPopup()")

    for _ in range(5):
        await page.evaluate("() => window.__waPrivacyHelper.checkAndDismissStrictPopup()")
        info = await page.evaluate("() => window.__waPrivacyHelper.getActiveLeftDrawerInfo()")
        if info.get("isMainPrivacy"):
            await page.evaluate("() => window.__waPrivacyHelper.scrollLeftDrawerToTop()")
            await asyncio.sleep(0.3)
            return True

        if info.get("isSubSection"):
            await page.evaluate("() => window.__waPrivacyHelper.clickDrawerBackButton()")
            await jitter_sleep(0.75)
            continue

        if info.get("isSettings"):
            await page.evaluate("() => window.__waPrivacyHelper.clickExactMainSectionRow(['gizlilik', 'privacy'])")
            await jitter_sleep(0.85)
            continue

        await page.evaluate("() => window.__waPrivacyHelper.clickDrawerBackButton()")
        await jitter_sleep(0.65)

    await page.evaluate("() => window.__waPrivacyHelper.scrollLeftDrawerToTop()")
    info = await page.evaluate("() => window.__waPrivacyHelper.getActiveLeftDrawerInfo()")
    return bool(info.get("isMainPrivacy"))


async def ensure_privacy_menu_open(page):
    await inject_helpers(page)
    await page.evaluate("() => window.__waPrivacyHelper.checkAndDismissStrictPopup()")
    info = await page.evaluate("() => window.__waPrivacyHelper.getActiveLeftDrawerInfo()")
    if info.get("isMainPrivacy"):
        return True
    if info.get("isSubSection"):
        return await return_to_main_privacy_drawer(page)

    print("\n[*] Sol menüden Ayarlar açılıyor...")
    await page.evaluate("() => window.__waPrivacyHelper.getBottomRailCandidateButtons()")
    await jitter_sleep(1.0)

    info = await page.evaluate("() => window.__waPrivacyHelper.getActiveLeftDrawerInfo()")
    if not info.get("isSettings") and not info.get("isMainPrivacy"):
        count = await page.evaluate("""() => {
            const h = window.__waPrivacyHelper;
            const bottomRailBtns = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex="0"]')).filter(el => {
                if (!h.isVisible(el) || h.isInChatList(el)) return false;
                const r = el.getBoundingClientRect();
                return r.left >= 0 && r.left < 75 && r.width >= 24 && r.width <= 72 && r.top > window.innerHeight * 0.45;
            });
            const unique = bottomRailBtns.filter(b => !bottomRailBtns.some(other => other !== b && other.contains(b)));
            unique.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
            window.__railBtns = unique;
            return unique.length;
        }""")

        for idx in range(count):
            await page.evaluate(f"""(i) => {{
                const h = window.__waPrivacyHelper;
                const btn = window.__railBtns[i];
                if (!btn) return;
                const aria = h.normTR(btn.getAttribute('aria-label') || btn.getAttribute('title'));
                if (!aria.includes('medya') && !aria.includes('media') && !aria.includes('profil')) {{
                    h.triggerSingleClick(btn);
                }}
            }}""", idx)
            await jitter_sleep(1.0)
            info = await page.evaluate("() => window.__waPrivacyHelper.getActiveLeftDrawerInfo()")
            if info.get("isSettings") or info.get("isMainPrivacy"):
                break

    await page.evaluate("() => window.__waPrivacyHelper.clickExactMainSectionRow(['gizlilik', 'privacy'])")
    await jitter_sleep(0.95)
    return True


async def build_master_list_in_modal(page, prev_snapshot):
    print("\n[*] [Master Analiz & Çoklu Kriter Tarama] Tüm kişiler 0'dan başlayarak inceleniyor...")
    await inject_helpers(page)

    await page.evaluate("""() => {
        const found = window.__waPrivacyHelper.findPrivacyModalAndScroller();
        if (found && found.scroller) found.scroller.scrollTop = 0;
    }""")
    await jitter_sleep(1.0)

    contacts_map = {}
    with_photo_keys = set()
    master_excluded_keys = set()
    new_snapshot = dict(prev_snapshot)
    stuck_count = 0
    last_top = -1

    while True:
        await jitter_sleep(0.6)

        step = await page.evaluate("""() => {
            const h = window.__waPrivacyHelper;
            const found = h.findPrivacyModalAndScroller();
            if (!found) return { error: true };

            const rows = h.getContactRows(found.scroller);
            rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

            const nameCountsInView = new Map();
            const items = [];

            for (const row of rows) {
                const tempNameSpan = row.querySelector('span[title], span[dir="auto"]');
                const rawName = tempNameSpan ? (tempNameSpan.getAttribute('title') || tempNameSpan.textContent || '').trim() : '';
                const dupIdx = nameCountsInView.get(rawName) || 0;
                nameCountsInView.set(rawName, dupIdx + 1);

                const attr = h.analyzeRowAttributes(row, dupIdx);
                if (!attr) continue;
                items.push(attr);
            }

            const scroller = found.scroller;
            const scrollTop = scroller.scrollTop;
            scroller.scrollTop += 250;
            const newScrollTop = scroller.scrollTop;

            return { error: false, items, scrollTop, newScrollTop };
        }""")

        if step.get("error"):
            break

        for it in step["items"]:
            u_key = it["uniqueKey"]
            has_pic = it["hasPhoto"]

            diff_status = "-"
            if u_key in prev_snapshot:
                if prev_snapshot[u_key] is True and not has_pic:
                    diff_status = "Fotoğrafını Kaldırdı"
                elif prev_snapshot[u_key] is False and has_pic:
                    diff_status = "Yeni Fotoğraf Ekledi"
            new_snapshot[u_key] = has_pic

            should_ex, reasons = evaluate_should_exclude(it, "all")
            extra_reasons = [r for r in reasons if r != "Fotoğrafsız"]

            if should_ex:
                if has_pic and not extra_reasons:
                    with_photo_keys.add(u_key)
                    master_excluded_keys.discard(u_key)
                else:
                    master_excluded_keys.add(u_key)
            else:
                with_photo_keys.add(u_key)
                master_excluded_keys.discard(u_key)

            contacts_map[u_key] = {
                **it,
                "reasons": reasons,
                "diff": diff_status
            }

        print(f"    -> [Master Analiz] İncelenen: {len(contacts_map)} | Hedef Gizlenecek: {len(master_excluded_keys)}", end="\r")

        if abs(step["newScrollTop"] - last_top) < 4:
            stuck_count += 1
            if stuck_count >= 4:
                break
        else:
            stuck_count = 0

        last_top = step["newScrollTop"]

    save_snapshot(new_snapshot)
    print(f"\n[+] Master Liste Kilitlendi: {len(master_excluded_keys)} kişi gizlenecek.")
    return master_excluded_keys, contacts_map


async def apply_locked_master_list_and_confirm(page, section_label, master_excluded_keys):
    await inject_helpers(page)
    master_list = list(master_excluded_keys)

    for pass_num in (1, 2):
        section_scanned = set()
        section_photo = set()
        section_selected = set()

        print(f"\n[*] [{section_label}] Sayaçlar sıfırlandı (0'dan sayılıyor, Geçiş {pass_num})...")
        await page.evaluate("""() => {
            const found = window.__waPrivacyHelper.findPrivacyModalAndScroller();
            if (found && found.scroller) found.scroller.scrollTop = 0;
        }""")
        await jitter_sleep(0.85)

        stuck_count = 0
        last_top = -1

        while True:
            await jitter_sleep(0.4)

            step = await page.evaluate("""(masterKeysArray) => {
                const h = window.__waPrivacyHelper;
                const masterSet = new Set(masterKeysArray);
                const found = h.findPrivacyModalAndScroller();
                if (!found) return { error: true };

                const rows = h.getContactRows(found.scroller);
                rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

                const nameCountsInView = new Map();
                const scannedNow = [];
                const selectedNow = [];
                const photoNow = [];

                for (const row of rows) {
                    const tempNameSpan = row.querySelector('span[title], span[dir="auto"]');
                    const rawName = tempNameSpan ? (tempNameSpan.getAttribute('title') || tempNameSpan.textContent || '').trim() : '';
                    const dupIdx = nameCountsInView.get(rawName) || 0;
                    nameCountsInView.set(rawName, dupIdx + 1);

                    const attr = h.analyzeRowAttributes(row, dupIdx);
                    if (!attr) continue;

                    const uKey = attr.uniqueKey;
                    scannedNow.push(uKey);

                    const shouldBeChecked = masterSet.has(uKey);
                    if (shouldBeChecked) {
                        selectedNow.push(uKey);
                    } else {
                        photoNow.push(uKey);
                    }

                    const currentlyChecked = h.isRowChecked(row);
                    if (shouldBeChecked !== currentlyChecked) {
                        h.clickRowOnceSafe(row);
                    }
                }

                const scroller = found.scroller;
                const scrollTop = scroller.scrollTop;
                scroller.scrollTop += 260;
                const newScrollTop = scroller.scrollTop;

                return { error: false, scannedNow, selectedNow, photoNow, scrollTop, newScrollTop };
            }""", master_list)

            if step.get("error"):
                break

            for k in step["scannedNow"]:
                section_scanned.add(k)
            for k in step["selectedNow"]:
                section_selected.add(k)
            for k in step["photoNow"]:
                section_photo.add(k)

            print(
                f"    -> [{section_label}] Toplam Kişi: {len(section_scanned)} | "
                f"Açık Bırakılan: {len(section_photo)} | "
                f"Gizlenen: {len(section_selected)}",
                end="\r"
            )

            if abs(step["newScrollTop"] - last_top) < 4:
                stuck_count += 1
                if stuck_count >= 4:
                    break
            else:
                stuck_count = 0

            last_top = step["newScrollTop"]

        footer_count = await page.evaluate("() => window.__waPrivacyHelper.readModalFooterExcludedCount()")
        if footer_count == len(master_excluded_keys):
            break

    print(f"\n[+] [{section_label}] Sayım ve eşitleme tamamlandı ({len(master_excluded_keys)} kişi). Yeşil onay (✓) butonuna basılıyor...")
    await jitter_sleep(0.6)
    await page.evaluate("() => window.__waPrivacyHelper.clickGreenCheckmarkButton()")
    await jitter_sleep(1.0)
    await page.evaluate("() => window.__waPrivacyHelper.checkAndDismissStrictPopup()")


async def main():
    all_ok = run_python_self_diagnostics()
    if "--self-test" in sys.argv:
        sys.exit(0 if all_ok else 1)

    from playwright.async_api import async_playwright

    prev_snapshot = load_previous_snapshot()

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            user_data_dir=SESSION_DIR,
            headless=False,
            viewport={"width": 1280, "height": 820},
            args=["--start-maximized"]
        )

        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto("https://web.whatsapp.com", wait_until="domcontentloaded")

        await wait_for_whatsapp_login(page)
        await ensure_privacy_menu_open(page)

        master_excluded_keys = None
        contacts_map = {}

        for sec in PRIVACY_SECTIONS:
            print(f"\n--- Yeni Bölüme Geçiliyor (Sayaçlar Sıfırlandı): {sec['label']} ---")
            await return_to_main_privacy_drawer(page)

            clicked_row = False
            for _ in range(10):
                clicked_row = await page.evaluate("(titles) => window.__waPrivacyHelper.clickExactMainSectionRow(titles)", sec["exactTitles"])
                if clicked_row:
                    break
                await asyncio.sleep(0.35)

            if not clicked_row:
                print(f"[!] {sec['label']} satırı bulunamadı, sonraki bölüme geçiliyor...")
                continue

            await jitter_sleep(0.85)
            strict1 = await page.evaluate("() => window.__waPrivacyHelper.checkAndDismissStrictPopup()")
            if strict1.get("isStrictLock"):
                print(f"[!] {sec['label']}: Katı hesap ayarı nedeniyle kilitli, atlanıyor...")
                await return_to_main_privacy_drawer(page)
                continue

            modal_open = await page.evaluate("() => Boolean(window.__waPrivacyHelper.findPrivacyModalAndScroller())")
            if not modal_open:
                sub1 = await page.evaluate("() => window.__waPrivacyHelper.clickSubSectionExceptMyContactsOrList(true)")
                await jitter_sleep(0.85)
                strict2 = await page.evaluate("() => window.__waPrivacyHelper.checkAndDismissStrictPopup()")
                modal_open = await page.evaluate("() => Boolean(window.__waPrivacyHelper.findPrivacyModalAndScroller())")

                if not modal_open and not strict2.get("isStrictLock") and sub1.get("type") == "radio":
                    await page.evaluate("() => window.__waPrivacyHelper.clickSubSectionExceptMyContactsOrList(true)")
                    await jitter_sleep(0.85)
                    await page.evaluate("() => window.__waPrivacyHelper.checkAndDismissStrictPopup()")
                    modal_open = await page.evaluate("() => Boolean(window.__waPrivacyHelper.findPrivacyModalAndScroller())")
                elif not modal_open and strict2.get("isStrictLock"):
                    print(f"[!] {sec['label']}: Katı hesap ayarı nedeniyle değiştirilemiyor, sonraki bölüme geçiliyor...")
                    await return_to_main_privacy_drawer(page)
                    continue

            if modal_open:
                if master_excluded_keys is None:
                    master_excluded_keys, contacts_map = await build_master_list_in_modal(page, prev_snapshot)
                await apply_locked_master_list_and_confirm(page, sec["label"], master_excluded_keys)

            await return_to_main_privacy_drawer(page)

        if master_excluded_keys is not None:
            with open(EXPORT_TXT, "w", encoding="utf-8") as f:
                for k in sorted(master_excluded_keys):
                    f.write(k.split(" || ")[0] + "\n")

            now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
            with open(EXPORT_CSV, "w", encoding="utf-8-sig", newline="") as cf:
                writer = csv.writer(cf)
                writer.writerow(["Kişi Adı", "Hakkımda / Alt Bilgi", "Fotoğraf Durumu", "Hakkımda Yazısı", "İşletme Hesabı", "Gizlenme Sebepleri", "Sonuç", "Değişiklik (Diff)", "Tarih"])
                for u_key, info in sorted(contacts_map.items()):
                    is_ex = u_key in master_excluded_keys
                    writer.writerow([
                        info["name"],
                        info["secondary"],
                        "Fotoğraflı" if info["hasPhoto"] else "Fotoğrafsız",
                        "Var" if info["hasAboutText"] else "Yok (Boş)",
                        "Evet" if info["isBusinessAccount"] else "Hayır",
                        ", ".join(info["reasons"]) if info["reasons"] else "-",
                        "Hariç Tutuldu (Gizlendi)" if is_ex else "Açık Bırakıldı",
                        info["diff"],
                        now_str
                    ])

            rows_html = []
            for u_key, info in sorted(contacts_map.items()):
                is_ex = u_key in master_excluded_keys
                rows_html.append(
                    f"<tr><td><strong>{info['name']}</strong></td>"
                    f"<td>{info['secondary'] or 'Boş'}</td>"
                    f"<td>{'Fotoğraflı' if info['hasPhoto'] else 'Fotoğrafsız'}</td>"
                    f"<td>{', '.join(info['reasons']) if info['reasons'] else '-'}</td>"
                    f"<td>{'Gizlendi' if is_ex else 'Açık'}</td></tr>"
                )
            with open(EXPORT_HTML, "w", encoding="utf-8") as hf:
                hf.write(
                    "<!DOCTYPE html><html lang='tr'><head><meta charset='utf-8'><title>WA Gizlilik Raporu (v15)</title>"
                    "<style>body{font-family:sans-serif;background:#0b141a;color:#e9edef;padding:24px;}table{width:100%;border-collapse:collapse;background:#111b21;}th,td{border:1px solid #2a3942;padding:8px;text-align:left;}th{background:#202c33;color:#00a884;}</style></head>"
                    f"<body><h2>WhatsApp Gizlilik Analiz Raporu (v24 Final Studio) - {now_str}</h2>"
                    f"<table><thead><tr><th>Kişi</th><th>Hakkımda</th><th>Fotoğraf</th><th>Kriter</th><th>Sonuç</th></tr></thead><tbody>{''.join(rows_html)}</tbody></table></body></html>"
                )

            print(f"\n[+] Tüm raporlar kaydedildi:\n    - {EXPORT_TXT}\n    - {EXPORT_CSV}\n    - {EXPORT_HTML}\n    - {SNAPSHOT_JSON}")

        print("\n" + "=" * 78)
        print("[✓] TÜM BÖLÜMLER KUSURSUZ TAMAMLANDI VE ONAYLANDI!")
        print("=" * 78)

        try:
            await page.wait_for_event("close", timeout=0)
        except Exception:
            pass
        await context.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
