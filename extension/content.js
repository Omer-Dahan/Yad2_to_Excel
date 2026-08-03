// Chrome Extension Content Script for Yad2 Car Export (Main World Context)

const STATE_KEY_ACTIVE = 'yad2_exporter_auto_active';
const STATE_KEY_DATA = 'yad2_exporter_auto_data';
const STATE_KEY_PAGE_COUNT = 'yad2_exporter_auto_page_count';

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

    const stopBtn = document.createElement('button');
    stopBtn.id = 'yad2-export-stop-btn';
    stopBtn.className = 'yad2-exporter-btn';
    stopBtn.innerHTML = '🛑 עצור סריקה ושמור';
    stopBtn.addEventListener('click', () => stopAutoScrape());

    panel.appendChild(currentBtn);
    panel.appendChild(multiBtn);
    panel.appendChild(stopBtn);
    document.body.appendChild(panel);

    // Progress Toast Notification
    const toast = document.createElement('div');
    toast.id = 'yad2-exporter-toast';
    document.body.appendChild(toast);

    // Check if auto-scrape is active and resume
    if (localStorage.getItem(STATE_KEY_ACTIVE) === 'true') {
        multiBtn.style.display = 'none';
        currentBtn.style.display = 'none';
        stopBtn.style.display = 'flex';
        
        const count = parseInt(localStorage.getItem(STATE_KEY_PAGE_COUNT) || '0', 10);
        showToast(`🔄 ממשיך סריקה אוטומטית (עמוד ${count + 1}). מנתח נתונים...`, 0);
        
        // Wait for page to fully load and hydrate before scraping
        setTimeout(() => {
            processAutoScrapeCurrentPage();
        }, 4000);
    }
}

function showToast(message, duration = 4000) {
    const toast = document.getElementById('yad2-exporter-toast');
    if (toast) {
        toast.innerText = message;
        toast.style.display = 'block';
        if (duration > 0) {
            setTimeout(() => {
                toast.style.display = 'none';
            }, duration);
        }
    }
}

