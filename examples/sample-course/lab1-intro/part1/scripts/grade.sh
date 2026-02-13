#!/bin/bash
# Grading script for Lab 1 Part 1

set -e

echo "=== Running Lab 1 Part 1 Grading ==="

# Run the student's code
python3 main.py > output.txt 2>&1

# Check output
if grep -q "Hello" output.txt; then
    echo "[PASS] Greeting found in output"
    score=100
else
    echo "[FAIL] No greeting found"
    score=0
fi

echo "=== Final Score: ${score}/100 ==="
exit 0
