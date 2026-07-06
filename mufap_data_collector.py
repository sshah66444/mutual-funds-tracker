import urllib.request
import ssl
import json
import os
from html.parser import HTMLParser
import re

class TableParser(HTMLParser):
    def __init__(self, target_id):
        super().__init__()
        self.target_id = target_id
        self.in_target_table = False
        self.table_depth = 0
        self.rows = []
        self.current_row = []
        self.current_cell = []
        self.in_cell = False
        self.cell_attrs = {}

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag == 'table':
            if attrs_dict.get('id') == self.target_id:
                self.in_target_table = True
                self.table_depth = 1
            elif self.in_target_table:
                self.table_depth += 1
        
        if self.in_target_table:
            if tag == 'tr':
                self.current_row = []
            elif tag in ('td', 'th'):
                self.in_cell = True
                self.current_cell = []
                self.cell_attrs = attrs_dict

    def handle_endtag(self, tag):
        if tag == 'table' and self.in_target_table:
            self.table_depth -= 1
            if self.table_depth == 0:
                self.in_target_table = False
        
        if self.in_target_table:
            if tag == 'tr':
                self.rows.append(self.current_row)
            elif tag in ('td', 'th'):
                cell_text = "".join(self.current_cell).strip()
                self.current_row.append(cell_text)
                self.in_cell = False

    def handle_data(self, data):
        if self.in_target_table and self.in_cell:
            self.current_cell.append(data)

def clean_value(val):
    if not val:
        return "N/A"
    val = val.strip()
    if val.upper() in ("N/A", "N/A*", "NIL", "NULL", "-", ""):
        return "N/A"
    return val

def to_float(value):
    if not value or value == "N/A":
        return None
    try:
        # Strip percentage signs and commas
        cleaned = value.replace("%", "").replace(",", "").strip()
        if cleaned.startswith("(") and cleaned.endswith(")"):
            cleaned = "-" + cleaned[1:-1]
        return float(cleaned)
    except ValueError:
        return None

def sanitize_return(val_str):
    if not val_str or val_str == "N/A":
        return "N/A"
    val_float = to_float(val_str)
    if val_float is None:
        return "N/A"
    # Filter out anomalous returns (> 150% or < -100%)
    if val_float < -100.0 or val_float > 150.0:
        return "N/A"
    return f"{val_float:.2f}"

def classify_risk(category_lower, fund_name_lower):
    if any(x in category_lower for x in ["money market", "cash", "treasury", "short term", "t-bill"]):
        return "Low"
    elif any(x in category_lower for x in ["equity", "index", "sector", "dedicated", "asset allocation", "balanced"]):
        return "High"
    elif any(x in category_lower for x in ["income", "debt", "sovereign", "government", "fixed rate", "capital protected"]):
        return "Medium"
    if any(x in fund_name_lower for x in ["equity", "index", "stock"]):
        return "High"
    elif any(x in fund_name_lower for x in ["cash", "money market"]):
        return "Low"
    return "Medium"

def classify_major_category(category_lower, fund_name_lower):
    # Pension
    if any(x in category_lower or x in fund_name_lower for x in ["pension", "vps"]):
        return "Pension"
    # Stock
    if any(x in category_lower for x in ["equity", "index", "sector", "dedicated"]):
        return "Stock"
    # Money Market
    elif any(x in category_lower for x in ["money market", "cash", "treasury", "short term", "t-bill"]):
        return "Money Market"
    # Income
    elif any(x in category_lower for x in ["income", "debt", "sovereign", "government", "fixed rate", "capital protected"]):
        return "Income"
    # Assets / Fallback
    return "Assets"

def fetch_table(url):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    req = urllib.request.Request(url, headers=headers)
    
    print(f"Requesting {url}...")
    with urllib.request.urlopen(req, context=ctx) as response:
        html = response.read().decode('utf-8', errors='ignore')
        parser = TableParser('table_id')
        parser.feed(html)
        return parser.rows

