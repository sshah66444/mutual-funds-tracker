// Global State
let fundsData = [];
let uniqueAMCs = [];
let portfolioItems = [];
let chartInstance = null;
let portfolioChartInstance = null;
let calcChartInstance = null;
let inflationFilterActive = false;
let inflationThreshold = 10.0;
let investmentEntries = [];
let navArchive = {};
let psxIndexData = null; // Today's KSE-100 data for NAV estimation

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    setupTabNavigation();
    setupGuideNavigation();
    setupEventHandlers();
});

// URLs configuration for Offline-first Fetch
const IS_LOCAL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const REMOTE_BASE = 'https://sshah66444.github.io/mutual-funds-tracker';
const DATA_PATHS = {
    mufap: '/data/mufap_data.json',
    psx: '/data/psx_index.json',
    movers: '/data/psx_performers.json',
    archive: '/data/nav_archive.json'
};

function getUrl(pathKey) {
    const path = DATA_PATHS[pathKey];
    return IS_LOCAL ? `.${path}` : `${REMOTE_BASE}${path}`;
}

// Caching helpers
function saveToCache(key, data) {
    try {
        localStorage.setItem(`cache_${key}`, JSON.stringify(data));
        localStorage.setItem(`cache_${key}_time`, Date.now().toString());
    } catch (e) {
        console.warn("localStorage saving failed:", e);
    }
}

function loadFromCache(key) {
    try {
        const data = localStorage.getItem(`cache_${key}`);
        return data ? JSON.parse(data) : null;
    } catch (e) {
        return null;
    }
}

// Load JSON Data with Offline-First & Cache Strategy
async function loadData() {
    let mufapLoaded = false;
    
    // 1. Try to load from online fetch
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s timeout
        const mufapUrl = getUrl('mufap');
        console.log("Fetching MUFAP data from:", mufapUrl);
        
        const response = await fetch(mufapUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (response.ok) {
            fundsData = await response.json();
            saveToCache('mufap', fundsData);
            mufapLoaded = true;
            console.log("MUFAP data loaded from online fetch");
        }
    } catch (err) {
        console.warn("Failed to fetch MUFAP online, falling back to cache:", err);
    }
    
    // 2. Load from localStorage cache if online fails
    if (!mufapLoaded) {
        fundsData = loadFromCache('mufap');
        if (fundsData) {
            mufapLoaded = true;
            console.log("MUFAP data loaded from local storage cache");
        }
    }
    
    // 3. Load from packaged static assets (first run fallback)
    if (!mufapLoaded) {
        try {
            console.log("Fallback: loading packaged static assets...");
            const response = await fetch('./data/mufap_data.json');
            if (response.ok) {
                fundsData = await response.json();
                saveToCache('mufap', fundsData);
                mufapLoaded = true;
                console.log("MUFAP data loaded from static asset fallback");
            }
        } catch (fallbackErr) {
            console.error("Static asset fallback failed:", fallbackErr);
        }
    }
    
    if (!mufapLoaded) {
        alert("Unable to load mutual fund data. Please check your internet connection.");
        return;
    }

    // Load PSX Index Details
    let psxData = null;
    try {
        const response = await fetch(getUrl('psx'));
        if (response.ok) {
            psxData = await response.json();
            saveToCache('psx', psxData);
        }
    } catch (e) {
        psxData = loadFromCache('psx');
    }
    if (psxData) {
        psxIndexData = psxData;
        updateKSE100Card(psxIndexData);
    } else {
        try {
            const fallback = await fetch('./data/psx_index.json');
            if (fallback.ok) {
                psxIndexData = await fallback.json();
                updateKSE100Card(psxIndexData);
            }
        } catch(e) {}
    }

    // Load PSX Movers/Performers
    let moversData = null;
    try {
        const response = await fetch(getUrl('movers'));
        if (response.ok) {
            moversData = await response.json();
            saveToCache('movers', moversData);
        }
    } catch (e) {
        moversData = loadFromCache('movers');
    }
    if (moversData) {
        renderPSXMovers(moversData);
    } else {
        try {
            const fallback = await fetch('./data/psx_performers.json');
            if (fallback.ok) {
                const fd = await fallback.json();
                renderPSXMovers(fd);
            }
        } catch(e) {}
    }

    // Load NAV Archive
    let archiveData = null;
    try {
        const response = await fetch(getUrl('archive'));
        if (response.ok) {
            archiveData = await response.json();
            saveToCache('archive', archiveData);
        }
    } catch (e) {
        archiveData = loadFromCache('archive');
    }
    if (archiveData) {
        navArchive = archiveData;
    } else {
        try {
            const fallback = await fetch('./data/nav_archive.json');
            if (fallback.ok) {
                navArchive = await fallback.json();
            }
        } catch(e) {}
    }

    // Extract unique AMCs
    const amcs = [...new Set(fundsData.map(f => f.amc))].filter(amc => amc && amc !== 'Unknown').sort();
    uniqueAMCs = amcs;
        
        // Populate DOM components
        updateGlobalStats();
        populateAMCDropdown();
        populateSelectors();
        renderOverviewHighlights();
        renderDirectoryTable();
        
        // Trigger initial calculator draw
        calculateGrowth();

        // Load saved investment entries from localStorage
        loadInvestmentsFromStorage();
        
    } catch (error) {
        console.error("Error loading data:", error);
        document.getElementById('data-update-date').innerText = "Error loading data";
    }
}

// Setup navigation between sidebar tabs
function setupTabNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const tabPanes = document.querySelectorAll('.tab-pane');
    const dropdownItems = document.querySelectorAll('.dropdown-item');
    const moreBtn = document.getElementById('btn-more-menu');
    const dropdownMenu = document.getElementById('mobile-more-dropdown');

    // Central function to switch tabs and manage active states
    window.switchTab = function(tabId) {
        // 1. Switch active class on main nav items
        navItems.forEach(n => {
            if (n.getAttribute('data-tab') === tabId) {
                n.classList.add('active');
            } else {
                n.classList.remove('active');
            }
        });

        // 2. Manage "More" button active state on mobile (highlight if current tab is in dropdown-only section)
        if (moreBtn) {
            const bottomTabIds = ['overview', 'directory', 'portfolio'];
            if (!bottomTabIds.includes(tabId)) {
                moreBtn.classList.add('active');
            } else {
                moreBtn.classList.remove('active');
            }
        }

        // 3. Switch active class on dropdown items
        dropdownItems.forEach(d => {
            if (d.getAttribute('data-tab') === tabId) {
                d.classList.add('active');
            } else {
                d.classList.remove('active');
            }
        });

        // 4. Switch tab panes
        tabPanes.forEach(pane => {
            if (pane.id === `tab-${tabId}`) {
                pane.classList.add('active');
            } else {
                pane.classList.remove('active');
            }
        });

        // 5. Trigger chart update if switching to portfolio
        if (tabId === 'portfolio' && portfolioItems.length > 0) {
            updatePortfolioChart();
        }
    };

    // Standard sidebar buttons click listener
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetTab = item.getAttribute('data-tab');
            if (targetTab) {
                window.switchTab(targetTab);
                if (dropdownMenu) dropdownMenu.style.display = 'none';
            }
        });
    });

    // Mobile "More" menu button toggle listener
    if (moreBtn && dropdownMenu) {
        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = dropdownMenu.style.display === 'flex';
            dropdownMenu.style.display = isVisible ? 'none' : 'flex';
        });
    }

    // Dropdown list items click listener
    dropdownItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetTab = item.getAttribute('data-tab');
            if (targetTab) {
                window.switchTab(targetTab);
            }
            if (dropdownMenu) dropdownMenu.style.display = 'none';
        });
    });

    // Click outside to close the dropdown menu
    document.addEventListener('click', () => {
        if (dropdownMenu && dropdownMenu.style.display === 'flex') {
            dropdownMenu.style.display = 'none';
        }
    });
}


