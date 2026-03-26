# EquityMCP Data Sources

This document maps each dataset to its source chain, reliability profile, and update cadence.

## Source reliability overview

- **More stable:** Yahoo Finance endpoints for Indian symbols (especially prices and fundamentals).
- **Less stable/unreliable:** NSE/BSE direct public endpoints (undocumented formats, occasional throttling/shape changes).
- **Fallback-of-last-resort:** hardcoded macro defaults when all external calls fail.

## Pipeline-level mapping

| Domain | Primary source | Fallback source | Update frequency |
|---|---|---|---|
| Company master | NSE market/equity endpoints + index constituents | BSE listing feed, then local CSV seed baseline + Yahoo enrichment | Weekly (`0 6 * * 0`) |
| Financials | Yahoo Finance fundamentals via `.NS` symbols | BSE-derived reconstruction when primary fails | Weekly (`0 7 * * 0`) |
| Prices (OHLCV) | Yahoo Finance chart API | None (single reliable source in current implementation) | Weekdays after close (`0 16 * * 1-5`) |
| Shareholding | BSE shareholding filings | None | Quarterly (`0 8 1 */3 *`) |
| Corporate actions | BSE corporate actions | NSE announcements fallback (and vice-versa path in pipeline logic) | Weekly (`0 9 * * 0`) |
| Insider trades | NSE SAST insider disclosures | BSE insider disclosures fallback | Weekdays (`0 17 * * 1-5`) |
| Macro indicators | RBI + government stats endpoints | Hardcoded latest-known values | Monthly (`0 10 1 * *`) |

## Detailed notes by dataset

## Company master
- Baseline universe can be loaded from `data/seeds/companies_seed.csv`.
- Pipeline attempts NSE first, then BSE if needed.
- Additional enrichment (including market-cap metadata path) uses Yahoo-backed lookup helpers.
- Practical implication: master coverage remains available even when exchange endpoints are flaky.

## Financials
- Primary pulls annual/quarterly fundamentals from Yahoo Finance modules.
- If Yahoo-derived pull fails for a ticker, pipeline includes fallback path to derive from alternate disclosures.
- Ratios are computed and stored alongside statement data.

## Prices
- Uses Yahoo daily chart endpoint for OHLCV and adjusted close.
- Adjusted series supports split/bonus-aware historical analysis.
- No secondary provider is currently configured.

## Shareholding
- Uses BSE shareholding pattern disclosures.
- No fallback source exists in code path; failures are logged and retried in next cycle.

## Corporate actions
- Designed with dual-source strategy (BSE primary, NSE fallback, and inverse path support).
- Captures dividends, splits, bonuses, rights, buybacks with `ON CONFLICT` dedupe.

## Insider trades
- NSE SAST disclosures are primary data feed.
- Falls back to BSE insider records if NSE retrieval fails.

## Macro
- Pulls monetary/inflation/growth/market-linked indicators from RBI and government endpoints.
- If all calls fail, inserts/updates a curated fallback snapshot (`LATEST_KNOWN_VALUES`).

## Operational guidance

- Treat NSE/BSE structures as brittle and monitor parser failures.
- Prefer Yahoo-backed paths for continuity where available.
- Keep fallback logic and `pipeline_status` visibility in place for resumable ingestion.
- Review schedules when changing frequency-sensitive tools (especially intraday or event-driven surfaces).
