#!/bin/bash
# Grading script for Lab 2 Part 1

set -e

echo "=== Running Lab 2 Part 1 Grading ==="

# Run the student's code
python3 analysis.py > output.txt 2>&1 || true

# Check if data was loaded
if grep -q "Loaded 5 rows" output.txt; then
    echo "[PASS] Data loaded correctly"
else
    echo "[FAIL] Data not loaded correctly"
fi

echo "=== Grading Complete ==="
exit 0