// Setup navigation inside the Investor Guide
function setupGuideNavigation() {
    const guideNavItems = document.querySelectorAll('.guide-nav-item');
    const guideSections = document.querySelectorAll('.guide-section');
    
    guideNavItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetSec = item.getAttribute('data-guide-section');
            
            guideNavItems.forEach(n => n.classList.remove('active'));
            guideSections.forEach(s => s.classList.remove('active'));
            
            item.classList.add('active');
            document.getElementById(`guide-sec-${targetSec}`).classList.add('active');
        });
    });
}

// Setup Event Handlers
function setupEventHandlers() {
    // Directory Filters
    document.getElementById('filter-amc').addEventListener('change', renderDirectoryTable);
    document.getElementById('filter-category').addEventListener('change', renderDirectoryTable);
    document.getElementById('filter-risk').addEventListener('change', renderDirectoryTable);
    document.getElementById('filter-shariah').addEventListener('change', renderDirectoryTable);
    document.getElementById('global-search').addEventListener('input', renderDirectoryTable);
    document.getElementById('sort-select').addEventListener('change', renderDirectoryTable);
    
    document.getElementById('btn-reset-filters').addEventListener('click', () => {
        document.getElementById('filter-amc').value = 'all';
        document.getElementById('filter-category').value = 'all';
        document.getElementById('filter-risk').value = 'all';
        document.getElementById('filter-shariah').checked = false;
        document.getElementById('global-search').value = '';
        document.getElementById('sort-select').value = 'score_desc';
        renderDirectoryTable();
    });

    // Comparison select triggers
    document.getElementById('compare-select-1').addEventListener('change', updateComparisonWorkspace);
    document.getElementById('compare-select-2').addEventListener('change', updateComparisonWorkspace);
    document.getElementById('compare-select-3').addEventListener('change', updateComparisonWorkspace);

    // Portfolio Add Fund Trigger
    document.getElementById('btn-add-to-portfolio').addEventListener('click', addFundToPortfolio);
    document.getElementById('portfolio-sim-amount').addEventListener('input', updatePortfolioAnalytics);

    // Growth Calculator triggers
    document.getElementById('calc-fund').addEventListener('change', prefillExpectedReturn);
    document.getElementById('calc-years').addEventListener('input', (e) => {
        document.getElementById('calc-years-display').innerText = e.target.value;
        calculateGrowth();
    });
    document.getElementById('btn-run-calc').addEventListener('click', calculateGrowth);

    // Modal Close handlers
    document.getElementById('btn-close-modal').addEventListener('click', () => {
        document.getElementById('fund-details-modal').style.display = 'none';
    });
    window.addEventListener('click', (e) => {
        const modal = document.getElementById('fund-details-modal');
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });

    // Inflation filter toggle
    const inflationBtn = document.getElementById('btn-inflation-filter');
    const inflationInput = document.getElementById('inflation-threshold');
    if (inflationBtn) {
        inflationBtn.addEventListener('click', () => {
            inflationFilterActive = !inflationFilterActive;
            inflationBtn.classList.toggle('active', inflationFilterActive);
            renderDirectoryTable();
        });
    }
    if (inflationInput) {
        inflationInput.addEventListener('input', () => {
            inflationThreshold = parseFloat(inflationInput.value) || 10;
            const lbl = document.getElementById('inflation-label');
            if (lbl) lbl.textContent = `(>${inflationThreshold}%)`;
            if (inflationFilterActive) renderDirectoryTable();
        });
    }

    // My Investments button
    const addInvBtn = document.getElementById('btn-add-investment');
    if (addInvBtn) addInvBtn.addEventListener('click', addInvestmentEntry);
}

// Parse value helper for maths
function parseFloatReturn(str) {
    if (!str || str === 'N/A') return null;
    let cleaned = str.replace(/%|,/g, '').trim();
    if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
        cleaned = '-' + cleaned.slice(1, -1);
    }
    const val = parseFloat(cleaned);
    return isNaN(val) ? null : val;
}

// Update Global counts and dates
function updateGlobalStats() {
    const totalFunds = fundsData.length;
    const shariahFunds = fundsData.filter(f => f.is_shariah).length;
    
    document.getElementById('total-funds-count').innerText = totalFunds.toLocaleString();
    document.getElementById('islamic-funds-count').innerText = shariahFunds.toLocaleString();
    document.getElementById('amc-count').innerText = uniqueAMCs.length;

    // Get date from first few entries
    if (fundsData.length > 0) {
        document.getElementById('data-update-date').innerText = fundsData[0].validity_date;
    }

    // Average money market yield
    const mmFunds = fundsData.filter(f => f.category.toLowerCase().includes('money market') && parseFloatReturn(f.returns.ytd) !== null);
    if (mmFunds.length > 0) {
        const avg = mmFunds.reduce((sum, f) => sum + parseFloatReturn(f.returns.ytd), 0) / mmFunds.length;
        document.getElementById('low-risk-avg-return').innerText = avg.toFixed(2) + '%';
    }
}

// Populate dropdown filters
function populateAMCDropdown() {
    const select = document.getElementById('filter-amc');
    uniqueAMCs.forEach(amc => {
        const option = document.createElement('option');
        option.value = amc;
        option.textContent = amc;
        select.appendChild(option);
    });
}

// Populate selectors in Portfolio and Comparison tabs
function populateSelectors() {
    const compare1 = document.getElementById('compare-select-1');
    const compare2 = document.getElementById('compare-select-2');
    const compare3 = document.getElementById('compare-select-3');
    const portfolioSelect = document.getElementById('portfolio-fund-select');
    const calcSelect = document.getElementById('calc-fund');
    
    // Sort funds by name for selection list
    const sortedFunds = [...fundsData].sort((a, b) => a.fund_name.localeCompare(b.fund_name));

    sortedFunds.forEach(fund => {
        const nameText = `${fund.fund_name} (NAV: Rs. ${fund.nav})`;
        
        // Compare select lists
        const opt1 = new Option(nameText, fund.fund_name);
        const opt2 = new Option(nameText, fund.fund_name);
        const opt3 = new Option(nameText, fund.fund_name);
        compare1.add(opt1);
        compare2.add(opt2);
        compare3.add(opt3);

        // Portfolio allocator dropdown
        portfolioSelect.add(new Option(fund.fund_name, fund.fund_name));

        // My Investments dropdown
        const invSel = document.getElementById('inv-fund-select');
        if (invSel) invSel.add(new Option(fund.fund_name, fund.fund_name));

        // Growth Calculator select list
        calcSelect.add(new Option(nameText, fund.fund_name));
    });
    
    // Prefill calculator select with first element
    if (sortedFunds.length > 0) {
        prefillExpectedReturn();
    }
}

// Highlights panel on overview
function renderOverviewHighlights() {
    const getTopFunds = (keywordCategory, elementId) => {
        const listEl = document.getElementById(elementId);
        listEl.innerHTML = '';
        
        // Filter by keyword and ensure positive numeric return
        const funds = fundsData.filter(f => {
            const cat = f.category.toLowerCase();
            const name = f.fund_name.toLowerCase();
            return cat.includes(keywordCategory) && parseFloatReturn(f.returns.ytd) !== null && f.major_category !== 'Pension';
        });

        // Sort by YTD return descending
        funds.sort((a, b) => parseFloatReturn(b.returns.ytd) - parseFloatReturn(a.returns.ytd));

        // Display top 3
        funds.slice(0, 3).forEach((f, idx) => {
            const card = document.createElement('div');
            card.className = 'mini-fund-card';
            card.onclick = () => {
                // Navigate to directory with this fund searched
                document.getElementById('global-search').value = f.fund_name;
                document.getElementById('btn-directory').click();
                renderDirectoryTable();
            };

            const ytd = parseFloatReturn(f.returns.ytd);
            
            card.innerHTML = `
                <div class="m-fund-info">
                    <div class="m-fund-name">${f.fund_name}</div>
                    <div class="m-fund-meta">
                        <span>${f.amc.replace(' Limited', '').replace(' Company', '')}</span>
                        ${f.is_shariah ? '<span class="shariah-badge"><i class="fa-solid fa-mosque"></i> Islamic</span>' : ''}
                    </div>
                </div>
                <div class="m-fund-yield">
                    <div class="m-yield-val ${ytd < 0 ? 'negative' : ''}">${ytd.toFixed(2)}%</div>
                    <div class="m-yield-label">YTD Return</div>
                </div>
            `;
            listEl.appendChild(card);
        });
    };

    getTopFunds('equity', 'top-equity-list');
    getTopFunds('income', 'top-income-list');
    getTopFunds('money market', 'top-mm-list');
    renderMFMovers();
}

