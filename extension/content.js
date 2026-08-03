// Chrome Extension Content Script for Yad2 Car Export (Main World Context)

const STATE_KEY_ACTIVE            = 'yad2_exporter_auto_active';
const STATE_KEY_DATA              = 'yad2_exporter_auto_data';
const STATE_KEY_PAGES_SCANNED     = 'yad2_exporter_pages_scanned';
const STATE_KEY_PAUSED            = 'yad2_exporter_paused';
const STATE_KEY_SESSION_SIGNATURE = 'yad2_exporter_session_signature';
const STATE_KEY_LAST_ACTIVITY     = 'yad2_exporter_last_activity';
const STATE_KEY_START_TIME        = 'yad2_exporter_start_time';
const STATE_KEY_EMPTY_STREAK      = 'yad2_exporter_empty_streak';
const STATE_KEY_CONSEC_BLOCKED    = 'yad2_exporter_consec_blocked';
const STATE_KEY_ENRICH_DISABLED   = 'yad2_exporter_enrich_disabled';

const STALE_SESSION_MS = 10 * 60 * 1000; // 10 minutes - see plan doc for reasoning re: Chrome timer throttling
const EMPTY_PAGE_STREAK_LIMIT = 2;
const CONSEC_BLOCKED_LIMIT = 3;

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

function computeSessionSignature() {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.search);
    params.delete('page');
    const sorted = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    return url.pathname + '?' + sorted.map(([k, v]) => `${k}=${v}`).join('&');
}

function parseLimitSetting(raw) {
    if (raw === null || raw === undefined || raw === '') return Infinity;
    const n = parseInt(raw, 10);
    return (isNaN(n) || n < 0) ? Infinity : n; // 0 is preserved as a real limit, not treated as "unlimited"
}

const HAND_TEXT_MAP = {
    'יד ראשונה': '1', 'יד שניה': '2', 'יד שנייה': '2',
    'יד שלישית': '3', 'יד רביעית': '4', 'יד חמישית': '5', 'יד שישית': '6'
};
function normalizeHand(raw) {
    const s = String(raw || '').trim();
    if (HAND_TEXT_MAP[s]) return HAND_TEXT_MAP[s];
    const m = s.match(/\d+/);
    return m ? m[0] : s;
}

function sanitizeCSVField(value) {
    let str = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str; // neutralize CSV/formula injection in Excel
    return str.replace(/"/g, '""');
}

function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.max(0, Math.round(seconds % 60));
    if (m <= 0) return `${s} שנ׳`;
    return `${m} דק׳ ${s} שנ׳`;
}

// Sleep that can be interrupted by Stop, and whose remaining time is NOT
// consumed while Paused (a pause genuinely suspends the anti-bot delay
// instead of being silently skipped once resumed).
async function sleepInterruptible(ms) {
    let remaining = ms;
    while (remaining > 0) {
        if (localStorage.getItem(STATE_KEY_ACTIVE) !== 'true') return false;
        if (localStorage.getItem(STATE_KEY_PAUSED) === 'true') {
            await new Promise(r => setTimeout(r, 500));
            continue;
        }
        const step = Math.min(500, remaining);
        await new Promise(r => setTimeout(r, step));
        remaining -= step;
    }
    return true;
}

function showIdleButtons() {
    const multiBtn = document.getElementById('yad2-export-multi-btn');
    const currentBtn = document.getElementById('yad2-export-current-btn');
    const pauseBtn = document.getElementById('yad2-export-pause-btn');
    const stopBtn = document.getElementById('yad2-export-stop-btn');
    if (currentBtn) currentBtn.classList.remove('yad2-exporter-hidden');
    if (multiBtn) multiBtn.classList.remove('yad2-exporter-hidden');
    if (pauseBtn) { pauseBtn.classList.add('yad2-exporter-hidden'); pauseBtn.innerHTML = '⏸ השהה'; }
    if (stopBtn) stopBtn.classList.add('yad2-exporter-hidden');
    const eta = document.getElementById('yad2-exporter-eta');
    if (eta) eta.classList.add('yad2-exporter-hidden');
}

function showActiveButtons() {
    const multiBtn = document.getElementById('yad2-export-multi-btn');
    const currentBtn = document.getElementById('yad2-export-current-btn');
    const pauseBtn = document.getElementById('yad2-export-pause-btn');
    const stopBtn = document.getElementById('yad2-export-stop-btn');
    if (currentBtn) currentBtn.classList.add('yad2-exporter-hidden');
    if (multiBtn) multiBtn.classList.add('yad2-exporter-hidden');
    if (pauseBtn) pauseBtn.classList.remove('yad2-exporter-hidden');
    if (stopBtn) stopBtn.classList.remove('yad2-exporter-hidden');
}

function clearAllScrapeState() {
    localStorage.setItem(STATE_KEY_ACTIVE, 'false');
    localStorage.setItem(STATE_KEY_PAUSED, 'false');
    localStorage.removeItem(STATE_KEY_DATA);
    localStorage.removeItem(STATE_KEY_PAGES_SCANNED);
    localStorage.removeItem(STATE_KEY_SESSION_SIGNATURE);
    localStorage.removeItem(STATE_KEY_LAST_ACTIVITY);
    localStorage.removeItem(STATE_KEY_START_TIME);
    localStorage.removeItem(STATE_KEY_EMPTY_STREAK);
    localStorage.removeItem(STATE_KEY_CONSEC_BLOCKED);
    localStorage.removeItem(STATE_KEY_ENRICH_DISABLED);
}

