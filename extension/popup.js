function isYad2Tab(url) {
    try {
        const hostname = new URL(url).hostname;
        return hostname === 'www.yad2.co.il' || hostname === 'yad2.co.il';
    } catch (e) {
        return false;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const maxPagesInput = document.getElementById('maxPages');
    const maxAdsInput = document.getElementById('maxAds');
    const saveBtn = document.getElementById('saveBtn');
    const statusDiv = document.getElementById('status');

    // מניעת הזנת מספרים שליליים ותווים לא רלוונטיים
    const enforcePositive = (e) => {
        if (e.target.value < 0) {
            e.target.value = Math.abs(e.target.value);
        }
    };
    const preventInvalidChars = (e) => {
        if (['-', '+', 'e', 'E', '.'].includes(e.key)) {
            e.preventDefault();
        }
    };

    [maxPagesInput, maxAdsInput].forEach(input => {
        input.addEventListener('input', enforcePositive);
        input.addEventListener('keydown', preventInvalidChars);
    });

    // Load current settings from active tab's localStorage
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (!tabs[0] || !isYad2Tab(tabs[0].url)) {
            statusDiv.textContent = "יש לפתוח בעמוד יד2";
            statusDiv.style.color = "#ff4757";
            return;
        }

        chrome.scripting.executeScript({
            target: {tabId: tabs[0].id},
            world: "MAIN",
            func: () => {
                return {
                    maxPages: localStorage.getItem('YAD2_MAX_PAGES'),
                    maxAds: localStorage.getItem('YAD2_MAX_ADS')
                };
            }
        }, (results) => {
            if (results && results[0] && results[0].result) {
                const res = results[0].result;
                if (res.maxPages) maxPagesInput.value = res.maxPages;
                if (res.maxAds) maxAdsInput.value = res.maxAds;
            }
        });
    });

    saveBtn.addEventListener('click', () => {
        const maxPages = maxPagesInput.value;
        const maxAds = maxAdsInput.value;

        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            if (!tabs[0] || !isYad2Tab(tabs[0].url)) {
                statusDiv.textContent = "יש לשמור בעמוד יד2";
                statusDiv.style.color = "#ff4757";
                return;
            }

            chrome.scripting.executeScript({
                target: {tabId: tabs[0].id},
                world: "MAIN",
                func: (pages, ads) => {
                    if (pages) localStorage.setItem('YAD2_MAX_PAGES', pages);
                    else localStorage.removeItem('YAD2_MAX_PAGES');
                    
                    if (ads) localStorage.setItem('YAD2_MAX_ADS', ads);
                    else localStorage.removeItem('YAD2_MAX_ADS');
                },
                args: [maxPages, maxAds]
            }, () => {
                statusDiv.textContent = "נשמר בהצלחה!";
                statusDiv.style.color = "#4cd137";
                setTimeout(() => { statusDiv.textContent = ''; }, 2000);
            });
        });
    });
});