function renderMFMovers() {
    // Collect all funds with a valid 1-day return
    const withReturn = fundsData
        .filter(f => f.major_category !== 'Pension')
        .map(f => ({ fund: f, r1d: parseFloatReturn(f.returns['1d']) }))
        .filter(x => x.r1d !== null);

    // Sort descending for gainers, ascending for losers
    const sorted = [...withReturn].sort((a, b) => b.r1d - a.r1d);
    const gainers = sorted.filter(x => x.r1d > 0).slice(0, 5);
    const losers  = sorted.filter(x => x.r1d < 0).slice(-5).reverse();
    const flat    = withReturn.filter(x => x.r1d === 0).slice(0, 5);

    const buildCard = (f, r1d) => {
        const card = document.createElement('div');
        card.className = 'mini-fund-card';
        card.onclick = () => showFundDetails(f.fund_name);
        const sign = r1d > 0 ? '+' : '';
        const cls  = r1d > 0 ? '' : (r1d < 0 ? 'negative' : '');
        card.innerHTML = `
            <div class="m-fund-info">
                <div class="m-fund-name">${f.fund_name}</div>
                <div class="m-fund-meta">
                    <span>${f.amc.replace(' Limited','').replace(' Company','')}</span>
                    ${f.is_shariah ? '<span class="shariah-badge"><i class="fa-solid fa-mosque"></i> Islamic</span>' : ''}
                </div>
            </div>
            <div class="m-fund-yield">
                <div class="m-yield-val ${cls}">${sign}${r1d.toFixed(2)}%</div>
                <div class="m-yield-label">Today</div>
            </div>`;
        return card;
    };

    const gainEl = document.getElementById('mf-gainers-list');
    const loseEl = document.getElementById('mf-losers-list');
    const flatEl = document.getElementById('mf-flat-list');
    if (!gainEl) return;

    gainEl.innerHTML = '';
    loseEl.innerHTML = '';
    flatEl.innerHTML = '';

    if (gainers.length === 0) {
        gainEl.innerHTML = '<p style="color:var(--text-muted); font-size:0.8rem; padding:10px 0; font-style:italic;">No funds with positive 1-day return today.</p>';
    } else {
        gainers.forEach(x => gainEl.appendChild(buildCard(x.fund, x.r1d)));
    }

    if (losers.length === 0) {
        loseEl.innerHTML = '<p style="color:var(--text-muted); font-size:0.8rem; padding:10px 0; font-style:italic;">No funds with negative 1-day return today.</p>';
    } else {
        losers.forEach(x => loseEl.appendChild(buildCard(x.fund, x.r1d)));
    }

    if (flat.length === 0) {
        flatEl.innerHTML = '<p style="color:var(--text-muted); font-size:0.8rem; padding:10px 0; font-style:italic;">No unchanged funds (or 1-day data not yet available).</p>';
    } else {
        flat.forEach(x => flatEl.appendChild(buildCard(x.fund, x.r1d)));
    }
}

// Render Directory Table Grid
function renderDirectoryTable() {
    const amcFilter = document.getElementById('filter-amc').value;
    const catFilter = document.getElementById('filter-category').value;
    const riskFilter = document.getElementById('filter-risk').value;
    const shariahFilter = document.getElementById('filter-shariah').checked;
    const searchQuery = document.getElementById('global-search').value.toLowerCase().trim();
    const sortVal = document.getElementById('sort-select').value;
    
    const tbody = document.getElementById('directory-tbody');
    tbody.innerHTML = '';

    // Filter Logic
    let filtered = fundsData.filter(fund => {
        // AMC
        if (amcFilter !== 'all' && fund.amc !== amcFilter) return false;
        
        // Category grouping
        if (catFilter !== 'all') {
            if (fund.major_category !== catFilter) return false;
        }

        // Risk Level
        if (riskFilter !== 'all' && fund.risk_level !== riskFilter) return false;

        // Shariah
        if (shariahFilter && !fund.is_shariah) return false;

        // Beat Inflation filter
        if (inflationFilterActive) {
            const r = parseFloatReturn(fund.returns['365d']);
            if (r === null || r <= inflationThreshold) return false;
        }

        // Search Query
        if (searchQuery) {
            const matchesName = fund.fund_name.toLowerCase().includes(searchQuery);
            const matchesAMC = fund.amc.toLowerCase().includes(searchQuery);
            const matchesCat = fund.category.toLowerCase().includes(searchQuery);
            if (!matchesName && !matchesAMC && !matchesCat) return false;
        }

        return true;
    });

    // Sort Logic
    filtered.sort((a, b) => {
        if (sortVal === 'name_asc') {
            return a.fund_name.localeCompare(b.fund_name);
        }
        
        let valA, valB;
        if (sortVal === 'score_desc') {
            valA = parseFloat(a.screener_score) || 0;
            valB = parseFloat(b.screener_score) || 0;
        } else if (sortVal === 'returns_1d_desc') {
            valA = parseFloatReturn(a.returns['1d']) ?? -9999;
            valB = parseFloatReturn(b.returns['1d']) ?? -9999;
        } else if (sortVal === 'returns_ytd_desc') {
            valA = parseFloatReturn(a.returns.ytd) ?? -9999;
            valB = parseFloatReturn(b.returns.ytd) ?? -9999;
        } else if (sortVal === 'returns_365d_desc') {
            valA = parseFloatReturn(a.returns['365d']) ?? -9999;
            valB = parseFloatReturn(b.returns['365d']) ?? -9999;
        } else if (sortVal === 'returns_3y_desc') {
            valA = parseFloatReturn(a.returns['3y']) ?? -9999;
            valB = parseFloatReturn(b.returns['3y']) ?? -9999;
        } else if (sortVal === 'nav_desc') {
            valA = parseFloat(a.nav.replace(/,/g, '')) ?? 0;
            valB = parseFloat(b.nav.replace(/,/g, '')) ?? 0;
        } else if (sortVal === 'ter_asc') {
            valA = parseFloat(a.ter_ytd) || 9999;
            valB = parseFloat(b.ter_ytd) || 9999;
            return valA - valB; // Ascending: lowest to highest
        } else if (sortVal === 'ter_desc') {
            valA = parseFloat(a.ter_ytd) || -9999;
            valB = parseFloat(b.ter_ytd) || -9999;
            return valB - valA; // Descending: highest to lowest
        }
        return valB - valA;
    });

    document.getElementById('filtered-count').innerText = filtered.length;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="12" style="text-align:center; padding: 40px; color: var(--text-muted);">No funds matched your current filters. Clear filters and try searching something else.</td></tr>`;
        return;
    }

    // Render Paginated rows (show top 50 for performance, scroll loads remaining)
    filtered.slice(0, 80).forEach(fund => {
        const tr = document.createElement('tr');
        
        const ytd = parseFloatReturn(fund.returns.ytd);
        const y1d = parseFloatReturn(fund.returns['1d']);
        const y365 = parseFloatReturn(fund.returns['365d']);
        const y3y = parseFloatReturn(fund.returns['3y']);

        const y1dClass = y1d === null ? 'na' : (y1d < 0 ? 'negative' : '');
        const ytdClass = ytd === null ? 'na' : (ytd < 0 ? 'negative' : '');
        const y365Class = y365 === null ? 'na' : (y365 < 0 ? 'negative' : '');
        const y3yClass = y3y === null ? 'na' : (y3y < 0 ? 'negative' : '');

        tr.innerHTML = `
            <td><span style="font-weight:700; color:var(--accent-cyan); font-size:1.05rem;">${fund.screener_score}</span></td>
            <td>
                <div class="fund-td-name" style="cursor:pointer; text-decoration:underline; text-decoration-color:rgba(6, 182, 212, 0.4);" onclick="showFundDetails('${fund.fund_name.replace(/'/g, "\\'")}')">  ${fund.fund_name}</div>
                <div class="fund-td-amc">${fund.amc} ${fund.is_shariah ? '<span class="badge-shariah-tag"><i class="fa-solid fa-mosque"></i> Shariah</span>' : ''}</div>
            </td>
            <td><span style="font-size:0.8rem; color:var(--text-secondary);">${fund.category}</span></td>
            <td><span class="badge-risk ${fund.risk_level.toLowerCase()}">${fund.risk_level}</span></td>
            <td><span style="font-size:0.82rem; font-weight:600; color:var(--accent-gold);">${fund.rating}</span></td>
            <td style="font-weight:600;">Rs. ${parseFloat(fund.nav).toLocaleString()}</td>
            <td style="font-weight:600; color:var(--text-secondary);">${fund.ter_ytd === 'N/A' ? 'N/A' : fund.ter_ytd + '%'}${fund.is_ter_estimated ? '*' : ''}</td>
            <td><span class="return-val ${y1dClass}">${y1d !== null ? (y1d > 0 ? '+' : '') + y1d.toFixed(2) + '%' : 'N/A'}</span></td>
            <td><span class="return-val ${ytdClass}">${ytd !== null ? ytd.toFixed(2) + '%' : 'N/A'}</span></td>
            <td><span class="return-val ${y365Class}">${y365 !== null ? y365.toFixed(2) + '%' : 'N/A'}</span></td>
            <td><span class="return-val ${y3yClass}">${y3y !== null ? y3y.toFixed(2) + '%' : 'N/A'}</span></td>
            <td>
                <div style="display:flex; gap:6px;">
                    <button class="btn-icon" title="Add to Compare" onclick="triggerCompareAddition('${fund.fund_name}')">
                        <i class="fa-solid fa-scale-balanced"></i>
                    </button>
                    <button class="btn-icon" title="Add to Portfolio" onclick="triggerPortfolioAddition('${fund.fund_name}')">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// Trigger comparison select filling from directory list