function updateETA(count) {
    const etaEl = document.getElementById('yad2-exporter-eta');
    if (!etaEl) return;
    const startTime = parseInt(localStorage.getItem(STATE_KEY_START_TIME) || '0', 10);
    if (!startTime || count < 1) { etaEl.classList.add('yad2-exporter-hidden'); return; }

    const elapsedSec = (Date.now() - startTime) / 1000;
    const rateSecPerItem = count >= 3 ? (elapsedSec / count) : 5.5; // static fallback until we have enough samples

    const maxAds = parseLimitSetting(localStorage.getItem('YAD2_MAX_ADS'));
    let text = `⏱ קצב ~${rateSecPerItem.toFixed(1)} שנ׳/רכב · נאספו ${count}`;
    if (isFinite(maxAds)) {
        const remaining = Math.max(0, maxAds - count);
        text += ` · נותרו כ-${formatDuration(remaining * rateSecPerItem)}`;
    } else {
        text += ` · חלפו ${formatDuration(elapsedSec)}`;
    }
    etaEl.innerText = text;
    etaEl.classList.remove('yad2-exporter-hidden');
}

// ------------------------------------------------------------------
// Panel init & session recovery
// ------------------------------------------------------------------

function initExporter() {
    if (document.getElementById('yad2-exporter-panel')) return;

    // Floating UI Panel
    const panel = document.createElement('div');
    panel.id = 'yad2-exporter-panel';

    const currentBtn = document.createElement('button');
    currentBtn.id = 'yad2-export-current-btn';
    currentBtn.className = 'yad2-exporter-btn';
    currentBtn.innerHTML = '📊 ייצא עמוד נוכחי';
    currentBtn.addEventListener('click', () => exportCurrentPage());

    const multiBtn = document.createElement('button');
    multiBtn.id = 'yad2-export-multi-btn';
    multiBtn.className = 'yad2-exporter-btn';
    multiBtn.innerHTML = '🤖 סריקה אוטומטית מלאה';
    multiBtn.addEventListener('click', () => startAutoScrape());

    const pauseBtn = document.createElement('button');
    pauseBtn.id = 'yad2-export-pause-btn';
    pauseBtn.className = 'yad2-exporter-btn yad2-exporter-hidden';
    pauseBtn.innerHTML = '⏸ השהה';
    pauseBtn.addEventListener('click', () => togglePause());

    const stopBtn = document.createElement('button');
    stopBtn.id = 'yad2-export-stop-btn';
    stopBtn.className = 'yad2-exporter-btn yad2-exporter-hidden';
    stopBtn.innerHTML = '🛑 עצור סריקה ושמור';
    stopBtn.addEventListener('click', () => stopAutoScrape());

    const eta = document.createElement('div');
    eta.id = 'yad2-exporter-eta';
    eta.className = 'yad2-exporter-hidden';

    const info = document.createElement('div');
    info.id = 'yad2-exporter-info';
    info.innerText = 'ניתן להחליף טאבים או למזער את החלון תוך כדי סריקה. אין לסגור את הטאב/כרום.';

    panel.appendChild(currentBtn);
    panel.appendChild(multiBtn);
    panel.appendChild(pauseBtn);
    panel.appendChild(stopBtn);
    panel.appendChild(eta);
    panel.appendChild(info);
    document.body.appendChild(panel);

    // Progress Toast Notification
    const toast = document.createElement('div');
    toast.id = 'yad2-exporter-toast';
    document.body.appendChild(toast);

    // Check if auto-scrape is active and decide how to resume (or whether to at all)
    if (localStorage.getItem(STATE_KEY_ACTIVE) === 'true') {
        const sigMatches = localStorage.getItem(STATE_KEY_SESSION_SIGNATURE) === computeSessionSignature();
        const isPaused = localStorage.getItem(STATE_KEY_PAUSED) === 'true';
        const lastActive = parseInt(localStorage.getItem(STATE_KEY_LAST_ACTIVITY) || '0', 10);
        const isStale = !isPaused && (Date.now() - lastActive) > STALE_SESSION_MS;

        if (sigMatches && !isStale) {
            showActiveButtons();
            if (isPaused) {
                pauseBtn.innerHTML = '▶ המשך';
                showToast('⏸ הסריקה נטענה במצב מושהה. לחצו "המשך" כדי להמשיך.', 0);
                // Deliberately NOT calling processAutoScrapeCurrentPage() here - a paused
                // session must never silently resume scrolling/fetching on its own.
            } else {
                const count = parseInt(localStorage.getItem(STATE_KEY_PAGES_SCANNED) || '0', 10);
                showToast(`🔄 ממשיך סריקה אוטומטית (עמוד ${count + 1}). מנתח נתונים...`, 0);
                setTimeout(() => {
                    localStorage.setItem(STATE_KEY_LAST_ACTIVITY, Date.now().toString());
                    processAutoScrapeCurrentPage();
                }, 4000);
            }
        } else {
            showRecoveryModal({ sigMatches, isPaused });
        }
    }
}

