#!/bin/bash
# Grading script for Lab 1 Part 1
# This script runs the student's code and checks the output

set -e

echo "Running grading script..."

# Run the student's code
python3 main.py > output.txt 2>&1

# Check for expected output
if grep -q "Hello, Vocareum!" output.txt; then
    echo "PASS: Hello message found"
else
    echo "FAIL: Hello message not found"
    exit 1
fi

if grep -q "2 + 3 = 5" output.txt; then
    echo "PASS: Calculation correct"
else
    echo "FAIL: Calculation incorrect"
    exit 1
fi

echo "All tests passed!"
exit 0