window.triggerCompareAddition = function(fundName) {
    const sel1 = document.getElementById('compare-select-1');
    const sel2 = document.getElementById('compare-select-2');
    const sel3 = document.getElementById('compare-select-3');

    if (!sel1.value) {
        sel1.value = fundName;
    } else if (!sel2.value) {
        sel2.value = fundName;
    } else {
        sel3.value = fundName;
    }
    
    // Switch to compare tab
    document.getElementById('btn-compare').click();
    updateComparisonWorkspace();
};

// Trigger portfolio addition from directory list
window.triggerPortfolioAddition = function(fundName) {
    document.getElementById('portfolio-fund-select').value = fundName;
    document.getElementById('btn-portfolio').click();
    addFundToPortfolio();
};

// ==========================================================================
// COMPARE LOGIC
// ==========================================================================
function updateComparisonWorkspace() {
    const f1 = document.getElementById('compare-select-1').value;
    const f2 = document.getElementById('compare-select-2').value;
    const f3 = document.getElementById('compare-select-3').value;
    
    const workspace = document.getElementById('compare-workspace');
    
    // Get objects
    const selectedFunds = [f1, f2, f3]
        .filter(name => name !== "")
        .map(name => fundsData.find(fund => fund.fund_name === name));
        
    if (selectedFunds.length === 0) {
        workspace.innerHTML = `
            <div class="no-selection-placeholder">
                <i class="fa-solid fa-scale-unbalanced-flip"></i>
                <p>Please select at least two funds above to start comparing.</p>
            </div>
        `;
        return;
    }

    // Build comparison grid
    let headersHTML = `<th>Performance Metrics</th>`;
    let sectorHTML = `<td><strong>Sector</strong></td>`;
    let amcHTML = `<td><strong>AMC</strong></td>`;
    let categoryHTML = `<td><strong>Category</strong></td>`;
    let riskHTML = `<td><strong>Risk Profile</strong></td>`;
    let ratingHTML = `<td><strong>Rating</strong></td>`;
    let scoreHTML = `<td><strong>Screener Score</strong></td>`;
    let navHTML = `<td><strong>NAV Unit Price</strong></td>`;
    let inceptionHTML = `<td><strong>Inception Date</strong></td>`;
    let loadHTML = `<td><strong>Loads (Front/Back/Contingent)</strong></td>`;
    let terHTML = `<td><strong>Expense Ratio (TER YTD)</strong></td>`;
    let mfHTML = `<td><strong>Management Fee (MF)</strong></td>`;
    let trusteeHTML = `<td><strong>Trustee</strong></td>`;
    
    // Returns rows
    let r1dHTML = `<td><strong>1 Day Return</strong></td>`;
    let r30dHTML = `<td><strong>30 Days Return</strong></td>`;
    let rYtdHTML = `<td><strong>YTD Return</strong></td>`;
    let r1yHTML = `<td><strong>365 Days (1 Yr)</strong></td>`;
    let r2yHTML = `<td><strong>2 Years Return</strong></td>`;
    let r3yHTML = `<td><strong>3 Years Return</strong></td>`;

    selectedFunds.forEach(fund => {
        headersHTML += `<th class="compare-col-header">${fund.fund_name}</th>`;
        sectorHTML += `<td class="compare-val">${fund.sector}</td>`;
        amcHTML += `<td class="compare-val">${fund.amc}</td>`;
        categoryHTML += `<td class="compare-val">${fund.category}</td>`;
        riskHTML += `<td class="compare-val"><span class="badge-risk ${fund.risk_level.toLowerCase()}">${fund.risk_level}</span></td>`;
        ratingHTML += `<td class="compare-val" style="color:var(--accent-gold); font-weight:700;">${fund.rating}</td>`;
        scoreHTML += `<td class="compare-val highlight" style="color:var(--accent-cyan); font-weight:800;">${fund.screener_score}/100</td>`;
        navHTML += `<td class="compare-val highlight" style="font-weight:700;">Rs. ${fund.nav}</td>`;
        inceptionHTML += `<td class="compare-val">${fund.inception_date}</td>`;
        loadHTML += `<td class="compare-val">${fund.front_end_load}% / ${fund.back_end_load}% / ${fund.contingent_load}%</td>`;
        terHTML += `<td class="compare-val">${fund.ter_ytd === 'N/A' ? 'N/A' : fund.ter_ytd + '%'}${fund.is_ter_estimated ? '*' : ''}</td>`;
        mfHTML += `<td class="compare-val">${fund.management_fee === 'N/A' ? 'N/A' : fund.management_fee + '%'}</td>`;
        trusteeHTML += `<td class="compare-val">${fund.trustee}</td>`;

        const renderReturnValCell = (valStr) => {
            const valNum = parseFloatReturn(valStr);
            if (valNum === null) return `<td class="compare-val" style="color:var(--text-muted);">N/A</td>`;
            const colorClass = valNum < 0 ? 'color: var(--accent-red);' : 'color: var(--accent-green); font-weight:700;';
            return `<td class="compare-val highlight" style="${colorClass}">${valNum.toFixed(2)}%</td>`;
        };

        r1dHTML += renderReturnValCell(fund.returns['1d']);
        r30dHTML += renderReturnValCell(fund.returns['30d']);
        rYtdHTML += renderReturnValCell(fund.returns.ytd);
        r1yHTML += renderReturnValCell(fund.returns['365d']);
        r2yHTML += renderReturnValCell(fund.returns['2y']);
        r3yHTML += renderReturnValCell(fund.returns['3y']);
    });

    workspace.innerHTML = `
        <table class="compare-table">
            <thead>
                <tr>${headersHTML}</tr>
            </thead>
            <tbody>
                <tr>${amcHTML}</tr>
                <tr>${categoryHTML}</tr>
                <tr>${riskHTML}</tr>
                <tr>${ratingHTML}</tr>
                <tr>${scoreHTML}</tr>
                <tr>${navHTML}</tr>
                <tr>${inceptionHTML}</tr>
                <tr>${loadHTML}</tr>
                <tr>${terHTML}</tr>
                <tr>${mfHTML}</tr>
                <tr>${trusteeHTML}</tr>
                <tr>${sectorHTML}</tr>
                <tr style="border-top: 2px solid var(--border-color);"><td colspan="${selectedFunds.length + 1}" style="font-weight:700; padding:10px 20px; font-size:0.75rem; text-transform:uppercase; color:var(--text-secondary);">Returns & Historical Yields</td></tr>
                <tr>${r1dHTML}</tr>
                <tr>${r30dHTML}</tr>
                <tr>${rYtdHTML}</tr>
                <tr>${r1yHTML}</tr>
                <tr>${r2yHTML}</tr>
                <tr>${r3yHTML}</tr>
            </tbody>
        </table>
    `;
}

