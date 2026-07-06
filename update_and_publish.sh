#!/bin/bash

# Change directory to the script's location
cd "$(dirname "$0")"

echo "=== Step 1: Fetching latest MUFAP and PSX metrics ==="
python3 mufap_data_collector.py

if [ $? -ne 0 ]; then
    echo "Error collecting data. Aborting upload."
    exit 1
fi

echo "=== Step 2: Committing and publishing updates to GitHub ==="
git add data/mufap_data.json data/psx_index.json data/psx_performers.json

# Also add code changes if any
git add index.html style.css app.js

git commit -m "Update daily market feeds - $(date '+%Y-%m-%d %H:%M')"

echo "Pushing updates to GitHub..."
git push origin main

if [ $? -eq 0 ]; then
    echo "=== Success! Your dashboard has been updated. ==="
else
    echo "Push failed. Please check your internet connection or git authentication."
fi
