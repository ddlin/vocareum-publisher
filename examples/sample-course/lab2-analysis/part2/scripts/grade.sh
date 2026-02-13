#!/bin/bash
# Grading script for Lab 2 Part 2

set -e

echo "=== Running Lab 2 Part 2 Grading ==="

python3 visualize.py > output.txt 2>&1 || true

if grep -q "Category Totals" output.txt; then
    echo "[PASS] Visualization generated"
else
    echo "[FAIL] Visualization not generated"
fi

echo "=== Grading Complete ==="
exit 0