// ==========================================================================
// PORTFOLIO BUILDER LOGIC
// ==========================================================================
function addFundToPortfolio() {
    const select = document.getElementById('portfolio-fund-select');
    const fundName = select.value;
    if (!fundName) return;

    // Check if already exists
    if (portfolioItems.some(item => item.fund_name === fundName)) {
        alert("This fund is already added to your allocation portfolio.");
        return;
    }

    portfolioItems.push({
        fund_name: fundName,
        weight: 0
    });

    // Auto balance weights if we have space or set remaining to 100
    redistributePortfolioWeights();
    renderPortfolioList();
    updatePortfolioAnalytics();
}

function redistributePortfolioWeights() {
    const count = portfolioItems.length;
    if (count === 0) return;
    const baseWeight = Math.floor(100 / count);
    let total = 0;
    
    portfolioItems.forEach((item, idx) => {
        if (idx === count - 1) {
            item.weight = 100 - total; // Remaining balance to equal exactly 100
        } else {
            item.weight = baseWeight;
            total += baseWeight;
        }
    });
}

function deletePortfolioItem(idx) {
    portfolioItems.splice(idx, 1);
    redistributePortfolioWeights();
    renderPortfolioList();
    updatePortfolioAnalytics();
}

function renderPortfolioList() {
    const listContainer = document.getElementById('portfolio-items-list');
    listContainer.innerHTML = '';
    
    if (portfolioItems.length === 0) {
        listContainer.innerHTML = `
            <div class="empty-portfolio-note">
                <i class="fa-solid fa-wallet"></i>
                <p>No funds added. Select a fund from the dropdown above to construct your asset portfolio.</p>
            </div>
        `;
        return;
    }

    portfolioItems.forEach((item, idx) => {
        const fundObj = fundsData.find(f => f.fund_name === item.fund_name);
        const div = document.createElement('div');
        div.className = 'portfolio-item';
        div.innerHTML = `
            <div class="p-item-header">
                <div class="p-item-title">
                    <span class="p-item-name">${item.fund_name}</span>
                    <div class="p-item-cat">${fundObj.category} | Risk: ${fundObj.risk_level}</div>
                </div>
                <button class="p-item-delete" onclick="deletePortfolioItem(${idx})"><i class="fa-solid fa-trash-can"></i></button>
            </div>
            <div class="p-item-control">
                <input type="range" class="p-item-slider" min="0" max="100" value="${item.weight}" oninput="updateItemWeight(${idx}, this.value)">
                <span class="p-item-weight-display">${item.weight}%</span>
            </div>
        `;
        listContainer.appendChild(div);
    });
}

window.updateItemWeight = function(idx, val) {
    portfolioItems[idx].weight = parseInt(val);
    
    // Update display labels directly for speed
    const displays = document.querySelectorAll('.p-item-weight-display');
    if (displays[idx]) {
        displays[idx].innerText = val + '%';
    }
    
    updatePortfolioAnalytics();
};

function updatePortfolioAnalytics() {
    let totalAlloc = 0;
    let weightedYTD = 0;
    let weighted1Y = 0;
    let highRiskWeight = 0;
    let lowRiskWeight = 0;
    let medRiskWeight = 0;

    portfolioItems.forEach(item => {
        totalAlloc += item.weight;
        const fundObj = fundsData.find(f => f.fund_name === item.fund_name);
        
        const ytd = parseFloatReturn(fundObj.returns.ytd) ?? 0;
        const y1y = parseFloatReturn(fundObj.returns['365d']) ?? 0;

        weightedYTD += ytd * (item.weight / 100);
        weighted1Y += y1y * (item.weight / 100);

        if (fundObj.risk_level === 'High') highRiskWeight += item.weight;
        else if (fundObj.risk_level === 'Low') lowRiskWeight += item.weight;
        else medRiskWeight += item.weight;
    });

    const allocBar = document.getElementById('portfolio-alloc-total');
    allocBar.innerText = totalAlloc + '%';
    
    const progressFill = document.getElementById('portfolio-progress-fill');
    progressFill.style.width = Math.min(totalAlloc, 100) + '%';

    if (totalAlloc === 100) {
        allocBar.className = "allocation-value valid";
        progressFill.style.backgroundColor = "var(--accent-green)";
    } else {
        allocBar.className = "allocation-value warning";
        progressFill.style.backgroundColor = "var(--accent-cyan)";
    }

    // Display Weighted Returns
    if (portfolioItems.length > 0) {
        document.getElementById('portfolio-weighted-ytd').innerText = weightedYTD.toFixed(2) + '%';
        document.getElementById('portfolio-weighted-1y').innerText = weighted1Y.toFixed(2) + '%';
        
        // Overall Risk class determine
        let riskClass = "Medium";
        if (highRiskWeight > 50) riskClass = "High (Aggressive)";
        else if (lowRiskWeight > 60) riskClass = "Low (Conservative)";
        else riskClass = "Medium (Moderate)";
        
        document.getElementById('portfolio-risk-profile').innerText = riskClass;

        // Run scenario projection
        const principal = parseFloat(document.getElementById('portfolio-sim-amount').value) || 0;
        const simYield = weightedYTD / 100;
        const projectedValue = principal * (1 + simYield);
        
        document.getElementById('portfolio-sim-result').innerText = "Rs. " + Math.round(projectedValue).toLocaleString();
    } else {
        document.getElementById('portfolio-weighted-ytd').innerText = "--%";
        document.getElementById('portfolio-weighted-1y').innerText = "--%";
        document.getElementById('portfolio-risk-profile').innerText = "--";
        document.getElementById('portfolio-sim-result').innerText = "Rs. --";
    }

    updatePortfolioChart();
}

function updatePortfolioChart() {
    const ctx = document.getElementById('portfolio-pie-chart').getContext('2d');
    
    // Destroy existing instance if it exists
    if (portfolioChartInstance) {
        portfolioChartInstance.destroy();
    }

    if (portfolioItems.length === 0) return;

    const labels = portfolioItems.map(item => {
        // Truncate name
        return item.fund_name.length > 20 ? item.fund_name.substring(0, 20) + '...' : item.fund_name;
    });
    const data = portfolioItems.map(item => item.weight);
    
    const colors = [
        'rgba(6, 182, 212, 0.7)',
        'rgba(16, 185, 129, 0.7)',
        'rgba(245, 158, 11, 0.7)',
        'rgba(139, 92, 246, 0.7)',
        'rgba(59, 130, 246, 0.7)',
        'rgba(239, 68, 68, 0.7)'
    ];

    portfolioChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: colors.slice(0, portfolioItems.length),
                borderColor: '#10141f',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#9ca3af',
                        font: { size: 9, family: 'Inter' }
                    }
                }
            }
        }
    });
}

// ==========================================================================
// CALC GROWTH SIMULATOR LOGIC
// ==========================================================================
function prefillExpectedReturn() {
    const fundName = document.getElementById('calc-fund').value;
    const fundObj = fundsData.find(f => f.fund_name === fundName);
    if (fundObj) {
        // Prefill expected return using 365d yield if numeric, fallback to YTD
        let expected = parseFloatReturn(fundObj.returns['365d']) || parseFloatReturn(fundObj.returns.ytd) || 12.0;
        if (expected <= 0) expected = 12.0;
        document.getElementById('calc-expected-return').value = expected.toFixed(1);
    }
}