function showRecoveryModal({ sigMatches, isPaused }) {
    if (document.getElementById('yad2-exporter-recovery-modal')) return;

    let items = [];
    try { items = JSON.parse(localStorage.getItem(STATE_KEY_DATA) || '[]'); } catch (e) {}

    const lastActive = parseInt(localStorage.getItem(STATE_KEY_LAST_ACTIVITY) || '0', 10);
    const minutesAgo = lastActive ? Math.max(0, Math.round((Date.now() - lastActive) / 60000)) : null;

    const overlay = document.createElement('div');
    overlay.id = 'yad2-exporter-recovery-modal';

    const box = document.createElement('div');
    box.className = 'yad2-exporter-modal-box';

    const title = document.createElement('h3');
    title.innerText = '⚠ נמצאה סריקה אוטומטית שלא הושלמה';
    box.appendChild(title);

    const desc = document.createElement('p');
    let descText = `נאספו ${items.length} רכבים ולא יוצאו. `;
    descText += !sigMatches
        ? 'החיפוש הנוכחי בעמוד הזה שונה מהחיפוש שהיה פעיל בסריקה.'
        : (minutesAgo !== null ? `הפעילות האחרונה הייתה לפני כ-${minutesAgo} דקות.` : 'הסריקה ננטשה ללא סיבה ברורה.');
    desc.innerText = descText;
    box.appendChild(desc);

    const btnRow = document.createElement('div');
    btnRow.className = 'yad2-exporter-modal-btns';

    const exportBtn = document.createElement('button');
    exportBtn.className = 'yad2-exporter-btn';
    exportBtn.innerHTML = '📥 ייצא מה שנאסף';
    exportBtn.addEventListener('click', () => {
        if (items.length > 0) downloadCSV(items, `yad2_cars_auto_${items.length}_items.csv`);
        clearAllScrapeState();
        overlay.remove();
        showIdleButtons();
        showToast(items.length > 0 ? `✅ יוצאו ${items.length} רכבים.` : 'לא היו נתונים לייצוא.', 4000);
    });
    btnRow.appendChild(exportBtn);

    if (sigMatches) {
        const resumeBtn = document.createElement('button');
        resumeBtn.className = 'yad2-exporter-btn';
        resumeBtn.innerHTML = '▶ המשך בכל זאת';
        resumeBtn.addEventListener('click', () => {
            localStorage.setItem(STATE_KEY_LAST_ACTIVITY, Date.now().toString());
            overlay.remove();
            showActiveButtons();
            const pauseBtn = document.getElementById('yad2-export-pause-btn');
            if (isPaused) {
                if (pauseBtn) pauseBtn.innerHTML = '▶ המשך';
                showToast('⏸ הסריקה במצב מושהה. לחצו "המשך" כדי להמשיך.', 0);
            } else {
                const count = parseInt(localStorage.getItem(STATE_KEY_PAGES_SCANNED) || '0', 10);
                showToast(`🔄 ממשיך סריקה אוטומטית (עמוד ${count + 1}). מנתח נתונים...`, 0);
                processAutoScrapeCurrentPage();
            }
        });
        btnRow.appendChild(resumeBtn);
    }

    const discardBtn = document.createElement('button');
    discardBtn.className = 'yad2-exporter-btn yad2-exporter-btn-secondary';
    discardBtn.innerHTML = '🗑 מחק בלי לייצא';
    discardBtn.addEventListener('click', () => {
        clearAllScrapeState();
        overlay.remove();
        showIdleButtons();
    });
    btnRow.appendChild(discardBtn);

    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
}

function togglePause() {
    const pauseBtn = document.getElementById('yad2-export-pause-btn');
    const isPaused = localStorage.getItem(STATE_KEY_PAUSED) === 'true';
    localStorage.setItem(STATE_KEY_PAUSED, (!isPaused).toString());
    localStorage.setItem(STATE_KEY_LAST_ACTIVITY, Date.now().toString());
    if (pauseBtn) pauseBtn.innerHTML = isPaused ? '⏸ השהה' : '▶ המשך';
    showToast(isPaused ? '▶ ממשיך סריקה...' : '⏸ הסריקה מושהית. לחצו שוב כדי להמשיך.', isPaused ? 2500 : 0);
}

let toastHideTimer = null;
function showToast(message, duration = 4000) {
    const toast = document.getElementById('yad2-exporter-toast');
    if (!toast) return;
    if (toastHideTimer) { clearTimeout(toastHideTimer); toastHideTimer = null; }
    toast.innerText = message;
    toast.style.display = 'block';
    if (duration > 0) {
        toastHideTimer = setTimeout(() => {
            toast.style.display = 'none';
            toastHideTimer = null;
        }, duration);
    }
}