def sanitize_fee(val_str):
    if not val_str or val_str == 'N/A':
        return 'N/A'
    try:
        val = float(val_str.replace(',', ''))
        if val <= 0:
            return '0.00'
        if val > 1000.0:
            return 'N/A'
        if val > 10.0:
            val = val / 100.0
        return f"{val:.2f}"
    except ValueError:
        return 'N/A'

# Percentile Rank Logic
def percentile(values, value, higher_is_better=True):
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = sum(1 for item in ordered if item <= value) / len(ordered)
    return rank if higher_is_better else 1.0 - rank

# Rating Conversion Score
def rating_score(rating):
    rating = rating.upper()
    if "AAA" in rating:
        return 1.0
    if "AA+" in rating:
        return 0.85
    if "AA" in rating:
        return 0.75
    if "A+" in rating:
        return 0.55
    if "A" in rating:
        return 0.45
    return 0.25 if rating and rating != "N/A" else 0.0

def main():
    try:
        perf_url = "https://mufap.com.pk/Industry/IndustryStatDaily?tab=1"
        nav_url = "https://mufap.com.pk/Industry/IndustryStatDaily?tab=3"
        
        print("Starting MUFAP data scraping with Screener Score calculation...")
        perf_rows = fetch_table(perf_url)
        print(f"Fetched {len(perf_rows)} rows from performance table.")
        
        nav_rows = fetch_table(nav_url)
        print(f"Fetched {len(nav_rows)} rows from NAV table.")
        
        exp_url = "https://mufap.com.pk/Industry/IndustryStatDaily?tab=5"
        exp_rows = fetch_table(exp_url)
        print(f"Fetched {len(exp_rows)} rows from Expense Ratios table.")
        
        if not perf_rows or not nav_rows or not exp_rows:
            print("Error: Could not retrieve data tables from MUFAP.")
            return
        
        # 1. Map NAV details by fund name (from tab=3)
        nav_map = {}
        for row in nav_rows[1:]:
            if len(row) >= 8:
                fund_name = row[2].strip()
                nav_map[fund_name] = {
                    'amc': clean_value(row[1]),
                    'inception_date': clean_value(row[4]),
                    'offer': clean_value(row[5]),
                    'repurchase': clean_value(row[6]),
                    'front_end_load': clean_value(row[9]) if len(row) > 9 else '0',
                    'back_end_load': clean_value(row[10]) if len(row) > 10 else '0',
                    'contingent_load': clean_value(row[11]) if len(row) > 11 else '0',
                    'trustee': clean_value(row[13]) if len(row) > 13 else 'Unknown'
                }
        
        # 1.5 Map Expense details by fund name (from tab=5)
        exp_map = {}
        for row in exp_rows[1:]:
            if len(row) >= 10:
                fund_name = row[2].strip()
                exp_map[fund_name] = {
                    'ter_mtd': clean_value(row[6]),
                    'ter_ytd': clean_value(row[7]),
                    'management_fee': clean_value(row[8]),
                    'sm_fee': clean_value(row[9])
                }
        
        # 2. First pass: Collect all matched funds and pre-extract values for percentile calculations
        raw_funds = []
        recent_values = []
        long_values = []
        load_values = []
        
        # Collect total TERs and other expenses by category to estimate missing TER YTD values
        other_expenses_by_cat = {
            'Stock': [], 'Money Market': [], 'Income': [], 'Pension': [], 'Assets': []
        }
        total_ters_by_cat = {
            'Stock': [], 'Money Market': [], 'Income': [], 'Pension': [], 'Assets': []
        }

        for row in perf_rows[1:]:
            if len(row) >= 7:
                fund_name = row[2].strip()
                category = row[1].strip()
                category_lower = category.lower()
                fund_name_lower = fund_name.lower()
                
                nav_info = nav_map.get(fund_name, {})
                exp_info = exp_map.get(fund_name, {})
                
                # Loads extraction
                f_load = to_float(nav_info.get('front_end_load', '0')) or 0.0
                b_load = to_float(nav_info.get('back_end_load', '0')) or 0.0
                c_load = to_float(nav_info.get('contingent_load', '0')) or 0.0
                total_load = f_load + b_load + c_load
                
                # Shariah check
                is_shariah = "shariah" in category_lower or "islamic" in category_lower or "shariah" in fund_name_lower or "islamic" in fund_name_lower
                
                # Risk & category mapping
                risk_level = classify_risk(category_lower, fund_name_lower)
                major_category = classify_major_category(category_lower, fund_name_lower)
                
                # Track other expenses for averages calculation
                raw_ter = sanitize_fee(exp_info.get('ter_ytd', 'N/A'))
                raw_mf = sanitize_fee(exp_info.get('management_fee', 'N/A'))
                try:
                    ter_val = float(raw_ter) if raw_ter != 'N/A' else 0.0
                    mf_val = float(raw_mf) if raw_mf != 'N/A' else 0.0
                    if ter_val > 0.0:
                        total_ters_by_cat[major_category].append(ter_val)
                        if mf_val > 0.0 and ter_val >= mf_val:
                            other_expenses_by_cat[major_category].append(ter_val - mf_val)
                except ValueError:
                    pass
                
                # 365d return
                recent_str = row[15] if len(row) > 15 else 'N/A'
                recent_val = to_float(recent_str)
                
                # 3y return (annualized)
                long_str = row[17] if len(row) > 17 else 'N/A'
                long_val = to_float(long_str)
                
                fund_data = {
                    'sector': clean_value(row[0]),
                    'category': category,
                    'fund_name': fund_name,
                    'rating': clean_value(row[3]),
                    'benchmark': clean_value(row[4]),
                    'validity_date': clean_value(row[5]),
                    'nav': clean_value(row[6]),
                    'returns': {
                        'mtd': sanitize_return(row[8]) if len(row) > 8 else 'N/A',
                        'ytd': sanitize_return(row[7]) if len(row) > 7 else 'N/A',
                        '1d': sanitize_return(row[9]) if len(row) > 9 else 'N/A',
                        '15d': sanitize_return(row[10]) if len(row) > 10 else 'N/A',
                        '30d': sanitize_return(row[11]) if len(row) > 11 else 'N/A',
                        '90d': sanitize_return(row[12]) if len(row) > 12 else 'N/A',
                        '180d': sanitize_return(row[13]) if len(row) > 13 else 'N/A',
                        '270d': sanitize_return(row[14]) if len(row) > 14 else 'N/A',
                        '365d': sanitize_return(recent_str),
                        '2y': sanitize_return(row[16]) if len(row) > 16 else 'N/A',
                        '3y': sanitize_return(long_str)
                    },
                    'amc': nav_info.get('amc', 'Unknown'),
                    'inception_date': nav_info.get('inception_date', 'Unknown'),
                    'offer': nav_info.get('offer', clean_value(row[6])),
                    'repurchase': nav_info.get('repurchase', clean_value(row[6])),
                    'front_end_load': nav_info.get('front_end_load', '0'),
                    'back_end_load': nav_info.get('back_end_load', '0'),
                    'contingent_load': nav_info.get('contingent_load', '0'),
                    'trustee': nav_info.get('trustee', 'Unknown'),
                    'management_fee': raw_mf,
                    'ter_ytd': raw_ter,
                    'sm_fee': sanitize_fee(exp_info.get('sm_fee', 'N/A')),
                    'is_shariah': is_shariah,
                    'risk_level': risk_level,
                    'major_category': major_category,
                    'total_load': total_load,
                    'recent_float': recent_val,
                    'long_float': long_val
                }
                raw_funds.append(fund_data)
                
                if recent_val is not None:
                    recent_values.append(recent_val)
                if long_val is not None:
                    long_values.append(long_val)
                load_values.append(total_load)

        # 2.5 Compute category averages for fallback and estimate missing/reset TER values
        default_other_avgs = {
            'Money Market': 0.35, 'Income': 0.56, 'Stock': 1.50, 'Assets': 1.15, 'Pension': 0.62
        }
        default_ter_avgs = {
            'Money Market': 0.99, 'Income': 1.19, 'Stock': 4.17, 'Assets': 2.00, 'Pension': 1.39
        }
        
        category_other_avgs = {}
        category_ter_avgs = {}
        
        for cat in ['Stock', 'Money Market', 'Income', 'Pension', 'Assets']:
            other_vals = other_expenses_by_cat[cat]
            if len(other_vals) >= 5:
                category_other_avgs[cat] = sum(other_vals) / len(other_vals)
            else:
                category_other_avgs[cat] = default_other_avgs[cat]
                
            ter_vals = total_ters_by_cat[cat]
            if len(ter_vals) >= 5:
                category_ter_avgs[cat] = sum(ter_vals) / len(ter_vals)
            else:
                category_ter_avgs[cat] = default_ter_avgs[cat]

        for fund in raw_funds:
            raw_ter = fund.get('ter_ytd', 'N/A')
            raw_mf = fund.get('management_fee', 'N/A')
            fund['is_ter_estimated'] = False
            
            try:
                ter_val = float(raw_ter) if raw_ter != 'N/A' else 0.0
                mf_val = float(raw_mf) if raw_mf != 'N/A' else 0.0
                
                # If TER YTD is reset or 0.00
                if ter_val == 0.0:
                    if mf_val > 0.0:
                        est_other = category_other_avgs.get(fund['major_category'], 0.80)
                        fund['ter_ytd'] = f"{(mf_val + est_other):.2f}"
                    else:
                        # Fall back to overall category average TER
                        est_ter = category_ter_avgs.get(fund['major_category'], 2.00)
                        fund['ter_ytd'] = f"{est_ter:.2f}"
                    fund['is_ter_estimated'] = True
            except ValueError:
                pass

        # 3. Second pass: Calculate Screener Score using percentiles (Weights: 55% 1-Yr, 25% 3-Yr, 15% low-load, 5% rating)
        final_funds = []
        for fund in raw_funds:
            recent_val = fund['recent_float']
            long_val = fund['long_float']
            total_load = fund['total_load']
            rating_str = fund['rating']

            p_recent = percentile(recent_values, recent_val) if recent_val is not None else 0.0
            p_long = percentile(long_values, long_val) if long_val is not None else 0.0
            p_load = percentile(load_values, total_load, higher_is_better=False)
            r_score = rating_score(rating_str)

            score = (0.55 * p_recent + 0.25 * p_long + 0.15 * p_load + 0.05 * r_score) * 100
            
            # Clean up temporary floats used for percentile calculation
            del fund['recent_float']
            del fund['long_float']
            
            fund['screener_score'] = round(score, 1)
            final_funds.append(fund)

        # 3.5 Scrape KSE-100 index details from PSX
        psx_data = {
            "price": "185,372.20",
            "direction": "+",
            "change_points": "851.24",
            "change_percent": "0.46%",
            "as_of": "Jul 3, 2026 4:50 PM"
        }
        try:
            print("Requesting KSE-100 index updates from PSX portal...")
            psx_url = "https://dps.psx.com.pk/"
            psx_req = urllib.request.Request(psx_url, headers={'User-Agent': 'Mozilla/5.0'})
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            with urllib.request.urlopen(psx_req, context=ctx) as response:
                psx_html = response.read().decode('utf-8', errors='ignore')
                pattern = r'data-name="KSE100"[^>]*>\s*<h1 class="marketIndices__price">([\d,]+\.\d+)<span class="marketIndices__change\s+([a-zA-Z\-_0-9]+)">.*?([\d,]+\.\d+)\s*\(([^)]+)\)</span></h1>\s*<div class="marketIndices__date">As of\s+([^<]+)</div>'
                match = re.search(pattern, psx_html, re.DOTALL | re.IGNORECASE)
                if match:
                    psx_data = {
                        "price": match.group(1),
                        "direction": "+" if "pos" in match.group(2) else "-",
                        "change_points": match.group(3),
                        "change_percent": match.group(4),
                        "as_of": match.group(5).strip()
                    }
                    print(f"Parsed KSE-100: {psx_data['price']} ({psx_data['direction']}{psx_data['change_points']})")
                else:
                    print("Could not match KSE100 pattern in PSX html, using default fallbacks.")
        except Exception as e_psx:
            print(f"Failed to scrape PSX index: {e_psx}, using default fallbacks.")

        # 3.6 Scrape top performers (gainers/losers/active) from PSX
        psx_performers = {}
        try:
            print("Requesting top active/gainers/losers from PSX portal...")
            perf_url = "https://dps.psx.com.pk/performers"
            perf_req = urllib.request.Request(perf_url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest'
            })
            with urllib.request.urlopen(perf_req, context=ctx) as response:
                perf_html = response.read().decode('utf-8', errors='ignore')
                
            sections = re.split(r'<div>\s*<h3 class="marketPerf__heading">', perf_html)
            for s in sections:
                if not s.strip():
                    continue
                title_match = re.match(r'^([^<]+)', s)
                if not title_match:
                    continue
                title = title_match.group(1).strip()
                key = "active" if "ACTIVE" in title else ("gainers" if "ADVANCERS" in title else "losers")
                
                row_pattern = r'<tr>\s*<td class="nowrap"><a class="tbl__symbol" href="/(?:company|etf)/([^"]*)" data-tippy="([^"]*)"><strong>.*?</strong></a>.*?</td>\s*<td class="right">([\d,.]+)</td>\s*<td class="nowrap right change__text--([^"]+)">.*? ([-+0-9,.]+)<span[^>]*>\s*\(([^)]+)\)</span></td>\s*<td class="right">([\d,.]+)</td>\s*</tr>'
                rows = re.findall(row_pattern, s, re.DOTALL | re.IGNORECASE)
                
                psx_performers[key] = []
                for r in rows:
                    symbol, name, price, change_class, change, pct, vol = r
                    psx_performers[key].append({
                        "symbol": symbol,
                        "name": name,
                        "price": price,
                        "direction": "+" if "pos" in change_class else ("-" if "neg" in change_class else "noc"),
                        "change": change,
                        "percent": pct,
                        "volume": vol
                    })
            print(f"Scraped {len(psx_performers.get('gainers', []))} gainers, {len(psx_performers.get('losers', []))} losers, and {len(psx_performers.get('active', []))} active stocks from PSX.")
        except Exception as e_perf:
            print(f"Failed to scrape PSX performers: {e_perf}")

        # 4. Save to json
        out_dir = "/Users/syed/.gemini/antigravity/scratch/pk-mutual-funds-tracker/data"
        os.makedirs(out_dir, exist_ok=True)
        
        psx_perf_path = os.path.join(out_dir, "psx_performers.json")
        with open(psx_perf_path, 'w', encoding='utf-8') as f_perf:
            json.dump(psx_performers, f_perf, indent=2, ensure_ascii=False)
            
        psx_out_path = os.path.join(out_dir, "psx_index.json")
        with open(psx_out_path, 'w', encoding='utf-8') as f_psx:
            json.dump(psx_data, f_psx, indent=2, ensure_ascii=False)
            
        out_path = os.path.join(out_dir, "mufap_data.json")
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(final_funds, f, indent=2, ensure_ascii=False)
            
        print(f"Scrape and scoring complete! Saved {len(final_funds)} scored funds to {out_path}")
        
    except Exception as e:
        print(f"Error executing scraper script: {e}")

if __name__ == "__main__":
    main()