function calculateGrowth() {
    const initial = parseFloat(document.getElementById('calc-initial').value) || 0;
    const monthly = parseFloat(document.getElementById('calc-monthly').value) || 0;
    const years = parseInt(document.getElementById('calc-years').value) || 5;
    const annualReturn = parseFloat(document.getElementById('calc-expected-return').value) || 0;

    const months = years * 12;
    const r = (annualReturn / 100) / 12; // Monthly rate

    let totalContribution = initial;
    let balance = initial;
    
    // Datasets for chart
    let contributionsArr = [initial];
    let futureValuesArr = [initial];
    let labelsArr = ['Start'];

    for (let month = 1; month <= months; month++) {
        balance = balance * (1 + r) + monthly;
        totalContribution += monthly;
        
        // Push annually
        if (month % 12 === 0) {
            labelsArr.push('Yr ' + (month / 12));
            contributionsArr.push(totalContribution);
            futureValuesArr.push(Math.round(balance));
        }
    }

    // Display summary numbers
    document.getElementById('calc-total-invested').innerText = "Rs. " + Math.round(totalContribution).toLocaleString();
    document.getElementById('calc-future-value').innerText = "Rs. " + Math.round(balance).toLocaleString();
    document.getElementById('calc-profit-earned').innerText = "Rs. " + Math.round(balance - totalContribution).toLocaleString();

    // Render Chart
    const ctx = document.getElementById('calc-growth-chart').getContext('2d');
    if (calcChartInstance) {
        calcChartInstance.destroy();
    }

    calcChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labelsArr,
            datasets: [
                {
                    label: 'Invested Capital',
                    data: contributionsArr,
                    borderColor: 'rgba(156, 163, 175, 0.8)',
                    backgroundColor: 'rgba(156, 163, 175, 0.1)',
                    fill: true,
                    tension: 0.2
                },
                {
                    label: 'Projected Portfolio Value',
                    data: futureValuesArr,
                    borderColor: 'rgba(6, 182, 212, 1)',
                    backgroundColor: 'rgba(6, 182, 212, 0.15)',
                    fill: true,
                    tension: 0.2
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: '#9ca3af', font: { family: 'Inter' } }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#9ca3af', font: { family: 'Inter' } }
                },
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: {
                        color: '#9ca3af',
                        font: { family: 'Inter' },
                        callback: function(value) {
                            return 'Rs. ' + (value >= 1e5 ? (value / 1e5).toFixed(1) + ' Lac' : value.toLocaleString());
                        }
                    }
                }
            }
        }
    });
}

let modalChartInstance = null;
let _currentModalFund = null;

window.showFundDetails = function(fundName) {
    const fund = fundsData.find(f => f.fund_name === fundName);
    if (!fund) return;
    _currentModalFund = fund;

    // Fill textual details
    document.getElementById('modal-fund-name').innerText = fund.fund_name;
    document.getElementById('modal-fund-amc').innerText = fund.amc;
    
    const shariahEl = document.getElementById('modal-fund-shariah');
    if (fund.is_shariah) {
        shariahEl.style.display = 'inline-flex';
    } else {
        shariahEl.style.display = 'none';
    }

    document.getElementById('modal-category').innerText = fund.category;
    document.getElementById('modal-risk').innerHTML = `<span class="badge-risk ${fund.risk_level.toLowerCase()}">${fund.risk_level}</span>`;
    document.getElementById('modal-rating').innerText = fund.rating;
    document.getElementById('modal-nav').innerText = `Rs. ${fund.nav}`;
    document.getElementById('modal-date').innerText = fund.validity_date;
    document.getElementById('modal-inception').innerText = fund.inception_date;
    document.getElementById('modal-m-fee').innerText = fund.management_fee === 'N/A' ? 'N/A' : fund.management_fee + '%';
    document.getElementById('modal-ter-ytd').innerHTML = fund.ter_ytd === 'N/A' ? 'N/A' : (fund.ter_ytd + '%' + (fund.is_ter_estimated ? ' <span style="font-size:0.75rem; color:var(--text-muted); font-style:italic;">(Estimated due to AMC reset)</span>' : ''));
    document.getElementById('modal-loads').innerText = `Front: ${fund.front_end_load}% / Back: ${fund.back_end_load}% / Contingent: ${fund.contingent_load}%`;
    document.getElementById('modal-trustee').innerText = fund.trustee;
    document.getElementById('modal-score').innerText = `${fund.screener_score} / 100`;

    // --- Estimated Today's NAV ---
    const estNavEl = document.getElementById('modal-est-nav');
    if (estNavEl) {
        const navNum = parseFloat(String(fund.nav).replace(/,/g, ''));
        const cat = (fund.major_category || '').toLowerCase();
        let estNav = null;
        let basisNote = '';
        let kseChangePct = 0;

        // Parse KSE-100 change from stored psxIndexData
        if (psxIndexData && psxIndexData.change_percent) {
            const raw = parseFloat(String(psxIndexData.change_percent).replace('%', '').replace(/,/g, ''));
            kseChangePct = (psxIndexData.direction === '+' ? 1 : -1) * Math.abs(raw);
        }

        if (cat.includes('equity') || cat.includes('stock')) {
            // Equity: ~85% beta to KSE-100 (typical for Pakistan equity funds)
            const beta = 0.85;
            estNav = navNum * (1 + (kseChangePct * beta) / 100);
            basisNote = `KSE-100 is ${kseChangePct >= 0 ? '+' : ''}${kseChangePct.toFixed(2)}% today → ~85% of that applied`;
        } else if (cat.includes('balanced') || cat.includes('asset alloc')) {
            // Balanced: ~40% equity exposure
            estNav = navNum * (1 + (kseChangePct * 0.40) / 100);
            basisNote = `KSE-100 is ${kseChangePct >= 0 ? '+' : ''}${kseChangePct.toFixed(2)}% today → ~40% equity exposure applied`;
        } else if (cat.includes('money market') || cat.includes('income') || cat.includes('fixed') || cat.includes('cash')) {
            // Fixed income: one day's yield from 1-year return
            const annualR = parseFloatReturn(fund.returns['365d']) || parseFloatReturn(fund.returns.ytd) || 10;
            const dailyR = annualR / 36500;
            estNav = navNum * (1 + dailyR);
            basisNote = `~1 day accrual on ${annualR.toFixed(1)}% annual yield`;
        }

        if (estNav !== null && !isNaN(estNav) && navNum > 0) {
            const diff = estNav - navNum;
            const diffPct = (diff / navNum) * 100;
            const isUp = diff >= 0;
            const arrow = isUp ? '▲' : '▼';
            const colorClass = isUp ? 'est-nav-up' : 'est-nav-down';
            estNavEl.innerHTML = `
                <div class="est-nav-box ${colorClass}">
                    <div class="est-nav-price">${arrow} Rs. ${estNav.toFixed(4)}</div>
                    <div class="est-nav-delta">${isUp ? '+' : ''}${diff.toFixed(4)} (${isUp ? '+' : ''}${diffPct.toFixed(2)}%)</div>
                    <div class="est-nav-basis">${basisNote}</div>
                    <div class="est-nav-disclaimer">⚠ Estimate only. Place order before 3:00 PM to get today's official NAV.</div>
                </div>`;
        } else {
            estNavEl.innerHTML = `<span style="color:var(--text-muted); font-size:0.8rem; font-style:italic;">Not enough data to estimate</span>`;
        }
    }

    // Populate Dividend History
    const divSection = document.getElementById('modal-dividends-section');
    const divBody = document.getElementById('modal-dividends-tbody');
    const dividends = fund.dividends || [];
    if (dividends.length > 0) {
        divBody.innerHTML = dividends.map(d => `
            <tr>
                <td>${d.date || 'N/A'}</td>
                <td style="font-weight:600; color:var(--accent-cyan);">Rs. ${d.payout_per_unit}</td>
                <td>${d.ex_nav !== 'N/A' ? 'Rs. ' + d.ex_nav : 'N/A'}</td>
            </tr>`).join('');
        if (divSection) divSection.style.display = 'block';
    } else {
        if (divSection) divSection.style.display = 'none';
    }

    // Setup add-to-portfolio button click in modal
    const addBtn = document.getElementById('modal-btn-add-portfolio');
    addBtn.onclick = () => {
        triggerPortfolioAddition(fund.fund_name);
        document.getElementById('fund-details-modal').style.display = 'none';
    };

    // Show modal
    document.getElementById('fund-details-modal').style.display = 'block';

    // Default to projected chart
    switchModalChart('projected');
};