function parseCarCard(card) {
    // Inject spaces to prevent sticky words (e.g., "word1word2").
    // Processed in REVERSE document order (children before parents): querySelectorAll
    // returns parents before their descendants, and reassigning a parent's innerHTML
    // detaches/reparses its children - any child processed after that point would be
    // mutating an orphaned node that never makes it into the final clone. Reversing
    // guarantees every element is touched before any of its ancestors.
    const clone = card.cloneNode(true);
    Array.from(clone.querySelectorAll('span, p, div, li, h1, h2, h3, a')).reverse().forEach(el => {
        el.innerHTML = el.innerHTML + ' ';
    });

    const text = clone.innerText || '';
    if (text.length < 15) return null;

    // Skip recommendation car rows or generic header widgets
    if (text.includes("דגמים דומים") || text.includes("הסוכנת החכמה") || text.includes("קורות חיים") || text.includes("מחשבון שכר")) {
        return null;
    }

    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // 1. Link & Item Token extraction
    const linkElem = card.querySelector("a[href*='/item/']") || card.querySelector("a[href*='cars']") || card.querySelector("a");
    let link = "";
    if (linkElem) {
        let href = linkElem.getAttribute("href") || "";
        if (href && !href.startsWith('http')) {
            link = href.startsWith('/') ? `https://www.yad2.co.il${href}` : `https://www.yad2.co.il/${href}`;
        } else {
            link = href;
        }
    }

    // Explicitly reject recommendation items
    if (link && link.includes("component-type=recommendation")) return null;

    // 2. Price Extraction - excludes numbers appearing near financing/marketing copy,
    // not just the "ירד ב" discount-badge phrasing.
    const PRICE_EXCLUDE_CONTEXT = ['ירד ב', 'מימון', 'החזר חודשי', 'תשלום חודשי', 'מקדמה', 'ליסינג', 'הלוואה'];
    let price = "N/A";
    const priceMatches = Array.from(text.matchAll(/(?:₪\s*([\d,]{4,7}))|([\d,]{4,7})\s*₪/g));
    for (const match of priceMatches) {
        const valStr = (match[1] || match[2]).replace(/,/g, '');
        const val = parseInt(valStr, 10);
        if (val < 10000 || val > 350000) continue;
        const contextBefore = text.slice(Math.max(0, (match.index || 0) - 40), match.index || 0);
        if (!PRICE_EXCLUDE_CONTEXT.some(kw => contextBefore.includes(kw))) {
            price = String(val);
            break;
        }
    }

    // 3. Year Extraction (20XX / 19XX) - rejects matches immediately followed by an
    // engine-displacement marker (e.g. "1998 סמ״ק"), which otherwise looks identical
    // to a valid year.
    const yearMatch = text.match(/\b(20\d{2}|19\d{2})\b(?!\s*(סמ|cc|CC))/);
    const year = yearMatch ? yearMatch[1] : "N/A";

    // 4. Hand Extraction (יד X) - requires whitespace before the digit so it doesn't
    // false-match the "יד2" brand string itself.
    const handMatch = text.match(/יד\s+(\d+)/);
    const hand = handMatch ? handMatch[1] : "N/A";

    // 5. Kilometers Extraction (XXX,XXX ק"מ)
    const kmMatch = text.match(/([\d,]+)\s*ק"מ/);
    const km = kmMatch ? kmMatch[1].replace(/,/g, '') : "N/A";

    // Must have valid price AND (year OR hand OR km) to be considered a real car listing card
    if (price === "N/A" && year === "N/A") return null;

    // 6. Title and Submodel Clean Parsing
    let title = lines[0] || 'רכב יד שנייה';
    let submodel = '';

    // If first line is a discount badge or a price
    if (title.startsWith("ירד ב") || title.includes("₪") || title.includes("טרייד אין") || title.includes("כונס") || title.length > 30) {
        title = lines[1] || lines[2] || title;
        submodel = lines[2] || lines[3] || '';
    } else if (lines.length > 1 && !lines[1].includes('₪') && !lines[1].includes('יד') && !lines[1].match(/\b20\d{2}\b/)) {
        submodel = lines[1];
    }

    // Clean multiple spaces in title and submodel
    title = title.replace(/\s+/g, ' ').trim();
    submodel = submodel.replace(/\s+/g, ' ').trim();

    // 7. Features / Equipment Badges
    const featureLines = lines.filter(l =>
        !l.includes('₪') &&
        !l.includes('יד') &&
        !l.match(/\b20\d{2}\b/) &&
        l !== title &&
        l !== submodel &&
        !l.startsWith("ירד ב")
    );
    const features = featureLines.slice(0, 4).join(' | ').replace(/\s+/g, ' ');

    return {
        Manufacturer: '',
        Model: title,
        Submodel: submodel,
        Price: price,
        Year: year,
        Hand: hand,
        Kilometers: km,
        Engine: '',
        Gear: '',
        Color: '',
        Features: features,
        Link: link
    };
}

function extractListings() {
    const listings = [];
    const seen = new Set();

    // 1. Next.js window.__NEXT_DATA__ state extraction
    try {
        const nextData = window.__NEXT_DATA__;
        if (nextData && nextData.props && nextData.props.pageProps) {
            const pageProps = nextData.props.pageProps;
            let items = [];

            // New Yad2 Structure (React Query dehydratedState)
            const queries = pageProps.dehydratedState?.queries || [];
            const feedQuery = queries.find(q => Array.isArray(q.queryKey) && q.queryKey[0] === 'feed');

            if (feedQuery && feedQuery.state && feedQuery.state.data) {
                const feedData = feedQuery.state.data;
                const rawItems = [
                    ...(feedData.private || []),
                    ...(feedData.commercial || []),
                    ...(feedData.solo || []),
                    ...(feedData.platinum || []),
                    ...(feedData.boost || [])
                ];

                if (rawItems.length > 0) {
                    items = rawItems;
                }
            }

            // Old Yad2 structure fallback
            if (!items || items.length === 0) {
                items = pageProps.items || (pageProps.feedData && pageProps.feedData.items) || [];
                if (!items || items.length === 0) {
                    for (const key in pageProps) {
                        if (pageProps[key] && typeof pageProps[key] === 'object') {
                            if (Array.isArray(pageProps[key].items)) {
                                items = pageProps[key].items;
                                break;
                            }
                        }
                    }
                }
            }

            if (Array.isArray(items) && items.length > 0) {
                items.forEach(item => {
                    if (typeof item === 'object' && item !== null) {
                            const manufacturer = item.manufacturer?.text || item.manufacturer || '';
                            const model = item.model?.text || item.model || item.title || item.heading || item.title_1 || '';
                            const submodel = item.subModel?.text || item.sub_title || item.submodel || item.title_2 || '';
                            const price = item.price !== undefined ? item.price : (item.price_raw || '');
                            const year = item.vehicleDates?.yearOfProduction || item.year || '';
                            const hand = item.hand?.text || item.hand?.id || item.hand || '';
                            const km = item.km || item.kilometers || item.mileage || '';
                            const token = item.token || item.id || '';
                            const engine = item.engineType?.text || item.engine_type || '';
                            const gear = item.gear?.text || item.gear || '';
                            const color = item.color?.text || item.color || '';
                            const area = item.address?.area?.text || item.address?.city?.text || '';
                            const link = token ? `https://www.yad2.co.il/item/${token}` : '';

                            let tagsArray = Array.isArray(item.tags) ? item.tags : [];
                            let features = tagsArray.map(t => {
                                if (typeof t === 'object' && t !== null) return t.name || t.text || t.label || '';
                                return t;
                            }).filter(Boolean).join(' | ');

                            if (!features) {
                                features = item.info || '';
                            }

                            const uniqueTitle = manufacturer ? `${manufacturer} ${model}` : model;

                            if ((model || price) && token && !seen.has(token) && !String(uniqueTitle).includes("דגמים דומים")) {
                                seen.add(token);
                                listings.push({
                                    Manufacturer: String(manufacturer).trim(),
                                    Model: String(model).trim().replace(/\s+/g, ' '),
                                    Submodel: String(submodel).trim().replace(/\s+/g, ' '),
                                    Price: String(price).replace(/,/g, '').replace(/₪/g, '').trim(),
                                    Year: String(year).trim(),
                                    Hand: normalizeHand(hand),
                                    Kilometers: String(km).replace(/,/g, '').trim(),
                                    Engine: String(engine).trim(),
                                    Gear: String(gear).trim(),
                                    Color: String(color).trim(),
                                    Area: String(area).trim(),
                                    Features: String(features).trim().replace(/\s+/g, ' '),
                                    Link: link
                                });
                            }
                    }
                });

                if (listings.length > 0) {
                    return listings;
                }
            }
        }
    } catch (e) {
        console.error('Error reading __NEXT_DATA__:', e);
    }

    // 2. DOM Traversal fallback targeting item feed containers
    const feedCards = document.querySelectorAll("div[class*='feed_item'], div[class*='feeditem'], [data-testid='feed-item'], article, .listing-card");

    feedCards.forEach(card => {
        const parsed = parseCarCard(card);
        if (parsed) {
            const uniqueKey = `${parsed.Model}-${parsed.Submodel}-${parsed.Price}-${parsed.Year}`;
            if (!seen.has(uniqueKey)) {
                seen.add(uniqueKey);
                listings.push(parsed);
            }
        }
    });

    // 3. Fallback generic element scanner if feed selectors fail
    if (listings.length === 0) {
        const candidates = Array.from(document.querySelectorAll('body *'));
        candidates.forEach(el => {
            if (el.children.length === 0 && el.innerText && el.innerText.includes('₪')) {
                let container = el;
                for (let i = 0; i < 5; i++) {
                    if (container.parentElement && container.parentElement.innerText && container.parentElement.innerText.length < 1500) {
                        container = container.parentElement;
                    }
                }
                const parsed = parseCarCard(container);
                if (parsed) {
                    const uniqueKey = `${parsed.Model}-${parsed.Submodel}-${parsed.Price}-${parsed.Year}`;
                    if (!seen.has(uniqueKey)) {
                        seen.add(uniqueKey);
                        listings.push(parsed);
                    }
                }
            }
        });
    }

    return listings;
}

let currentPageExportRunning = false;

// Exports the current page, enriching each listing with the same per-item deep-fetch
// (color, description, test date, previous owners, precise km) that the full auto-scan
// uses - not just the fast card/NEXT_DATA snapshot. This makes it slower than an instant
// export (roughly 4-5 seconds per listing, same anti-bot pacing as the auto-scan), but the
// exported data is now consistent between both buttons instead of "current page" silently
// producing a shallower file.
async function exportCurrentPage() {
    if (currentPageExportRunning) return;

    const listings = extractListings();
    if (!listings || listings.length === 0) {
        alert('לא נמצאו מודעות רכב בעמוד הנוכחי. ודא כי עמוד תוצאות החיפוש נטען במלואו.');
        return;
    }

    currentPageExportRunning = true;
    const currentBtn = document.getElementById('yad2-export-current-btn');
    const originalLabel = currentBtn ? currentBtn.innerHTML : '';
    if (currentBtn) {
        currentBtn.innerHTML = '⏳ מייצא עם פרטים מלאים...';
        currentBtn.disabled = true;
    }

    let consecutiveBlocked = 0;
    let enrichDisabled = false;

    for (let i = 0; i < listings.length; i++) {
        const item = listings[i];
        showToast(`סורק עומק רכב ${i + 1} מתוך ${listings.length}...`, 0);

        const tokenMatch = (item.Link || '').match(/\/item\/([a-zA-Z0-9_-]+)/);
        if (!enrichDisabled && tokenMatch && tokenMatch[1]) {
            const deepData = await fetchItemDetails(tokenMatch[1]);

            if (deepData && deepData.__blocked) {
                consecutiveBlocked++;
                if (consecutiveBlocked >= CONSEC_BLOCKED_LIMIT) {
                    enrichDisabled = true;
                    showToast('⚠ יד2 כנראה חוסמת בקשות לדפי פירוט - ממשיכים עם נתוני כרטיס בסיסיים בלבד.', 4000);
                }
            } else if (deepData) {
                consecutiveBlocked = 0;
                if (deepData.km && !item.Kilometers) item.Kilometers = String(deepData.km).replace(/,/g, '').trim();
                if (deepData.color && !item.Color) item.Color = String(deepData.color).trim();
                item.Description = String(deepData.description || '').trim();
                item.TestDate = String(deepData.testDate || '').trim();
                item.PreviousOwners = String(deepData.previousOwners || '').trim();
            }

            if (i < listings.length - 1) {
                const delay = Math.floor(Math.random() * 3000) + 3000;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    // Timestamp (not just date) so repeated exports on the same day never share a
    // filename - a stale download sitting in the Downloads folder under the same
    // name as a fresh one is exactly what looked like "an old, un-updated file".
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadCSV(listings, `yad2_cars_page_${stamp}.csv`);
    showToast(`✓ יוצאו בהצלחה ${listings.length} מודעות רכב (עם פרטים מלאים)!`, 5000);

    if (currentBtn) {
        currentBtn.innerHTML = originalLabel;
        currentBtn.disabled = false;
    }
    currentPageExportRunning = false;
}

// ------------------------------------------------------------------
// Auto Scraper Logic
// ------------------------------------------------------------------

async function startAutoScrape() {
    const maxPages = parseLimitSetting(localStorage.getItem('YAD2_MAX_PAGES'));
    const maxAds = parseLimitSetting(localStorage.getItem('YAD2_MAX_ADS'));
    if (maxPages === 0 || maxAds === 0) {
        showToast('⚠ מקסימום עמודים/רכבים מוגדר ל-0 - אין מה לסרוק. שנו את ההגדרות בפופאפ התוסף.', 5000);
        return;
    }

    // Rescue backstop: never silently overwrite unexported data from an earlier,
    // abandoned session - this can happen if the recovery modal was bypassed somehow.
    const leftoverRaw = localStorage.getItem(STATE_KEY_DATA);
    if (leftoverRaw) {
        try {
            const leftover = JSON.parse(leftoverRaw);
            if (Array.isArray(leftover) && leftover.length > 0) {
                downloadCSV(leftover, `yad2_cars_RESCUED_${Date.now()}.csv`);
                showToast(`⚠ נמצאו ${leftover.length} רכבים מסריקה קודמת שלא יוצאה - יוצאו אוטומטית לפני התחלה מחדש`, 6000);
            }
        } catch (e) {}
    }

    localStorage.setItem(STATE_KEY_ACTIVE, 'true');
    localStorage.setItem(STATE_KEY_PAUSED, 'false');
    localStorage.setItem(STATE_KEY_DATA, JSON.stringify([]));
    localStorage.removeItem(STATE_KEY_PAGES_SCANNED);
    localStorage.setItem(STATE_KEY_SESSION_SIGNATURE, computeSessionSignature());
    localStorage.setItem(STATE_KEY_LAST_ACTIVITY, Date.now().toString());
    localStorage.setItem(STATE_KEY_START_TIME, Date.now().toString());
    localStorage.removeItem(STATE_KEY_EMPTY_STREAK);
    localStorage.removeItem(STATE_KEY_CONSEC_BLOCKED);
    localStorage.removeItem(STATE_KEY_ENRICH_DISABLED);

    showActiveButtons();
    showToast(`🚀 מתחיל סריקה אוטומטית מלאה... גולל לאיסוף נתונים.`, 0);
    processAutoScrapeCurrentPage();
}

// Single funnel for every way an auto-scrape can end: user Stop, hitting maxAds/maxPages,
// the empty-page circuit breaker, a storage-quota error, or running out of pages.
// Always resets the panel to its idle state and exports whatever was collected.
function finishAutoScrape(allListings, toastMsg, toastDuration = 4000) {
    clearAllScrapeState();
    showIdleButtons();
    if (toastMsg) showToast(toastMsg, toastDuration);
    if (allListings && allListings.length > 0) {
        downloadCSV(allListings, `yad2_cars_auto_${allListings.length}_items.csv`);
    }
}

function stopAutoScrape() {
    let allListings = [];
    try { allListings = JSON.parse(localStorage.getItem(STATE_KEY_DATA) || '[]'); } catch (e) {}

    if (allListings.length > 0) {
        finishAutoScrape(allListings, `✅ הסריקה נעצרה. מייצא ${allListings.length} מודעות...`, 5000);
    } else {
        finishAutoScrape(allListings, `⏹ הסריקה נעצרה. לא נאספו נתונים.`, 4000);
    }
}

async function fetchItemDetails(token) {
    try {
        const res = await fetch(`https://www.yad2.co.il/item/${token}`);
        if (!res.ok) {
            if (res.status === 403 || res.status === 429) return { __blocked: true };
            return null;
        }
        const html = await res.text();

        let km = '';
        let color = '';
        let description = '';
        let testDate = '';
        let previousOwners = '';
        let foundStructuredData = false;

        // [\s\S] instead of "." so this also matches when the __NEXT_DATA__ JSON blob
        // spans multiple lines (plain "." never matches newlines).
        const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
        if (match) {
            try {
                const nextData = JSON.parse(match[1]);
                const pageProps = nextData.props?.pageProps;
                if (pageProps) {
                    let itemData = null;
                    const queries = pageProps.dehydratedState?.queries || [];
                    const itemQuery = queries.find(q => Array.isArray(q.queryKey) && q.queryKey[0] === 'item');
                    if (itemQuery && itemQuery.state && itemQuery.state.data) {
                        itemData = itemQuery.state.data;
                    }
                    if (!itemData) {
                        itemData = pageProps.item || pageProps.ad || null;
                    }

                    if (itemData) {
                        foundStructuredData = true;
                        km = itemData.km || itemData.kilometers || itemData.mileage || itemData.details?.km || '';
                        color = itemData.color?.text || itemData.color || '';
                        description = itemData.description || itemData.info_text || '';
                        testDate = itemData.testDate || itemData.test_date || '';
                        previousOwners = itemData.previousOwners || itemData.previous_owners || '';
                    }
                }
            } catch (e) {}
        }

        // Fallback to DOM parsing for km if not found in JSON
        if (!km) {
            const doc = new DOMParser().parseFromString(html, "text/html");
            const kmElement = doc.querySelector("div[data-testid='we-checked-km-card'] span.detail-card-module-scss-module__Zc37sq__value") ||
                              doc.querySelector("span[data-testid='detail-card-value']");
            if (kmElement) {
                km = kmElement.innerText;
                foundStructuredData = true;
            } else {
                const text = doc.body.innerText;
                const kmMatch = text.match(/([\d,]+)\s*ק"מ/);
                if (kmMatch) { km = kmMatch[1]; foundStructuredData = true; }
            }
        }

        // A 200 OK response that yields none of the expected data (JSON or DOM) is the
        // usual signature of a bot-challenge/CAPTCHA page rather than a benign miss.
        if (!foundStructuredData) return { __blocked: true };

        return { km, color, description, testDate, previousOwners };

    } catch (e) {
        console.error(`Error fetching item ${token}:`, e);
    }
    return null;
}

async function processAutoScrapeCurrentPage() {
    if (localStorage.getItem(STATE_KEY_ACTIVE) !== 'true') return;

    // Scroll to load all dynamic elements
    for (let s = 0; s < 10; s++) {
        window.scrollBy(0, 500);
        if (!(await sleepInterruptible(400))) return;
    }

    // Extract items
    const pageItems = extractListings();

    // Load accumulated data
    let allListings = [];
    try { allListings = JSON.parse(localStorage.getItem(STATE_KEY_DATA) || '[]'); } catch (e) {}

    // De-dupe and add
    const seenLinks = new Set(allListings.map(i => i.Link).filter(Boolean));
    const seenTitles = new Set(allListings.map(i => `${i.Model}-${i.Price}-${i.Year}`));

    const maxPages = parseLimitSetting(localStorage.getItem('YAD2_MAX_PAGES'));
    const maxAds = parseLimitSetting(localStorage.getItem('YAD2_MAX_ADS'));

    let itemsAdded = 0;

    for (let i = 0; i < pageItems.length; i++) {
        const item = pageItems[i];

        if (localStorage.getItem(STATE_KEY_ACTIVE) !== 'true') {
            showToast("סריקה נעצרה על ידי המשתמש", 3000);
            return;
        }
        while (localStorage.getItem(STATE_KEY_PAUSED) === 'true') {
            await new Promise(r => setTimeout(r, 500));
            if (localStorage.getItem(STATE_KEY_ACTIVE) !== 'true') return;
        }

        if (allListings.length >= maxAds) {
            finishAutoScrape(allListings, `הגענו למקסימום רכבים המוגדר (${maxAds}). מסיים ומוריד...`, 3000);
            return;
        }

        const titleKey = `${item.Model}-${item.Price}-${item.Year}`;
        if (!seenLinks.has(item.Link) && !seenTitles.has(titleKey)) {

            showToast(`סורק עומק רכב ${i + 1} מתוך ${pageItems.length}...`, 0);

            const enrichDisabled = localStorage.getItem(STATE_KEY_ENRICH_DISABLED) === 'true';
            const tokenMatch = item.Link.match(/\/item\/([a-zA-Z0-9_-]+)/);

            if (!enrichDisabled && tokenMatch && tokenMatch[1]) {
                const token = tokenMatch[1];
                const deepData = await fetchItemDetails(token);

                if (deepData && deepData.__blocked) {
                    const blockedStreak = parseInt(localStorage.getItem(STATE_KEY_CONSEC_BLOCKED) || '0', 10) + 1;
                    localStorage.setItem(STATE_KEY_CONSEC_BLOCKED, blockedStreak.toString());
                    if (blockedStreak >= CONSEC_BLOCKED_LIMIT) {
                        localStorage.setItem(STATE_KEY_ENRICH_DISABLED, 'true');
                        showToast('⚠ יד2 כנראה חוסמת בקשות לדפי פירוט - ממשיכים לאסוף נתוני כרטיס בסיסיים בלבד.', 6000);
                    }
                } else if (deepData) {
                    localStorage.setItem(STATE_KEY_CONSEC_BLOCKED, '0');
                    if (deepData.km && !item.Kilometers) item.Kilometers = String(deepData.km).replace(/,/g, '').trim();
                    if (deepData.color && !item.Color) item.Color = String(deepData.color).trim();
                    item.Description = String(deepData.description || '').trim();
                    item.TestDate = String(deepData.testDate || '').trim();
                    item.PreviousOwners = String(deepData.previousOwners || '').trim();
                }

                // Random delay between 3 and 6 seconds (interruptible by Pause/Stop)
                const delay = Math.floor(Math.random() * 3000) + 3000;
                if (!(await sleepInterruptible(delay))) return;
            }

            if (item.Link) seenLinks.add(item.Link);
            seenTitles.add(titleKey);
            allListings.push(item);
            itemsAdded++;

            // Save state continuously so we don't lose data on interrupt
            try {
                localStorage.setItem(STATE_KEY_DATA, JSON.stringify(allListings));
                localStorage.setItem(STATE_KEY_LAST_ACTIVITY, Date.now().toString());
            } catch (e) {
                finishAutoScrape(allListings, '⚠ שגיאת אחסון (localStorage מלא) - הסריקה נעצרה ומה שנאסף יוצא כעת.', 6000);
                return;
            }
            updateETA(allListings.length);
        }
    }

    // Circuit breaker: if consecutive pages contribute zero new items (e.g. the site
    // clamps an out-of-range `page` param back to a valid one), stop instead of looping.
    if (itemsAdded === 0) {
        const streak = parseInt(localStorage.getItem(STATE_KEY_EMPTY_STREAK) || '0', 10) + 1;
        localStorage.setItem(STATE_KEY_EMPTY_STREAK, streak.toString());
        if (streak >= EMPTY_PAGE_STREAK_LIMIT) {
            finishAutoScrape(allListings, `⚠ ${streak} עמודים רצופים ללא רכבים חדשים - כנראה סוף התוצאות. מסיים ומוריד...`, 4000);
            return;
        }
    } else {
        localStorage.setItem(STATE_KEY_EMPTY_STREAK, '0');
    }

    const pagesScanned = parseInt(localStorage.getItem(STATE_KEY_PAGES_SCANNED) || '0', 10) + 1;
    localStorage.setItem(STATE_KEY_PAGES_SCANNED, pagesScanned.toString());

    showToast(`נאספו סה"כ ${allListings.length} רכבים עד כה. מחפש עמוד הבא...`, 0);

    if (pagesScanned >= maxPages) {
        finishAutoScrape(allListings, `הגענו למקסימום עמודים המוגדר (${maxPages}). מסיים ומוריד...`, 3000);
        return;
    }

    // Find and click Next button
    let nextBtn = document.querySelector("a[rel='next'], [data-testid='next-page'], button[class*='pagination_next'], a[class*='pagination-next']");

    // Fallback if Next button not found by selector
    if (!nextBtn) {
        const clickable = Array.from(document.querySelectorAll("button, a, span, div"));
        nextBtn = clickable.find(el => {
            const text = el.innerText ? el.innerText.trim() : '';
            // Look for "הבא" (Next) but ensure it's a small element like a button
            return text === "הבא" && el.innerText.length < 10;
        });
    }

    // Navigate to next page via URL manipulation (extremely robust)
    if (nextBtn || pageItems.length > 20) {
        if (!(await sleepInterruptible(1500))) return;
        if (localStorage.getItem(STATE_KEY_ACTIVE) === 'true') {
            const url = new URL(window.location.href);
            let currentPage = parseInt(url.searchParams.get('page')) || 1;
            url.searchParams.set('page', currentPage + 1);

            showToast(`🔄 עורך קישור ישירות לעמוד ${currentPage + 1}...`, 0);
            window.location.href = url.toString();
        }
    } else {
        // No next page found
        finishAutoScrape(allListings, `[*] לא נמצאו עמודים נוספים. סיום סריקה אוטומטית.`, 3000);
    }
}

// ------------------------------------------------------------------
// Utilities
// ------------------------------------------------------------------

function downloadCSV(listings, filename) {
    const headers = ["Manufacturer", "Model", "Submodel/Trim", "Price (ILS)", "Year", "Hand", "Kilometers", "Engine", "Gear", "Color", "Area", "Features", "Test Date", "Previous Owners", "Description", "Link"];
    let csvContent = "﻿"; // UTF-8 BOM for Hebrew Excel support
    csvContent += headers.join(",") + "\r\n";

    listings.forEach(item => {
        const row = [
            sanitizeCSVField(item.Manufacturer),
            sanitizeCSVField(item.Model),
            sanitizeCSVField(item.Submodel),
            sanitizeCSVField(item.Price),
            sanitizeCSVField(item.Year),
            sanitizeCSVField(item.Hand),
            sanitizeCSVField(item.Kilometers),
            sanitizeCSVField(item.Engine),
            sanitizeCSVField(item.Gear),
            sanitizeCSVField(item.Color),
            sanitizeCSVField(item.Area),
            sanitizeCSVField(item.Features),
            sanitizeCSVField(item.TestDate),
            sanitizeCSVField(item.PreviousOwners),
            sanitizeCSVField((item.Description || '').replace(/\n/g, ' ').replace(/\r/g, '')),
            sanitizeCSVField(item.Link)
        ].map(v => `"${v}"`);
        csvContent += row.join(",") + "\r\n";
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename || `yad2_cars_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// Keep the persisted "last activity" timestamp fresh the moment the tab backgrounds,
// so the staleness check (10 min) is measured from real abandonment, not throttling.
document.addEventListener('visibilitychange', () => {
    if (document.hidden && localStorage.getItem(STATE_KEY_ACTIVE) === 'true' && localStorage.getItem(STATE_KEY_PAUSED) !== 'true') {
        localStorage.setItem(STATE_KEY_LAST_ACTIVITY, Date.now().toString());
        showToast('⚠ הטאב עבר לרקע - הסריקה תמשיך אך עלולה להאט.', 4000);
    }
});

// Auto init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initExporter);
} else {
    initExporter();
}
setTimeout(initExporter, 2000);
