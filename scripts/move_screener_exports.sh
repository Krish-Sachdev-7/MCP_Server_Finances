#!/bin/bash
# Move screener.in Excel exports from Downloads to the project data directory
# Run this from anywhere: bash scripts/move_screener_exports.sh

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HOME/Downloads"
DEST="$SCRIPT_DIR/data/imports/companies"

mkdir -p "$DEST"

TICKERS=(
  RELIANCE TCS HDFCBANK INFY ICICIBANK BHARTIARTL SBIN
  HINDUNILVR ITC KOTAKBANK LT HCLTECH AXISBANK ASIANPAINT
  MARUTI SUNPHARMA TITAN BAJFINANCE WIPRO
  ULTRACEMCO NESTLEIND BAJAJFINSV ONGC NTPC POWERGRID
  "M&M" TECHM JSWSTEEL TATASTEEL ADANIENT ADANIPORTS
  COALINDIA GRASIM INDUSINDBK DRREDDY CIPLA BRITANNIA
  APOLLOHOSP EICHERMOT DIVISLAB TATACONSUM SBILIFE
  HDFCLIFE BPCL HEROMOTOCO BAJAJ-AUTO HINDALCO UPL VEDL
  TATAMOTORS
)

SUCCESS=0
FAIL=0
FAILED_LIST=()

for TICKER in "${TICKERS[@]}"; do
  FILE="$SRC/$TICKER.xlsx"
  if [ -f "$FILE" ]; then
    mv "$FILE" "$DEST/$TICKER.xlsx"
    echo "OK: $TICKER"
    ((SUCCESS++))
  else
    echo "MISSING: $TICKER (not found in $SRC)"
    ((FAIL++))
    FAILED_LIST+=("$TICKER")
  fi
done

echo ""
echo "===== SUMMARY ====="
echo "Succeeded: $SUCCESS / ${#TICKERS[@]}"
echo "Failed: $FAIL"
if [ ${#FAILED_LIST[@]} -gt 0 ]; then
  echo "Missing tickers: ${FAILED_LIST[*]}"
fi