window.switchModalChart = function(mode) {
    const fund = _currentModalFund;
    if (!fund) return;

    const projBtn = document.getElementById('modal-chart-btn-projected');
    const histBtn = document.getElementById('modal-chart-btn-historical');
    const chartNote = document.getElementById('modal-chart-note');
    const chartTitle = document.getElementById('modal-chart-title');

    if (projBtn) projBtn.classList.toggle('active', mode === 'projected');
    if (histBtn) histBtn.classList.toggle('active', mode === 'historical');

    const archiveEntries = navArchive[fund.fund_name] || [];

    if (mode === 'historical' && archiveEntries.length >= 2) {
        // Plot real NAV archive data
        if (chartTitle) chartTitle.textContent = 'NAV Price History';
        if (chartNote) chartNote.textContent = `Showing ${archiveEntries.length} day(s) of archived NAV data. Archive grows daily each time the scraper runs.`;
        const labels = archiveEntries.map(e => e.date);
        const values = archiveEntries.map(e => parseFloat(e.nav));
        _renderModalChart(labels, values, 'NAV (Rs.)', 'rgba(16, 185, 129, 1)', 'rgba(16, 185, 129, 0.1)', v => 'Rs. ' + parseFloat(v).toFixed(4));
    } else if (mode === 'historical') {
        // Not enough archive data — fall back to trailing returns curve
        if (chartNote) chartNote.textContent = 'NAV archive is building. Run the daily scraper to accumulate data. Showing trailing returns approximation.';
        _renderTrailingReturnsChart(fund, chartTitle, chartNote);
    } else {
        // Projected mode
        _renderTrailingReturnsChart(fund, chartTitle, chartNote);
    }
};

function _renderTrailingReturnsChart(fund, chartTitle, chartNote) {
    if (chartTitle) chartTitle.textContent = '5-Year Growth Performance (Rs. 100)';
    if (chartNote) chartNote.textContent = '*Projected growth using trailing annualized returns. Years 4–5 use 3-year CAGR.';

    const base = 100;
    const r1 = parseFloatReturn(fund.returns['365d']);
    const r2 = parseFloatReturn(fund.returns['2y']);
    const r3 = parseFloatReturn(fund.returns['3y']);

    let cagr = 0.10;
    if (r3 !== null && r3 > 0) cagr = r3 / 100;
    else if (r2 !== null && r2 > 0) cagr = r2 / 100;
    else if (r1 !== null && r1 > 0) cagr = r1 / 100;

    const y0 = base;
    const y1 = r1 !== null ? base * (1 + r1/100) : base * (1 + cagr);
    const y2 = r2 !== null ? base * Math.pow(1 + r2/100, 2) : base * Math.pow(1 + cagr, 2);
    const y3 = r3 !== null ? base * Math.pow(1 + r3/100, 3) : base * Math.pow(1 + cagr, 3);
    const y4 = base * Math.pow(1 + cagr, 4);
    const y5 = base * Math.pow(1 + cagr, 5);

    const now = new Date().getFullYear();
    const labels = [now-5, now-4, now-3, now-2, now-1, now].map(String);
    const values = [y0, y1, y2, y3, y4, y5].map(Math.round);
    _renderModalChart(labels, values, 'Asset Value (Rs.)', 'rgba(6, 182, 212, 1)', 'rgba(6, 182, 212, 0.12)', v => 'Rs. ' + v);
}

function _renderModalChart(labels, values, label, borderColor, bgColor, tickFormatter) {
    const ctx = document.getElementById('modal-performance-chart').getContext('2d');
    if (modalChartInstance) modalChartInstance.destroy();
    modalChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label,
                data: values,
                borderColor,
                backgroundColor: bgColor,
                fill: true,
                tension: 0.3,
                borderWidth: 3,
                pointBackgroundColor: borderColor,
                pointRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#9ca3af', font: { family: 'Inter', size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: {
                        color: '#9ca3af',
                        font: { family: 'Inter', size: 10 },
                        callback: tickFormatter
                    }
                }
            }
        }
    });
}


function updateKSE100Card(psxData) {
    if (!psxData) return;
    const priceEl = document.getElementById('kse100-price');
    const changeEl = document.getElementById('kse100-change');
    if (priceEl && changeEl) {
        priceEl.innerText = psxData.price;
        const color = psxData.direction === '+' ? 'var(--accent-green)' : 'var(--accent-red)';
        const arrow = psxData.direction === '+' ? '<i class="fa-solid fa-arrow-trend-up"></i>' : '<i class="fa-solid fa-arrow-trend-down"></i>';
        changeEl.innerHTML = `<span style="color:${color}; font-weight:700;">${arrow} ${psxData.direction}${psxData.change_points} (${psxData.change_percent})</span> <span style="color:var(--text-muted); font-size:0.68rem; margin-left:6px;">As of ${psxData.as_of}</span>`;
    }

    // --- Good Day to Invest? Signal Banner ---
    const banner = document.getElementById('invest-signal-banner');
    if (!banner) return;

    const rawPct = parseFloat(String(psxData.change_percent).replace('%','').replace(/,/g,'')) || 0;
    const changePct = (psxData.direction === '+' ? 1 : -1) * Math.abs(rawPct);
    const kseValEl  = document.getElementById('invest-signal-kse-val');
    const iconEl    = document.getElementById('invest-signal-icon');
    const verdictEl = document.getElementById('invest-signal-verdict');
    const subEl     = document.getElementById('invest-signal-sub');
    const tipEl     = document.getElementById('invest-signal-tip');

    if (kseValEl) kseValEl.textContent = `${psxData.direction}${psxData.change_points} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`;

    let tier, icon, verdict, sub, tip, bannerClass;

    if (changePct <= -2) {
        tier = 'great';
        icon = '🟢';
        verdict = 'Great Day to Invest in Equity Funds';
        sub = `KSE-100 is down ${Math.abs(changePct).toFixed(2)}% — fund NAVs will likely be significantly cheaper tonight.`;
        tip = 'Place your order before 3:00 PM to lock in tonight\'s discounted NAV. More units for the same money.';
        bannerClass = 'signal-great';
    } else if (changePct <= -0.5) {
        tier = 'good';
        icon = '🟡';
        verdict = 'Good Day to Invest in Equity Funds';
        sub = `KSE-100 is down ${Math.abs(changePct).toFixed(2)}% — equity fund NAVs will be slightly lower tonight.`;
        tip = 'A mild dip — still a favourable entry if you were planning to invest anyway. Cutoff: 3:00 PM.';
        bannerClass = 'signal-good';
    } else if (changePct < 0.5) {
        tier = 'neutral';
        icon = '⚪';
        verdict = 'Neutral Day — No Clear Advantage';
        sub = `KSE-100 is nearly flat (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%). NAVs will be close to yesterday's.`;
        tip = 'No significant timing edge today. Good day for Money Market or Income fund investments.';
        bannerClass = 'signal-neutral';
    } else if (changePct < 2) {
        tier = 'caution';
        icon = '🟠';
        verdict = 'Market Up — Slightly Higher Entry Today';
        sub = `KSE-100 is up ${changePct.toFixed(2)}% — equity fund NAVs will be higher tonight than yesterday.`;
        tip = 'Consider waiting for a dip, or invest in a Money Market fund today to park funds safely.';
        bannerClass = 'signal-caution';
    } else {
        tier = 'wait';
        icon = '🔴';
        verdict = 'Strong Rally — Consider Waiting';
        sub = `KSE-100 is up ${changePct.toFixed(2)}% — equity NAVs will be significantly higher tonight.`;
        tip = 'You\'d be buying at a premium vs yesterday. Unless you\'re investing long-term and not timing, consider waiting for a pullback.';
        bannerClass = 'signal-wait';
    }

    banner.className = `invest-signal-banner ${bannerClass}`;
    if (iconEl)    iconEl.textContent    = icon;
    if (verdictEl) verdictEl.textContent = verdict;
    if (subEl)     subEl.textContent     = sub;
    if (tipEl)     tipEl.textContent     = tip;
    if (kseValEl)  kseValEl.style.color  = changePct >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
    banner.style.display = 'flex';
}