function parseCarCard(card) {
    // Inject spaces to prevent sticky words (e.g., "word1word2")
    const clone = card.cloneNode(true);
    clone.querySelectorAll('span, p, div, li, h1, h2, h3, a').forEach(el => {
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

    // 2. Price Extraction
    let price = "N/A";
    const priceMatches = Array.from(text.matchAll(/(?:₪\s*([\d,]{4,7}))|([\d,]{4,7})\s*₪/g));
    for (const match of priceMatches) {
        const valStr = (match[1] || match[2]).replace(/,/g, '');
        const val = parseInt(valStr, 10);
        // Ignore discount badges (usually small numbers like 2000, 3000, 4000) unless it's the actual car price
        if (!text.includes(`ירד ב ${match[0]}`) && !text.includes(`ירד ב ${valStr}`) && val >= 10000 && val <= 350000) {
            price = String(val);
            break;
        }
    }

    // 3. Year Extraction (20XX / 19XX)
    const yearMatch = text.match(/\b(20\d{2}|19\d{2})\b/);
    const year = yearMatch ? yearMatch[1] : "N/A";

    // 4. Hand Extraction (יד X)
    const handMatch = text.match(/יד\s*(\d+)/);
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
                                    Hand: String(hand).replace('יד שניה', '2').replace('יד ראשונה', '1').trim(),
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
            const uniqueKey = `${parsed.Title || parsed.Model}-${parsed.Submodel}-${parsed.Price}-${parsed.Year}`;
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
                    const uniqueKey = `${parsed.Title || parsed.Model}-${parsed.Submodel}-${parsed.Price}-${parsed.Year}`;
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

function exportCurrentPage() {
    const listings = extractListings();
    if (!listings || listings.length === 0) {
        alert('לא נמצאו מודעות רכב בעמוד הנוכחי. ודא כי עמוד תוצאות החיפוש נטען במלואו.');
        return;
    }
    downloadCSV(listings, `yad2_cars_page_${new Date().toISOString().slice(0, 10)}.csv`);
    showToast(`✓ יוצאו בהצלחה ${listings.length} מודעות רכב!`);
}

// ------------------------------------------------------------------
// Auto Scraper Logic
// ------------------------------------------------------------------

async function startAutoScrape() {
    localStorage.setItem(STATE_KEY_ACTIVE, 'true');
    localStorage.setItem(STATE_KEY_DATA, JSON.stringify([]));
    localStorage.setItem('yad2_exporter_pages_scanned', '0');
    
    document.getElementById('yad2-export-multi-btn').style.display = 'none';
    document.getElementById('yad2-export-current-btn').style.display = 'none';
    document.getElementById('yad2-export-stop-btn').style.display = 'flex';

    showToast(`🚀 מתחיל סריקה אוטומטית מלאה... גולל לאיסוף נתונים.`, 0);
    processAutoScrapeCurrentPage();
}

function stopAutoScrape() {
    localStorage.setItem(STATE_KEY_ACTIVE, 'false');
    
    document.getElementById('yad2-export-multi-btn').style.display = 'flex';
    document.getElementById('yad2-export-current-btn').style.display = 'flex';
    document.getElementById('yad2-export-stop-btn').style.display = 'none';

    const rawData = localStorage.getItem(STATE_KEY_DATA);
    let allListings = [];
    if (rawData) {
        try {
            allListings = JSON.parse(rawData);
        } catch(e) {}
    }

    if (allListings.length > 0) {
        showToast(`✅ הסריקה נעצרה. מייצא ${allListings.length} מודעות...`, 5000);
        downloadCSV(allListings, `yad2_cars_auto_${allListings.length}_items.csv`);
    } else {
        showToast(`⏹ הסריקה נעצרה. לא נאספו נתונים.`, 4000);
    }
}

async function fetchItemDetails(token) {
    try {
        const res = await fetch(`https://www.yad2.co.il/item/${token}`);
        if (!res.ok) return null;
        const html = await res.text();
        
        let km = '';
        let color = '';
        let description = '';
        let testDate = '';
        let previousOwners = '';

        const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
        if (match) {
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
                    km = itemData.km || itemData.kilometers || itemData.mileage || itemData.details?.km || '';
                    color = itemData.color?.text || itemData.color || '';
                    description = itemData.description || itemData.info_text || '';
                    testDate = itemData.testDate || itemData.test_date || '';
                    previousOwners = itemData.previousOwners || itemData.previous_owners || '';
                }
            }
        }
        
        // Fallback to DOM parsing for km if not found in JSON
        if (!km) {
            const doc = new DOMParser().parseFromString(html, "text/html");
            const kmElement = doc.querySelector("div[data-testid='we-checked-km-card'] span.detail-card-module-scss-module__Zc37sq__value") || 
                              doc.querySelector("span[data-testid='detail-card-value']");
            if (kmElement) {
                km = kmElement.innerText;
            } else {
                const text = doc.body.innerText;
                const kmMatch = text.match(/([\d,]+)\s*ק"מ/);
                if (kmMatch) km = kmMatch[1];
            }
        }

        return { km, color, description, testDate, previousOwners };

    } catch (e) {
        console.error(`Error fetching item ${token}:`, e);
    }
    return null;
}

async function processAutoScrapeCurrentPage() {
    if (localStorage.getItem(STATE_KEY_ACTIVE) !== 'true') return;

    let count = parseInt(localStorage.getItem(STATE_KEY_PAGE_COUNT) || '0', 10);
    count++;
    localStorage.setItem(STATE_KEY_PAGE_COUNT, count.toString());

    // Scroll to load all dynamic elements
    for (let s = 0; s < 10; s++) {
        window.scrollBy(0, 500);
        await new Promise(r => setTimeout(r, 400));
        if (localStorage.getItem(STATE_KEY_ACTIVE) !== 'true') return; // Check if stopped mid-scroll
    }

    // Extract items
    const pageItems = extractListings();
    
    // Load accumulated data
    const rawData = localStorage.getItem(STATE_KEY_DATA);
    let allListings = [];
    if (rawData) {
        try {
            allListings = JSON.parse(rawData);
        } catch(e) {}
    }

    // De-dupe and add
    const seenLinks = new Set(allListings.map(i => i.Link).filter(Boolean));
    const seenTitles = new Set(allListings.map(i => `${i.Title || i.Model}-${i.Price}-${i.Year}`));
    
    let pagesScanned = parseInt(localStorage.getItem('yad2_exporter_pages_scanned') || '0');
    pagesScanned++;
    localStorage.setItem('yad2_exporter_pages_scanned', pagesScanned.toString());

    const maxPages = parseInt(localStorage.getItem('YAD2_MAX_PAGES')) || Infinity;
    const maxAds = parseInt(localStorage.getItem('YAD2_MAX_ADS')) || Infinity;

    let itemsAdded = 0;

    for (let i = 0; i < pageItems.length; i++) {
        const item = pageItems[i];
        
        if (localStorage.getItem(STATE_KEY_ACTIVE) !== 'true') {
            showToast("סריקה נעצרה על ידי המשתמש", 3000);
            return;
        }

        if (allListings.length >= maxAds) {
            showToast(`הגענו למקסימום רכבים המוגדר (${maxAds}). מסיים ומוריד...`, 3000);
            localStorage.setItem(STATE_KEY_ACTIVE, 'false');
            downloadCSV(allListings, `yad2_cars_auto_${allListings.length}_items.csv`);
            return;
        }

        const titleKey = `${item.Title || item.Model}-${item.Price}-${item.Year}`;
        if (!seenLinks.has(item.Link) && !seenTitles.has(titleKey)) {
            
            showToast(`סורק עומק רכב ${i + 1} מתוך ${pageItems.length}...`, 0);
            
            const tokenMatch = item.Link.match(/\/item\/([a-zA-Z0-9_-]+)/);
            if (tokenMatch && tokenMatch[1]) {
                const token = tokenMatch[1];
                const deepData = await fetchItemDetails(token);
                if (deepData) {
                    if (deepData.km && !item.Kilometers) item.Kilometers = String(deepData.km).replace(/,/g, '').trim();
                    if (deepData.color && !item.Color) item.Color = String(deepData.color).trim();
                    item.Description = String(deepData.description || '').trim();
                    item.TestDate = String(deepData.testDate || '').trim();
                    item.PreviousOwners = String(deepData.previousOwners || '').trim();
                }
                
                // Random delay between 3 and 6 seconds
                const delay = Math.floor(Math.random() * 3000) + 3000;
                await new Promise(r => setTimeout(r, delay));
            }

            if (item.Link) seenLinks.add(item.Link);
            seenTitles.add(titleKey);
            allListings.push(item);
            itemsAdded++;
            
            // Save state continuously so we don't lose data on interrupt
            localStorage.setItem(STATE_KEY_DATA, JSON.stringify(allListings));
        }
    }

    if (itemsAdded === 0 && pageItems.length > 0) {
        console.log("No new items found on this page, but proceeding to next page.");
    }

    showToast(`נאספו סה"כ ${allListings.length} רכבים עד כה. מחפש עמוד הבא...`, 0);

    if (pagesScanned >= maxPages) {
        showToast(`הגענו למקסימום עמודים המוגדר (${maxPages}). מסיים ומוריד...`, 3000);
        localStorage.setItem(STATE_KEY_ACTIVE, 'false');
        downloadCSV(allListings, `yad2_cars_auto_${allListings.length}_items.csv`);
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
        await new Promise(r => setTimeout(r, 1500));
        if (localStorage.getItem(STATE_KEY_ACTIVE) === 'true') {
            const url = new URL(window.location.href);
            let currentPage = parseInt(url.searchParams.get('page')) || 1;
            url.searchParams.set('page', currentPage + 1);
            
            showToast(`🔄 עורך קישור ישירות לעמוד ${currentPage + 1}...`, 0);
            window.location.href = url.toString();
        }
    } else {
        // No next page found
        showToast(`[*] לא נמצאו עמודים נוספים. סיום סריקה אוטומטית.`, 3000);
        stopAutoScrape();
    }
}

// ------------------------------------------------------------------
// Utilities
// ------------------------------------------------------------------

function downloadCSV(listings, filename) {
    const headers = ["Manufacturer", "Model", "Submodel/Trim", "Price (ILS)", "Year", "Hand", "Kilometers", "Engine", "Gear", "Color", "Area", "Features", "Test Date", "Previous Owners", "Description", "Link"];
    let csvContent = "\uFEFF"; // UTF-8 BOM for Hebrew Excel support
    csvContent += headers.join(",") + "\r\n";

    listings.forEach(item => {
        const row = [
            `"${(item.Manufacturer || '').replace(/"/g, '""')}"`,
            `"${(item.Model || item.Title || '').replace(/"/g, '""')}"`,
            `"${(item.Submodel || '').replace(/"/g, '""')}"`,
            `"${(item.Price || '').replace(/"/g, '""')}"`,
            `"${(item.Year || '').replace(/"/g, '""')}"`,
            `"${(item.Hand || '').replace(/"/g, '""')}"`,
            `"${(item.Kilometers || '').replace(/"/g, '""')}"`,
            `"${(item.Engine || '').replace(/"/g, '""')}"`,
            `"${(item.Gear || '').replace(/"/g, '""')}"`,
            `"${(item.Color || '').replace(/"/g, '""')}"`,
            `"${(item.Area || '').replace(/"/g, '""')}"`,
            `"${(item.Features || '').replace(/"/g, '""')}"`,
            `"${(item.TestDate || '').replace(/"/g, '""')}"`,
            `"${(item.PreviousOwners || '').replace(/"/g, '""')}"`,
            `"${(item.Description || '').replace(/"/g, '""').replace(/\n/g, ' ').replace(/\r/g, '')}"`,
            `"${(item.Link || '').replace(/"/g, '""')}"`
        ];
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
}

// Auto init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initExporter);
} else {
    initExporter();
}
setTimeout(initExporter, 2000);
