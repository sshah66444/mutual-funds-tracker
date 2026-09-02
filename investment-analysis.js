(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.InvestmentAnalysis = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function number(value) {
        const parsed = parseFloat(String(value == null ? '' : value).replace(/[%+,]/g, '').trim());
        return Number.isFinite(parsed) ? parsed : null;
    }

    function isoDate(value) {
        if (!value) return '';
        const text = String(value).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
        const parsed = new Date(text);
        if (Number.isNaN(parsed.getTime())) return '';
        const year = parsed.getFullYear();
        const month = String(parsed.getMonth() + 1).padStart(2, '0');
        const day = String(parsed.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function cleanSeries(entries, current) {
        const byDate = new Map();
        (entries || []).forEach((entry, index) => {
            const date = isoDate(entry && entry.date) || `undated-${String(index).padStart(6, '0')}`;
            const price = number(entry && (entry.price != null ? entry.price : entry.nav));
            if (price != null && price > 0) byDate.set(date, { date, price });
        });
        if (current) {
            const date = isoDate(current.date);
            const price = number(current.price);
            if (date && price != null && price > 0) byDate.set(date, { date, price });
        }
        return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    }

    function returnOver(series, sessions) {
        if (series.length <= sessions) return null;
        const latest = series[series.length - 1].price;
        const earlier = series[series.length - 1 - sessions].price;
        return earlier > 0 ? ((latest / earlier) - 1) * 100 : null;
    }

    function spanDays(series) {
        if (series.length < 2) return 0;
        const first = new Date(series[0].date);
        const last = new Date(series[series.length - 1].date);
        if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return 0;
        return Math.max(0, Math.round((last - first) / 86400000));
    }

    function confidence(count, medium, high) {
        if (count >= high) return { level: 'High', className: 'confidence-high' };
        if (count >= medium) return { level: 'Medium', className: 'confidence-medium' };
        return { level: 'Low', className: 'confidence-low' };
    }

    function rangeStats(series) {
        if (!series.length) return { current: null, high: null, low: null, drawdown: null, rangePosition: null };
        const prices = series.map(item => item.price);
        const current = prices[prices.length - 1];
        const high = Math.max(...prices);
        const low = Math.min(...prices);
        return {
            current,
            high,
            low,
            drawdown: high > 0 ? ((current / high) - 1) * 100 : null,
            rangePosition: high > low ? ((current - low) / (high - low)) * 100 : 50
        };
    }

    function analyseMarket(history, current) {
        const series = cleanSeries(history, current);
        const stats = rangeStats(series);
        const trust = confidence(series.length, 120, 220);
        let label = 'Not enough market history';
        let detail = 'Keep investing decisions schedule-based until more daily observations are available.';
        let className = 'signal-neutral';
        let multiplier = 1;

        if (trust.level !== 'Low' && stats.drawdown != null) {
            if (stats.drawdown <= -15) {
                label = 'Deep market pullback';
                detail = 'The index is far below its observed peak. Equity risk is elevated, so staged deployment is preferable to one large order.';
                className = 'signal-great';
                multiplier = 1.75;
            } else if (stats.drawdown <= -8) {
                label = 'Meaningful market pullback';
                detail = 'The index is materially below its observed peak. This can improve long-term entry conditions, but it is not a bottom signal.';
                className = 'signal-good';
                multiplier = 1.5;
            } else if (stats.drawdown <= -4) {
                label = 'Moderate market pullback';
                detail = 'The market is below its recent peak. A planned equity tranche can be modestly increased without abandoning diversification.';
                className = 'signal-good';
                multiplier = 1.25;
            } else if (stats.drawdown >= -1) {
                label = 'Market near observed high';
                detail = 'The market is close to its observed peak. Continue a regular plan rather than assuming a short-term fall is certain.';
                className = 'signal-caution';
            } else {
                label = 'Market in its normal recent range';
                detail = 'There is no strong drawdown signal. A regular scheduled tranche avoids relying on short-term market direction.';
                className = 'signal-neutral';
            }
        }

        return {
            series,
            count: series.length,
            spanDays: spanDays(series),
            confidence: trust,
            label,
            detail,
            className,
            trancheMultiplier: multiplier,
            current: stats.current,
            peak: stats.high,
            low: stats.low,
            drawdown: stats.drawdown,
            rangePosition: stats.rangePosition,
            returns: { week: returnOver(series, 5), month: returnOver(series, 21), quarter: returnOver(series, 63) }
        };
    }

    function fundKind(fund) {
        const text = `${fund && fund.category || ''} ${fund && fund.major_category || ''}`.toLowerCase();
        if (text.includes('money market') || text.includes('cash')) return 'money-market';
        if (text.includes('income') || text.includes('fixed') || text.includes('debt')) return 'income';
        if (text.includes('balanced') || text.includes('asset allocation') || text.includes('fund of funds')) return 'mixed';
        if (text.includes('equity') || text.includes('stock') || text.includes('index')) return 'equity';
        return 'other';
    }

    function analyseFund(fund, entries) {
        const kind = fundKind(fund);
        const series = cleanSeries(entries, { date: fund && fund.validity_date, price: fund && fund.nav });
        const stats = rangeStats(series);
        const trust = confidence(series.length, 180, 500);
        const nav = number(fund && fund.nav);
        const offer = number(fund && fund.offer);
        const offerPremium = nav && offer ? ((offer / nav) - 1) * 100 : null;
        const first = series.length ? new Date(series[0].date) : null;
        const last = series.length ? new Date(series[series.length - 1].date) : null;
        const hasDistribution = (fund && fund.dividends || []).some(dividend => {
            const date = new Date(dividend.date);
            return first && last && !Number.isNaN(date.getTime()) && date >= first && date <= last;
        });
        let label;
        let detail;

        if (kind === 'money-market') {
            label = 'Choose on net yield and costs';
            detail = 'For money-market funds, a lower NAV is not a useful entry signal. Compare annualised yield, TER, loads, liquidity and credit quality.';
        } else if (kind === 'income') {
            label = 'Timing signal has limited value';
            detail = 'For income funds, compare yield, duration, credit quality, TER and loads. Daily NAV direction alone does not identify a good entry.';
        } else if (trust.level === 'Low') {
            label = 'Insufficient history for an entry verdict';
            detail = `Only ${series.length} usable NAV observations are available. At least 180 are required before showing a fund-level historical signal.`;
        } else if (hasDistribution) {
            label = 'Distribution-adjusted history required';
            detail = 'A payout occurred inside the measured period, so the raw NAV drawdown may be mechanical rather than an investment opportunity.';
        } else if (stats.drawdown <= -15) {
            label = 'Deep NAV pullback';
            detail = 'The fund is well below its observed high. Check benchmark conditions and fund quality before increasing a staged tranche.';
        } else if (stats.drawdown <= -8) {
            label = 'Meaningful NAV pullback';
            detail = 'The NAV is materially below its observed high. This is historical context, not proof that the decline has ended.';
        } else if (stats.drawdown <= -4) {
            label = 'Moderate NAV pullback';
            detail = 'The fund is below its observed high, providing a modest historical entry advantage if it still fits your long-term plan.';
        } else {
            label = 'NAV in its normal recent range';
            detail = 'There is no strong fund-level pullback signal. Continue a scheduled plan instead of waiting for a specific weekday.';
        }

        return {
            kind,
            series,
            count: series.length,
            spanDays: spanDays(series),
            confidence: trust,
            label,
            detail,
            current: stats.current,
            peak: stats.high,
            low: stats.low,
            drawdown: stats.drawdown,
            rangePosition: stats.rangePosition,
            offerPremium,
            hasDistribution,
            returns: { week: returnOver(series, 5), month: returnOver(series, 21) }
        };
    }

    function tranchePlan(options) {
        const amount = Math.max(0, number(options && options.amount) || 0);
        const tranches = Math.max(1, Math.min(24, Math.round(number(options && options.tranches) || 1)));
        const horizon = Math.max(0, number(options && options.horizonYears) || 0);
        const kind = options && options.kind || 'equity';
        const market = options && options.market;
        const timingRelevant = kind === 'equity' || kind === 'mixed';
        const reliableMarket = market && market.confidence && market.confidence.level !== 'Low';
        const multiplier = timingRelevant && reliableMarket ? market.trancheMultiplier : 1;
        const base = amount / tranches;
        const today = Math.min(amount, Math.round((base * multiplier) / 100) * 100);
        const remaining = Math.max(0, amount - today);
        const remainingCount = Math.max(0, tranches - 1);
        const later = remainingCount ? Math.round((remaining / remainingCount) / 100) * 100 : 0;
        let warning = '';
        if ((kind === 'equity' || kind === 'mixed') && horizon < 5) {
            warning = 'Equity-oriented funds are generally unsuitable for money you may need within five years.';
        } else if (!timingRelevant) {
            warning = 'Market-dip timing is not applied to this category; compare net yield, risk and costs instead.';
        } else if (!reliableMarket) {
            warning = 'Market history confidence is low, so the regular tranche is used without a timing adjustment.';
        }
        return { amount, tranches, base, today, remaining, remainingCount, later, multiplier, warning };
    }

    return { number, isoDate, cleanSeries, analyseMarket, fundKind, analyseFund, tranchePlan };
}));