function renderPSXMovers(perfData) {
    if (!perfData) return;
    
    const categories = ['active', 'gainers', 'losers'];
    categories.forEach(cat => {
        const listEl = document.getElementById(`psx-${cat}-list`);
        if (!listEl) return;
        
        listEl.innerHTML = '';
        const items = perfData[cat] || [];
        
        if (items.length === 0) {
            listEl.innerHTML = '<p style="color:var(--text-muted); font-size:0.8rem; font-style:italic; padding: 10px 0;">No active trading data available</p>';
            return;
        }
        
        items.forEach(item => {
            const card = document.createElement('div');
            card.className = 'mini-fund-card';
            card.style.cursor = 'default';
            
            const isPos = item.direction === '+';
            const isNeg = item.direction === '-';
            const color = isPos ? 'var(--accent-green)' : (isNeg ? 'var(--accent-red)' : 'var(--text-muted)');
            const sign = isPos ? '+' : '';
            
            card.innerHTML = `
                <div class="m-fund-info" style="max-width: 65%;">
                    <h4 style="margin:0 0 2px 0; font-size:0.85rem; font-weight:700; color:var(--text-primary);">${item.symbol}</h4>
                    <span style="font-size:0.7rem; color:var(--text-muted); display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${item.name}">${item.name}</span>
                </div>
                <div class="m-fund-stats" style="text-align:right;">
                    <div style="font-weight:700; font-size:0.85rem; color:var(--text-primary);">Rs. ${item.price}</div>
                    <div style="font-size:0.7rem; font-weight:700; color:${color};">${sign}${item.change} (${item.percent})</div>
                    ${cat === 'active' ? `<div style="font-size:0.6rem; color:var(--text-muted); margin-top:2px;">Vol: ${parseFloat(item.volume.replace(/,/g, '')).toLocaleString()}</div>` : ''}
                </div>
            `;
            listEl.appendChild(card);
        });
    });
}

// ==========================================================================
// MY INVESTMENTS — P&L TRACKER
// ==========================================================================
function loadInvestmentsFromStorage() {
    try {
        const stored = localStorage.getItem('pakfund_investments');
        if (stored) {
            investmentEntries = JSON.parse(stored);
            renderInvestmentsTable();
        }
    } catch (e) {
        investmentEntries = [];
    }
}

function saveInvestmentsToStorage() {
    localStorage.setItem('pakfund_investments', JSON.stringify(investmentEntries));
}

function addInvestmentEntry() {
    const fundSelect = document.getElementById('inv-fund-select');
    const dateInput = document.getElementById('inv-date');
    const amountInput = document.getElementById('inv-amount');
    const unitsInput = document.getElementById('inv-units');

    const fundName = fundSelect.value;
    const date = dateInput.value;
    const amount = parseFloat(amountInput.value);
    const unitsManual = parseFloat(unitsInput.value);

    if (!fundName || !date || !amount || amount <= 0) {
        alert('Please select a fund, a date, and a valid investment amount.');
        return;
    }

    const fund = fundsData.find(f => f.fund_name === fundName);
    const currentNav = fund ? parseFloat(fund.nav) : null;
    const units = (unitsManual > 0) ? unitsManual : (currentNav ? amount / currentNav : null);

    investmentEntries.push({ id: Date.now(), fund_name: fundName, date, amount_invested: amount, units });
    saveInvestmentsToStorage();
    renderInvestmentsTable();

    fundSelect.value = '';
    dateInput.value = '';
    amountInput.value = '';
    if (unitsInput) unitsInput.value = '';
}

function renderInvestmentsTable() {
    const tbody = document.getElementById('investments-tbody');
    const summaryBar = document.getElementById('investment-summary-bar');
    if (!tbody) return;

    if (investmentEntries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; color:var(--text-muted); padding:24px; font-style:italic;">No investment entries yet. Log your first entry above.</td></tr>';
        if (summaryBar) summaryBar.style.display = 'none';
        return;
    }

    const today = new Date();
    let totalInvested = 0, totalCurrentValue = 0;
    let rows = '';

    investmentEntries.forEach(entry => {
        const fund = fundsData.find(f => f.fund_name === entry.fund_name);
        const currentNav = fund ? parseFloat(fund.nav) : null;
        const units = entry.units;
        const currentValue = (currentNav && units) ? currentNav * units : null;
        const pnl = currentValue !== null ? currentValue - entry.amount_invested : null;
        const returnPct = pnl !== null ? (pnl / entry.amount_invested) * 100 : null;
        const daysHeld = Math.floor((today - new Date(entry.date)) / 86400000);

        totalInvested += entry.amount_invested;
        if (currentValue !== null) totalCurrentValue += currentValue;

        const pnlClass = pnl === null ? '' : (pnl >= 0 ? 'pnl-positive' : 'pnl-negative');
        const sign = pnl !== null && pnl > 0 ? '+' : '';
        const fmt = n => n.toLocaleString('en-PK', { maximumFractionDigits: 0 });

        rows += `<tr>
            <td style="font-weight:600; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${entry.fund_name}">${entry.fund_name}</td>
            <td>${entry.date}</td>
            <td>Rs. ${fmt(entry.amount_invested)}</td>
            <td>${units ? units.toLocaleString('en-PK', {minimumFractionDigits:3, maximumFractionDigits:3}) : 'N/A'}</td>
            <td>${currentNav ? 'Rs. ' + currentNav.toFixed(4) : 'N/A'}</td>
            <td>${currentValue ? 'Rs. ' + fmt(currentValue) : 'N/A'}</td>
            <td class="${pnlClass}">${pnl !== null ? sign + 'Rs. ' + fmt(Math.abs(pnl)) : 'N/A'}</td>
            <td class="${pnlClass}">${returnPct !== null ? sign + returnPct.toFixed(2) + '%' : 'N/A'}</td>
            <td>${daysHeld}d</td>
            <td><button class="inv-delete-btn" onclick="deleteInvestmentEntry(${entry.id})" title="Remove"><i class="fa-solid fa-trash-can"></i></button></td>
        </tr>`;
    });

    tbody.innerHTML = rows;

    const totalPnl = totalCurrentValue - totalInvested;
    const pnlClass = totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
    const sign = totalPnl >= 0 ? '+' : '';
    const fmt = n => n.toLocaleString('en-PK', { maximumFractionDigits: 0 });

    document.getElementById('investments-total-invested').textContent = 'Rs. ' + fmt(totalInvested);
    document.getElementById('investments-current-value').textContent = totalCurrentValue > 0 ? 'Rs. ' + fmt(totalCurrentValue) : 'N/A';
    const pnlEl = document.getElementById('investments-total-pnl');
    pnlEl.textContent = totalCurrentValue > 0 ? sign + 'Rs. ' + fmt(Math.abs(totalPnl)) : 'N/A';
    pnlEl.className = 'inv-s-value ' + (totalCurrentValue > 0 ? pnlClass : '');
    if (summaryBar) summaryBar.style.display = 'flex';
}

window.deleteInvestmentEntry = function(id) {
    investmentEntries = investmentEntries.filter(e => e.id !== id);
    saveInvestmentsToStorage();
    renderInvestmentsTable();
};
